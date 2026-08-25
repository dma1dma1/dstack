import assert from "node:assert/strict";
import { test } from "node:test";
import {
	continuationPrompt,
	latestActiveTodoTasks,
	shouldArmContinuation,
	type TodoBranchEntry,
} from "../extensions/continuation.ts";

function todoResult(tasks: unknown, isError = false): TodoBranchEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "todo",
			isError,
			details: { tasks },
		},
	};
}

test("latestActiveTodoTasks uses the newest successful todo snapshot", () => {
	const tasks = latestActiveTodoTasks([
		todoResult([{ id: 1, subject: "Old task", status: "in_progress" }]),
		{ type: "message", message: { role: "assistant" } },
		todoResult([
			{ id: 1, subject: "Old task", status: "completed" },
			{ id: 2, subject: "Implement continuation", status: "in_progress", activeForm: "implementing" },
			{ id: 3, subject: "Test continuation", status: "pending" },
			{ id: 4, subject: "Removed", status: "deleted" },
		]),
	]);

	assert.deepEqual(tasks, [
		{ id: 2, subject: "Implement continuation", status: "in_progress", activeForm: "implementing" },
		{ id: 3, subject: "Test continuation", status: "pending" },
	]);
});

test("latestActiveTodoTasks ignores a failed newer todo call", () => {
	assert.deepEqual(
		latestActiveTodoTasks([
			todoResult([{ id: 1, subject: "Keep working", status: "pending" }]),
			todoResult([], true),
		]),
		[{ id: 1, subject: "Keep working", status: "pending" }],
	);
});

test("continuation only arms for settled work without queued messages", () => {
	const tasks = [{ id: 1, subject: "Keep working", status: "pending" as const }];
	assert.equal(shouldArmContinuation(tasks, { isIdle: true, hasPendingMessages: false }), true);
	assert.equal(shouldArmContinuation(tasks, { isIdle: false, hasPendingMessages: false }), false);
	assert.equal(shouldArmContinuation(tasks, { isIdle: true, hasPendingMessages: true }), false);
	assert.equal(shouldArmContinuation([], { isIdle: true, hasPendingMessages: false }), false);
});

test("continuation prompt tells the model to resume concrete tasks", () => {
	const prompt = continuationPrompt([
		{ id: 3, subject: "Implement continuation", status: "in_progress", activeForm: "implementing" },
	]);
	assert.match(prompt, /Resume the work now/);
	assert.match(prompt, /#3 \[in_progress\] Implement continuation — implementing/);
});
