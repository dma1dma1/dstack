import assert from "node:assert/strict";
import { test } from "node:test";
import { latestActivity, type TaskResult } from "../extensions/dstack.ts";

function taskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		agent: "general-purpose",
		cwd: "/repo",
		task: "Inspect the repository",
		text: "",
		exitCode: -1,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

test("collapsed task activity stays on one concise line", () => {
	const result = taskResult({
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "First line\nSecond line\nThird line" },
					{ type: "toolCall", name: "read", arguments: { path: "extensions/dstack.ts", offset: 1 } },
				],
			},
		],
	});

	assert.equal(latestActivity(result), '→ read {"path":"extensions/dstack.ts","offset":1}');
	assert.equal(latestActivity(taskResult({ text: "Done\nwith details", exitCode: 0 })), "Done");
});

