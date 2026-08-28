import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dstack from "../extensions/dstack.ts";
import { commitWorkflowResult, parseWorkflowManifest } from "../extensions/background/runner.ts";
import { createLocalSlotAcquirer, executeWorkflow, DSTACK_ARTIFACT_DIR_ENV, DSTACK_CHILD_INDEX_ENV, ROOT_WORKFLOW_ENV, SCHEDULER_ROOT_ENV } from "../extensions/background/workflow.ts";
import { parseSpawnRecordV1, STALE_ACTIVITY_THRESHOLD_MS } from "../extensions/background/tree.ts";
import { formatStaleWakePrompt, restoreFiredStaleWakes, shouldTriggerCompletionWake, shouldTriggerStaleWake } from "../extensions/task-registry.ts";
import { classifyFailure, MAX_OWNER_ATTEMPTS, nextRecoveryAction, type RecoveryLineage } from "../extensions/background/recovery.ts";
import { acquireChildSlot, snapshotActiveLeases } from "../extensions/background/scheduler.ts";
import { toAbsolutePath } from "../extensions/background/artifacts.ts";

const RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const REQUEST_CHANNEL = "pi-background-tasks:request:v1";

function response(requestId: string, operation: string, result: unknown) {
	return {
		schema_version: "pi-background-tasks.extension-response.v1",
		request_id: requestId,
		operation,
		ok: true,
		result,
	};
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function testRuntime(events: ReturnType<typeof createEventBus>) {
	const tools = new Map<string, {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean; usage?: unknown }>;
		renderResult?: (
			result: { content: Array<{ type: string; text?: string }>; isError: boolean; details?: unknown },
			options: { expanded: boolean; isPartial?: boolean },
			theme?: unknown,
		) => { render: (width: number) => string[] };
	}>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
	const shortcuts = new Map<string, { description: string; handler: (ctx: unknown) => Promise<unknown> }>();
	const entryRenderers = new Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const widgets: string[] = [];
	let customOverlayOpened = 0;
	let lastOverlayOptions: unknown;
	const pi = {
		events,
		registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
		registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
			commands.set(name, def);
		},
		registerShortcut(key: string, def: { description: string; handler: (ctx: unknown) => Promise<unknown> }) {
			shortcuts.set(key, def);
		},
		registerEntryRenderer(type: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown) {
			entryRenderers.set(type, renderer);
		},
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
		sendMessage(message: unknown, options?: unknown) {
			sentMessages.push({ message, options });
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	dstack(pi);
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			setStatus() {},
			setWidget(name: string, content?: unknown) {
				if (content === undefined) {
					const idx = widgets.indexOf(name);
					if (idx >= 0) widgets.splice(idx, 1);
				} else if (!widgets.includes(name)) {
					widgets.push(name);
				}
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			async custom(factory: (...args: unknown[]) => { render: (w: number) => string[]; dispose?: () => void }, options: unknown) {
				customOverlayOpened++;
				lastOverlayOptions = options;
				const done = (_res: unknown) => {};
				const component = factory(
					{
						requestRender: () => {},
						terminal: { rows: 40, columns: 120 },
					},
					{ fg: (_: string, t: string) => t },
					{},
					done,
				);
				if (typeof component === "object" && component !== null && "dispose" in component && typeof component.dispose === "function") {
					component.dispose();
				}
				return "closed";
			},
		},
		sessionManager: {
			getBranch: (): unknown[] => [],
			getSessionId: () => "public-tools-session",
		},
		modelRegistry: { getAvailable: () => [] },
	};
	return {
		tools,
		handlers,
		commands,
		shortcuts,
		entryRenderers,
		entries,
		notifications,
		sentMessages,
		widgets,
		getCustomOverlayOpened: () => customOverlayOpened,
		getLastOverlayOptions: () => lastOverlayOptions,
		ctx,
	};
}

