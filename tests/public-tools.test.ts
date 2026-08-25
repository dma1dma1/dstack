import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import dstack from "../extensions/dstack.ts";
import { commitWorkflowResult, parseWorkflowManifest } from "../extensions/background/runner.ts";
import { createLocalSlotAcquirer, executeWorkflow } from "../extensions/background/workflow.ts";

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

function testRuntime(events: ReturnType<typeof createEventBus>) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const widgets: string[] = [];
	const pi = {
		events,
		registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
		registerCommand() {},
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
		appendEntry() {},
		getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
		sendMessage() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	dstack(pi);
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus() {},
			setWidget(name: string) { widgets.push(name); },
			notify() {},
		},
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "public-tools-session",
		},
		modelRegistry: { getAvailable: () => [] },
	};
	return { tools, handlers, widgets, ctx };
}

test("root task returns a receipt before the runner completes and dstack_result projects running and ordered completion", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "dstack-public-tools-"));
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		}),
	});
	await commitWorkflowResult(manifest, index);
	task = { ...task, status: "completed" };

	const completed = await resultTool.execute("result-complete", { taskId: receipt.taskId }, undefined, undefined, runtime.ctx);
	assert.equal((completed.details as { kind: string }).kind, "complete");
	assert.deepEqual(
		(completed.details as { package: { results: Array<{ task: string }> } }).package.results.map((item) => item.task),
		["first", "second"],
	);
	await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
	assert.deepEqual(runtime.widgets, []);
});

test("depth 1 keeps the synchronous execution path", async () => {
	const events = createEventBus();
	let backgroundRequests = 0;
	const stop = events.on(REQUEST_CHANNEL, () => { backgroundRequests += 1; });
	const runtime = testRuntime(events);
	await runtime.handlers.get("session_start")?.({}, runtime.ctx);
	const previousDepth = process.env.DSTACK_NESTING;
	process.env.DSTACK_NESTING = "1";
	try {
		const result = await runtime.tools.get("dstack_task")?.execute(
			"nested-call",
			{ agent: "missing-agent", task: "fail synchronously" },
			undefined,
			undefined,
			runtime.ctx,
		);
		assert.equal(result?.isError, true);
		assert.match(result?.content[0]?.text ?? "", /Unknown agent/);
		assert.equal(backgroundRequests, 0);
	} finally {
		stop();
		if (previousDepth === undefined) delete process.env.DSTACK_NESTING;
		else process.env.DSTACK_NESTING = previousDepth;
	}
});
