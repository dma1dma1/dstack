import assert from "node:assert/strict";
import { test } from "node:test";
import { dmodeNestingGuidance, dmodeReminder, restoreMode, sameModeCommands, toggleMode } from "../extensions/mode.ts";
import { MODE_ENTRY } from "../extensions/types.ts";

test("dmode guidance matches the three nesting depths", () => {
	assert.match(dmodeNestingGuidance(0), /root depth 0.*Parallelize independent tasks.*distinct checkout.*Depth-1/s);
	assert.match(dmodeNestingGuidance(1), /depth 1.*final fan-out level.*distinct checkout.*Depth-2/s);
	assert.match(dmodeNestingGuidance(2), /terminal depth-2 worker.*Do not call dstack_task/s);
	assert.match(dmodeReminder("/tmp/SKILL.md", 2), /\/tmp\/SKILL\.md.*terminal depth-2/s);
});

test("/dmode and /poteto-mode set the same session flag", () => {
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
