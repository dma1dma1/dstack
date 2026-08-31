import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyJsonEvent,
	buildChildArgv,
	capOutput,
	childDepthFor,
	childEnv,
	formatUsageStats,
	mapWithConcurrency,
	mcpExtensionPaths,
	NestingError,
	parseNestingDepth,
	parseTaskRequest,
	PER_TASK_OUTPUT_CAP,
	resolveAgent,
	requireMcpExtensionPaths,
	runChildProcess,
	spawnableDepth,
	sumChildUsage,
	type ChildResult,
} from "../extensions/spawn.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, NESTING_ENV } from "../extensions/types.ts";
import { claimNestedUsage, type NestedTaskRecord } from "../extensions/task-registry.ts";

const extensionPath = "/opt/dstack/extensions/dstack.ts";

function childArgv(input: Omit<Parameters<typeof buildChildArgv>[0], "extensionPath">) {
	return buildChildArgv({ ...input, extensionPath });
}

test("spawn argv isolates extensions and loads dstack explicitly", () => {
	const args = childArgv({
		task: "look around",
		model: "acme/fast",
		tools: "read,grep,find,ls",
		companionExtensionPaths: ["/opt/pi-mcp-adapter/index.ts"],
	});
	assert.deepEqual(args.slice(0, 7), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"-e",
		extensionPath,
	]);
	assert.equal(args.filter((arg) => arg === "-e").length, 2);
	assert.equal(args[args.lastIndexOf("-e") + 1], "/opt/pi-mcp-adapter/index.ts");
	assert.ok(args.includes("--model"));
	assert.equal(args[args.indexOf("--model") + 1], "acme/fast");
	assert.ok(args.includes("--tools"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
	assert.equal(args.at(-1), "Task: look around");
});

test("MCP extension discovery uses the loaded MCP tool source and fails closed when absent", () => {
	const sourceInfo = { path: "/opt/pi-mcp-adapter/index.ts", source: "npm:pi-mcp-adapter", scope: "user", origin: "package" } as const;
	const tools = [
		{ name: "read", description: "", parameters: {}, sourceInfo },
		{ name: "mcp", description: "", parameters: {}, sourceInfo },
		{ name: "mcp__github", description: "", parameters: {}, sourceInfo },
	] as unknown as Parameters<typeof mcpExtensionPaths>[0];
	assert.deepEqual(mcpExtensionPaths(tools), ["/opt/pi-mcp-adapter/index.ts"]);
	assert.deepEqual(requireMcpExtensionPaths(tools), ["/opt/pi-mcp-adapter/index.ts"]);
	assert.throws(() => requireMcpExtensionPaths([]), /MCP tools are unavailable/);
});

test("spawn argv uses a contained session dir instead of --no-session when provided", () => {
	const args = childArgv({ task: "look around", sessionDir: "/tmp/dstack/wf/children/0/session" });
	assert.equal(args.includes("--no-session"), false);
	assert.equal(args[args.indexOf("--session-dir") + 1], "/tmp/dstack/wf/children/0/session");
	assert.deepEqual(args.slice(0, 5), ["--mode", "json", "-p", "--session-dir", "/tmp/dstack/wf/children/0/session"]);
	assert.equal(args[args.indexOf("-e") + 1], extensionPath);
	assert.equal(args.at(-1), "Task: look around");
});

test("inherit-parent omits --model", () => {
	const args = childArgv({ task: "x", omitModel: true, model: "acme/fast" });
	assert.equal(args.includes("--model"), false);
});

test("thinking flag is passed when provided and omitted when undefined", () => {
	const withoutThinking = childArgv({ task: "x", model: "acme/fast" });
	assert.equal(withoutThinking.includes("--thinking"), false);

	const withThinking = childArgv({ task: "x", model: "acme/fast", thinking: "high" });
	assert.ok(withThinking.includes("--thinking"));
	assert.equal(withThinking[withThinking.indexOf("--thinking") + 1], "high");
});

test("append-system-prompt is a file path", () => {
	const args = childArgv({
		task: "x",
		systemPromptPath: "/tmp/dstack/prompt.md",
	});
	assert.equal(args[args.indexOf("--append-system-prompt") + 1], "/tmp/dstack/prompt.md");
});

test("nesting depth parses strictly and fails closed", () => {
	assert.equal(parseNestingDepth(undefined), 0);
	assert.equal(parseNestingDepth("0"), 0);
	assert.equal(parseNestingDepth("1"), 1);
	assert.equal(parseNestingDepth("2"), 2);
	for (const malformed of ["", "01", " 1", "-1", "3", "true"]) {
		assert.throws(() => parseNestingDepth(malformed), NestingError);
	}
});

test("root and depth-1 processes produce validated child depths", () => {
	assert.equal(spawnableDepth({}), 0);
	assert.equal(spawnableDepth({ [NESTING_ENV]: "0" }), 0);
	assert.equal(spawnableDepth({ [NESTING_ENV]: "1" }), 1);
	assert.throws(() => spawnableDepth({ [NESTING_ENV]: "2" }), NestingError);
	assert.equal(childDepthFor(0), 1);
	assert.equal(childDepthFor(1), 2);
	assert.deepEqual(childEnv(2, { KEEP: "yes", [NESTING_ENV]: "1" }), {
		KEEP: "yes",
		[NESTING_ENV]: "2",
	});
});

test("a successful child process fails when its final turn abandons a launched nested task", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dstack-unresolved-child-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "dstack_task", arguments: { task: "implement" } }],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			content: [{ type: "text", text: JSON.stringify({ taskId: "nested-repro", mode: "single", taskCount: 1 }) }],
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "I’m implementing and verifying now." }],
			stopReason: "stop",
		},
	];
	const script = `for (const message of ${JSON.stringify(messages)}) console.log(JSON.stringify({ type: "message_end", message }));`;
	const result = await runChildProcess({
		args: [],
		cwd: root,
		env: childEnv(1),
		invocation: { command: process.execPath, argsPrefix: ["--input-type=module", "-e", script] },
	});

	assert.equal(result.exitCode, 1);
	assert.equal(result.text, "I’m implementing and verifying now.");
	assert.match(
		result.errorMessage ?? "",
		/Child agent exited before collecting launched task nested-repro/,
	);
	assert.deepEqual(result.unresolvedTaskIds, ["nested-repro"]);
});

