import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	allowStatusTool,
	ChildJournalRecorder,
	compactJournal,
	MAX_JOURNAL_BYTES,
	MAX_JOURNAL_ENTRIES,
	readJournalFile,
	readSemanticStatusFile,
	sanitizeToolGist,
	sanitizeTurnSummary,
	type JournalEntry,
	type SemanticStatus,
} from "../extensions/background/journal.ts";
import { readDstackResult, type CommittedResult, type TaskBinding } from "../extensions/background/result.ts";
import dstack, { latestActivity, type TaskResult } from "../extensions/dstack.ts";
import { NESTING_ENV, STATUS_FILE_ENV } from "../extensions/types.ts";
import type { WorkflowManifestV1 } from "../extensions/background/workflow.ts";

test("tool gist sanitization removes sensitive blobs and truncates cleanly", () => {
	const readGist = sanitizeToolGist("read", { path: "src/index.ts", offset: 10, limit: 50 });
	assert.equal(readGist, "src/index.ts offset=10 limit=50");

	const bashGist = sanitizeToolGist("bash", { command: "git status\n--short" });
	assert.equal(bashGist, "git status --short");

	const bearerGist = sanitizeToolGist("bash", { command: "curl -H 'Authorization: Bearer live-token' https://example.com" });
	assert.ok(!bearerGist.includes("live-token"));
	assert.ok(bearerGist.toLowerCase().includes("authorization=[redacted]"));

	const editGist = sanitizeToolGist("edit", { path: "package.json", edits: [{ oldText: "foo", newText: "bar" }] });
	assert.equal(editGist, "package.json");

	const statusGist = sanitizeToolGist("dstack_status", { phase: "impl", note: "writing tests", blocking: false });
	assert.equal(statusGist, "phase=impl note=writing tests blocking=false");

	const genericGist = sanitizeToolGist("custom_tool", {
		target: "production",
		secretKey: "super-secret",
		content: "huge multiline content that should not be in gist",
	});
	assert.ok(!genericGist.includes("huge multiline content"));
	assert.ok(genericGist.includes("target=production"));
});

test("turn summary sanitizes newlines and bounds length", () => {
	const summary = sanitizeTurnSummary("First sentence of response.\n\nSecond line with extra details.");
	assert.equal(summary, "First sentence of response.");

	const longLine = "a".repeat(300);
	const bounded = sanitizeTurnSummary(longLine, 100);
	assert.ok(bounded.length <= 100);
	assert.ok(bounded.endsWith("..."));
});

test("journal bounding and compaction preferentially drops routine tools while preserving key milestones", () => {
	const entries: JournalEntry[] = [
		{ seq: 1, timestamp: new Date(1000).toISOString(), kind: "spawn", agent: "poteto-agent", task: "implement feature", cwd: "/app" },
		{ seq: 2, timestamp: new Date(2000).toISOString(), kind: "phase", phase: "grounding", note: "exploring codebase" },
	];

	for (let i = 3; i <= 300; i++) {
		entries.push({
			seq: i,
			timestamp: new Date(2000 + i * 10).toISOString(),
			kind: "tool",
			name: "read",
			gist: `file-${i}.ts offset=1 limit=10`,
		});
	}

	entries.push(
		{ seq: 301, timestamp: new Date(6000).toISOString(), kind: "turn", turn: 1, summary: "Finished reviewing files." },
		{ seq: 302, timestamp: new Date(7000).toISOString(), kind: "phase", phase: "implementation", note: "writing code" },
		{ seq: 303, timestamp: new Date(8000).toISOString(), kind: "exit", exitCode: 0, text: "All tasks completed successfully." },
	);

	assert.ok(entries.length > MAX_JOURNAL_ENTRIES);
	const compacted = compactJournal(entries, MAX_JOURNAL_ENTRIES, MAX_JOURNAL_BYTES);

	assert.ok(compacted.length <= MAX_JOURNAL_ENTRIES);
	assert.ok(Buffer.byteLength(JSON.stringify(compacted), "utf8") <= MAX_JOURNAL_BYTES);

	assert.equal(compacted[0]?.kind, "spawn");
	assert.ok(compacted.some((e) => e.kind === "phase" && e.phase === "grounding"));
	assert.ok(compacted.some((e) => e.kind === "phase" && e.phase === "implementation"));
	assert.ok(compacted.some((e) => e.kind === "turn" && e.turn === 1));
	assert.equal(compacted.at(-1)?.kind, "exit");

	for (let i = 1; i < compacted.length; i++) {
		const prev = compacted[i - 1]!;
		const curr = compacted[i]!;
		assert.ok(curr.seq > prev.seq);
		assert.ok(Date.parse(curr.timestamp) >= Date.parse(prev.timestamp));
	}
});