test("root task returns a receipt before the runner completes and dstack_result projects running and ordered completion", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-public-tools-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	process.env.HOME = home;
	delete process.env.DSTACK_NESTING;
	delete process.env.DSTACK_ASSIGNMENT;
	const configPath = join(home, ".pi", "agent", "dstack", "models.json");
	await mkdir(join(home, ".pi", "agent", "dstack"), { recursive: true });
	await writeFile(configPath, JSON.stringify({
		roles: {
			feature: "google/gemini-3.7-flash",
			"arena-runners": ["provider/one", "provider/two", "provider/three"],
			"architect-runners": ["provider/architect"],
		},
	}), "utf8");
	t.after(() => {
		process.env.HOME = previousHome;
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
	});

	const events = createEventBus();
	let task = {
		id: "bg-public-tools",
		name: "dstack",
		command: "runner",
		status: "running" as "running" | "completed",
		outputPath: join(home, "companion-output.txt"),
	};
	const stop = events.on(REQUEST_CHANNEL, (raw) => {
		if (typeof raw !== "object" || raw === null || !("request_id" in raw) || !("operation" in raw)) return;
		const requestId = String(raw.request_id);
		const operation = String(raw.operation);
		if (operation === "capabilities") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, {
				api_version: 1,
				run: true,
				run_is_agent: true,
				run_completion_trigger: true,
				status: true,
				logs: true,
				logs_bounded: true,
				kill: true,
			}));
		} else if (operation === "run") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, task));
		} else if (operation === "status") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, { tasks: [task] }));
		}
	});
	t.after(stop);

	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);
	const taskTool = runtime.tools.get("dstack_task");
	const resultTool = runtime.tools.get("dstack_result");
	assert.ok(taskTool);
	assert.ok(resultTool);

	const receiptResult = await taskTool.execute("root-call", {
		tasks: [
			{ agent: "general-purpose", task: "first" },
			{ agent: "comment-sicko", task: "second" },
		],
	}, undefined, undefined, runtime.ctx);
	const receipt = receiptResult.details as { taskId: string; workflowId: string; mode: string; childCount: number; resultTool: string };
	assert.deepEqual(receipt, {
		taskId: "bg-public-tools",
		workflowId: receipt.workflowId,
		mode: "parallel",
		childCount: 2,
		resultTool: "dstack_result",
	});

	const running = await resultTool.execute("result-running", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
	assert.deepEqual(running.details, {
		kind: "running",
		taskId: receipt.taskId,
		progress: { queued: 2, running: 0, complete: 0, total: 2 },
	});

	const artifactDir = join(home, ".pi", "agent", "dstack", "background", "public-tools-session", "workflows", receipt.workflowId);
	const manifestBytes = await readFile(join(artifactDir, "manifest.json"));
	const manifest = parseWorkflowManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	const index = await executeWorkflow(manifest, manifestSha256, new AbortController().signal, {
		slots: createLocalSlotAcquirer(2),
		spawnChild: async ({ args }) => ({
			text: `done:${args.at(-1)?.slice(6)}`,
			exitCode: 0,
			stderr: "",
			messages: [],
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.025, contextTokens: 18, turns: 1 },
		}),
	});
	await commitWorkflowResult(manifest, index);
	task = { ...task, status: "completed" };

	const completed = await resultTool.execute("result-complete", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
	assert.equal((completed.details as { kind: string }).kind, "complete");
	assert.deepEqual(
		(completed.details as { package: { results: Array<{ summary: string }> } }).package.results.map((item) => item.summary),
		["done:first", "done:second"],
	);
	const completedJson = completed.content[0]?.type === "text" ? completed.content[0].text : "";
	assert.ok(!completedJson.includes('"task"'));
	assert.ok(!completedJson.includes('"journal"'));
	assert.ok(!completedJson.includes('"usage"'));
	assert.ok(!completedJson.includes('"model"'));
	assert.ok(!completedJson.includes('"cwd"'));
	assert.ok(!completedJson.includes('"messages"'));
	assert.ok(!completedJson.includes('"fullOutput"'));
	assert.ok(!completedJson.includes('"stderr"'));
	assert.ok(!completedJson.includes('"stopReason"'));
	assert.ok(!completedJson.includes('"status"'));
	assert.deepEqual(JSON.parse(completedJson), {
		kind: "complete",
		taskId: receipt.taskId,
		detail: "summary",
		package: {
			mode: "parallel",
			results: [
				{ agent: "general-purpose", summary: "done:first", exitCode: 0 },
				{ agent: "comment-sicko", summary: "done:second", exitCode: 0 },
			],
		},
	});

	const fullCompleted = await resultTool.execute(
		"result-complete-full",
		{ taskId: receipt.taskId, detail: "full" },
		undefined,
		undefined,
		runtime.ctx,
	);
	assert.equal((fullCompleted.details as { kind: string }).kind, "complete");
	assert.deepEqual(
		(fullCompleted.details as { package: { results: Array<{ task: string }> } }).package.results.map((item) => item.task),
		["first", "second"],
	);
	const fullCompletedJson = fullCompleted.content[0]?.type === "text" ? fullCompleted.content[0].text : "";
	const parsedFull = JSON.parse(fullCompletedJson);
	assert.equal(parsedFull.kind, "complete");
	assert.equal(parsedFull.detail, "full");
	assert.equal(parsedFull.package.results[0].task, "first");
	assert.equal(parsedFull.package.results[0].cwd, process.cwd());
	assert.deepEqual(parsedFull.package.results[0].usage, {
		input: 10,
		output: 5,
		cacheRead: 2,
		cacheWrite: 1,
		cost: 0.025,
		contextTokens: 18,
		turns: 1,
	});
	assert.deepEqual(completed.usage, {
		input: 20,
		output: 10,
		cacheRead: 4,
		cacheWrite: 2,
		totalTokens: 36,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
	});

	const repeated = await resultTool.execute("result-repeat", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
	assert.equal(repeated.usage, undefined);

	const reloadedRuntime = testRuntime(events);
	await reloadedRuntime.handlers.get("session_start")?.({}, reloadedRuntime.ctx);
	const reloadedResult = await reloadedRuntime.tools.get("dstack_result")?.execute(
		"result-after-reload",
		{ taskId: receipt.taskId },
		undefined,
		undefined,
		reloadedRuntime.ctx,
	);
	assert.equal(reloadedResult?.usage, undefined);

	const featureResult = await taskTool.execute(
		"feature-call",
		{
			agent: "poteto-agent",
			task: "feature task",
			role: "feature",
			workflow: { playbook: "feature", assignment: "owner", phase: "run", completedPhases: [], artifacts: [] },
		},
		undefined,
		undefined,
		runtime.ctx,
	);
	assert.notEqual(featureResult.isError, true);
	const featureReceipt = featureResult.details as { workflowId: string };
	const featureManifest = JSON.parse(await readFile(
		join(home, ".pi", "agent", "dstack", "background", "public-tools-session", "workflows", featureReceipt.workflowId, "manifest.json"),
		"utf8",
	)) as { specs: Array<{ model?: string; requestedRole?: string; workflow?: { assignment: string }; systemPrompt?: string }> };
	assert.equal(featureManifest.specs[0]?.model, "google/gemini-3.7-flash");
	assert.equal(featureManifest.specs[0]?.requestedRole, "feature");
	assert.equal(featureManifest.specs[0]?.workflow?.assignment, "owner");
	assert.match(featureManifest.specs[0]?.systemPrompt ?? "", /task owner.*playbooks\/feature\.md/s);

	const arenaResult = await taskTool.execute(
		"arena-call",
		{
			tasks: ["one", "two", "three"].map((name) => ({
				agent: "general-purpose",
				task: `arena ${name}`,
				role: "arena-runners",
			})),
		},
		undefined,
		undefined,
		runtime.ctx,
	);
	assert.notEqual(arenaResult.isError, true);
	const arenaReceipt = arenaResult.details as { workflowId: string };
	const arenaManifest = JSON.parse(await readFile(
		join(home, ".pi", "agent", "dstack", "background", "public-tools-session", "workflows", arenaReceipt.workflowId, "manifest.json"),
		"utf8",
	)) as { specs: Array<{ model?: string; requestedRole?: string; roleIndex?: number }> };
	assert.deepEqual(arenaManifest.specs.map((spec) => spec.model), ["provider/one", "provider/two", "provider/three"]);
	assert.deepEqual(arenaManifest.specs.map((spec) => spec.requestedRole), ["arena-runners", "arena-runners", "arena-runners"]);
	assert.deepEqual(arenaManifest.specs.map((spec) => spec.roleIndex), [0, 1, 2]);

	const unknownRole = await taskTool.execute(
		"unknown-role-call",
		{ agent: "general-purpose", task: "must fail", role: "architect runners" },
		undefined,
		undefined,
		runtime.ctx,
	);
	assert.equal(unknownRole.isError, true);
	assert.equal(unknownRole.content[0]?.text, 'Unknown role "architect runners". Did you mean "architect-runners"?');
	await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
	assert.deepEqual(runtime.widgets, []);
});

test("depth 1 returns immediate receipt and inspection via dstack_result", async () => {
	const events = createEventBus();
	let backgroundRequests = 0;
	const stop = events.on(REQUEST_CHANNEL, () => { backgroundRequests += 1; });
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);
	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	const previousRootWorkflow = process.env[ROOT_WORKFLOW_ENV];
	const previousArtifactDir = process.env[DSTACK_ARTIFACT_DIR_ENV];
	const previousChildIndex = process.env[DSTACK_CHILD_INDEX_ENV];
	const previousSchedulerRoot = process.env[SCHEDULER_ROOT_ENV];

	process.env.DSTACK_NESTING = "1";
	delete process.env.DSTACK_ASSIGNMENT;
	delete process.env[ROOT_WORKFLOW_ENV];
	delete process.env[DSTACK_ARTIFACT_DIR_ENV];
	delete process.env[DSTACK_CHILD_INDEX_ENV];
	delete process.env[SCHEDULER_ROOT_ENV];

	try {
		const result = await runtime.tools.get("dstack_task")?.execute(
			"nested-call",
			{ agent: "missing-agent", task: "fail asynchronously" },
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(result?.isError, false);
		const receipt = result?.details as { taskId: string; mode: string };
		assert.ok(receipt?.taskId);
		assert.equal(backgroundRequests, 0);

		const resultTool = runtime.tools.get("dstack_result");
		assert.ok(resultTool);

		await waitUntil(async () => {
			const res = await resultTool.execute("res-check", { taskId: receipt.taskId, detail: "summary" }, undefined, undefined, runtime.ctx);
			const details = res.details as { kind: string };
			return details?.kind === "runner_failed" || details?.kind === "complete";
		});

		const res = await resultTool.execute("res-check", { taskId: receipt.taskId, detail: "summary" }, undefined, undefined, runtime.ctx);
		const details = res.details as { kind: string; package?: { results: Array<{ exitCode: number; errorMessage?: string }> } };
		assert.equal(details.kind, "complete");
		assert.match(details.package?.results[0]?.errorMessage ?? "", /Unknown agent/);
	} finally {
		stop();
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
		if (previousRootWorkflow === undefined) delete process.env[ROOT_WORKFLOW_ENV];
		else process.env[ROOT_WORKFLOW_ENV] = previousRootWorkflow;
		if (previousArtifactDir === undefined) delete process.env[DSTACK_ARTIFACT_DIR_ENV];
		else process.env[DSTACK_ARTIFACT_DIR_ENV] = previousArtifactDir;
		if (previousChildIndex === undefined) delete process.env[DSTACK_CHILD_INDEX_ENV];
		else process.env[DSTACK_CHILD_INDEX_ENV] = previousChildIndex;
		if (previousSchedulerRoot === undefined) delete process.env[SCHEDULER_ROOT_ENV];
		else process.env[SCHEDULER_ROOT_ENV] = previousSchedulerRoot;
	}
});