test("a failed on-spawn boundary kills the child before accepting JSON", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dstack-spawn-boundary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const script = [
		`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"must-not-be-read"}]}}) + "\\n");`,
		`setInterval(() => {}, 1000);`,
	].join("\n");
	let updates = 0;
	let stdoutChunks = 0;
	await assert.rejects(
		runChildProcess({
			args: [],
			cwd: root,
			env: childEnv(1),
			invocation: { command: process.execPath, argsPrefix: ["--input-type=module", "-e", script] },
			onSpawn: () => {
				throw new Error("lease binding failed");
			},
			onUpdate: () => { updates += 1; },
			onStdout: () => { stdoutChunks += 1; },
		}),
		/lease binding failed/,
	);
	assert.equal(updates, 0);
	assert.equal(stdoutChunks, 0);
});

test("child telemetry reports the concrete provider model", () => {
	const result: ChildResult = {
		text: "",
		exitCode: 0,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	applyJsonEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "router",
				model: "requested-model",
				responseModel: "concrete-model",
			},
		},
		{ messages: [], result },
	);
	assert.equal(result.model, "router/concrete-model");
});

test("child JSON events retain live text, tools, and nested agent updates", () => {
	const result: ChildResult = {
		text: "",
		exitCode: -1,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	const state = { messages: result.messages, result };
	assert.equal(
		applyJsonEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Checking the repository" },
						{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
					],
				},
			},
			state,
		),
		true,
	);
	assert.equal(result.text, "Checking the repository");
	assert.deepEqual(result.messages[0]?.content[1], {
		type: "toolCall",
		name: "read",
		arguments: { path: "README.md" },
	});
	const nestedUpdate = (exitCode: number, text: string) => ({
		type: "tool_execution_update",
		toolCallId: "nested-1",
		toolName: "dstack_task",
		partialResult: {
			content: [{ type: "text", text: "parallel: 1/2 done, 1 running..." }],
			details: { results: [{ agent: "poteto-agent", exitCode, text }] },
		},
	});
	assert.equal(applyJsonEvent(nestedUpdate(-1, "Inspecting files"), state), true);
	assert.equal(result.messages.length, 2);
	assert.equal(applyJsonEvent(nestedUpdate(0, "Done"), state), true);
	assert.equal(result.messages.length, 2);
	assert.deepEqual(result.messages[1]?.content[0], {
		type: "toolUpdate",
		id: "nested-1",
		name: "dstack_task",
		text: "parallel: 1/2 done, 1 running...",
		agents: [{ agent: "poteto-agent", exitCode: 0, text: "Done" }],
	});
	assert.equal(applyJsonEvent({ type: "message_update" }, state), false);
});