test("ChildJournalRecorder enforces monotonic seq and writes atomically", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dstack-journal-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const journalPath = join(dir, "journal.json");
	const statusPath = join(dir, "status.json");
	const recorder = new ChildJournalRecorder({ journalPath, statusPath });

	const spawnEntry = recorder.recordSpawn({ agent: "worker", task: "run unit tests", cwd: dir });
	assert.equal(spawnEntry.seq, 1);
	assert.equal(spawnEntry.kind, "spawn");

	const toolEntry = recorder.recordTool({ name: "bash", arguments: { command: "npm test" } });
	assert.equal(toolEntry?.seq, 2);
	assert.equal(toolEntry?.kind, "tool");

	const turnEntry = recorder.recordTurn({ turn: 1, text: "Tests ran clean." });
	assert.equal(turnEntry?.seq, 3);
	assert.equal(turnEntry?.kind, "turn");

	recorder.recordStatus({ phase: "testing", note: "passed 5 suites", blocking: false, updatedAt: new Date().toISOString() });
	const exitEntry = recorder.recordExit({ exitCode: 0, text: "Done" });
	assert.equal(exitEntry.seq, 5);

	await recorder.persist();

	const snapshot = await readJournalFile(journalPath);
	assert.ok(snapshot);
	assert.equal(snapshot.seq, 5);
	assert.equal(snapshot.entries.length, 5);
	assert.deepEqual(
		snapshot.entries.map((e) => e.seq),
		[1, 2, 3, 4, 5],
	);
});

test("allowStatusTool ensures dstack_status is available despite tool allowlist", () => {
	assert.equal(allowStatusTool(undefined), undefined);
	assert.equal(allowStatusTool("read,grep,find,ls"), "read,grep,find,ls,dstack_status");
	assert.equal(allowStatusTool("read,dstack_status,write"), "read,dstack_status,write");
});

test("dstack_status tool registers only in child processes and writes status file atomically", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dstack-status-tool-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const statusFile = join(dir, "status.json");
	const prevNesting = process.env[NESTING_ENV];
	const prevStatus = process.env[STATUS_FILE_ENV];
	const prevAssignment = process.env.DSTACK_ASSIGNMENT;

	try {
		delete process.env[NESTING_ENV];
		delete process.env[STATUS_FILE_ENV];
		delete process.env.DSTACK_ASSIGNMENT;

		const rootTools = new Map<string, unknown>();
		dstack({
			events: createEventBus(),
			registerTool(tool: { name: string }) { rootTools.set(tool.name, tool); },
			registerCommand() {},
			on() {},
			appendEntry() {},
			getAllTools() { return []; },
			sendMessage() {},
			sendUserMessage() {},
		} as unknown as ExtensionAPI);
		assert.equal(rootTools.has("dstack_status"), false);

		process.env[NESTING_ENV] = "1";
		process.env[STATUS_FILE_ENV] = statusFile;

		const childTools = new Map<string, { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: SemanticStatus; isError?: boolean }> }>();
		dstack({
			events: createEventBus(),
			registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) { childTools.set(tool.name, tool as never); },
			registerCommand() {},
			on() {},
			appendEntry() {},
			getAllTools() { return []; },
			sendMessage() {},
			sendUserMessage() {},
		} as unknown as ExtensionAPI);

		const statusTool = childTools.get("dstack_status");
		assert.ok(statusTool);

		const result = await statusTool.execute("call-1", {
			phase: "verification",
			note: "running integration suite",
			blocking: true,
		});

		assert.equal(result.isError, false);
		assert.equal(result.details.phase, "verification");
		assert.equal(result.details.note, "running integration suite");
		assert.equal(result.details.blocking, true);

		const written = await readSemanticStatusFile(statusFile);
		assert.ok(written);
		assert.equal(written.phase, "verification");
		assert.equal(written.note, "running integration suite");
		assert.equal(written.blocking, true);
	} finally {
		if (prevNesting === undefined) delete process.env[NESTING_ENV];
		else process.env[NESTING_ENV] = prevNesting;
		if (prevStatus === undefined) delete process.env[STATUS_FILE_ENV];
		else process.env[STATUS_FILE_ENV] = prevStatus;
		if (prevAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = prevAssignment;
	}
});

