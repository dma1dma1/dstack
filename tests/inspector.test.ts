import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	AgentInspector,
	boundedTailRead,
	buildAgentInspection,
	createWorkflowListCache,
	deriveInspectorLayoutMetrics,
	formatConversationRecords,
	listSessionWorkflows,
	parseChildResultDetails,
	readChildActivityDetails,
	readChildResultDetails,
	renderAmbientWidgetLine,
	wrapText,
	type AgentInspectorResult,
	type AmbientStatus,
	type BoundedReadResult,
	type InspectorTheme,
	type ListSessionWorkflowsIO,
	type WorkflowSummary,
} from "../extensions/background/inspector.ts";
import {
	createSessionTailState,
	tailSessionFile,
	type ChildSessionRefV1,
} from "../extensions/background/session.ts";
import {
	formatJournalEntry,
	formatRecentActivity,
	type JournalEntry,
	type SemanticStatus,
} from "../extensions/background/journal.ts";
import {
	parseChildUsage,
	parseSpawnRecordV1,
	type SpawnNestedChild,
	type TreeSnapshot,
	type TreeTheme,
} from "../extensions/background/tree.ts";
import type { LeaseSnapshot } from "../extensions/background/scheduler.ts";
import type { TodoItem } from "../extensions/types.ts";

function plainTheme(): InspectorTheme & TreeTheme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-inspector-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("boundedTailRead reads bounded bytes from end of file without throwing", async (t) => {
	const dir = await temporaryDirectory(t);
	const file = join(dir, "output.txt");

	const line100 = "Line of output content\n".repeat(100);
	await writeFile(file, line100, "utf8");

	const readFull = await boundedTailRead(file, 100_000);
	assert.equal(readFull.truncated, false);
	assert.equal(readFull.bytesRead, readFull.totalBytes);
	assert.equal(readFull.content, line100);

	const readTail = await boundedTailRead(file, 50);
	assert.equal(readTail.truncated, true);
	assert.equal(readTail.bytesRead, 50);
	assert.ok(readTail.totalBytes > 50);
	assert.equal(readTail.content, line100.slice(line100.length - 50));
});

test("listSessionWorkflows enumerates session workflows, maps bindings, and sorts oldest first", async (t) => {
	const home = await temporaryDirectory(t);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = previousHome;
	});

	const sessionId = "test-session-123";
	const sRoot = join(home, ".pi", "agent", "dstack", "background", encodeURIComponent(sessionId));
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-older"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-newer"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-corrupt"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-corrupt-schema"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-pending"), { recursive: true });

	await writeFile(
		join(sRoot, "bindings", "task-older.json"),
		JSON.stringify({ taskId: "task-older", workflowId: "wf-older" }),
		"utf8",
	);
	await writeFile(
		join(sRoot, "bindings", "task-newer.json"),
		JSON.stringify({ taskId: "task-newer", workflowId: "wf-newer" }),
		"utf8",
	);
	await writeFile(
		join(sRoot, "bindings", "task-pending.json"),
		JSON.stringify({ taskId: "task-pending", workflowId: "wf-pending" }),
		"utf8",
	);

	const nowMs = Date.now();
	const timeNewer = new Date(nowMs + 100_000).toISOString();
	const timeOlder = new Date(nowMs + 50_000).toISOString();

	await writeFile(
		join(sRoot, "workflows", "wf-older", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-older",
			mode: "single",
			createdAt: timeOlder,
			specs: [{ agent: "poteto-agent", task: "older task", workflow: { assignment: "owner", playbook: "feature" } }],
		}),
		"utf8",
	);
	await writeFile(join(sRoot, "workflows", "wf-older", "COMMITTED"), "", "utf8");

	await writeFile(
		join(sRoot, "workflows", "wf-newer", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-newer",
			mode: "parallel",
			createdAt: timeNewer,
			specs: [{ agent: "poteto-agent", task: "newer task", workflow: { assignment: "owner", playbook: "explore" } }],
		}),
		"utf8",
	);

	await writeFile(join(sRoot, "workflows", "wf-corrupt", "manifest.json"), "invalid json", "utf8");
	await writeFile(join(sRoot, "workflows", "wf-corrupt-schema", "manifest.json"), JSON.stringify({ invalid: true }), "utf8");

	const list = await listSessionWorkflows(sessionId);
	assert.equal(list.length, 5);

	const corruptWf = list.find((w) => w.workflowId === "wf-corrupt");
	assert.ok(corruptWf);
	assert.deepEqual(corruptWf.manifest, { kind: "corrupt" });

	const corruptSchemaWf = list.find((w) => w.workflowId === "wf-corrupt-schema");
	assert.ok(corruptSchemaWf);
	assert.deepEqual(corruptSchemaWf.manifest, { kind: "corrupt" });

	const pendingWf = list.find((w) => w.workflowId === "wf-pending");
	assert.ok(pendingWf);
	assert.equal(pendingWf.taskId, "task-pending");
	assert.equal(pendingWf.committed, false);
	assert.deepEqual(pendingWf.manifest, { kind: "pending" });

	const olderWf = list.find((w) => w.workflowId === "wf-older");
	assert.ok(olderWf);
	assert.equal(olderWf.taskId, "task-older");
	assert.equal(olderWf.committed, true);
	assert.equal(olderWf.playbook, "feature");
	assert.deepEqual(olderWf.manifest, { kind: "ok", createdAt: timeOlder, playbook: "feature" });

	const newerWf = list.find((w) => w.workflowId === "wf-newer");
	assert.ok(newerWf);
	assert.equal(newerWf.taskId, "task-newer");
	assert.equal(newerWf.committed, false);
	assert.equal(newerWf.playbook, "explore");
	assert.deepEqual(newerWf.manifest, { kind: "ok", createdAt: timeNewer, playbook: "explore" });
});

test("readChildResultDetails and readChildActivityDetails parse usage telemetry", async (t) => {
	const dir = await temporaryDirectory(t);
	const childDir = join(dir, "children", "0");
	await mkdir(childDir, { recursive: true });

	await writeFile(
		join(childDir, "activity.json"),
		JSON.stringify({
			schemaVersion: "dstack.child-activity.v1",
			workflowId: "wf-act",
			index: 0,
			activity: "working on step",
			updatedAt: "2025-01-01T12:00:00.000Z",
			turns: 4,
			contextTokens: 12500,
		}),
		"utf8",
	);

	const act = await readChildActivityDetails(dir, 0, "wf-act");
	assert.ok(act !== undefined);
	assert.equal(act.turns, 4);
	assert.equal(act.contextTokens, 12500);

	await writeFile(
		join(childDir, "result.json"),
		JSON.stringify({
			schemaVersion: "dstack.child-result.v1",
			workflowId: "wf-act",
			index: 0,
			state: "succeeded",
			output: {
				path: "/path/to/output.txt",
				sha256: "abc123sha256hash",
				bytes: 4096,
			},
			result: {
				text: "done output summary",
				exitCode: 0,
				model: "anthropic/claude-3-5-sonnet",
				stopReason: "stop",
				usage: {
					turns: 6,
					contextTokens: 18000,
					input: 2500,
					output: 800,
					cost: 0.045,
					cacheRead: 0,
					cacheWrite: 0,
				},
			},
		}),
		"utf8",
	);

	const res = await readChildResultDetails(dir, 0);
	assert.ok(res !== undefined);
	assert.equal(res.model, "anthropic/claude-3-5-sonnet");
	assert.equal(res.turns, 6);
	assert.equal(res.contextTokens, 18000);
	assert.equal(res.cost, 0.045);
	assert.equal(res.summaryText, "done output summary");
	assert.equal(res.stopReason, "stop");
	assert.equal(res.exitCode, 0);
	assert.equal(res.outputSeal?.bytes, 4096);
	assert.equal(res.outputSeal?.sha256, "abc123sha256hash");
});

test("renderAmbientWidgetLine renders concise one-line indicators for running and finished states", () => {
	const theme = plainTheme();
	const runningSnapshot: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "parallel",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 1, running: 2, complete: 1, total: 4 },
		slots: { active: 2, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", taskPreview: "plan", nestedGroups: [], nested: [] },
			{ index: 1, agent: "general-purpose", state: "running", taskPreview: "code", nestedGroups: [], nested: [] },
			{ index: 2, agent: "general-purpose", state: "queued", taskPreview: "test", nestedGroups: [], nested: [] },
			{ index: 3, agent: "general-purpose", state: "succeeded", taskPreview: "init", nestedGroups: [], nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const runningLines = renderAmbientWidgetLine({ snapshot: runningSnapshot, activeWorkflowCount: 1 }, 100, theme);
	assert.equal(runningLines.length, 1);
	assert.ok(runningLines[0]?.includes("2 running"));
	assert.ok(runningLines[0]?.includes("1 queued"));
	assert.ok(runningLines[0]?.includes("slots 2/4"));
	assert.ok(runningLines[0]?.includes("shift+up to inspect"));

	const finishedSnapshot: TreeSnapshot = {
		...runningSnapshot,
		committed: true,
		counts: { queued: 0, running: 0, complete: 4, total: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "succeeded", taskPreview: "plan", nestedGroups: [], nested: [] },
			{ index: 1, agent: "general-purpose", state: "succeeded", taskPreview: "code", nestedGroups: [], nested: [] },
			{ index: 2, agent: "general-purpose", state: "succeeded", taskPreview: "test", nestedGroups: [], nested: [] },
			{ index: 3, agent: "general-purpose", state: "succeeded", taskPreview: "init", nestedGroups: [], nested: [] },
		],
	};

	const finishedLines = renderAmbientWidgetLine({ snapshot: finishedSnapshot, activeWorkflowCount: 0 }, 100, theme);
	assert.equal(finishedLines.length, 1);
	assert.ok(finishedLines[0]?.includes("feature complete"));
	assert.ok(finishedLines[0]?.includes("shift+up to inspect"));
});

test("renderAmbientWidgetLine reports session-wide active workflow count when multiple workflows are active", () => {
	const theme = plainTheme();
	const snapshot: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "single",
		playbook: "bug-fix",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 3, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", taskPreview: "fix bug", nestedGroups: [], nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const multiWorkflowStatus: AmbientStatus = {
		snapshot,
		activeWorkflowCount: 2,
	};

	const multiLines = renderAmbientWidgetLine(multiWorkflowStatus, 100, theme);
	assert.equal(multiLines.length, 1);
	assert.ok(multiLines[0]?.includes("bug-fix"));
	assert.ok(multiLines[0]?.includes("2 active workflows"));
	assert.ok(multiLines[0]?.includes("slots 3/4"));
	assert.ok(!multiLines[0]?.includes("1 running"));
	assert.ok(multiLines[0]?.includes("shift+up to inspect"));

	const singleWorkflowStatus: AmbientStatus = {
		snapshot,
		activeWorkflowCount: 1,
	};
	const singleLines = renderAmbientWidgetLine(singleWorkflowStatus, 100, theme);
	assert.equal(singleLines.length, 1);
	assert.ok(singleLines[0]?.includes("1 running"));
	assert.ok(!singleLines[0]?.includes("1 active workflows"));
});