test("tool result usage accumulates without changing assistant state", () => {
	const result: ChildResult = {
		text: "assistant text",
		exitCode: 0,
		stderr: "",
		messages: [],
		stopReason: "stop",
		errorMessage: "existing error",
		model: "provider/model",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, contextTokens: 10, turns: 1 },
	};
	applyJsonEvent(
		{
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "nested-call-1",
				content: [],
				usage: {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					cost: { total: 1.25 },
				},
			},
		},
		{ messages: result.messages, result },
	);
	assert.deepEqual(result.usage, {
		input: 11,
		output: 22,
		cacheRead: 33,
		cacheWrite: 44,
		cost: 1.75,
		contextTokens: 10,
		turns: 1,
	});
	assert.equal(result.text, "assistant text");
	assert.equal(result.model, "provider/model");
	assert.equal(result.stopReason, "stop");
	assert.equal(result.errorMessage, "existing error");
	assert.equal(result.messages.length, 1);

	assert.equal(applyJsonEvent(
		{
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolCallId: "nested-call-1",
				content: [],
				usage: {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					cost: { total: 1.25 },
				},
			},
		},
		{ messages: result.messages, result },
	), false);
	assert.equal(result.usage.cost, 1.75);
	assert.equal(result.messages.length, 1);
});

test("assistant usage still updates the child result", () => {
	const result: ChildResult = {
		text: "",
		exitCode: 0,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	applyJsonEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "provider",
				responseModel: "model",
				stopReason: "stop",
				usage: {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					cost: { total: 1.25 },
				},
			},
		},
		{ messages: result.messages, result },
	);
	assert.deepEqual(result.usage, {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		cost: 1.25,
		contextTokens: 100,
		turns: 1,
	});
	assert.equal(result.text, "done");
	assert.equal(result.model, "provider/model");
	assert.equal(result.stopReason, "stop");
});

test("sumChildUsage returns undefined for all-zero usage", () => {
	assert.equal(sumChildUsage([
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 10, turns: 1 },
	]), undefined);
});

test("sumChildUsage sums token fields and total cost", () => {
	assert.deepEqual(
		sumChildUsage([
			{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25, contextTokens: 10, turns: 1 },
			{ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1.5, contextTokens: 100, turns: 2 },
		]),
		{
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.75 },
		},
	);
});