test("depth-1 nested dstack_task writes spawn record with parentage and phase when env vars are present", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dstack-nested-spawn-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const artifactDir = join(cwd, "artifacts");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(artifactDir, { recursive: true });
	await mkdir(schedulerRoot, { recursive: true });

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	const previousRootWf = process.env[ROOT_WORKFLOW_ENV];
	const previousSchedRoot = process.env[SCHEDULER_ROOT_ENV];
	const previousChildIdx = process.env[DSTACK_CHILD_INDEX_ENV];
	const previousArtifactDir = process.env[DSTACK_ARTIFACT_DIR_ENV];

	process.env.DSTACK_NESTING = "1";
	process.env.DSTACK_ASSIGNMENT = "owner";
	process.env[ROOT_WORKFLOW_ENV] = "wf-nested-test";
	process.env[SCHEDULER_ROOT_ENV] = schedulerRoot;
	process.env[DSTACK_CHILD_INDEX_ENV] = "0";
	process.env[DSTACK_ARTIFACT_DIR_ENV] = artifactDir;

	try {
		const res = await runtime.tools.get("dstack_task")?.execute(
			"nested-call",
			{
				agent: "missing-agent",
				task: "nested worker brief with full multiline\ninstruction content",
				cwd,
				tools: "read,write",
				model: "anthropic/claude-3-5-sonnet",
				workflow: {
					playbook: "feature",
					assignment: "worker",
					phase: "implement",
					completedPhases: ["ground"],
					artifacts: [{ name: "ground-doc", path: "/tmp/ground.md", sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }],
				},
			},
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(res?.isError, false);
		const receipt = res?.details as { taskId: string };
		assert.ok(receipt?.taskId);

		const spawnsDir = join(artifactDir, "children", "0", "spawns");
		await waitUntil(async () => {
			try {
				const files = (await readdir(spawnsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
				return files.length === 1;
			} catch {
				return false;
			}
		});

		const files = (await readdir(spawnsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
		assert.equal(files.length, 1);
		await waitUntil(async () => {
			try {
				const raw = await readFile(join(spawnsDir, files[0]!), "utf8");
				const spawnRecord = parseSpawnRecordV1(JSON.parse(raw));
				return spawnRecord?.children[0]?.state === "failed";
			} catch {
				return false;
			}
		});

		const raw = await readFile(join(spawnsDir, files[0]!), "utf8");
		const spawnRecord = parseSpawnRecordV1(JSON.parse(raw));
		assert.ok(spawnRecord !== undefined);
		assert.equal(spawnRecord.workflowId, "wf-nested-test");
		assert.equal(spawnRecord.parentIndex, 0);
		assert.equal(spawnRecord.phase, "implement");
		assert.equal(spawnRecord.children.length, 1);

		const child = spawnRecord.children[0];
		assert.ok(child !== undefined);
		assert.equal(child.agent, "missing-agent");
		assert.equal(child.role, undefined);
		assert.equal(child.assignment, "worker");
		assert.equal(child.taskFull, "nested worker brief with full multiline\ninstruction content");
		assert.equal(child.taskPreview, "nested worker brief with full multiline");
		assert.equal(child.cwd, cwd);
		assert.equal(child.tools, "read,write");
		assert.equal(child.model, "anthropic/claude-3-5-sonnet");
		assert.equal(child.workflow?.playbook, "feature");
		assert.equal(child.workflow?.phase, "implement");
		assert.deepEqual(child.workflow?.completedPhases, ["ground"]);
		assert.deepEqual(child.workflow?.artifacts, [{ name: "ground-doc", path: "/tmp/ground.md", sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }]);
		assert.equal(child.state, "failed");
		assert.match(child.errorMessage ?? "", /Unknown agent/);
		assert.ok(typeof child.endedAt === "string" && child.endedAt.length > 0);

		const resultTool = runtime.tools.get("dstack_result");
		assert.ok(resultTool !== undefined);
		await waitUntil(async () => {
			const res = await resultTool.execute("res-check", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
			const details = res.details as { kind: string };
			return details?.kind === "complete";
		});
	} finally {
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
		if (previousRootWf === undefined) delete process.env[ROOT_WORKFLOW_ENV];
		else process.env[ROOT_WORKFLOW_ENV] = previousRootWf;
		if (previousSchedRoot === undefined) delete process.env[SCHEDULER_ROOT_ENV];
		else process.env[SCHEDULER_ROOT_ENV] = previousSchedRoot;
		if (previousChildIdx === undefined) delete process.env[DSTACK_CHILD_INDEX_ENV];
		else process.env[DSTACK_CHILD_INDEX_ENV] = previousChildIdx;
		if (previousArtifactDir === undefined) delete process.env[DSTACK_ARTIFACT_DIR_ENV];
		else process.env[DSTACK_ARTIFACT_DIR_ENV] = previousArtifactDir;
	}
});

test("depth-1 nested dstack_task persists concrete model from PI_PROVIDER and PI_MODEL for inherit-parent worker", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dstack-nested-env-model-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const artifactDir = join(cwd, "artifacts");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(artifactDir, { recursive: true });
	await mkdir(schedulerRoot, { recursive: true });

	const configPath = join(cwd, ".pi", "agent", "dstack", "models.json");
	await mkdir(join(cwd, ".pi", "agent", "dstack"), { recursive: true });
	await writeFile(configPath, JSON.stringify({
		roles: { "implementation-worker": "inherit-parent" },
	}), "utf8");

	const previousHome = process.env.HOME;
	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	const previousRootWf = process.env[ROOT_WORKFLOW_ENV];
	const previousSchedRoot = process.env[SCHEDULER_ROOT_ENV];
	const previousChildIdx = process.env[DSTACK_CHILD_INDEX_ENV];
	const previousArtifactDir = process.env[DSTACK_ARTIFACT_DIR_ENV];
	const previousProvider = process.env.PI_PROVIDER;
	const previousModel = process.env.PI_MODEL;

	process.env.HOME = cwd;
	process.env.DSTACK_NESTING = "1";
	process.env.DSTACK_ASSIGNMENT = "owner";
	process.env[ROOT_WORKFLOW_ENV] = "wf-nested-env-model";
	process.env[SCHEDULER_ROOT_ENV] = schedulerRoot;
	process.env[DSTACK_CHILD_INDEX_ENV] = "0";
	process.env[DSTACK_ARTIFACT_DIR_ENV] = artifactDir;
	process.env.PI_PROVIDER = "anthropic";
	process.env.PI_MODEL = "claude-3-7-sonnet";

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	try {
		const res = await runtime.tools.get("dstack_task")?.execute(
			"nested-call",
			{
				agent: "missing-agent",
				task: "implement worker task",
				cwd,
				role: "implementation-worker",
				workflow: {
					playbook: "feature",
					assignment: "worker",
					phase: "implementation",
					completedPhases: ["grounding"],
					artifacts: [],
				},
			},
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(res?.isError, false);
		const receipt = res?.details as { taskId: string };
		assert.ok(receipt?.taskId);

		const spawnsDir = join(artifactDir, "children", "0", "spawns");
		await waitUntil(async () => {
			try {
				const files = (await readdir(spawnsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
				return files.length === 1;
			} catch {
				return false;
			}
		});

		const files = (await readdir(spawnsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
		assert.equal(files.length, 1);
		await waitUntil(async () => {
			try {
				const raw = await readFile(join(spawnsDir, files[0]!), "utf8");
				const spawnRecord = parseSpawnRecordV1(JSON.parse(raw));
				return spawnRecord?.children[0]?.state === "failed";
			} catch {
				return false;
			}
		});

		const raw = await readFile(join(spawnsDir, files[0]!), "utf8");
		const spawnRecord = parseSpawnRecordV1(JSON.parse(raw));
		assert.ok(spawnRecord !== undefined);
		assert.equal(spawnRecord.children.length, 1);

		const child = spawnRecord.children[0];
		assert.ok(child !== undefined);
		assert.equal(child.role, "implementation-worker");
		assert.equal(child.model, "anthropic/claude-3-7-sonnet");

		const resultTool = runtime.tools.get("dstack_result");
		assert.ok(resultTool !== undefined);
		await waitUntil(async () => {
			const res = await resultTool.execute("res-check", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
			const details = res.details as { kind: string };
			return details?.kind === "complete";
		});
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
		if (previousRootWf === undefined) delete process.env[ROOT_WORKFLOW_ENV];
		else process.env[ROOT_WORKFLOW_ENV] = previousRootWf;
		if (previousSchedRoot === undefined) delete process.env[SCHEDULER_ROOT_ENV];
		else process.env[SCHEDULER_ROOT_ENV] = previousSchedRoot;
		if (previousChildIdx === undefined) delete process.env[DSTACK_CHILD_INDEX_ENV];
		else process.env[DSTACK_CHILD_INDEX_ENV] = previousChildIdx;
		if (previousArtifactDir === undefined) delete process.env[DSTACK_ARTIFACT_DIR_ENV];
		else process.env[DSTACK_ARTIFACT_DIR_ENV] = previousArtifactDir;
		if (previousProvider === undefined) delete process.env.PI_PROVIDER;
		else process.env.PI_PROVIDER = previousProvider;
		if (previousModel === undefined) delete process.env.PI_MODEL;
		else process.env.PI_MODEL = previousModel;
	}
});

test("depth-1 nested dstack_task ignores missing env vars and does not write spawn records", async () => {
	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	const previousRootWf = process.env[ROOT_WORKFLOW_ENV];
	const previousSchedRoot = process.env[SCHEDULER_ROOT_ENV];
	const previousChildIdx = process.env[DSTACK_CHILD_INDEX_ENV];
	const previousArtifactDir = process.env[DSTACK_ARTIFACT_DIR_ENV];

	process.env.DSTACK_NESTING = "1";
	process.env.DSTACK_ASSIGNMENT = "owner";
	delete process.env[ROOT_WORKFLOW_ENV];
	delete process.env[SCHEDULER_ROOT_ENV];
	delete process.env[DSTACK_CHILD_INDEX_ENV];
	delete process.env[DSTACK_ARTIFACT_DIR_ENV];

	try {
		const res = await runtime.tools.get("dstack_task")?.execute(
			"nested-missing-env",
			{
				agent: "missing-agent",
				task: "fail without env",
			},
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(res?.isError, false);
		const receipt = res?.details as { taskId: string };
		assert.ok(receipt?.taskId);

		const resultTool = runtime.tools.get("dstack_result");
		await waitUntil(async () => {
			const inspect = await resultTool?.execute("res-check", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
			const details = inspect?.details as { kind: string };
			return details?.kind === "complete";
		});

		assert.equal(runtime.entries.filter((e) => e.customType === "dstack-tree-snapshot").length, 0);
	} finally {
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
		if (previousRootWf === undefined) delete process.env[ROOT_WORKFLOW_ENV];
		else process.env[ROOT_WORKFLOW_ENV] = previousRootWf;
		if (previousSchedRoot === undefined) delete process.env[SCHEDULER_ROOT_ENV];
		else process.env[SCHEDULER_ROOT_ENV] = previousSchedRoot;
		if (previousChildIdx === undefined) delete process.env[DSTACK_CHILD_INDEX_ENV];
		else process.env[DSTACK_CHILD_INDEX_ENV] = previousChildIdx;
		if (previousArtifactDir === undefined) delete process.env[DSTACK_ARTIFACT_DIR_ENV];
		else process.env[DSTACK_ARTIFACT_DIR_ENV] = previousArtifactDir;
	}
});

test("depth-1 nested chain stops and marks unstarted steps as skipped in spawn record", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dstack-nested-chain-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const artifactDir = join(cwd, "artifacts");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(artifactDir, { recursive: true });
	await mkdir(schedulerRoot, { recursive: true });

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	const previousRootWf = process.env[ROOT_WORKFLOW_ENV];
	const previousSchedRoot = process.env[SCHEDULER_ROOT_ENV];
	const previousChildIdx = process.env[DSTACK_CHILD_INDEX_ENV];
	const previousArtifactDir = process.env[DSTACK_ARTIFACT_DIR_ENV];

	process.env.DSTACK_NESTING = "1";
	process.env.DSTACK_ASSIGNMENT = "owner";
	process.env[ROOT_WORKFLOW_ENV] = "wf-chain-test";
	process.env[SCHEDULER_ROOT_ENV] = schedulerRoot;
	process.env[DSTACK_CHILD_INDEX_ENV] = "0";
	process.env[DSTACK_ARTIFACT_DIR_ENV] = artifactDir;

	try {
		const res = await runtime.tools.get("dstack_task")?.execute(
			"nested-chain",
			{
				chain: [
					{ agent: "missing-agent", task: "failing step 1" },
					{ agent: "general-purpose", task: "unstarted step 2" },
				],
			},
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(res?.isError, false);
		const receipt = res?.details as { taskId: string };
		assert.ok(receipt?.taskId);

		const spawnsDir = join(artifactDir, "children", "0", "spawns");
		await waitUntil(async () => {
			try {
				const files = (await readdir(spawnsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
				if (files.length !== 1) return false;
				const raw = await readFile(join(spawnsDir, files[0]!), "utf8");
				const spawnRecord = parseSpawnRecordV1(JSON.parse(raw));
				return spawnRecord?.children[1]?.state === "skipped";
			} catch {
				return false;
			}
		});

		const files = (await readdir(spawnsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
		assert.equal(files.length, 1);
		const raw = await readFile(join(spawnsDir, files[0]!), "utf8");
		const spawnRecord = parseSpawnRecordV1(JSON.parse(raw));
		assert.ok(spawnRecord !== undefined);
		assert.equal(spawnRecord.mode, "chain");
		assert.equal(spawnRecord.children.length, 2);

		const step1 = spawnRecord.children[0];
		assert.equal(step1?.agent, "missing-agent");
		assert.equal(step1?.state, "failed");
		assert.ok(typeof step1?.endedAt === "string");

		const step2 = spawnRecord.children[1];
		assert.equal(step2?.agent, "general-purpose");
		assert.equal(step2?.state, "skipped");
		assert.equal(step2?.startedAt, undefined);
		assert.ok(typeof step2?.endedAt === "string");
	} finally {
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
		if (previousRootWf === undefined) delete process.env[ROOT_WORKFLOW_ENV];
		else process.env[ROOT_WORKFLOW_ENV] = previousRootWf;
		if (previousSchedRoot === undefined) delete process.env[SCHEDULER_ROOT_ENV];
		else process.env[SCHEDULER_ROOT_ENV] = previousSchedRoot;
		if (previousChildIdx === undefined) delete process.env[DSTACK_CHILD_INDEX_ENV];
		else process.env[DSTACK_CHILD_INDEX_ENV] = previousChildIdx;
		if (previousArtifactDir === undefined) delete process.env[DSTACK_ARTIFACT_DIR_ENV];
		else process.env[DSTACK_ARTIFACT_DIR_ENV] = previousArtifactDir;
	}
});

test("dtree command toggles widget and renders workflow snapshot entries", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-public-dtree-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => { process.env.HOME = previousHome; });

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const dtreeCommand = runtime.commands.get("dtree");
	assert.ok(dtreeCommand !== undefined);

	await dtreeCommand.handler("off", runtime.ctx);
	assert.ok(runtime.notifications.some((n) => n.message.includes("widget disabled")));

	await dtreeCommand.handler("on", runtime.ctx);
	assert.ok(runtime.notifications.some((n) => n.message.includes("widget enabled")));

	await dtreeCommand.handler("", runtime.ctx);
	assert.ok(runtime.notifications.some((n) => n.message.includes("no dstack workflow in this session")));

	const renderer = runtime.entryRenderers.get("dstack-tree-snapshot");
	assert.ok(renderer !== undefined);
	const rendered = renderer(
		{ data: { taskId: "t-1", workflowId: "w-1", mode: "single", createdAt: "2025-01-01T00:00:00.000Z", committed: true, counts: { queued: 0, running: 0, complete: 1, total: 1 }, slots: { active: 0, capacity: 4 }, children: [{ index: 0, agent: "poteto-agent", state: "succeeded", taskPreview: "done", nested: [] }], todos: [], todoCounts: { total: 0, completed: 0, inProgress: 0 }, capturedAt: "2025-01-01T00:01:00.000Z" } },
		{ expanded: false },
		{ fg: (_: string, text: string) => text, bold: (t: string) => t, strikethrough: (t: string) => t },
	);
	assert.ok(rendered !== undefined);
});

test("dtree resolves manifest playbook when inspecting another task", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-public-dtree-manifest-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	process.env.HOME = home;
	delete process.env.DSTACK_NESTING;
	delete process.env.DSTACK_ASSIGNMENT;
	t.after(() => {
		process.env.HOME = previousHome;
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
	});

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const backgroundRoot = join(home, ".pi", "agent", "dstack", "background");
	const sRoot = join(backgroundRoot, "public-tools-session");
	const priorRoot = join(backgroundRoot, "prior-session");
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-active"), { recursive: true });
	await mkdir(join(priorRoot, "bindings"), { recursive: true });
	await mkdir(join(priorRoot, "workflows", "wf-other"), { recursive: true });

	await writeFile(
		join(priorRoot, "bindings", "task-other.json"),
		JSON.stringify({ taskId: "task-other", workflowId: "wf-other" }),
		"utf8",
	);
	await writeFile(
		join(priorRoot, "workflows", "wf-other", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-other",
			mode: "single",
			createdAt: new Date().toISOString(),
			specs: [{ agent: "poteto-agent", task: "other task", workflow: { assignment: "owner", playbook: "target-manifest-playbook" } }],
		}),
		"utf8",
	);

	await writeFile(
		join(sRoot, "bindings", "task-active.json"),
		JSON.stringify({ taskId: "task-active", workflowId: "wf-active" }),
		"utf8",
	);
	await writeFile(
		join(sRoot, "workflows", "wf-active", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-active",
			mode: "single",
			createdAt: new Date().toISOString(),
			specs: [{ agent: "poteto-agent", task: "active task", workflow: { assignment: "owner", playbook: "active-manifest-playbook" } }],
		}),
		"utf8",
	);

	runtime.ctx.sessionManager.getBranch = () => [
		{
			type: "custom",
			customType: "dstack-active-workflow",
			data: { taskId: "task-active", playbook: "active-workflow-playbook" },
		},
	];
	await runtime.handlers.get("session_tree")?.({}, runtime.ctx);

	const dtreeCommand = runtime.commands.get("dtree");
	assert.ok(dtreeCommand !== undefined);

	await dtreeCommand.handler("task-other", runtime.ctx);
	const otherEntry = runtime.entries.find(
		(e) => e.customType === "dstack-tree-snapshot" && (e.data as { taskId: string }).taskId === "task-other",
	);
	assert.ok(otherEntry !== undefined);
	assert.equal((otherEntry.data as { playbook?: string }).playbook, "target-manifest-playbook");

	await dtreeCommand.handler("task-active", runtime.ctx);
	const activeEntry = runtime.entries.find(
		(e) => e.customType === "dstack-tree-snapshot" && (e.data as { taskId: string }).taskId === "task-active",
	);
	assert.ok(activeEntry !== undefined);
	assert.equal((activeEntry.data as { playbook?: string }).playbook, "active-workflow-playbook");
});

test("dstack_result clears widget and stops timer when terminal result is uncommitted", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-public-uncommitted-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	process.env.HOME = home;
	delete process.env.DSTACK_NESTING;
	delete process.env.DSTACK_ASSIGNMENT;
	t.after(() => {
		process.env.HOME = previousHome;
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
	});

	const events = createEventBus();
	let task = {
		id: "bg-failing-task",
		name: "dstack",
		command: "runner",
		status: "running" as "running" | "failed",
		outputPath: join(home, "companion-output.txt"),
	};
	const stop = events.on(REQUEST_CHANNEL, (raw) => {
		if (typeof raw !== "object" || raw === null || !("request_id" in raw) || !("operation" in raw)) return;
		const requestId = String(raw.request_id);
		const operation = String(raw.operation);
		if (operation === "capabilities") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, {
				api_version: 1,
				run: true,
				status: true,
			}));
		} else if (operation === "run") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, task));
		} else if (operation === "status") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, { tasks: [task] }));
		}
	});
	t.after(stop);

	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const sRoot = join(home, ".pi", "agent", "dstack", "background", "public-tools-session");
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-fail"), { recursive: true });
	await writeFile(
		join(sRoot, "bindings", "bg-failing-task.json"),
		JSON.stringify({ taskId: "bg-failing-task", workflowId: "wf-fail" }),
		"utf8",
	);
	await writeFile(
		join(sRoot, "workflows", "wf-fail", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-fail",
			mode: "single",
			createdAt: new Date().toISOString(),
			specs: [{ agent: "poteto-agent", task: "owner task", workflow: { assignment: "owner", playbook: "bug-fix" } }],
		}),
		"utf8",
	);

	runtime.ctx.sessionManager.getBranch = () => [
		{
			type: "custom",
			customType: "dstack-active-workflow",
			data: { taskId: "bg-failing-task", playbook: "bug-fix" },
		},
	];
	await runtime.handlers.get("session_tree")?.({}, runtime.ctx);
	await waitUntil(() => runtime.widgets.includes("dstack-tree"));

	task = { ...task, status: "failed" };

	const resultTool = runtime.tools.get("dstack_result");
	assert.ok(resultTool !== undefined);
	const res = await resultTool.execute("call-1", { taskId: "bg-failing-task" }, undefined, undefined, runtime.ctx);
	assert.equal((res.details as { kind: string }).kind, "runner_failed");
	assert.equal(runtime.widgets.includes("dstack-tree"), false);
});

