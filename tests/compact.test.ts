import assert from "node:assert/strict";
import { test } from "node:test";
import { compactDetails, compactInstructions, restoreActiveWorkflow } from "../extensions/compact.ts";
import { ACTIVE_WORKFLOW_ENTRY } from "../extensions/types.ts";

const activeWorkflow = { taskId: "task-123", playbook: "feature" };

test("active owner state survives compaction without worker transcripts", () => {
	assert.deepEqual(compactDetails({ activeWorkflow }), { activeWorkflow });
	assert.match(compactInstructions({ activeWorkflow }), /task task-123, playbook feature/);
	assert.doesNotMatch(compactInstructions({ activeWorkflow }), /worker|transcript/i);
});

test("active owner state restores and a tombstone clears it", () => {
	assert.deepEqual(restoreActiveWorkflow([
		{ type: "custom", customType: ACTIVE_WORKFLOW_ENTRY, data: activeWorkflow },
	]), activeWorkflow);
	assert.equal(restoreActiveWorkflow([
		{ type: "custom", customType: ACTIVE_WORKFLOW_ENTRY, data: activeWorkflow },
		{ type: "custom", customType: ACTIVE_WORKFLOW_ENTRY, data: null },
	]), undefined);
});