test("claimNestedUsage transfers terminal cancelled child usage once and repeated claims return none", () => {
	const record: NestedTaskRecord = {
		taskId: "nested-task-test",
		groupId: "g-1",
		mode: "single",
		createdAt: new Date().toISOString(),
		abortController: new AbortController(),
		children: [],
		status: "cancelled",
		collected: false,
		collectionRequested: false,
		readCount: 0,
		usageClaimed: false,
		completionPromise: Promise.resolve({ mode: "single", results: [] }),
		details: {
			mode: "single",
			results: [
				{
					agent: "general-purpose",
					cwd: "/tmp",
					task: "cancelled worker",
					text: "partial output",
					exitCode: 1,
					stderr: "aborted",
					messages: [],
					usage: { input: 120, output: 45, cacheRead: 10, cacheWrite: 5, cost: 0.0035, contextTokens: 500, turns: 2 },
				},
			],
		},
	};

	const firstClaim = claimNestedUsage(record);
	assert.deepEqual(firstClaim, {
		input: 120,
		output: 45,
		cacheRead: 10,
		cacheWrite: 5,
		totalTokens: 180,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0035 },
	});
	assert.equal(record.usageClaimed, true);

	const secondClaim = claimNestedUsage(record);
	assert.equal(secondClaim, undefined);
});

test("child usage reports model, tokens, context, turns, and cost", () => {
	assert.equal(
		formatUsageStats(
			{
				input: 12_400,
				output: 2_100,
				cacheRead: 8_700,
				cacheWrite: 1_200,
				cost: 0.084,
				contextTokens: 18_200,
				turns: 4,
			},
			"acme/agent-model",
		),
		"4 turns ↑12k ↓2.1k R8.7k W1.2k $0.0840 ctx:18k acme/agent-model",
	);
});

test("output cap 50 KiB", () => {
	const small = "ok";
	assert.equal(capOutput(small), small);
	const big = "a".repeat(PER_TASK_OUTPUT_CAP + 20);
	const capped = capOutput(big);
	assert.ok(Buffer.byteLength(capped, "utf8") > PER_TASK_OUTPUT_CAP);
	assert.ok(capped.includes("Output truncated"));
	assert.ok(Buffer.byteLength(capped.split("\n\n[Output truncated")[0] ?? "", "utf8") <= PER_TASK_OUTPUT_CAP);
});

test("default local concurrency runs all 12 tasks", async () => {
	let live = 0;
	let peak = 0;
	const items = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => i);
	const results = await mapWithConcurrency(items, MAX_CONCURRENCY, async (item) => {
		live += 1;
		peak = Math.max(peak, live);
		await new Promise((r) => setTimeout(r, 20));
		live -= 1;
		return item;
	});
	assert.deepEqual(results, items);
	assert.equal(peak, MAX_CONCURRENCY);
});

test("parseTaskRequest rejects too many tasks", () => {
	const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, () => ({ agent: "general-purpose", task: "x" }));
	const parsed = parseTaskRequest({ tasks });
	assert.ok("error" in parsed);
});

test("dmode false forces general-purpose", () => {
	assert.deepEqual(resolveAgent({ agent: "poteto-agent", task: "x", dmode: false }), {
		agent: "general-purpose",
		dmode: false,
		tools: undefined,
	});
	assert.equal(resolveAgent({ agent: "poteto-agent", task: "x" }).dmode, true);
	assert.equal(resolveAgent({ agent: "comment-sicko", task: "x" }).tools, "read,grep,find,ls");
});

test("substantive assistant report is preserved when hidden nested collection follow-up runs", () => {
	const result: ChildResult = {
		text: "",
		exitCode: 0,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	const state = { messages: result.messages, result };

	applyJsonEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Substantive report: All 5 requirements passed successfully." }],
				stopReason: "stop",
			},
		},
		state,
	);
	assert.equal(result.text, "Substantive report: All 5 requirements passed successfully.");

	applyJsonEvent(
		{
			type: "custom_message",
			customType: "dstack-nested-complete",
		},
		state,
	);

	applyJsonEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I have collected the nested task result." }],
				stopReason: "stop",
			},
		},
		state,
	);
	assert.equal(result.text, "Substantive report: All 5 requirements passed successfully.");

	const finalSynthesis = "Final synthesis after collection: all five requirements passed, including the nested worker result and focused verification.";
	applyJsonEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: finalSynthesis }],
				stopReason: "stop",
			},
		},
		state,
	);
	assert.equal(result.text, finalSynthesis);
});