test("dagents command and shift+up shortcut open inspector overlay and manage widget suppression", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-public-dagents-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => { process.env.HOME = previousHome; });

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const dagentsCommand = runtime.commands.get("dagents");
	assert.ok(dagentsCommand !== undefined);

	const shiftUpShortcut = runtime.shortcuts.get("shift+up");
	assert.ok(shiftUpShortcut !== undefined);

	await dagentsCommand.handler("", runtime.ctx);
	assert.equal(runtime.getCustomOverlayOpened(), 1);
	assert.deepEqual(runtime.getLastOverlayOptions(), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			minWidth: 64,
			maxHeight: "90%",
			margin: { bottom: 1, left: 1, right: 1 },
		},
	});

	await shiftUpShortcut.handler(runtime.ctx);
	assert.equal(runtime.getCustomOverlayOpened(), 2);
	assert.deepEqual(runtime.getLastOverlayOptions(), {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			minWidth: 64,
			maxHeight: "90%",
			margin: { bottom: 1, left: 1, right: 1 },
		},
	});
});

test("dstack_kill cancels companion-backed root task, emits eventbus request, and projects cancelled result state", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-root-kill-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	const previousDepth = process.env.DSTACK_NESTING;
	process.env.HOME = home;
	delete process.env.DSTACK_NESTING;
	t.after(() => {
		process.env.HOME = previousHome;
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
	});

	const events = createEventBus();
	const killRequests: unknown[] = [];
	let task = {
		id: "bg-root-kill-task",
		name: "dstack",
		command: "runner",
		status: "running" as "running" | "killed",
		outputPath: join(home, "companion-output.txt"),
	};

	const stop = events.on(REQUEST_CHANNEL, (raw) => {
		if (typeof raw !== "object" || raw === null || !("request_id" in raw) || !("operation" in raw)) return;
		const requestId = String(raw.request_id);
		const operation = String(raw.operation);
		if (operation === "capabilities") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, {
				api_version: 1,
				run: true,
				status: true,
				kill: true,
			}));
		} else if (operation === "status") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, { tasks: [task] }));
		} else if (operation === "kill") {
			killRequests.push(raw);
			task = { ...task, status: "killed" };
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, {
				message: "Task was killed",
				task,
			}));
		}
	});
	t.after(stop);

	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const sRoot = join(home, ".pi", "agent", "dstack", "background", "public-tools-session");
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-root-kill"), { recursive: true });
	await writeFile(
		join(sRoot, "bindings", "bg-root-kill-task.json"),
		JSON.stringify({ taskId: "bg-root-kill-task", workflowId: "wf-root-kill" }),
		"utf8",
	);

	const killTool = runtime.tools.get("dstack_kill");
	assert.ok(killTool !== undefined);

	const killRes = await killTool.execute("k1", { taskId: "bg-root-kill-task" }, undefined, undefined, runtime.ctx);
	assert.equal(killRes.isError, false);
	const killDetails = killRes.details as { taskId: string; status: string };
	assert.equal(killDetails.taskId, "bg-root-kill-task");
	assert.equal(killDetails.status, "killed");
	assert.equal(killRequests.length, 1);

	const resultTool = runtime.tools.get("dstack_result");
	assert.ok(resultTool !== undefined);
	const resultRes = await resultTool.execute("r1", { taskId: "bg-root-kill-task" }, undefined, undefined, runtime.ctx);
	const resDetails = resultRes.details as { kind: string; taskId: string };
	assert.equal(resDetails.kind, "cancelled");
	assert.equal(resDetails.taskId, "bg-root-kill-task");
});

