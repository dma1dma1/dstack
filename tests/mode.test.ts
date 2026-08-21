import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreMode, sameModeCommands, toggleMode } from "../extensions/mode.ts";
import { MODE_ENTRY } from "../extensions/types.ts";

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