test("renderAmbientWidgetLine hides a committed tracked workflow while another workflow remains active", () => {
	const theme = plainTheme();
	const snapshot: TreeSnapshot = {
		taskId: "task-new",
		workflowId: "wf-new",
		mode: "single",
		playbook: "bug-fix",
		createdAt: "2025-01-01T00:01:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "succeeded", taskPreview: "fix bug", nestedGroups: [], nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const lines = renderAmbientWidgetLine({ snapshot, activeWorkflowCount: 1 }, 100, theme);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("1 active workflow"));
	assert.ok(lines[0]?.includes("slots 1/4"));
	assert.ok(!lines[0]?.includes("bug-fix"));
	assert.ok(!lines[0]?.includes("complete"));
});

test("AgentInspector component navigation: list -> drill-down -> nested drill-down -> pop navigation -> close", async () => {
	let renderRequested = 0;
	const tui = {
		requestRender: () => {
			renderRequested++;
		},
	};
	let closedResult: AgentInspectorResult | undefined;
	const done = (res: AgentInspectorResult) => {
		closedResult = res;
	};

	const workflows: WorkflowSummary[] = [
		{
			workflowId: "wf-1",
			taskId: "task-1",
			artifactDir: "/tmp/wf-1",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	];

	const snapshot: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				model: "openai-codex/gpt-5.6-sol",
				phase: "implementation",
				taskPreview: "build inspector",
				taskFull: "build inspector with clean frames",
				startedAt: "2025-01-01T00:00:10.000Z",
				activity: { text: "writing component", updatedAt: "2025-01-01T00:01:00.000Z" },
				nestedGroups: [
					{
						groupId: "nested-grp-1",
						mode: "single",
						createdAt: "2025-01-01T00:00:20.000Z",
						children: [
							{
								groupId: "nested-grp-1",
								nestedIndex: 0,
								agent: "general-purpose",
								role: "worker",
								assignment: "worker",
								taskPreview: "nested worker job",
								state: "running",
								activity: "compiling",
								startedAt: "2025-01-01T00:00:20.000Z",
								updatedAt: "2025-01-01T00:01:00.000Z",
								live: true,
							},
						],
					},
				],
				nested: [
					{
						groupId: "nested-grp-1",
						nestedIndex: 0,
						agent: "general-purpose",
						role: "worker",
						assignment: "worker",
						taskPreview: "nested worker job",
						state: "running",
						activity: "compiling",
						startedAt: "2025-01-01T00:00:20.000Z",
						updatedAt: "2025-01-01T00:01:00.000Z",
						live: true,
					},
				],
			},
		],
		todos: [
			{ id: "todo-1", content: "ground investigation", status: "completed" },
			{ id: "todo-2", content: "implement component", status: "in_progress" },
		],
		todoCounts: { total: 2, completed: 1, inProgress: 1 },
		capturedAt: "2025-01-01T00:01:30.000Z",
	};

	const readOutputTail = async () => ({
		content: "line 1\nline 2\nline 3\nline 4\n",
		truncated: false,
		bytesRead: 28,
		totalBytes: 28,
	});

	const inspector = new AgentInspector(tui, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => workflows,
		getSnapshot: async () => snapshot,
		readOutputTail,
		now: () => new Date("2025-01-01T00:02:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const listLines = inspector.render(100);
	assert.ok(listLines.length > 5);
	assert.ok(listLines.some((l) => l.includes("dstack agent inspector")));
	assert.ok(listLines.some((l) => l.includes("owner poteto-agent")));
	assert.ok(listLines.some((l) => l.includes("worker general-purpose")));

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\r");
	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const detailLines = inspector.render(100);
	assert.ok(detailLines.some((l) => l.includes("Agent: poteto-agent")));
	assert.ok(detailLines.some((l) => l.includes("Assignment: owner")));
	assert.ok(detailLines.some((l) => l.includes("Role: feature → openai-codex/gpt-5.6-sol")));
	assert.ok(detailLines.some((l) => l.includes("Model: openai-codex/gpt-5.6-sol")));
	assert.ok(detailLines.some((l) => l.includes("Workflow: feature")));
	assert.ok(detailLines.some((l) => l.includes("Phase: implementation")));
	assert.ok(detailLines.some((l) => l.includes("Input Envelope:")));

	inspector.handleInput("\x1b[6~");
	const scrolledDetailLines = inspector.render(100);
	assert.ok(scrolledDetailLines.some((l) => l.includes("Todos:")));
	assert.ok(scrolledDetailLines.some((l) => l.includes("Output Envelope:")));

	inspector.handleInput("\x1b[F");
	const endDetailLines = inspector.render(100);
	assert.ok(endDetailLines.some((l) => l.includes("Nested agents")));

	inspector.handleInput("\r");
	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const nestedDetailLines = inspector.render(100);
	assert.ok(nestedDetailLines.some((l) => l.includes("nested agent: general-purpose") || l.includes("Agent: general-purpose")));
	assert.ok(nestedDetailLines.some((l) => l.includes("Parent: poteto-agent")));

	inspector.handleInput("\x1b[D");
	inspector.handleInput("s");
	const backParentLines = inspector.render(100);
	assert.ok(backParentLines.some((l) => l.includes("Agent: poteto-agent")));

	inspector.handleInput("\x1b");
	const backListLines = inspector.render(100);
	assert.ok(backListLines.some((l) => l.includes("dstack agent inspector")));

	inspector.handleInput("\x1b");
	assert.equal(closedResult, "closed");

	inspector.dispose();
});

test("AgentInspector history toggle and empty states", async () => {
	let closed = false;
	const done = () => {
		closed = true;
	};

	const committedWorkflows: WorkflowSummary[] = [
		{
			workflowId: "wf-done",
			taskId: "task-done",
			artifactDir: "/tmp/wf-done",
			schedulerRoot: "/tmp/scheduler",
			committed: true,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	];

	const doneSnapshot: TreeSnapshot = {
		taskId: "task-done",
		workflowId: "wf-done",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				taskPreview: "done task",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:04:00.000Z",
				outcome: "all steps finished",
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:04:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => committedWorkflows,
		getSnapshot: async () => doneSnapshot,
		now: () => new Date("2025-01-01T00:05:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const initial = inspector.render(100);
	assert.ok(initial.some((l) => l.includes("all steps finished")));

	inspector.handleInput("h");
	const hidden = inspector.render(100);
	assert.ok(hidden.some((l) => l.includes("No active dstack workflows")));

	inspector.handleInput("h");
	const visibleAgain = inspector.render(100);
	assert.ok(visibleAgain.some((l) => l.includes("all steps finished")));

	inspector.dispose();
});

test("AgentInspector stale state and explicit raw output tail scrolling behavior", async () => {
	const done = () => {};
	const staleWorkflow: WorkflowSummary[] = [
		{
			workflowId: "wf-stale",
			taskId: "task-stale",
			artifactDir: "/tmp/wf-stale",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	];

	const staleSnapshot: TreeSnapshot = {
		taskId: "task-stale",
		workflowId: "wf-stale",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				taskPreview: "stuck job",
				stale: true,
				startedAt: "2025-01-01T00:00:00.000Z",
				activity: { text: "last saw progress 10m ago", updatedAt: "2025-01-01T00:01:00.000Z" },
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:10:00.000Z",
	};

	let tailReads = 0;
	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), done, {
		sessionId: "test-sess",
		initialTaskId: "task-stale",
		listWorkflows: async () => staleWorkflow,
		getSnapshot: async () => staleSnapshot,
		readOutputTail: async () => {
			tailReads++;
			return {
				content: Array.from({ length: 30 }, (_, i) => `Output log line #${i + 1}`).join("\n"),
				truncated: true,
				bytesRead: 600,
				totalBytes: 2400,
			};
		},
	});

	for (let attempt = 0; attempt < 50 && tailReads === 0; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(tailReads > 0);

	inspector.handleInput("s");
	const detailLines = inspector.render(100);
	assert.ok(detailLines.some((l) => l.includes("⚠ Stale")));
	assert.ok(detailLines.some((l) => l.includes("Input Envelope:")));

	inspector.handleInput("o");
	const rawLines = inspector.render(100);
	assert.ok(rawLines.some((l) => l.includes("following tail 600 bytes of 2400 bytes")));

	inspector.handleInput("\x1b[A");
	const scrolledLines = inspector.render(100);
	assert.ok(scrolledLines.some((l) => l.includes("lines ") && l.includes("of 30")));

	inspector.handleInput("r");
	await new Promise((r) => setTimeout(r, 20));
	const resumedLines = inspector.render(100);
	assert.ok(resumedLines.some((l) => l.includes("following tail")));

	inspector.dispose();
});

test("AgentInspector task view displays full multiline task with vertical scrolling and no truncation", async () => {
	const multilineTask = [
		"Step 1: Investigate current state of the code.",
		"Step 2: Define structured view model types.",
		"Step 3: Implement detail pane tabs (s, t, f, o).",
		"Step 4: Verify that long lines wrap cleanly and do not get clipped.",
		"Step 5: Add tests for backward compatibility and forward persistence.",
		"Step 6: Ensure depth-2 agents have full parity with depth-1.",
		"Step 7: Perform full typecheck and test suite verification.",
		"Step 8: Final review of changes.",
	].join("\n");

	const snapshot: TreeSnapshot = {
		taskId: "task-multiline",
		workflowId: "wf-multiline",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				taskPreview: "Step 1: Investigate...",
				taskFull: multilineTask,
				startedAt: "2025-01-01T00:00:00.000Z",
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-multiline",
		listWorkflows: async () => [
			{
				workflowId: "wf-multiline",
				taskId: "task-multiline",
				artifactDir: "/tmp/wf-multiline",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const summaryLines = inspector.render(100);
	assert.ok(summaryLines.some((l) => l.includes("press 't' for full task")));

	inspector.handleInput("t");
	const taskLines = inspector.render(80);
	assert.ok(taskLines.some((l) => l.includes("Full Task Content:")));
	assert.ok(taskLines.some((l) => l.includes("Step 1: Investigate current state")));
	assert.ok(taskLines.some((l) => l.includes("Step 8: Final review of changes")));

	inspector.handleInput("\x1b[B");
	const scrolledTask = inspector.render(80);
	assert.ok(scrolledTask.some((l) => l.includes("Full Task Content:")));

	inspector.handleInput("s");
	const backSummary = inspector.render(80);
	assert.ok(backSummary.some((l) => l.includes("Input Envelope:")));

	inspector.dispose();
});

test("AgentInspector final response view renders free-form text with labeled envelope fields and scrolling", async () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-final",
		workflowId: "wf-final",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				taskPreview: "run task",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:02:00.000Z",
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-final",
		listWorkflows: async () => [
			{
				workflowId: "wf-final",
				taskId: "task-final",
				artifactDir: "/tmp/wf-final",
				schedulerRoot: "/tmp/scheduler",
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
		readChildResult: async () => ({
			state: "succeeded",
			model: "anthropic/claude-3-7-sonnet",
			summaryText: "Execution completed successfully.\nAll 144 unit tests pass.\nNo regressions detected.",
			exitCode: 0,
			stopReason: "tool_use",
			outputSeal: {
				path: "children/0/output.txt",
				sha256: "deadbeef12345678",
				bytes: 2048,
			},
			usage: {
				turns: 5,
				contextTokens: 12000,
				input: 1500,
				output: 600,
				cost: 0.03,
				cacheRead: 0,
				cacheWrite: 0,
			},
		}),
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("f");
	const finalLines = inspector.render(100);
	assert.ok(finalLines.some((l) => l.includes("Envelope:") && l.includes("exitCode 0")));
	assert.ok(finalLines.some((l) => l.includes("Seal:") && l.includes("deadbeef12345678")));
	assert.ok(finalLines.some((l) => l.includes("Final Response (free-form text):")));
	assert.ok(finalLines.some((l) => l.includes("Execution completed successfully.")));
	assert.ok(finalLines.some((l) => l.includes("All 144 unit tests pass.")));

	inspector.dispose();
});

test("AgentInspector depth-2 agent parity in views, labeled fields, and unavailable raw output handling", async () => {
	const nestedChild: SpawnNestedChild = {
		groupId: "grp-nested-parity",
		nestedIndex: 0,
		agent: "general-purpose",
		role: "worker",
		assignment: "worker",
		taskPreview: "subtask 1",
		taskFull: "Detailed depth-2 subtask:\nRun implementation checks.\nVerify output format.",
		state: "succeeded",
		startedAt: "2025-01-01T00:00:10.000Z",
		endedAt: "2025-01-01T00:00:40.000Z",
		updatedAt: "2025-01-01T00:00:40.000Z",
		live: false,
		model: "anthropic/claude-3-5-haiku",
		cwd: "/tmp/worktree-parity",
		tools: "read,edit,write",
		finalResponse: "Depth-2 task finished cleanly without errors.",
		exitCode: 0,
		stopReason: "stop",
		usage: {
			turns: 3,
			contextTokens: 5000,
			input: 800,
			output: 200,
			cost: 0.005,
			cacheRead: 0,
			cacheWrite: 0,
		},
		workflow: {
			playbook: "feature",
			assignment: "worker",
			phase: "implementation",
			completedPhases: ["grounding"],
			artifacts: [{ name: "spec", path: "/tmp/spec.md" }],
		},
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-depth2",
		workflowId: "wf-depth2",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				taskPreview: "parent owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				nestedGroups: [
					{
						groupId: "grp-nested-parity",
						mode: "single",
						createdAt: "2025-01-01T00:00:00.000Z",
						children: [nestedChild],
					},
				],
				nested: [nestedChild],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-depth2",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-nested-parity",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-depth2",
				taskId: "task-depth2",
				artifactDir: "/tmp/wf-depth2",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const depth2Summary = inspector.render(100);
	assert.ok(depth2Summary.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(depth2Summary.some((l) => l.includes("Parent:") && l.includes("poteto-agent")));

	inspector.handleInput("\x1b[6~");
	const depth2SummaryScrolled = inspector.render(100);
	assert.ok(depth2SummaryScrolled.some((l) => l.includes("Output Envelope:")));
	assert.ok(depth2SummaryScrolled.some((l) => l.includes("provenance: spawn-record")));

	inspector.handleInput("t");
	const depth2Task = inspector.render(100);
	assert.ok(depth2Task.some((l) => l.includes("Detailed depth-2 subtask:")));
	assert.ok(depth2Task.some((l) => l.includes("Run implementation checks.")));

	inspector.handleInput("f");
	const depth2Final = inspector.render(100);
	assert.ok(depth2Final.some((l) => l.includes("Depth-2 task finished cleanly without errors.")));
	assert.ok(depth2Final.some((l) => l.includes("provenance: spawn-record")));

	inspector.handleInput("o");
	const depth2Raw = inspector.render(100);
	assert.ok(depth2Raw.some((l) => l.includes("Raw output.txt tail is not captured separately for depth-2 child agents")));

	inspector.dispose();
});

test("parseSpawnRecordV1 backward compatibility with old records and forward parsing with all optional fields", () => {
	const oldRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-legacy",
		parentIndex: 0,
		groupId: "grp-legacy",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "worker",
				assignment: "worker",
				taskPreview: "legacy task preview",
				state: "succeeded",
				activity: "done",
				updatedAt: "2025-01-01T00:01:00.000Z",
				startedAt: "2025-01-01T00:00:10.000Z",
				endedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};

	const parsedOld = parseSpawnRecordV1(oldRecord);
	assert.ok(parsedOld !== undefined);
	assert.equal(parsedOld.workflowId, "wf-legacy");
	assert.equal(parsedOld.children.length, 1);
	assert.equal(parsedOld.children[0]?.agent, "general-purpose");
	assert.equal(parsedOld.children[0]?.taskPreview, "legacy task preview");
	assert.equal(parsedOld.children[0]?.taskFull, undefined);
	assert.equal(parsedOld.children[0]?.model, undefined);
	assert.equal(parsedOld.children[0]?.usage, undefined);

	const newRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-new",
		parentIndex: 1,
		groupId: "grp-new",
		mode: "parallel",
		phase: "verification",
		createdAt: "2025-01-01T00:00:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "worker",
				assignment: "worker",
				taskPreview: "new task preview",
				taskFull: "new task full multiline content",
				state: "succeeded",
				activity: "completed step",
				updatedAt: "2025-01-01T00:02:00.000Z",
				startedAt: "2025-01-01T00:00:10.000Z",
				endedAt: "2025-01-01T00:02:00.000Z",
				model: "anthropic/claude-3-7-sonnet",
				cwd: "/tmp/cwd-new",
				tools: "read,write",
				finalResponse: "all tests pass",
				exitCode: 0,
				stopReason: "tool_use",
				usage: {
					turns: 4,
					contextTokens: 8000,
					input: 1200,
					output: 400,
					cost: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
				},
				workflow: {
					playbook: "feature",
					assignment: "worker",
					phase: "verification",
					completedPhases: ["grounding", "implementation"],
					artifacts: [{ name: "test-report", path: "/tmp/report.json", sha256: "sha123" }],
				},
			},
		],
	};

	const parsedNew = parseSpawnRecordV1(newRecord);
	assert.ok(parsedNew !== undefined);
	assert.equal(parsedNew.workflowId, "wf-new");
	assert.equal(parsedNew.phase, "verification");
	assert.equal(parsedNew.children.length, 1);
	const c = parsedNew.children[0]!;
	assert.equal(c.taskFull, "new task full multiline content");
	assert.equal(c.model, "anthropic/claude-3-7-sonnet");
	assert.equal(c.cwd, "/tmp/cwd-new");
	assert.equal(c.tools, "read,write");
	assert.equal(c.finalResponse, "all tests pass");
	assert.equal(c.exitCode, 0);
	assert.equal(c.stopReason, "tool_use");
	assert.equal(c.usage?.turns, 4);
	assert.equal(c.usage?.cost, 0.02);
	assert.equal(c.workflow?.playbook, "feature");
	assert.equal(c.workflow?.completedPhases.length, 2);
	assert.equal(c.workflow?.artifacts[0]?.sha256, "sha123");
});

test("wrapText wraps long lines cleanly at word boundaries and keeps newlines", () => {
	const input = "This is a short line.\nThis is a much longer line that should be wrapped neatly across multiple lines without losing any text.\nShort.";
	const wrapped = wrapText(input, 30);
	assert.ok(wrapped.length > 3);
	assert.equal(wrapped[0], "This is a short line.");
	assert.ok(wrapped.every((line) => line.length <= 30));
	assert.equal(wrapped[wrapped.length - 1], "Short.");

	const rawToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+/=!";
	const width = 16;
	const wrappedToken = wrapText(rawToken, width);
	assert.ok(wrappedToken.length >= 4);
	assert.ok(wrappedToken.every((chunk) => chunk.length <= width));
	assert.ok(wrappedToken.every((chunk) => !chunk.includes("…") && !chunk.includes("...")));
	assert.equal(wrappedToken.join(""), rawToken);
});

test("parseChildUsage validates complete records and rejects partial or non-finite records", () => {
	const complete = {
		input: 1000,
		output: 200,
		cacheRead: 50,
		cacheWrite: 25,
		cost: 0.015,
		contextTokens: 4000,
		turns: 3,
	};
	const parsed = parseChildUsage(complete);
	assert.deepEqual(parsed, complete);

	assert.equal(parseChildUsage(null), undefined);
	assert.equal(parseChildUsage(undefined), undefined);
	assert.equal(parseChildUsage("not-an-object"), undefined);

	assert.equal(parseChildUsage({ input: 100, output: 50 }), undefined);
	assert.equal(parseChildUsage({ ...complete, cost: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, cacheRead: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, cacheWrite: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, contextTokens: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, turns: undefined }), undefined);

	assert.equal(parseChildUsage({ ...complete, input: Number.NaN }), undefined);
	assert.equal(parseChildUsage({ ...complete, cost: Number.POSITIVE_INFINITY }), undefined);
	assert.equal(parseChildUsage({ ...complete, turns: "5" as unknown as number }), undefined);
});

test("AgentInspector summary view bounds viewport, shows line-range indicator, and supports vertical scrolling", async () => {
	const manyTodos: TodoItem[] = Array.from({ length: 12 }, (_, i) => ({
		id: `todo-${i + 1}`,
		content: `Execute detailed inspection task step ${i + 1}`,
		status: i < 3 ? "completed" : i === 3 ? "in_progress" : "pending",
	}));

	const snapshot: TreeSnapshot = {
		taskId: "task-long-summary",
		workflowId: "wf-long-summary",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				role: "feature",
				assignment: "owner",
				state: "running",
				taskPreview: "Long summary test task",
				taskFull: "Long summary test task full description",
				startedAt: "2025-01-01T00:00:00.000Z",
				workflow: {
					playbook: "feature",
					assignment: "owner",
					phase: "implementation",
					completedPhases: ["grounding", "architecture"],
					artifacts: [
						{ name: "arch-doc", path: "/tmp/arch.md" },
						{ name: "plan-doc", path: "/tmp/plan.md" },
					],
				},
				nestedGroups: [],
				nested: [],
			},
		],
		todos: manyTodos,
		todoCounts: { total: 12, completed: 3, inProgress: 1 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-long-summary",
		listWorkflows: async () => [
			{
				workflowId: "wf-long-summary",
				taskId: "task-long-summary",
				artifactDir: "/tmp/wf-long-summary",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const initialSummary = inspector.render(100);
	assert.ok(initialSummary.some((l) => l.includes("Agent:") && l.includes("poteto-agent")));
	assert.ok(initialSummary.some((l) => l.includes("lines 1-14 of")));
	assert.ok(initialSummary.some((l) => l.includes("PgUp/PgDn scroll") && l.includes("Home/End")));

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	const scrolledDownSummary = inspector.render(100);
	assert.ok(scrolledDownSummary.some((l) => l.includes("lines 3-16 of") || l.includes("lines 3-")));

	inspector.handleInput("\x1b[6~");
	inspector.handleInput("\x1b[6~");
	const pageDownSummary = inspector.render(100);
	assert.ok(pageDownSummary.some((l) => l.includes("step 10") || l.includes("step 11") || l.includes("step 12")));

	inspector.handleInput("\x1b[F");
	const bottomSummary = inspector.render(100);
	assert.ok(bottomSummary.some((l) => l.includes("step 12")));

	inspector.handleInput("\x1b[H");
	const topSummary = inspector.render(100);
	assert.ok(topSummary.some((l) => l.includes("lines 1-14 of")));
	assert.ok(topSummary.some((l) => l.includes("Agent:") && l.includes("poteto-agent")));

	inspector.dispose();
});

test("AgentInspector done resolves at most once", () => {
	let doneCalls = 0;
	const done = () => {
		doneCalls++;
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => [],
	});

	inspector.handleInput("q");
	inspector.handleInput("q");
	inspector.handleInput("\x1b");
	assert.equal(doneCalls, 1);

	inspector.dispose();
});

test("AgentInspector dispose halts refresh timer and prevents post-dispose render or state mutation", async () => {
	let renderCalls = 0;
	let resolveList: (value: WorkflowSummary[]) => void;
	const listPromise = new Promise<WorkflowSummary[]>((resolve) => {
		resolveList = resolve;
	});

	const inspector = new AgentInspector(
		{
			requestRender: () => {
				renderCalls++;
			},
		},
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			refreshIntervalMs: 5,
			listWorkflows: () => listPromise,
		},
	);

	inspector.dispose();
	const rendersAtDispose = renderCalls;

	resolveList!([
		{
			workflowId: "wf-late",
			taskId: "task-late",
			artifactDir: "/tmp/wf-late",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	]);

	await new Promise((r) => setTimeout(r, 20));
	assert.equal(renderCalls, rendersAtDispose);
});

test("AgentInspector suppresses overlapping poll execution", async () => {
	let activePolls = 0;
	let maxConcurrentPolls = 0;

	const inspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			refreshIntervalMs: 5,
			listWorkflows: async () => {
				activePolls++;
				maxConcurrentPolls = Math.max(maxConcurrentPolls, activePolls);
				await new Promise((r) => setTimeout(r, 25));
				activePolls--;
				return [];
			},
		},
	);

	await new Promise((r) => setTimeout(r, 60));
	inspector.dispose();

	assert.equal(maxConcurrentPolls, 1);
});

test("AgentInspector freezes committed workflow elapsed time using child end times and capturedAt", async () => {
	let simulatedNow = new Date("2025-01-01T00:10:00.000Z");

	const committedWorkflows: WorkflowSummary[] = [
		{
			workflowId: "wf-done",
			taskId: "task-done",
			artifactDir: "/tmp/wf-done",
			schedulerRoot: "/tmp/scheduler",
			committed: true,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	];

	const doneSnapshot: TreeSnapshot = {
		taskId: "task-done",
		workflowId: "wf-done",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				taskPreview: "done task",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:03:00.000Z",
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:05:00.000Z",
	};

	const inspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => committedWorkflows,
			getSnapshot: async () => doneSnapshot,
			now: () => simulatedNow,
		},
	);

	await new Promise((r) => setTimeout(r, 20));

	const initialLines = inspector.render(100);
	assert.ok(initialLines.some((l) => l.includes("1/1 done · 3m00s")));

	simulatedNow = new Date("2025-01-01T05:00:00.000Z");
	const laterLines = inspector.render(100);
	assert.ok(laterLines.some((l) => l.includes("1/1 done · 3m00s")));

	inspector.dispose();
});

test("AgentInspector distinguishes top-level load failure from empty state", async () => {
	const failingInspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => {
				throw new Error("EACCES: permission denied");
			},
		},
	);

	await new Promise((r) => setTimeout(r, 20));
	const errorLines = failingInspector.render(100);
	assert.ok(errorLines.some((l) => l.includes("Failed to load dstack workflows: EACCES: permission denied")));
	failingInspector.dispose();

	const emptyInspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => [],
		},
	);

	await new Promise((r) => setTimeout(r, 20));
	const emptyLines = emptyInspector.render(100);
	assert.ok(emptyLines.some((l) => l.includes("No dstack agents in this session yet")));
	emptyInspector.dispose();
});