test("dstack_kill is idempotent for already-terminal tasks and safe for unknown tasks", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-kill-idempotent-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	const previousDepth = process.env.DSTACK_NESTING;
	process.env.HOME = home;
	delete process.env.DSTACK_NESTING;
	t.after(() => {
		process.env.HOME = previousHome;
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
	});

	const events = createEventBus();
	const completedTask = {
		id: "bg-done-task",
		name: "dstack",
		command: "runner",
		status: "completed" as const,
		outputPath: join(home, "output.txt"),
	};

	let killCalls = 0;
	const stop = events.on(REQUEST_CHANNEL, (raw) => {
		if (typeof raw !== "object" || raw === null || !("request_id" in raw) || !("operation" in raw)) return;
		const requestId = String(raw.request_id);
		const operation = String(raw.operation);
		if (operation === "capabilities") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, {
				api_version: 1,
				run: true,
				status: true,
				kill: true,
			}));
		} else if (operation === "status") {
			events.emit(RESPONSE_CHANNEL, response(requestId, operation, { tasks: [completedTask] }));
		} else if (operation === "kill") {
			killCalls++;
		}
	});
	t.after(stop);

	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const killTool = runtime.tools.get("dstack_kill");
	assert.ok(killTool !== undefined);

	const doneKill = await killTool.execute("k1", { taskId: "bg-done-task" }, undefined, undefined, runtime.ctx);
	assert.equal(doneKill.isError, false);
	const doneDetails = doneKill.details as { status: string };
	assert.equal(doneDetails.status, "already_terminal");
	assert.equal(killCalls, 0);

	const unknownKill = await killTool.execute("k2", { taskId: "non-existent-task" }, undefined, undefined, runtime.ctx);
	assert.equal(unknownKill.isError, false);
	const unknownDetails = unknownKill.details as { status: string };
	assert.equal(unknownDetails.status, "unknown_task");
});

