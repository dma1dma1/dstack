import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyJsonEvent,
	buildChildArgv,
	capOutput,
	childDepthFor,
	childEnv,
	formatUsageStats,
	mapWithConcurrency,
	NestingError,
	parseNestingDepth,
	parseTaskRequest,
	PER_TASK_OUTPUT_CAP,
	resolveAgent,
	spawnableDepth,
	type ChildResult,
} from "../extensions/spawn.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, NESTING_ENV } from "../extensions/types.ts";

const extensionPath = "/opt/dstack/extensions/dstack.ts";

function childArgv(input: Omit<Parameters<typeof buildChildArgv>[0], "extensionPath">) {
	return buildChildArgv({ ...input, extensionPath });
}

test("spawn argv isolates extensions and loads dstack explicitly", () => {
	const args = childArgv({ task: "look around", model: "acme/fast", tools: "read,grep,find,ls" });
	assert.deepEqual(args.slice(0, 7), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"-e",
		extensionPath,
	]);
	assert.equal(args.filter((arg) => arg === "-e").length, 1);
	assert.ok(args.includes("--model"));
	assert.equal(args[args.indexOf("--model") + 1], "acme/fast");
	assert.ok(args.includes("--tools"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
	assert.equal(args.at(-1), "Task: look around");
});

test("inherit-parent omits --model", () => {
	const args = childArgv({ task: "x", omitModel: true, model: "acme/fast" });
	assert.equal(args.includes("--model"), false);
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

test("child telemetry reports the concrete provider model", () => {
	const result: ChildResult = {
		text: "",
		exitCode: 0,
		stderr: "",
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

test("concurrency 4 for 8 tasks", async () => {
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
	const tasks = Array.from({ length: 9 }, () => ({ agent: "general-purpose", task: "x" }));
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