test("AgentInspector renders inherited model for running depth-2 child", async () => {
	const runningNested: SpawnNestedChild = {
		groupId: "grp-running",
		nestedIndex: 0,
		agent: "general-purpose",
		role: "implementation-worker",
		assignment: "worker",
		taskPreview: "running worker task",
		state: "running",
		startedAt: "2025-01-01T00:00:10.000Z",
		updatedAt: "2025-01-01T00:00:10.000Z",
		live: true,
		model: "anthropic/claude-3-7-sonnet",
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-running-d2",
		workflowId: "wf-running-d2",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				taskPreview: "parent owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				nestedGroups: [
					{
						groupId: "grp-running",
						mode: "single",
						createdAt: "2025-01-01T00:00:10.000Z",
						children: [runningNested],
					},
				],
				nested: [runningNested],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:00:30.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-running-d2",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-running",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-running-d2",
				taskId: "task-running-d2",
				artifactDir: "/tmp/wf-running-d2",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));
	inspector.handleInput("s");
	const lines = inspector.render(100);

	assert.ok(lines.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(lines.some((l) => l.includes("Model:") && l.includes("anthropic/claude-3-7-sonnet")));
	assert.ok(!lines.some((l) => l.includes("Model:") && l.includes("implementation-worker")));
	inspector.dispose();
});