test("shouldTriggerStaleWake pure helper enforces one-shot, staleness, terminal, and control safety invariants", () => {
	const baseSnapshot = {
		taskId: "task-stale-test",
		workflowId: "wf-stale-test",
		mode: "single" as const,
		createdAt: new Date().toISOString(),
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				state: "running" as const,
				agent: "poteto-agent",
				taskPreview: "work on task",
				stale: true,
				nested: [],
				nestedGroups: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: new Date().toISOString(),
	};

	const safeControl = { isIdle: true, hasPendingMessages: false };
	const firedSet = new Set<string>();

	assert.equal(shouldTriggerStaleWake({ snapshot: baseSnapshot, firedTaskIds: firedSet, control: safeControl }), true);

	firedSet.add("task-stale-test");
	assert.equal(shouldTriggerStaleWake({ snapshot: baseSnapshot, firedTaskIds: firedSet, control: safeControl }), false);

	firedSet.clear();

	const committedSnapshot = { ...baseSnapshot, committed: true };
	assert.equal(shouldTriggerStaleWake({ snapshot: committedSnapshot, firedTaskIds: firedSet, control: safeControl }), false);

	assert.equal(shouldTriggerStaleWake({ snapshot: baseSnapshot, firedTaskIds: firedSet, control: { isIdle: false, hasPendingMessages: false } }), false);

	assert.equal(shouldTriggerStaleWake({ snapshot: baseSnapshot, firedTaskIds: firedSet, control: { isIdle: true, hasPendingMessages: true } }), false);

	const freshSnapshot = {
		...baseSnapshot,
		children: [
			{
				index: 0,
				state: "running" as const,
				agent: "poteto-agent",
				taskPreview: "work on task",
				stale: false,
				nested: [],
				nestedGroups: [],
			},
		],
	};
	assert.equal(shouldTriggerStaleWake({ snapshot: freshSnapshot, firedTaskIds: firedSet, control: safeControl }), false);

	const completedSnapshot = {
		...baseSnapshot,
		children: [
			{
				index: 0,
				state: "succeeded" as const,
				agent: "poteto-agent",
				taskPreview: "work on task",
				stale: true,
				nested: [],
				nestedGroups: [],
			},
		],
	};
	assert.equal(shouldTriggerStaleWake({ snapshot: completedSnapshot, firedTaskIds: firedSet, control: safeControl }), false);

	const nestedStaleSnapshot = {
		...baseSnapshot,
		children: [
			{
				index: 0,
				state: "running" as const,
				agent: "poteto-agent",
				taskPreview: "owner task",
				stale: false,
				nestedGroups: [],
				nested: [
					{
						groupId: "g1",
						nestedIndex: 0,
						agent: "general-purpose",
						taskPreview: "nested worker",
						state: "running" as const,
						live: true,
						stale: true,
						updatedAt: new Date().toISOString(),
					},
				],
			},
		],
	};
	assert.equal(shouldTriggerStaleWake({ snapshot: nestedStaleSnapshot, firedTaskIds: firedSet, control: safeControl }), true);
});