test("dstack_result exposes live child state, latest semantic status, freshness, and recent journal", async () => {
	const binding: TaskBinding = { taskId: "task-live-1", workflowId: "wf-live-1" };
	const journalEntries: JournalEntry[] = [
		{ seq: 1, timestamp: "2026-02-26T10:00:00.000Z", kind: "spawn", agent: "poteto-agent", task: "build feature", cwd: "/tmp" },
		{ seq: 2, timestamp: "2026-02-26T10:00:05.000Z", kind: "phase", phase: "grounding", note: "reading files" },
		{ seq: 3, timestamp: "2026-02-26T10:00:10.000Z", kind: "tool", name: "read", gist: "src/main.ts" },
	];
	const status: SemanticStatus = { phase: "grounding", note: "reading files", updatedAt: "2026-02-26T10:00:05.000Z" };

	const view = await readDstackResult({
		taskId: "task-live-1",
		statusExact: async () => ({
			id: "task-live-1",
			name: "dstack",
			command: "runner",
			status: "running",
			outputPath: "/tmp/out.txt",
		}),
		readBinding: async () => binding,
		readProgress: async () => ({
			queued: 0,
			running: 1,
			complete: 0,
			total: 1,
			children: [
				{
					index: 0,
					state: "running",
					agent: "poteto-agent",
					task: "build feature",
					latestStatus: status,
					latestActivity: "grounding: reading files",
					lastActiveAt: "2026-02-26T10:00:10.000Z",
					journal: journalEntries,
				},
			],
		}),
		readCommittedResult: async () => undefined,
	});

	assert.equal(view.kind, "running");
	if (view.kind === "running") {
		assert.equal(view.progress.running, 1);
		assert.equal(view.children?.length, 1);
		const child = view.children?.[0];
		assert.equal(child?.agent, "poteto-agent");
		assert.equal(child?.state, "running");
		assert.equal(child?.latestStatus?.phase, "grounding");
		assert.equal(child?.latestActivity, "grounding: reading files");
		assert.equal(child?.lastActiveAt, "2026-02-26T10:00:10.000Z");
		assert.equal(child?.journal?.length, 3);
	}
});

