import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDockLines, latestActivity, type TaskDetails, type TaskResult } from "../extensions/dstack.ts";

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

test("agent dock shows active children without copying nested output", () => {
	const details: TaskDetails = {
		mode: "parallel",
		results: [
			taskResult({
				messages: [
					{
						role: "activity",
						content: [
							{
								type: "toolUpdate",
								id: "nested-1",
								name: "dstack_task",
								text: "parallel: 1/2 done, 1 running...\nlarge nested output must stay hidden",
								agents: [{ agent: "poteto-agent", exitCode: -1, text: "many lines" }],
							},
						],
					},
				],
			}),
			taskResult({ agent: "comment-sicko", exitCode: 0, text: "Review complete" }),
		],
	};

	assert.deepEqual(agentDockLines([details]), [
		"dstack agents  1 running",
		"  ⏳ general-purpose  ↳ dstack_task: parallel: 1/2 done, 1 running...",
		"  ✓ comment-sicko  Review complete",
	]);
});
