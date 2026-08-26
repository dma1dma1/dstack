import assert from "node:assert/strict";
import { test } from "node:test";
import { dmodeNestingGuidance, dmodeReminder, restoreMode, sameModeCommands, toggleMode } from "../extensions/mode.ts";
import { MODE_ENTRY } from "../extensions/types.ts";

test("dmode guidance matches the three nesting depths", () => {
	assert.match(dmodeNestingGuidance(0), /root depth 0.*routing each nontrivial request to a depth-1 task owner.*user's outcome.*task id.*final evidence.*trivial/s);
	assert.match(dmodeNestingGuidance(1), /depth 1 without structured workflow metadata.*final fan-out level.*distinct checkout.*Depth-2 workers are terminal/s);
	assert.match(dmodeNestingGuidance(2), /terminal depth-2 worker without structured workflow metadata.*Do not call dstack_task.*Complete the assigned scope directly/s);
});

test("root reminders require delegation without restricting terminal workers", () => {
	assert.match(dmodeReminder("/tmp/SKILL.md", 0), /Root routing section.*\/tmp\/SKILL\.md.*routing each nontrivial request.*trivial/s);
	assert.doesNotMatch(dmodeReminder("/tmp/SKILL.md", 1), /repository-context-intensive|trivial, low-context mechanical/);
	assert.doesNotMatch(dmodeReminder("/tmp/SKILL.md", 2), /repository-context-intensive|trivial, low-context mechanical/);
	assert.match(dmodeReminder("/tmp/SKILL.md", 2), /\/tmp\/SKILL\.md.*terminal depth-2/s);
});

test("dmode defaults on and restores the latest session flag", () => {
	assert.deepEqual(restoreMode([]), { on: true });
	assert.deepEqual(restoreMode([{ type: "custom", customType: MODE_ENTRY, data: { on: false } }]), { on: false });

	assert.deepEqual(sameModeCommands(), ["dmode", "poteto-mode"]);
	assert.deepEqual(toggleMode({ on: false }, ""), { on: true });
	assert.deepEqual(toggleMode({ on: true }, "off"), { on: false });
	assert.deepEqual(toggleMode({ on: false }, "on"), { on: true });
	const restored = restoreMode([
		{ type: "custom", customType: MODE_ENTRY, data: { on: true } },
		{ type: "custom", customType: MODE_ENTRY, data: { on: false } },
		{ type: "custom", customType: MODE_ENTRY, data: { on: true } },
	]);
	assert.deepEqual(restored, { on: true });
});