test("completion wake and recovery decision helpers enforce dedupe and bounded-retry invariants", () => {
	const committedSnapshot = {
		taskId: "task-cw",
		workflowId: "wf-cw",
		mode: "single" as const,
		createdAt: new Date().toISOString(),
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: new Date().toISOString(),
	};
	const idle = { isIdle: true, hasPendingMessages: false };
	assert.equal(shouldTriggerCompletionWake({ snapshot: committedSnapshot, collected: false, firedTaskIds: new Set(), control: idle }), true);
	assert.equal(shouldTriggerCompletionWake({ snapshot: committedSnapshot, collected: true, firedTaskIds: new Set(), control: idle }), false);
	assert.equal(shouldTriggerCompletionWake({ snapshot: committedSnapshot, collected: false, firedTaskIds: new Set(["task-cw"]), control: idle }), false);
	assert.equal(shouldTriggerCompletionWake({ snapshot: { ...committedSnapshot, committed: false }, collected: false, firedTaskIds: new Set(), control: idle }), false);
	assert.equal(shouldTriggerCompletionWake({ snapshot: committedSnapshot, collected: false, firedTaskIds: new Set(), control: { isIdle: true, hasPendingMessages: true } }), false);

	const completeView = (exitCode: number) => ({
		kind: "complete" as const,
		taskId: "bg-1",
		detail: "full" as const,
		package: {
			mode: "single" as const,
			results: [{ agent: "poteto-agent", cwd: "/", task: "t", text: "", exitCode, stderr: "", messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }],
		},
	});
	assert.equal(classifyFailure(completeView(0)), "success");
	assert.equal(classifyFailure(completeView(1)), "retryable");
	assert.equal(classifyFailure({ kind: "runner_failed", taskId: "bg-1", message: "boom", companionOutputPath: "" }), "retryable");
	assert.equal(classifyFailure({ kind: "cancelled", taskId: "bg-1", message: "user killed" }), "unrecoverable");

	const lineage: RecoveryLineage = {
		lineageId: "bg-1",
		request: { kind: "single", spec: { agent: "poteto-agent", task: "do it" } },
		currentTaskId: "bg-1",
		attempts: [],
		status: "active",
	};
	assert.deepEqual(nextRecoveryAction(lineage, "bg-1", "retryable"), { kind: "relaunch", attemptNumber: 2 });
	assert.deepEqual(nextRecoveryAction(lineage, "bg-stale", "retryable"), { kind: "ignore" });
	assert.deepEqual(nextRecoveryAction({ ...lineage, status: "resolved" }, "bg-1", "retryable"), { kind: "ignore" });
	assert.deepEqual(
		nextRecoveryAction({ ...lineage, attempts: [{ taskId: "bg-1", endedAt: "2025-01-01T00:00:00.000Z", reason: "crash" }] }, "bg-1", "retryable"),
		{ kind: "ignore" },
	);
	const exhaustedAttempts = Array.from({ length: MAX_OWNER_ATTEMPTS - 1 }, (_, i) => ({
		taskId: `bg-old-${i}`,
		endedAt: "2025-01-01T00:00:00.000Z",
		reason: "crash",
	}));
	const exhausted = nextRecoveryAction({ ...lineage, attempts: exhaustedAttempts }, "bg-1", "retryable");
	assert.equal(exhausted.kind, "stop");
	assert.equal(exhausted.kind === "stop" ? exhausted.status : undefined, "exhausted");
	const resolved = nextRecoveryAction(lineage, "bg-1", "success");
	assert.equal(resolved.kind === "stop" ? resolved.status : undefined, "resolved");
	const unrecoverable = nextRecoveryAction(lineage, "bg-1", "unrecoverable");
	assert.equal(unrecoverable.kind === "stop" ? unrecoverable.status : undefined, "unrecoverable");
});

test("stale-parent wake-up triggers one hidden follow-up and survives session reload without duplicate", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-stale-wake-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => { process.env.HOME = previousHome; });

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const sRoot = join(home, ".pi", "agent", "dstack", "background", "public-tools-session");
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-stale-test", "children", "0"), { recursive: true });
	await mkdir(join(sRoot, "scheduler"), { recursive: true });
	await writeFile(
		join(sRoot, "bindings", "bg-stale-task.json"),
		JSON.stringify({ taskId: "bg-stale-task", workflowId: "wf-stale-test" }),
		"utf8",
	);

	const staleTimestamp = new Date(Date.now() - (STALE_ACTIVITY_THRESHOLD_MS + 10_000)).toISOString();
	await writeFile(
		join(sRoot, "workflows", "wf-stale-test", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-stale-test",
			mode: "single",
			createdAt: staleTimestamp,
			specs: [{ agent: "poteto-agent", task: "owner task", workflow: { assignment: "owner", playbook: "feature", phase: "run", completedPhases: [], artifacts: [] } }],
		}),
		"utf8",
	);
	await writeFile(
		join(sRoot, "workflows", "wf-stale-test", "progress.json"),
		JSON.stringify({
			schemaVersion: "dstack.progress.v2",
			workflowId: "wf-stale-test",
			queued: 0,
			running: 1,
			complete: 0,
			total: 1,
			children: [{ index: 0, agent: "poteto-agent", state: "running", startedAt: staleTimestamp }],
		}),
		"utf8",
	);
	await writeFile(
		join(sRoot, "workflows", "wf-stale-test", "children", "0", "activity.json"),
		JSON.stringify({
			schemaVersion: "dstack.child-activity.v1",
			workflowId: "wf-stale-test",
			index: 0,
			activity: "working on stalled thing",
			updatedAt: staleTimestamp,
			turns: 1,
			contextTokens: 100,
		}),
		"utf8",
	);

	runtime.ctx.sessionManager.getBranch = () => [
		{
			type: "custom",
			customType: "dstack-active-workflow",
			data: { taskId: "bg-stale-task", playbook: "feature" },
		},
		...runtime.entries.map((entry) => ({ type: "custom", ...entry })),
	];

	await runtime.handlers.get("session_tree")?.({}, runtime.ctx);
	await waitUntil(() => runtime.sentMessages.length > 0, 3000);

	assert.equal(runtime.sentMessages.length, 1);
	const sent = runtime.sentMessages[0] as { message: { customType: string; content: string; display: boolean }; options: { deliverAs: string; triggerTurn: boolean } };
	assert.equal(sent.message.customType, "dstack-stale-wake");
	assert.equal(sent.message.display, false);
	assert.equal(sent.options.deliverAs, "followUp");
	assert.equal(sent.options.triggerTurn, true);
	assert.match(sent.message.content, /inactive for more than 2 minutes and may be stale/);
	assert.match(sent.message.content, /dstack_result.*dstack_kill/);

	const restoredFired = restoreFiredStaleWakes(runtime.entries.map((e) => ({
		type: "custom",
		customType: e.customType,
		data: e.data,
	})));
	assert.equal(restoredFired.has("bg-stale-task"), true);
	await runtime.handlers.get("session_tree")?.({}, runtime.ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(runtime.sentMessages.length, 1);
});