test("AgentInspector renders child-reported model for completed depth-2 child in summary and final views", async () => {
	const completedNested: SpawnNestedChild = {
		groupId: "grp-completed",
		nestedIndex: 0,
		agent: "general-purpose",
		role: "implementation-worker",
		assignment: "worker",
		taskPreview: "completed worker task",
		state: "succeeded",
		startedAt: "2025-01-01T00:00:10.000Z",
		endedAt: "2025-01-01T00:00:45.000Z",
		updatedAt: "2025-01-01T00:00:45.000Z",
		live: false,
		model: "google/gemini-2.5-pro",
		finalResponse: "implementation successfully completed",
		exitCode: 0,
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-completed-d2",
		workflowId: "wf-completed-d2",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				taskPreview: "parent owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				nestedGroups: [
					{
						groupId: "grp-completed",
						mode: "single",
						createdAt: "2025-01-01T00:00:10.000Z",
						children: [completedNested],
					},
				],
				nested: [completedNested],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-completed-d2",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-completed",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-completed-d2",
				taskId: "task-completed-d2",
				artifactDir: "/tmp/wf-completed-d2",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));
	inspector.handleInput("s");
	const summaryLines = inspector.render(100);
	assert.ok(summaryLines.some((l) => l.includes("Model:") && l.includes("google/gemini-2.5-pro")));

	inspector.handleInput("f");
	const finalLines = inspector.render(100);
	assert.ok(finalLines.some((l) => l.includes("model: google/gemini-2.5-pro")));
	assert.ok(finalLines.some((l) => l.includes("implementation successfully completed")));
	inspector.dispose();
});

test("AgentInspector recovers nested model from historical sealed result on disk and renders it", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-historical-sealed");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(artifactDir, { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifestData = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-historical-sealed",
		sessionId: "test-sess",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner task",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature", phase: "implement" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifestData), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({ queued: 0, running: 0, complete: 1, total: 1 }), "utf8");

	const childDir = join(artifactDir, "children", "0");
	const spawnsDir = join(childDir, "spawns");
	await mkdir(spawnsDir, { recursive: true });

	const historicalSpawn = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-historical-sealed",
		parentIndex: 0,
		groupId: "grp-hist-sealed",
		mode: "single",
		createdAt: "2025-01-01T00:00:10.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "historical worker task",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	await writeFile(join(spawnsDir, "grp-hist-sealed.json"), JSON.stringify(historicalSpawn), "utf8");

	const parentResult = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-historical-sealed",
		index: 0,
		state: "succeeded",
		result: {
			agent: "poteto-agent",
			details: {
				mode: "single",
				results: [
					{
						agent: "general-purpose",
						model: "anthropic/claude-3-5-haiku",
						exitCode: 0,
					},
				],
			},
		},
	};
	await writeFile(join(childDir, "result.json"), JSON.stringify(parentResult), "utf8");

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-historical-sealed",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-hist-sealed",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-historical-sealed",
				taskId: "task-hist-sealed",
				artifactDir,
				schedulerRoot,
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
	});

	await new Promise((r) => setTimeout(r, 40));
	inspector.handleInput("s");
	const lines = inspector.render(100);

	assert.ok(lines.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(lines.some((l) => l.includes("Model:") && l.includes("anthropic/claude-3-5-haiku")));
	assert.ok(!lines.some((l) => l.includes("Model:") && l.includes("implementation-worker")));
	inspector.dispose();
});

test("AgentInspector renders Model: unavailable for historical records without sealed fallback", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-historical-unavailable");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(artifactDir, { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifestData = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-historical-unavailable",
		sessionId: "test-sess",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner task",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature", phase: "implement" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifestData), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({ queued: 0, running: 0, complete: 1, total: 1 }), "utf8");

	const childDir = join(artifactDir, "children", "0");
	const spawnsDir = join(childDir, "spawns");
	await mkdir(spawnsDir, { recursive: true });

	const historicalSpawn = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-historical-unavailable",
		parentIndex: 0,
		groupId: "grp-hist-unavail",
		mode: "single",
		createdAt: "2025-01-01T00:00:10.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "historical unavail task",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	await writeFile(join(spawnsDir, "grp-hist-unavail.json"), JSON.stringify(historicalSpawn), "utf8");

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-historical-unavailable",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-hist-unavail",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-historical-unavailable",
				taskId: "task-hist-unavail",
				artifactDir,
				schedulerRoot,
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
	});

	await new Promise((r) => setTimeout(r, 40));
	inspector.handleInput("s");
	const lines = inspector.render(100);

	assert.ok(lines.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(lines.some((l) => l.includes("Model:") && l.includes("unavailable")));
	assert.ok(!lines.some((l) => l.includes("Model:") && l.includes("implementation-worker")));
	inspector.dispose();
});