test("dstack_result summary retains compact history while full detail retains raw messages", async () => {
	const binding: TaskBinding = { taskId: "task-comp-1", workflowId: "wf-comp-1" };
	const journal: JournalEntry[] = [
		{ seq: 1, timestamp: "2026-02-26T10:00:00.000Z", kind: "spawn", agent: "poteto-agent", task: "implement", cwd: "/tmp" },
		{ seq: 2, timestamp: "2026-02-26T10:00:10.000Z", kind: "phase", phase: "verification", note: "running tests" },
		{ seq: 3, timestamp: "2026-02-26T10:00:20.000Z", kind: "exit", exitCode: 0, text: "Success" },
	];
	const status: SemanticStatus = { phase: "verification", note: "running tests", updatedAt: "2026-02-26T10:00:10.000Z" };

	const taskResult: TaskResult = {
		agent: "poteto-agent",
		cwd: "/tmp",
		task: "implement",
		text: "Feature complete and tested.",
		exitCode: 0,
		stderr: "",
		messages: [
			{ role: "user", content: [{ type: "text", text: "Start" }] },
			{ role: "assistant", content: [{ type: "text", text: "Feature complete and tested." }] },
		],
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 },
		journal,
		status,
	};

	const committed: CommittedResult = {
		kind: "complete",
		package: { mode: "single", results: [taskResult] },
	};

	const summaryView = await readDstackResult({
		taskId: "task-comp-1",
		detail: "summary",
		statusExact: async () => ({ id: "task-comp-1", name: "dstack", command: "runner", status: "completed", outputPath: "/tmp/out.txt" }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => committed,
	});

	assert.equal(summaryView.kind, "complete");
	if (summaryView.kind === "complete" && summaryView.detail === "summary") {
		const res = summaryView.package.results[0];
		assert.ok(res);
		assert.equal(res.summary, "Feature complete and tested.");
		assert.deepEqual(res.status, status);
		assert.equal(res.journal?.length, 3);
	}

	const fullView = await readDstackResult({
		taskId: "task-comp-1",
		detail: "full",
		statusExact: async () => ({ id: "task-comp-1", name: "dstack", command: "runner", status: "completed", outputPath: "/tmp/out.txt" }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => committed,
	});

	assert.equal(fullView.kind, "complete");
	if (fullView.kind === "complete" && fullView.detail === "full") {
		const res = fullView.package.results[0];
		assert.ok(res);
		assert.equal(res.text, "Feature complete and tested.");
		assert.equal(res.messages.length, 2);
		assert.deepEqual(res.status, status);
		assert.equal(res.journal?.length, 3);
	}
});

test("nested depth-1 owner retains bounded compact journal and status in TaskDetails", () => {
	const journal: JournalEntry[] = [
		{ seq: 1, timestamp: "2026-02-26T11:00:00.000Z", kind: "spawn", agent: "general-purpose", task: "subtask", cwd: "/tmp" },
		{ seq: 2, timestamp: "2026-02-26T11:00:05.000Z", kind: "phase", phase: "execution", note: "doing work" },
		{ seq: 3, timestamp: "2026-02-26T11:00:10.000Z", kind: "exit", exitCode: 0, text: "Finished subtask" },
	];
	const status: SemanticStatus = { phase: "execution", note: "doing work", updatedAt: "2026-02-26T11:00:05.000Z" };

	const workerResult: TaskResult = {
		agent: "general-purpose",
		cwd: "/tmp",
		task: "subtask",
		text: "Subtask output",
		exitCode: 0,
		stderr: "",
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "Subtask output" }] },
		],
		usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0005, contextTokens: 70, turns: 1 },
		journal,
		status,
	};

	const strippedResult: TaskResult = {
		...workerResult,
		messages: [],
	};
	assert.equal(latestActivity(strippedResult), "execution: doing work");

	const withoutStatus: TaskResult = {
		...strippedResult,
		status: undefined,
	};
	assert.equal(latestActivity(withoutStatus), "completed");
});

test("executeWorkflow generates per-child journal and merges semantic status", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "dstack-workflow-status-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const artifactDir = join(dir, "artifacts");
	const schedulerRoot = join(dir, "scheduler");

	const manifest = {
		schemaVersion: "dstack.workflow.v1" as const,
		workflowId: "wf-status-test",
		sessionId: "session-status-test",
		schedulerRoot,
		artifactDir,
		extensionPath: join(dir, "extension.ts"),
		piChildLaunch: { executable: process.execPath, argvPrefix: [] },
		mode: "single" as const,
		childDepth: 1 as const,
		specs: [
			{
				agent: "poteto-agent",
				task: "implement status history",
				cwd: dir,
				requestedRole: "feature",
			},
		],
		createdAt: new Date().toISOString(),
	} satisfies WorkflowManifestV1;

	const { executeWorkflow, createLocalSlotAcquirer } = await import("../extensions/background/workflow.ts");
	const { atomicWriteFile } = await import("../extensions/background/artifacts.ts");

	const index = await executeWorkflow(manifest, "f".repeat(64), new AbortController().signal, {
		slots: createLocalSlotAcquirer(1),
		spawnChild: async (input) => {
			const statusFile = input.env[STATUS_FILE_ENV];
			if (statusFile) {
				await atomicWriteFile(statusFile, JSON.stringify({
					phase: "implementation",
					note: "modifying workflow.ts",
					blocking: false,
					updatedAt: new Date().toISOString(),
				}));
			}

			input.onUpdate?.({
				text: "Wrote changes",
				exitCode: -1,
				stderr: "",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", name: "edit", arguments: { path: "workflow.ts" } },
							{ type: "text", text: "Wrote changes" },
						],
					},
				],
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 },
			});

			return {
				text: "Finished implementation",
				exitCode: 0,
				stderr: "",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Finished implementation" }],
					},
				],
				usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 300, turns: 2 },
			};
		},
	});

	const result = index.package.results[0];
	assert.ok(result);
	assert.equal(result.status?.phase, "implementation");
	assert.equal(result.status?.note, "modifying workflow.ts");
	assert.ok(result.journal && result.journal.length >= 3);

	const journalDisk = await readJournalFile(join(artifactDir, "children", "0", "journal.json"));
	assert.ok(journalDisk);
	assert.ok(journalDisk.entries.some((e) => e.kind === "spawn"));
	assert.ok(journalDisk.entries.some((e) => e.kind === "tool" && e.name === "edit"));
	assert.ok(journalDisk.entries.some((e) => e.kind === "phase" && e.phase === "implementation"));
	assert.ok(journalDisk.entries.some((e) => e.kind === "exit" && e.exitCode === 0));

});