test("nested depth-1 task supports immediate receipt, running inspection, dstack_kill cancellation, and cancelled result", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dstack-nested-kill-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	process.env.DSTACK_NESTING = "1";
	delete process.env.DSTACK_ASSIGNMENT;

	try {
		const taskTool = runtime.tools.get("dstack_task");
		const resultTool = runtime.tools.get("dstack_result");
		const killTool = runtime.tools.get("dstack_kill");
		assert.ok(taskTool && resultTool && killTool);

		const launch = await taskTool.execute(
			"nested-1",
			{ agent: "general-purpose", task: "long running nested task", tools: "read" },
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(launch.isError, false);
		const receipt = launch.details as { taskId: string; mode: string };
		assert.ok(receipt?.taskId);

		// dstack_result now blocks on running nested tasks; an aborted signal projects the running state immediately
		const runningRes = await resultTool.execute("r-run", { taskId: receipt.taskId }, AbortSignal.abort(), undefined, runtime.ctx);
		const runningDetails = runningRes.details as { kind: string };
		assert.ok(runningDetails.kind === "running" || runningDetails.kind === "complete");

		const killRes = await killTool.execute("k-nested", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
		assert.equal(killRes.isError, false);
		const killDetails = killRes.details as { taskId: string; status: string };
		assert.equal(killDetails.taskId, receipt.taskId);
		assert.ok(killDetails.status === "killed" || killDetails.status === "already_terminal");

		const afterKillRes = await resultTool.execute("r-cancelled", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
		const afterKillDetails = afterKillRes.details as { kind: string; taskId: string };
		assert.ok(afterKillDetails.kind === "cancelled" || afterKillDetails.kind === "complete");

		const secondKill = await killTool.execute("k-again", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
		assert.equal(secondKill.isError, false);
		assert.equal((secondKill.details as { status: string }).status, "already_terminal");
	} finally {
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
	}
});

test("nested depth-1 task dstack_kill releases scheduler lease and restores capacity", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "dstack-sched-kill-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));

	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(schedulerRoot, { recursive: true });

	const previousDepth = process.env.DSTACK_NESTING;
	const previousAssignment = process.env.DSTACK_ASSIGNMENT;
	const previousRootWf = process.env[ROOT_WORKFLOW_ENV];
	const previousSchedRoot = process.env[SCHEDULER_ROOT_ENV];
	const previousChildIdx = process.env[DSTACK_CHILD_INDEX_ENV];
	const previousArtifactDir = process.env[DSTACK_ARTIFACT_DIR_ENV];

	process.env.DSTACK_NESTING = "1";
	process.env.DSTACK_ASSIGNMENT = "owner";
	process.env[ROOT_WORKFLOW_ENV] = "wf-sched-kill";
	process.env[SCHEDULER_ROOT_ENV] = schedulerRoot;
	delete process.env[DSTACK_CHILD_INDEX_ENV];
	delete process.env[DSTACK_ARTIFACT_DIR_ENV];

	const events = createEventBus();
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);

	try {
		const taskTool = runtime.tools.get("dstack_task");
		const resultTool = runtime.tools.get("dstack_result");
		const killTool = runtime.tools.get("dstack_kill");
		assert.ok(taskTool && resultTool && killTool);

		const launch = await taskTool.execute(
			"sched-call",
			{ agent: "general-purpose", task: "hold lease briefly", tools: "read" },
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(launch.isError, false);
		const receipt = launch.details as { taskId: string };

		try {
			await waitUntil(async () => (await snapshotActiveLeases(schedulerRoot)).length === 1, 5_000);
		} catch {
			const current = await resultTool.execute("r-lease", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
			assert.fail(`nested task did not acquire a scheduler lease: ${JSON.stringify(current.details)}`);
		}
		const killed = await killTool.execute("k1", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
		assert.equal((killed.details as { status: string }).status, "killed");
		assert.equal((await snapshotActiveLeases(schedulerRoot)).length, 0);

		const lease = await acquireChildSlot({
			schedulerRoot: toAbsolutePath(schedulerRoot),
			workflowId: "wf-sched-kill",
			childId: "after-kill-child",
			work: { depth: 2 },
			signal: new AbortController().signal,
		});
		assert.ok(lease !== undefined);
		await lease.release();
	} finally {
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
		if (previousAssignment === undefined) delete process.env.DSTACK_ASSIGNMENT;
		else process.env.DSTACK_ASSIGNMENT = previousAssignment;
		if (previousRootWf === undefined) delete process.env[ROOT_WORKFLOW_ENV];
		else process.env[ROOT_WORKFLOW_ENV] = previousRootWf;
		if (previousSchedRoot === undefined) delete process.env[SCHEDULER_ROOT_ENV];
		else process.env[SCHEDULER_ROOT_ENV] = previousSchedRoot;
		if (previousChildIdx === undefined) delete process.env[DSTACK_CHILD_INDEX_ENV];
		else process.env[DSTACK_CHILD_INDEX_ENV] = previousChildIdx;
		if (previousArtifactDir === undefined) delete process.env[DSTACK_ARTIFACT_DIR_ENV];
		else process.env[DSTACK_ARTIFACT_DIR_ENV] = previousArtifactDir;
	}
});

test("dstack_result renderResult renders concise collapsed summary with expand hint and full text when expanded", async () => {
	initTheme();
	const events = createEventBus();
	const runtime = testRuntime(events);
	const resultTool = runtime.tools.get("dstack_result");
	assert.ok(resultTool);
	assert.ok(resultTool.renderResult);

	const details = {
		kind: "complete",
		taskId: "bg-render-test",
		detail: "summary",
		package: {
			mode: "single",
			results: [{ agent: "poteto-agent", summary: "done".repeat(30_000), exitCode: 0 }],
		},
	};
	const sampleJson = JSON.stringify(details);
	const resultPayload = {
		content: [{ type: "text", text: sampleJson }],
		isError: false,
		details,
	};

	const collapsedComponent = resultTool.renderResult(resultPayload, { expanded: false, isPartial: false }, undefined);
	const collapsedLines = collapsedComponent.render(80);
	assert.equal(collapsedLines.length, 1);
	assert.match(collapsedLines[0] ?? "", /✓ complete bg-render-test/);
	assert.match(collapsedLines[0] ?? "", /to expand/);
	assert.ok(!collapsedLines[0]?.includes('"package"'));

	const expandedComponent = resultTool.renderResult(resultPayload, { expanded: true, isPartial: false }, undefined);
	const expandedLines = expandedComponent.render(80);
	assert.ok(expandedLines.join("\n").includes('"package"'));

	const malformedPayload = {
		content: [{ type: "text", text: sampleJson }],
		isError: false,
		details: "not-a-valid-details-record",
	};
	const malformedCollapsed = resultTool.renderResult(malformedPayload, { expanded: false, isPartial: false }, undefined);
	const malformedLines = malformedCollapsed.render(80);
	assert.equal(malformedLines.length, 1);
	assert.match(malformedLines[0] ?? "", /\(result output\)/);
	assert.ok(!malformedLines[0]?.includes('"package"'));
});