test("deriveInspectorLayoutMetrics derives metrics across viewport sizes and provides backward-compatible fallback", () => {
	const fallback = deriveInspectorLayoutMetrics(undefined);
	assert.equal(fallback.terminalRows, 26);
	assert.equal(fallback.frameHeight, 23);
	assert.equal(fallback.bodyRows, 16);
	assert.equal(fallback.listVisibleRows, 14);
	assert.equal(fallback.summaryVisibleRows, 14);
	assert.equal(fallback.taskVisibleRows, 14);
	assert.equal(fallback.finalVisibleRows, 12);
	assert.equal(fallback.rawVisibleRows, 12);

	const tall = deriveInspectorLayoutMetrics(60);
	assert.equal(tall.terminalRows, 60);
	assert.equal(tall.frameHeight, 54);
	assert.equal(tall.bodyRows, 47);
	assert.equal(tall.listVisibleRows, 45);
	assert.equal(tall.summaryVisibleRows, 45);
	assert.equal(tall.taskVisibleRows, 44);
	assert.equal(tall.finalVisibleRows, 43);
	assert.equal(tall.rawVisibleRows, 43);

	const small = deriveInspectorLayoutMetrics(15);
	assert.equal(small.terminalRows, 15);
	assert.equal(small.frameHeight, 13);
	assert.equal(small.bodyRows, 6);
	assert.equal(small.listVisibleRows, 4);
	assert.equal(small.summaryVisibleRows, 4);
	assert.equal(small.taskVisibleRows, 3);
	assert.equal(small.finalVisibleRows, 2);
	assert.equal(small.rawVisibleRows, 2);

	const minimal = deriveInspectorLayoutMetrics(4);
	assert.equal(minimal.terminalRows, 8);
	assert.equal(minimal.frameHeight, 8);
	assert.equal(minimal.bodyRows, 1);
	assert.equal(minimal.listVisibleRows, 1);
	assert.equal(minimal.summaryVisibleRows, 1);
	assert.equal(minimal.taskVisibleRows, 1);
	assert.equal(minimal.finalVisibleRows, 1);
	assert.equal(minimal.rawVisibleRows, 1);
});

test("AgentInspector grows frame and view budgets on tall viewports", async () => {
	const snapshot: TreeSnapshot = {
		workflowId: "wf-tall",
		taskId: "task-tall",
		mode: "single",
		committed: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, total: 1, running: 1, complete: 0 },
		slots: { active: 1, capacity: 4 },
		playbook: "feature",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				startedAt: "2025-01-01T00:00:01.000Z",
				taskPreview: "tall viewport task",
				assignment: "owner",
				phase: "implement",
				nestedGroups: [],
				nested: [],
			},
		],
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-tall",
		terminalRows: 60,
		listWorkflows: async () => [
			{
				workflowId: "wf-tall",
				taskId: "task-tall",
				artifactDir: "/tmp/wf-tall",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	assert.equal(inspector.layoutMetrics.terminalRows, 60);
	assert.equal(inspector.layoutMetrics.frameHeight, 54);
	assert.equal(inspector.layoutMetrics.bodyRows, 47);

	const summaryLines = inspector.render(100);
	assert.equal(summaryLines.length, 54);
	assert.ok(summaryLines[0]?.includes("╭"));
	assert.ok(summaryLines[summaryLines.length - 1]?.includes("╰"));
	assert.ok(summaryLines[summaryLines.length - 2]?.includes("Esc/← back"));

	inspector.handleInput("t");
	const taskLines = inspector.render(100);
	assert.equal(taskLines.length, 54);
	assert.ok(taskLines[taskLines.length - 2]?.includes("Esc/← back"));

	inspector.handleInput("f");
	const finalLines = inspector.render(100);
	assert.equal(finalLines.length, 54);
	assert.ok(finalLines[finalLines.length - 2]?.includes("Esc/← back"));

	inspector.handleInput("o");
	const rawLines = inspector.render(100);
	assert.equal(rawLines.length, 54);
	assert.ok(rawLines[rawLines.length - 2]?.includes("Esc/← back"));

	inspector.handleInput("\x1b[D");
	const listLines = inspector.render(100);
	assert.equal(listLines.length, 54);
	assert.ok(listLines[listLines.length - 2]?.includes("Esc/q close"));

	inspector.dispose();
});

test("AgentInspector bounds frame and preserves borders, footer, and scrolling on small viewports", async () => {
	const children = Array.from({ length: 10 }, (_, i) => ({
		index: i,
		agent: "poteto-agent",
		state: "running" as const,
		startedAt: "2025-01-01T00:00:01.000Z",
		taskPreview: `step ${i + 1} task preview description`,
		assignment: "worker" as const,
		phase: `phase-${i + 1}`,
		nestedGroups: [],
		nested: [],
	}));

	const snapshot: TreeSnapshot = {
		workflowId: "wf-small",
		taskId: "task-small",
		mode: "parallel",
		committed: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, total: 10, running: 10, complete: 0 },
		slots: { active: 4, capacity: 4 },
		playbook: "feature",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children,
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		terminalRows: 15,
		listWorkflows: async () => [
			{
				workflowId: "wf-small",
				taskId: "task-small",
				artifactDir: "/tmp/wf-small",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	assert.equal(inspector.layoutMetrics.terminalRows, 15);
	assert.equal(inspector.layoutMetrics.frameHeight, 13);
	assert.equal(inspector.layoutMetrics.bodyRows, 6);
	assert.equal(inspector.layoutMetrics.listVisibleRows, 4);

	const initialList = inspector.render(100);
	assert.equal(initialList.length, 13);
	assert.ok(initialList[0]?.includes("╭"));
	assert.ok(initialList[12]?.includes("╰"));
	assert.ok(initialList[11]?.includes("Esc/q close"));

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");

	const scrolledList = inspector.render(100);
	assert.equal(scrolledList.length, 13);
	assert.ok(scrolledList[0]?.includes("╭"));
	assert.ok(scrolledList[12]?.includes("╰"));
	assert.ok(scrolledList[11]?.includes("Esc/q close"));

	inspector.handleInput("\r");
	const smallDetail = inspector.render(100);
	assert.equal(smallDetail.length, 13);
	assert.ok(smallDetail[0]?.includes("╭"));
	assert.ok(smallDetail[12]?.includes("╰"));
	assert.ok(smallDetail[11]?.includes("Esc/← back"));

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	const scrolledDetail = inspector.render(100);
	assert.equal(scrolledDetail.length, 13);
	assert.ok(scrolledDetail[11]?.includes("Esc/← back"));

	inspector.handleInput("f");
	const smallFinal = inspector.render(100);
	assert.equal(smallFinal.length, 13);
	assert.ok(smallFinal[9]?.includes("lines 1-1 of 1"));
	assert.ok(smallFinal[11]?.includes("Esc/← back"));
	assert.ok(smallFinal[12]?.includes("╰"));

	inspector.dispose();
});

test("AgentInspector calculates Final view row budget with fully populated envelope and scrolls without truncation", async () => {
	const snapshot: TreeSnapshot = {
		workflowId: "wf-final-populated",
		taskId: "task-final-populated",
		mode: "single",
		committed: true,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, total: 1, running: 0, complete: 1 },
		slots: { active: 0, capacity: 4 },
		playbook: "feature",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				startedAt: "2025-01-01T00:00:01.000Z",
				endedAt: "2025-01-01T00:01:00.000Z",
				taskPreview: "task preview",
				assignment: "owner",
				phase: "implement",
				nestedGroups: [],
				nested: [],
			},
		],
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const populatedResultDetails = {
		state: "succeeded" as const,
		exitCode: 0,
		stopReason: "completed",
		model: "anthropic/claude-3-7-sonnet",
		summaryText: Array.from({ length: 20 }, (_, i) => `Final response paragraph line ${i + 1}`).join("\n"),
		outputSeal: {
			path: "/tmp/workflows/wf-final-populated/children/0/output.txt",
			sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			bytes: 1234,
		},
		usage: {
			input: 8000,
			output: 2000,
			cacheRead: 1000,
			cacheWrite: 500,
			turns: 5,
			contextTokens: 12000,
			cost: 0.045,
		},
		errorMessage: "Recovered non-fatal diagnostic warning",
		stderr: "Standard error log line 1\nStandard error log line 2",
	};

	let liveTerminalRows = 26;
	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-final-populated",
		initialView: "final",
		terminalRows: () => liveTerminalRows,
		listWorkflows: async () => [
			{
				workflowId: "wf-final-populated",
				taskId: "task-final-populated",
				artifactDir: "/tmp/wf-final-populated",
				schedulerRoot: "/tmp/scheduler",
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
		readChildResult: async () => populatedResultDetails,
	});

	await new Promise((r) => setTimeout(r, 20));

	const lines = inspector.render(100);
	assert.equal(lines.length, 23);
	assert.ok(lines[0]?.includes("╭"));
	assert.ok(lines[22]?.includes("╰"));
	assert.ok(lines[21]?.includes("Esc/← back"));

	assert.ok(lines[19]?.includes("lines 1-7 of 20"));
	assert.ok(lines[19]?.includes("↑/↓ PgUp/PgDn scroll"));
	assert.ok(lines.some((l) => l.includes("Final response paragraph line 1")));
	assert.ok(lines.some((l) => l.includes("Final response paragraph line 7")));
	assert.ok(!lines.some((l) => l.includes("Final response paragraph line 8")));

	inspector.handleInput("\x1b[B");
	const scrolled1 = inspector.render(100);
	assert.equal(scrolled1.length, 23);
	assert.ok(scrolled1[19]?.includes("lines 2-8 of 20"));
	assert.ok(!scrolled1.some((l) => l.includes("Final response paragraph line 1")));
	assert.ok(scrolled1.some((l) => l.includes("Final response paragraph line 2")));
	assert.ok(scrolled1.some((l) => l.includes("Final response paragraph line 8")));

	inspector.handleInput("\x1b[F");
	const atBottom = inspector.render(100);
	assert.equal(atBottom.length, 23);
	assert.ok(atBottom[19]?.includes("lines 14-20 of 20"));
	assert.ok(atBottom.some((l) => l.includes("Final response paragraph line 14")));
	assert.ok(atBottom.some((l) => l.includes("Final response paragraph line 20")));

	liveTerminalRows = 60;
	inspector.handleInput("\x1b[H");
	const tallLines = inspector.render(100);
	assert.equal(tallLines.length, 54);
	assert.ok(tallLines[50]?.includes("lines 1-20 of 20"));
	assert.ok(tallLines.some((l) => l.includes("Final response paragraph line 1")));
	assert.ok(tallLines.some((l) => l.includes("Final response paragraph line 20")));

	inspector.dispose();
});

