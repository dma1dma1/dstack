import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv, NestingError, parseTaskRequest, spawnableDepth } from "../extensions/spawn.ts";
import { ASSIGNMENT_ENV, NESTING_ENV, type WorkflowContext } from "../extensions/types.ts";
import { parseWorkflowContext, workflowSystemPrompt } from "../extensions/workflow-context.ts";

const workflow: WorkflowContext = {
	playbook: "feature",
	assignment: "worker",
	phase: "implement-api",
	completedPhases: ["ground", "design"],
	artifacts: [{ name: "design", path: "/workspace/design.md", sha256: "a".repeat(64) }],
};

test("workflow context validates its boundary and round-trips through task parsing", () => {
	assert.deepEqual(parseWorkflowContext(workflow), workflow);
	assert.deepEqual(parseTaskRequest({ agent: "poteto-agent", task: "implement", workflow }), {
		kind: "single",
		spec: {
			agent: "poteto-agent",
			task: "implement",
			model: undefined,
			role: undefined,
			overrideReason: undefined,
			tools: undefined,
			cwd: undefined,
			worktree: undefined,
			dmode: undefined,
			workflow,
		},
	});
	assert.deepEqual(parseWorkflowContext({ ...workflow, phase: "Not A Slug" }), {
		error: "workflow.phase must be a lowercase slug.",
	});
	assert.deepEqual(parseWorkflowContext({ ...workflow, artifacts: [{ name: "design", path: "design.md" }] }), {
		error: "workflow.artifacts[0].path must be an absolute normalized path.",
	});
});

test("structured prompts give owners the playbook and workers only phase state", () => {
	const owner = workflowSystemPrompt("/plugin/skills/dmode/SKILL.md", 1, { ...workflow, assignment: "owner" });
	assert.match(owner, /depth-1 task owner/);
	assert.match(owner, /\/plugin\/skills\/dmode\/playbooks\/feature\.md/);
	assert.match(owner, /as many bounded batches/);

	const worker = workflowSystemPrompt("/plugin/skills/dmode/SKILL.md", 2, workflow);
	assert.match(worker, /terminal depth-2 worker/);
	assert.match(worker, /Current phase: implement-api/);
	assert.match(worker, /Completed phases: ground, design/);
	assert.match(worker, /\/workspace\/design\.md/);
	assert.match(worker, /Do not read dmode or a playbook/);
	assert.doesNotMatch(worker, /skills\/dmode\/SKILL\.md|playbooks\/feature\.md/);
});

test("worker and reviewer assignments are terminal even at depth 1", () => {
	for (const assignment of ["worker", "reviewer"] as const) {
		assert.throws(
			() => spawnableDepth({ [NESTING_ENV]: "1", [ASSIGNMENT_ENV]: assignment }),
			NestingError,
		);
		assert.equal(childEnv(2, {}, assignment)[ASSIGNMENT_ENV], assignment);
	}
	assert.equal(spawnableDepth({ [NESTING_ENV]: "1", [ASSIGNMENT_ENV]: "owner" }), 1);
	assert.equal(childEnv(2, { [ASSIGNMENT_ENV]: "worker" })[ASSIGNMENT_ENV], undefined);
});
