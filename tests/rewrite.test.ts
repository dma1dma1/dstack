import assert from "node:assert/strict";
import { test } from "node:test";
import { forbiddenHits, rewriteSkillText } from "../extensions/rewrite.ts";

const BEFORE = `---
name: Poteto Mode
---

Spawn with Task and subagent_type: "generalPurpose".
Use AskQuestion and TodoWrite.
Config lives at ~/.cursor/rules/pstack-models.mdc.
Run /setup-pstack.
Call move_agent_to_root after the tree is made.
readonly: true
run_in_background: true
environment: "cloud"
`;

test("rewrite dictionary fixtures: sample SKILL.md before/after", () => {
	const after = rewriteSkillText(BEFORE);
	assert.match(after, /name: dmode/);
	assert.match(after, /dstack_task/);
	assert.match(after, /agent: "general-purpose"/);
	assert.match(after, /dmode: false/);
	assert.match(after, /dstack_ask/);
	assert.match(after, /dstack_todo/);
	assert.match(after, /~\/\.pi\/agent\/dstack\/models\.json/);
	assert.match(after, /\/setup-dstack/);
	assert.match(after, /worktree cwd/);
	assert.match(after, /tools: "read,grep,find,ls"/);
	assert.equal(after.includes("run_in_background"), false);
	assert.equal(after.includes('environment: "cloud"'), false);
	assert.deepEqual(
		forbiddenHits(after).filter((h) => h.pattern !== "Task"),
		[],
	);
	assert.equal(
		forbiddenHits(after).some((h) => h.pattern === "AskQuestion" || h.pattern === "TodoWrite" || h.pattern === "subagent_type"),
		false,
	);
});