test("AgentInspector renders numbered task groups, compact ordering cue, and failure diagnostics", async () => {
	const tui = { requestRender: () => {} };
	const done = () => {};
	const dimmedText: string[] = [];
	const theme: InspectorTheme = {
		...plainTheme(),
		fg(color, text) {
			if (color === "dim") dimmedText.push(text);
			return text;
		},
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-inspector-groups",
		workflowId: "wf-inspector-groups",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 2, total: 3 },
		slots: { active: 1, capacity: 4 },
		capturedAt: "2025-01-01T00:06:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				assignment: "owner",
				taskPreview: "orchestrate feature",
				startedAt: "2025-01-01T00:00:05.000Z",
				nestedGroups: [
					{
						groupId: "grp-1-parallel",
						mode: "parallel",
						phase: "grounding",
						createdAt: "2025-01-01T00:01:00.000Z",
						children: [
							{
								groupId: "grp-1-parallel",
								nestedIndex: 0,
								agent: "general-purpose",
								role: "worker",
								taskPreview: "explore code",
								state: "succeeded",
								startedAt: "2025-01-01T00:01:05.000Z",
								endedAt: "2025-01-01T00:02:00.000Z",
								updatedAt: "2025-01-01T00:02:00.000Z",
								live: false,
							},
							{
								groupId: "grp-1-parallel",
								nestedIndex: 1,
								agent: "missing-worker",
								taskPreview: "should be ignored",
								state: "failed",
								errorMessage: "Unknown agent \"missing-worker\". Must be poteto-agent, general-purpose, or comment-sicko.",
								startedAt: "2025-01-01T00:01:05.000Z",
								endedAt: "2025-01-01T00:01:10.000Z",
								updatedAt: "2025-01-01T00:01:10.000Z",
								live: false,
							},
						],
					},
					{
						groupId: "grp-2-sequence",
						mode: "chain",
						phase: "implementation",
						createdAt: "2025-01-01T00:03:00.000Z",
						children: [
							{
								groupId: "grp-2-sequence",
								nestedIndex: 0,
								agent: "general-purpose",
								role: "worker",
								taskPreview: "step 1",
								state: "succeeded",
								startedAt: "2025-01-01T00:03:05.000Z",
								endedAt: "2025-01-01T00:04:00.000Z",
								updatedAt: "2025-01-01T00:04:00.000Z",
								live: false,
							},
							{
								groupId: "grp-2-sequence",
								nestedIndex: 1,
								agent: "general-purpose",
								role: "worker",
								taskPreview: "step 2",
								state: "running",
								activity: "running tests",
								startedAt: "2025-01-01T00:04:05.000Z",
								updatedAt: "2025-01-01T00:05:00.000Z",
								live: true,
							},
						],
					},
				],
				nested: [],
			},
		],
	};

	const workflows: WorkflowSummary[] = [
		{
			workflowId: "wf-inspector-groups",
			taskId: "task-inspector-groups",
			artifactDir: "/tmp/wf-inspector-groups",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	];

	const inspector = new AgentInspector(tui, theme, done, {
		sessionId: "test-sess",
		listWorkflows: async () => workflows,
		getSnapshot: async () => snapshot,
		readOutputTail: async () => ({ content: "", truncated: false, bytesRead: 0, totalBytes: 0 }),
		now: () => new Date("2025-01-01T00:06:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const listLines = inspector.render(120);

	assert.ok(listLines.some((l) => l.includes("↓ new")), "subtitle states chronological direction");
	assert.ok(dimmedText.includes("↓ new"), "subtitle direction cue is dim");
	assert.ok(listLines.some((l) => l.includes("├─ 1 ◐ owner poteto-agent")), "top-level task has a creation ordinal");

	assert.ok(listLines.some((l) => l.includes("├─ parallel · 2 agents · phase grounding")), "parallel group row rendered without an ordinal");
	assert.ok(listLines.some((l) => l.includes("│  ├─ 1 ✓ worker general-purpose")), "parallel child 1 indented under group");
	assert.ok(listLines.some((l) => l.includes("│  └─ 2 ✗ missing-worker")), "parallel child 2 indented under group");

	assert.ok(listLines.some((l) => l.includes("└─ sequence · 2 steps · phase implementation")), "sequence group row rendered");
	assert.ok(listLines.some((l) => l.includes("   ├─ 1 ✓ worker general-purpose")), "sequence step 1 indented under group");
	assert.ok(listLines.some((l) => l.includes("   └─ 2 ◐ worker general-purpose")), "sequence step 2 indented under group");

	assert.ok(
		listLines.some((l) => l.includes("Unknown agent \"missing-worker\"")),
		"failed nested row in list shows errorMessage instead of taskPreview",
	);

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\r");
	await new Promise((r) => setTimeout(r, 20));

	const detailLines = inspector.render(120);
	assert.ok(detailLines.some((l) => l.includes("nested agent: general-purpose (depth 2)")));

	inspector.dispose();
});

test("formatRecentActivity shows all human-readable semantic history without internal tool noise", () => {
	const spawn: JournalEntry = { seq: 1, timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn", agent: "poteto-agent", task: "orchestrate feature", cwd: "/tmp" };
	const tool: JournalEntry = { seq: 2, timestamp: "2025-01-01T00:00:05.000Z", kind: "tool", name: "read", gist: "src/tree.ts" };
	const turn: JournalEntry = { seq: 3, timestamp: "2025-01-01T00:00:10.000Z", kind: "turn", turn: 1, summary: "Read tree sources and planned edit" };
	const phase: JournalEntry = { seq: 4, timestamp: "2025-01-01T00:00:15.000Z", kind: "phase", phase: "integrate", note: "resolving conflicts", blocking: true };
	const exit: JournalEntry = { seq: 5, timestamp: "2025-01-01T00:00:20.000Z", kind: "exit", exitCode: 0 };
	const fail: JournalEntry = { seq: 6, timestamp: "2025-01-01T00:00:25.000Z", kind: "failure", error: "process timed out" };

	assert.equal(formatJournalEntry(spawn), "spawned (poteto-agent)");
	assert.equal(formatJournalEntry(tool), "→ read src/tree.ts");
	assert.equal(formatJournalEntry(turn), "turn 1: Read tree sources and planned edit");
	assert.equal(formatJournalEntry(phase), "integrate: resolving conflicts: [blocking]");
	assert.equal(formatJournalEntry(exit), "completed");
	assert.equal(formatJournalEntry(fail), "failed: process timed out");

	const screenshotRepro: JournalEntry[] = [
		spawn,
		{ seq: 2, timestamp: "2025-01-01T00:00:02.000Z", kind: "turn", turn: 4, summary: "" },
		{ seq: 3, timestamp: "2025-01-01T00:00:03.000Z", kind: "tool", name: "bash", gist: "cd /Users/dma/.dma/worktrees/dstack/example && git diff" },
		{ seq: 4, timestamp: "2025-01-01T00:00:04.000Z", kind: "tool", name: "read", gist: "/Users/dma/.dma/worktrees/dstack/example/extensions/background/journal.ts" },
		{ seq: 5, timestamp: "2025-01-01T00:00:05.000Z", kind: "turn", turn: 5, summary: "" },
		{ seq: 6, timestamp: "2025-01-01T00:00:06.000Z", kind: "turn", turn: 6, summary: "Reviewed the activity history" },
		{ seq: 7, timestamp: "2025-01-01T00:00:07.000Z", kind: "phase", phase: "verify", note: "checking the inspector output" },
	];
	assert.deepEqual(formatRecentActivity(screenshotRepro), [
		"Reviewed the activity history",
		"verify: checking the inspector output",
	]);

	assert.deepEqual(formatRecentActivity([spawn]), []);
	assert.deepEqual(formatRecentActivity([]), []);
	assert.deepEqual(formatRecentActivity(undefined), []);

	const allRelevant: JournalEntry[] = Array.from({ length: 6 }, (_, index) => ({
		seq: index + 1,
		timestamp: `2025-01-01T00:00:0${index + 1}.000Z`,
		kind: "turn",
		turn: index + 1,
		summary: `Completed step ${index + 1}`,
	}));
	assert.deepEqual(formatRecentActivity(allRelevant), [
		"Completed step 1",
		"Completed step 2",
		"Completed step 3",
		"Completed step 4",
		"Completed step 5",
		"Completed step 6",
	]);
});

test("AgentInspector displays Recent Activity and Semantic Status for running depth-1 and depth-2 agents", async () => {
	const status: SemanticStatus = {
		phase: "integrate",
		note: "running integration tests",
		blocking: false,
		updatedAt: "2025-01-01T00:02:00.000Z",
	};

	const snapshot: TreeSnapshot = {
		workflowId: "wf-live-journal",
		taskId: "task-live-journal",
		mode: "single",
		committed: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, total: 1, running: 1, complete: 0 },
		slots: { active: 2, capacity: 4 },
		playbook: "feature",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				startedAt: "2025-01-01T00:00:01.000Z",
				taskPreview: "orchestrate feature development",
				assignment: "owner",
				phase: "integrate",
				status,
				journal: [
					{ seq: 1, timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn", agent: "poteto-agent", task: "orchestrate feature development", cwd: "/tmp" },
					{ seq: 2, timestamp: "2025-01-01T00:01:00.000Z", kind: "tool", name: "read", gist: "src/tree.ts" },
					{ seq: 3, timestamp: "2025-01-01T00:01:30.000Z", kind: "turn", turn: 2, summary: "reviewed tree renderer changes" },
					{ seq: 4, timestamp: "2025-01-01T00:02:00.000Z", kind: "phase", phase: "integrate", note: "running integration tests" },
				],
				activity: {
					text: "integrate: running integration tests",
					updatedAt: "2025-01-01T00:02:00.000Z",
				},
				stale: true,
				nestedGroups: [],
				nested: [
					{
						groupId: "nested-grp-1",
						nestedIndex: 0,
						agent: "general-purpose",
						role: "implementation-worker",
						assignment: "worker",
						taskPreview: "run test suite",
						state: "running",
						startedAt: "2025-01-01T00:01:00.000Z",
						updatedAt: "2025-01-01T00:02:00.000Z",
						live: true,
						journal: [
							{ seq: 1, timestamp: "2025-01-01T00:01:00.000Z", kind: "spawn", agent: "general-purpose", task: "run test suite", cwd: "/tmp" },
							{ seq: 2, timestamp: "2025-01-01T00:01:30.000Z", kind: "tool", name: "bash", gist: "npm test" },
							{ seq: 3, timestamp: "2025-01-01T00:02:00.000Z", kind: "turn", turn: 1, summary: "all 188 tests passed" },
						],
					},
				],
			},
		],
		capturedAt: "2025-01-01T00:05:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess-journal",
		initialTaskId: "task-live-journal",
		listWorkflows: async () => [
			{
				workflowId: "wf-live-journal",
				taskId: "task-live-journal",
				artifactDir: "/tmp/wf-live-journal",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const topDetailLines = inspector.render(100);
	assert.ok(topDetailLines.some((l) => l.includes("Status:") && l.includes("running")));
	assert.ok(topDetailLines.some((l) => l.includes("Phase:") && l.includes("integrate")));
	assert.ok(topDetailLines.some((l) => l.includes("Activity:") && l.includes("integrate: running integration tests")));
	assert.ok(topDetailLines.some((l) => l.includes("⚠ Stale")));
	assert.ok(topDetailLines.some((l) => l.includes("Recent Activity:")));
	assert.ok(topDetailLines.some((l) => l.includes("reviewed tree renderer changes")));
	assert.ok(!topDetailLines.some((l) => l.includes("→ read src/tree.ts")));
	assert.ok(!topDetailLines.some((l) => l.includes("turn 2: reviewed tree renderer changes")));
	assert.ok(topDetailLines.some((l) => l.includes("integrate: running integration tests")));

	inspector.handleInput("\r");
	inspector.handleInput("s");
	const nestedDetailLines = inspector.render(100);
	assert.ok(nestedDetailLines.some((l) => l.includes("nested agent: general-purpose (depth 2)")));
	assert.ok(nestedDetailLines.some((l) => l.includes("Recent Activity:")));
	assert.ok(nestedDetailLines.some((l) => l.includes("all 188 tests passed")));
	assert.ok(!nestedDetailLines.some((l) => l.includes("→ bash npm test")));
	assert.ok(!nestedDetailLines.some((l) => l.includes("turn 1: all 188 tests passed")));

	inspector.dispose();
});

test("AgentInspector does not display Recent Activity for completed agents to preserve outcome behavior", async () => {
	const snapshot: TreeSnapshot = {
		workflowId: "wf-completed",
		taskId: "task-completed",
		mode: "single",
		committed: true,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, total: 1, running: 0, complete: 1 },
		slots: { active: 0, capacity: 4 },
		playbook: "feature",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				startedAt: "2025-01-01T00:00:01.000Z",
				endedAt: "2025-01-01T00:01:00.000Z",
				taskPreview: "finish feature implementation",
				assignment: "owner",
				phase: "review",
				outcome: "All deliverables verified",
				journal: [
					{ seq: 1, timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn", agent: "poteto-agent", task: "finish feature", cwd: "/tmp" },
					{ seq: 2, timestamp: "2025-01-01T00:00:30.000Z", kind: "tool", name: "write", gist: "out.txt" },
					{ seq: 3, timestamp: "2025-01-01T00:01:00.000Z", kind: "exit", exitCode: 0 },
				],
				nestedGroups: [],
				nested: [],
			},
		],
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess-completed",
		initialTaskId: "task-completed",
		listWorkflows: async () => [
			{
				workflowId: "wf-completed",
				taskId: "task-completed",
				artifactDir: "/tmp/wf-completed",
				schedulerRoot: "/tmp/scheduler",
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
		readChildResult: async () => ({
			state: "succeeded",
			exitCode: 0,
			summaryText: "Delivered successfully",
		}),
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("s");
	const lines = inspector.render(100);
	assert.ok(lines.some((l) => l.includes("Status:") && l.includes("succeeded")));
	assert.ok(lines.some((l) => l.includes("Outcome:") && l.includes("All deliverables verified")));
	assert.ok(!lines.some((l) => l.includes("Recent Activity:")));

	inspector.dispose();
});

test("AgentInspector distinguishes pending launches from corrupt workflows", async () => {
	const tui = { requestRender: () => {} };
	const done = () => {};

	const workflows: WorkflowSummary[] = [
		{
			workflowId: "wf-launching-123456",
			taskId: "task-launching",
			artifactDir: "/tmp/wf-launching",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			manifest: { kind: "pending" },
		},
		{
			workflowId: "wf-corrupt-123456",
			taskId: "task-corrupt",
			artifactDir: "/tmp/wf-corrupt",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			manifest: { kind: "corrupt" },
		},
	];

	const inspector = new AgentInspector(tui, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => workflows,
		getSnapshot: async () => undefined,
		now: () => new Date("2025-01-01T00:02:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const lines = inspector.render(100);
	assert.ok(lines.some((l) => l.includes("2 active workflows")));
	assert.ok(lines.some((l) => l.includes("dstack · launching (wf-launc)")));
	assert.ok(lines.some((l) => l.includes("dstack · (unreadable workflow wf-corru)")));

	inspector.handleInput("h");
	const historyLines = inspector.render(100);
	assert.ok(historyLines.some((l) => l.includes("2 active · 2 total")));
	assert.ok(historyLines.some((l) => l.includes("dstack · launching (wf-launc)")));
	assert.ok(historyLines.some((l) => l.includes("dstack · (unreadable workflow wf-corru)")));

	inspector.dispose();
});

test("AgentInspector snapshot refresh and retry transition from pending to ok", async () => {
	const tui = { requestRender: () => {} };
	const done = () => {};

	let currentWorkflows: WorkflowSummary[] = [
		{
			workflowId: "wf-transition-1",
			taskId: "task-transition-1",
			artifactDir: "/tmp/wf-transition-1",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			manifest: { kind: "pending" },
		},
	];

	let snapshotReturned: TreeSnapshot | undefined = undefined;

	const inspector = new AgentInspector(tui, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => currentWorkflows,
		getSnapshot: async () => snapshotReturned,
		now: () => new Date("2025-01-01T00:02:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const initialLines = inspector.render(100);
	assert.ok(initialLines.some((l) => l.includes("dstack · launching (wf-trans)")));
	assert.ok(initialLines.some((l) => l.includes("1 active workflow")));

	currentWorkflows = [
		{
			workflowId: "wf-transition-1",
			taskId: "task-transition-1",
			artifactDir: "/tmp/wf-transition-1",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
		},
	];
	snapshotReturned = {
		taskId: "task-transition-1",
		workflowId: "wf-transition-1",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", role: "feature", assignment: "owner", taskPreview: "owner task", nestedGroups: [], nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	await (inspector as unknown as { poll: () => Promise<void> }).poll();

	const refreshedLines = inspector.render(100);
	assert.ok(refreshedLines.some((l) => l.includes("dstack · feature · 0/1 done")));
	assert.ok(refreshedLines.some((l) => l.includes("owner poteto-agent")));
	assert.ok(refreshedLines.some((l) => l.includes("1 active workflow")));

	inspector.dispose();
});

test("tailSessionFile handles partial lines, truncation, identity replacement, and caps", async (t) => {
	const dir = await temporaryDirectory(t);
	const sessionFile = join(dir, "test.jsonl");

	const state = createSessionTailState();

	await writeFile(sessionFile, '{"type":"session","id":"sess-1"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n', "utf8");
	const res1 = await tailSessionFile(state, sessionFile);
	assert.equal(res1.changed, true);
	assert.equal(state.records.length, 2);

	const res2 = await tailSessionFile(state, sessionFile);
	assert.equal(res2.changed, false);
	assert.equal(state.records.length, 2);

	const { appendFile } = await import("node:fs/promises");
	await appendFile(sessionFile, '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"incomp', "utf8");
	const resPartial = await tailSessionFile(state, sessionFile);
	assert.equal(resPartial.changed, false);
	assert.equal(state.records.length, 2);
	assert.ok(state.partial.length > 0);

	await appendFile(sessionFile, 'lete"}]}}\n', "utf8");
	const resComplete = await tailSessionFile(state, sessionFile);
	assert.equal(resComplete.changed, true);
	assert.equal(state.records.length, 3);
	assert.equal(state.partial.length, 0);

	await writeFile(sessionFile, '{"type":"session","id":"sess-reset"}\n', "utf8");
	const resTrunc = await tailSessionFile(state, sessionFile);
	assert.equal(resTrunc.changed, true);
	assert.equal(state.records.length, 1);
	assert.equal(state.records[0]?.id, "sess-reset");

	const stateCapped = createSessionTailState();
	const lines = Array.from({ length: 50 }, (_, i) => `{"type":"message","id":"${i}"}\n`).join("");
	await writeFile(sessionFile, lines, "utf8");
	await tailSessionFile(stateCapped, sessionFile, { maxRecords: 10 });
	assert.equal(stateCapped.records.length, 10);
	assert.equal(stateCapped.records[0]?.id, "40");
	assert.equal(stateCapped.records[9]?.id, "49");
});

test("AgentInspector opens summary by default and follows running conversation", async (t) => {
	const dir = await temporaryDirectory(t);
	const sessionFile = join(dir, "live.jsonl");

	const sessionRecord: ChildSessionRefV1 = {
		schemaVersion: "dstack.child-session.v1",
		sessionId: "sess-live",
		sessionFile,
		sessionDir: dir,
		createdAt: "2025-01-01T00:00:00.000Z",
	};

	await writeFile(
		sessionFile,
		[
			'{"type":"session","version":3,"id":"sess-live"}',
			'{"type":"message","message":{"role":"user","content":"Please implement feature X"}}',
			'{"type":"message","message":{"role":"assistant","model":"claude-3-7-sonnet","content":[{"type":"thinking","thinking":"Analyzing codebase..."},{"type":"text","text":"I will begin now."},{"type":"toolCall","name":"read","arguments":{"path":"src/index.ts"}}]}}',
			'{"type":"message","message":{"role":"toolResult","toolName":"read","content":[{"type":"text","text":"export const x = 1;"}],"isError":false}}',
		].join("\n") + "\n",
		"utf8",
	);

	const snapshot: TreeSnapshot = {
		taskId: "task-live-conv",
		workflowId: "wf-live-conv",
		mode: "single",
		committed: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				taskPreview: "implement feature X",
				session: sessionRecord,
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-live-conv",
		listWorkflows: async () => [
			{
				workflowId: "wf-live-conv",
				taskId: "task-live-conv",
				artifactDir: dir,
				schedulerRoot: dir,
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z", playbook: "feature" },
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 30));

	const summaryLines = inspector.render(100);
	assert.ok(summaryLines.some((l) => l.includes("Summary")));
	assert.ok(summaryLines.some((l) => l.includes("Agent:")));
	assert.ok(summaryLines.some((l) => l.includes("implement feature X")));

	inspector.handleInput("c");
	const convLines = inspector.render(100);
	assert.ok(convLines.some((l) => l.includes("Conversation")));
	assert.ok(convLines.some((l) => l.includes("User")));
	assert.ok(convLines.some((l) => l.includes("Please implement feature X")));
	assert.ok(convLines.some((l) => l.includes("Assistant")));
	assert.ok(convLines.some((l) => l.includes("Analyzing codebase")));
	assert.ok(convLines.some((l) => l.includes("I will begin now.")));
	assert.ok(convLines.some((l) => l.includes("read")));

	inspector.handleInput("\x1b[A");
	const scrolledUp = inspector.render(100);
	assert.ok(scrolledUp.some((l) => l.includes("User")));

	inspector.handleInput("\x1b[F");
	const followedAgain = inspector.render(100);
	assert.ok(followedAgain.some((l) => l.includes("Conversation")));

	inspector.dispose();
});

test("AgentInspector offers resume and fork actions for completed sessions", async (t) => {
	const dir = await temporaryDirectory(t);
	const sessionFile = join(dir, "completed.jsonl");

	const sessionRecord: ChildSessionRefV1 = {
		schemaVersion: "dstack.child-session.v1",
		sessionId: "sess-done",
		sessionFile,
		sessionDir: dir,
		createdAt: "2025-01-01T00:00:00.000Z",
	};

	await writeFile(
		sessionFile,
		'{"type":"session","version":3,"id":"sess-done"}\n{"type":"message","message":{"role":"user","content":"Task done"}}\n',
		"utf8",
	);

	const snapshot: TreeSnapshot = {
		taskId: "task-done-action",
		workflowId: "wf-done-action",
		mode: "single",
		committed: true,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "succeeded",
				taskPreview: "done task",
				cwd: "/tmp/working-dir",
				session: sessionRecord,
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	let resumeAction: AgentInspectorResult | undefined;
	const inspectorResume = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		(res) => {
			resumeAction = res;
		},
		{
			sessionId: "test-sess",
			initialTaskId: "task-done-action",
			listWorkflows: async () => [
				{
					workflowId: "wf-done-action",
					taskId: "task-done-action",
					artifactDir: dir,
					schedulerRoot: dir,
					committed: true,
					createdAt: "2025-01-01T00:00:00.000Z",
					manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z" },
				},
			],
			getSnapshot: async () => snapshot,
		},
	);

	await new Promise((r) => setTimeout(r, 30));
	inspectorResume.handleInput("u");
	assert.deepEqual(resumeAction, { action: "resume", sessionFile });
	inspectorResume.dispose();

	let forkAction: AgentInspectorResult | undefined;
	const inspectorFork = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		(res) => {
			forkAction = res;
		},
		{
			sessionId: "test-sess",
			initialTaskId: "task-done-action",
			listWorkflows: async () => [
				{
					workflowId: "wf-done-action",
					taskId: "task-done-action",
					artifactDir: dir,
					schedulerRoot: dir,
					committed: true,
					createdAt: "2025-01-01T00:00:00.000Z",
					manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z" },
				},
			],
			getSnapshot: async () => snapshot,
		},
	);

	await new Promise((r) => setTimeout(r, 30));
	inspectorFork.handleInput("k");
	assert.deepEqual(forkAction, { action: "fork", sessionFile, cwd: "/tmp/working-dir" });
	inspectorFork.dispose();
});

test("AgentInspector does not offer resume/fork actions for running agents", async (t) => {
	const dir = await temporaryDirectory(t);
	const sessionFile = join(dir, "running.jsonl");

	const sessionRecord: ChildSessionRefV1 = {
		schemaVersion: "dstack.child-session.v1",
		sessionId: "sess-running",
		sessionFile,
		sessionDir: dir,
		createdAt: "2025-01-01T00:00:00.000Z",
	};

	await writeFile(sessionFile, '{"type":"session","version":3,"id":"sess-running"}\n', "utf8");

	const snapshot: TreeSnapshot = {
		taskId: "task-running-no-action",
		workflowId: "wf-running-no-action",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "running",
				taskPreview: "running task",
				session: sessionRecord,
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	let actionCalled = false;
	const inspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {
			actionCalled = true;
		},
		{
			sessionId: "test-sess",
			initialTaskId: "task-running-no-action",
			listWorkflows: async () => [
				{
					workflowId: "wf-running-no-action",
					taskId: "task-running-no-action",
					artifactDir: dir,
					schedulerRoot: dir,
					committed: false,
					createdAt: "2025-01-01T00:00:00.000Z",
					manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z" },
				},
			],
			getSnapshot: async () => snapshot,
		},
	);

	await new Promise((r) => setTimeout(r, 30));
	inspector.handleInput("u");
	inspector.handleInput("k");
	assert.equal(actionCalled, false);
	inspector.dispose();
});

test("AgentInspector caches committed snapshots and passes activeLeases once per tick", async () => {
	let snapshotCalls = 0;
	let lastActiveLeases: readonly LeaseSnapshot[] | undefined;

	const committedSnapshot: TreeSnapshot = {
		taskId: "task-cached",
		workflowId: "wf-cached",
		mode: "single",
		committed: true,
		createdAt: "2025-01-01T00:00:00.000Z",
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "succeeded",
				taskPreview: "done task",
				nestedGroups: [],
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const workflows: WorkflowSummary[] = [
		{
			workflowId: "wf-cached",
			taskId: "task-cached",
			artifactDir: "/tmp/wf-cached",
			schedulerRoot: "/tmp/scheduler",
			committed: true,
			createdAt: "2025-01-01T00:00:00.000Z",
			manifest: { kind: "ok", createdAt: "2025-01-01T00:00:00.000Z" },
		},
	];

	const inspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => workflows,
			getSnapshot: async (input) => {
				snapshotCalls++;
				lastActiveLeases = input.activeLeases;
				return committedSnapshot;
			},
			pollIntervalMs: 20,
		},
	);

	await new Promise((r) => setTimeout(r, 30));
	assert.equal(snapshotCalls, 1);
	assert.ok(lastActiveLeases !== undefined);

	await new Promise((r) => setTimeout(r, 60));
	assert.equal(snapshotCalls, 1);
	inspector.dispose();
});

test("listSessionWorkflows caches immutable manifests and bindings, and observes active-to-committed transitions", async (t) => {
	const home = await temporaryDirectory(t);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = previousHome;
	});

	const sessionId = "scale-test-session";
	const cache = createWorkflowListCache();
	const sRoot = join(home, ".pi", "agent", "dstack", "background", encodeURIComponent(sessionId));
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-1"), { recursive: true });

	await writeFile(
		join(sRoot, "bindings", "task-1.json"),
		JSON.stringify({ taskId: "task-1", workflowId: "wf-1" }),
		"utf8",
	);

	await writeFile(
		join(sRoot, "workflows", "wf-1", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-1",
			mode: "single",
			createdAt: "2025-01-01T00:00:00.000Z",
			specs: [{ agent: "poteto-agent", task: "first task", workflow: { assignment: "owner", playbook: "feature" } }],
		}),
		"utf8",
	);
	await writeFile(join(sRoot, "workflows", "wf-1", "COMMITTED"), "{}", "utf8");

	let readdirCalls = 0;
	let readFileCalls = 0;
	const io: ListSessionWorkflowsIO = {
		stat,
		async readdir(path) {
			readdirCalls++;
			return readdir(path);
		},
		async readFile(path, encoding) {
			readFileCalls++;
			return readFile(path, encoding);
		},
	};

	const list1 = await listSessionWorkflows(sessionId, cache, io);
	assert.equal(list1.length, 1);
	assert.equal(list1[0]?.workflowId, "wf-1");
	assert.equal(list1[0]?.committed, true);

	const initialReaddirs = readdirCalls;
	const initialReadFiles = readFileCalls;

	const list1Unchanged = await listSessionWorkflows(sessionId, cache, io);
	assert.equal(list1Unchanged.length, 1);
	assert.equal(readdirCalls, initialReaddirs);
	assert.equal(readFileCalls, initialReadFiles);

	await writeFile(join(sRoot, "workflows", "wf-1", "manifest.json"), "invalid json", "utf8");

	await mkdir(join(sRoot, "workflows", "wf-2"), { recursive: true });
	await writeFile(
		join(sRoot, "bindings", "task-2.json"),
		JSON.stringify({ taskId: "task-2", workflowId: "wf-2" }),
		"utf8",
	);
	await writeFile(
		join(sRoot, "workflows", "wf-2", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-2",
			mode: "parallel",
			createdAt: "2025-01-01T00:01:00.000Z",
			specs: [{ agent: "general-purpose", task: "active task", workflow: { assignment: "worker", playbook: "feature" } }],
		}),
		"utf8",
	);

	const list2 = await listSessionWorkflows(sessionId, cache, io);
	assert.equal(list2.length, 2);
	assert.equal(list2[0]?.workflowId, "wf-1");
	assert.equal(list2[0]?.committed, true);
	assert.equal(list2[0]?.manifest.kind, "ok");
	assert.equal(list2[1]?.workflowId, "wf-2");
	assert.equal(list2[1]?.committed, false);

	await writeFile(join(sRoot, "workflows", "wf-2", "COMMITTED"), "{}", "utf8");
	const list3 = await listSessionWorkflows(sessionId, cache, io);
	assert.equal(list3.length, 2);
	assert.equal(list3[1]?.workflowId, "wf-2");
	assert.equal(list3[1]?.committed, true);

	const readdirsBeforeCorrupt = readdirCalls;
	const readFilesBeforeCorrupt = readFileCalls;
	await writeFile(join(sRoot, "workflows", "wf-2", "manifest.json"), "invalid json", "utf8");
	const list4 = await listSessionWorkflows(sessionId, cache, io);
	assert.equal(list4[1]?.workflowId, "wf-2");
	assert.equal(list4[1]?.committed, true);
	assert.equal(list4[1]?.manifest.kind, "ok");
	assert.equal(readdirCalls, readdirsBeforeCorrupt);
	assert.equal(readFileCalls, readFilesBeforeCorrupt);
});

test("tailSessionFile returns changed=true on empty replacement and partial replacement reset", async (t) => {
	const dir = await temporaryDirectory(t);
	const sessionFile = join(dir, "replace-test.jsonl");
	const state = createSessionTailState();

	await writeFile(
		sessionFile,
		'{"type":"session","id":"sess-init"}\n{"type":"message","message":{"role":"user","content":"start"}}\n',
		"utf8",
	);
	const res1 = await tailSessionFile(state, sessionFile);
	assert.equal(res1.changed, true);
	assert.equal(state.records.length, 2);

	await writeFile(sessionFile, "", "utf8");
	const resEmpty = await tailSessionFile(state, sessionFile);
	assert.equal(resEmpty.changed, true);
	assert.equal(state.records.length, 0);
	assert.equal(state.offset, 0);
	assert.equal(state.partial.length, 0);

	await writeFile(sessionFile, '{"type":"session","id":"sess-rep"}\n', "utf8");
	const resRep = await tailSessionFile(state, sessionFile);
	assert.equal(resRep.changed, true);
	assert.equal(state.records.length, 1);

	await writeFile(sessionFile, '{"type":"partial"', "utf8");
	const resPartial = await tailSessionFile(state, sessionFile);
	assert.equal(resPartial.changed, true);
	assert.equal(state.records.length, 0);
	assert.ok(state.partial.length > 0);

	const { appendFile } = await import("node:fs/promises");
	await appendFile(sessionFile, ',"msg":"continued"}\n', "utf8");
	const resComplete = await tailSessionFile(state, sessionFile);
	assert.equal(resComplete.changed, true);
	assert.equal(state.records.length, 1);
	assert.equal(state.partial.length, 0);
});

test("tailSessionFile incrementally advances offset with byte-bounded chunks and stored-record byte caps", async (t) => {
	const dir = await temporaryDirectory(t);
	const sessionFile = join(dir, "bounded-tail.jsonl");
	const state = createSessionTailState();

	const lines = Array.from({ length: 5 }, (_, i) => {
		const payload = "x".repeat(80);
		return JSON.stringify({ type: "message", index: i, payload }) + "\n";
	});
	await writeFile(sessionFile, lines.join(""), "utf8");

	const lineByteLen = Buffer.byteLength(lines[0]!, "utf8");
	const totalBytes = lineByteLen * 5;

	const maxBytesPerCall = lineByteLen * 2 + 10;
	const resCall1 = await tailSessionFile(state, sessionFile, { maxBytesPerCall });
	assert.equal(resCall1.changed, true);
	assert.equal(state.records.length, 2);
	assert.equal(state.offset, maxBytesPerCall);
	assert.equal(state.partial.length, 10);

	const resCall2 = await tailSessionFile(state, sessionFile, { maxBytesPerCall });
	assert.equal(resCall2.changed, true);
	assert.equal(state.records.length, 4);
	assert.equal(state.offset, maxBytesPerCall * 2);
	assert.equal(state.partial.length, 20);

	const resCall3 = await tailSessionFile(state, sessionFile, { maxBytesPerCall });
	assert.equal(resCall3.changed, true);
	assert.equal(state.records.length, 5);
	assert.equal(state.offset, totalBytes);
	assert.equal(state.partial.length, 0);

	const stateByteCapped = createSessionTailState();
	await tailSessionFile(stateByteCapped, sessionFile, { maxRecordBytes: lineByteLen * 2 + 10 });
	assert.ok(stateByteCapped.records.length <= 3);
	assert.ok(stateByteCapped.totalRecordBytes <= lineByteLen * 2 + 10);
});
