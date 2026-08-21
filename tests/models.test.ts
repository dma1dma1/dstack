import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig, resolveModel, validateRoles } from "../extensions/models.ts";

test("models.json rejects unknown slugs", () => {
	const result = validateRoles({ "how explorer": "acme/secret" }, new Set(["acme/fast"]));
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "unknown-slug");
});

test("inherit-parent and auto are always valid", () => {
	const result = validateRoles(
		{
			"how explorer": "inherit-parent",
			"how explainer": "auto",
		},
		new Set(),
	);
	assert.equal(result.ok, true);
});

test("critic panel of four inherit-parent is rejected", () => {
	const result = validateRoles(
		{
			"how critics": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
		},
		new Set(["acme/fast"]),
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "all-inherit-panel");
});

test("critic panel can mix inherit-parent with a real slug", () => {
	const result = validateRoles(
		{ "how critics": ["inherit-parent", "acme/fast"] },
		new Set(["acme/fast"]),
	);
	assert.equal(result.ok, true);
});

test("inherit-parent omits --model via resolveModel", () => {
	assert.deepEqual(
		resolveModel({ explicit: "inherit-parent", roles: {} }),
		{ omitModel: true },
	);
	assert.deepEqual(
		resolveModel({ role: "how explorer", roles: { "how explorer": "auto" } }),
		{ omitModel: true },
	);
	assert.deepEqual(
		resolveModel({ role: "how explorer", roles: { "how explorer": "acme/fast" } }),
		{ model: "acme/fast", omitModel: false },
	);
});

test("parseConfig reads worktree.from", () => {
	const parsed = parseConfig({
		roles: { "bug-fix": "acme/fast" },
		worktree: { base: "~/.dma/worktrees", from: "origin/main" },
	});
	assert.equal(parsed.ok, true);
	if (parsed.ok) assert.equal(parsed.value.worktree.from, "origin/main");
});