test("nested depth-1 task execution propagates worker journal and semantic status", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-nested-status-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const fakePi = join(home, "fake-pi.mjs");
	await writeFile(fakePi, [
		'import { writeFileSync } from "node:fs";',
		'writeFileSync(process.env.DSTACK_STATUS_FILE, JSON.stringify({ phase: "verification", note: "checking nested path", updatedAt: new Date().toISOString() }));',
		'const message = { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "nested.ts" } }, { type: "text", text: "Nested work complete" }], usage: { input: 7, output: 3, totalTokens: 10 } };',
		'process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");',
	].join("\n"));

	const configPath = join(home, ".pi", "agent", "dstack", "models.json");
	await mkdir(join(home, ".pi", "agent", "dstack"), { recursive: true });
	await writeFile(configPath, JSON.stringify({
		roles: {
			feature: "test/fake",
			"implementation-worker": "test/fake",
		},
	}));

	const prevHome = process.env.HOME;
	const prevNesting = process.env[NESTING_ENV];
	const prevAssignment = process.env.DSTACK_ASSIGNMENT;
	const prevEntryScript = process.argv[1];

	process.env.HOME = home;
	process.env[NESTING_ENV] = "1";
	delete process.env.DSTACK_ASSIGNMENT;
	process.argv[1] = fakePi;

	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }> }>();
	dstack({
		events: createEventBus(),
		registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
		registerCommand() {},
		on() {},
		appendEntry() {},
		getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
		sendMessage() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI);

	const taskTool = tools.get("dstack_task");
	assert.ok(taskTool);

	const ctx = {
		cwd: home,
		mode: "tui",
		hasUI: true,
		ui: { setStatus() {}, setWidget() {}, notify() {} },
		sessionManager: { getBranch: () => [], getSessionId: () => "nested-session" },
		modelRegistry: { getAvailable: () => [] },
	};

	try {
		const res = await taskTool.execute("nested-test", {
			agent: "general-purpose",
			task: "nested worker task",
			model: "test/fake",
			overrideReason: "test explicit model",
		}, undefined, undefined, ctx);

		assert.equal(res.isError, false);
		const resultDetails = res.details;
		assert.ok(typeof resultDetails === "object" && resultDetails !== null);
		assert.ok("results" in resultDetails && Array.isArray(resultDetails.results));
		const child = resultDetails.results[0];
		assert.equal(child?.status?.phase, "verification");
		assert.ok(child?.journal?.some((entry: JournalEntry) => entry.kind === "tool" && entry.name === "read"));
		assert.equal(child?.journal?.at(-1)?.kind, "exit");
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		process.argv[1] = prevEntryScript;
		if (prevNesting === undefined) delete process.env[NESTING_ENV];
		else process.env[NESTING_ENV] = prevNesting;
		if (prevAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = prevAssignment;
	}
});
