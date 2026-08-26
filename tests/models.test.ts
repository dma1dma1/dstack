import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig, resolveModel, validateRoles } from "../extensions/models.ts";

test("models.json rejects unknown slugs", () => {
	const result = validateRoles({ "how-explorer": "acme/secret" }, new Set(["acme/fast"]));
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "unknown-slug");
});

test("inherit-parent and auto are always valid", () => {
	const result = validateRoles(
		{
			"how-explorer": "inherit-parent",
			"how-explainer": "auto",
		},
		new Set(),
	);
	assert.equal(result.ok, true);
});

test("critic panel of four inherit-parent is rejected", () => {
	const result = validateRoles(
		{
			"how-critics": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
		},
		new Set(["acme/fast"]),
	);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "all-inherit-panel");
});

test("critic panel can mix inherit-parent with a real slug", () => {
	const result = validateRoles(
		{ "how-critics": ["inherit-parent", "acme/fast"] },
		new Set(["acme/fast"]),
	);
	assert.equal(result.ok, true);
});

test("inherit-parent omits --model via resolveModel", () => {
	assert.deepEqual(
		resolveModel({ explicit: "inherit-parent", roles: {} }),
		{ ok: true, value: { omitModel: true } },
	);
	assert.deepEqual(
		resolveModel({ role: "how-explorer", roles: { "how-explorer": "auto" } }),
		{ ok: true, value: { omitModel: true, requestedRole: "how-explorer" } },
	);
	assert.deepEqual(
		resolveModel({ role: "how-explorer", roles: { "how-explorer": "acme/fast" } }),
		{ ok: true, value: { model: "acme/fast", omitModel: false, requestedRole: "how-explorer" } },
	);
});

test("feature role resolves its configured model", () => {
	const result = resolveModel({ role: "feature", roles: { feature: "google/gemini-3.7-flash" } });
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.value.model, "google/gemini-3.7-flash");
});

test("unknown role fails closed with the nearest configured role", () => {
	const result = resolveModel({
		role: "architect runners",
		roles: { "architect-runners": ["acme/one", "acme/two"] },
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error.kind, "unknown-role");
		if (result.error.kind === "unknown-role") assert.equal(result.error.suggestion, "architect-runners");
	}
});

test("list roles rotate across parallel candidate indexes", () => {
	const roles = { "arena-runners": ["acme/one", "beta/two", "gamma/three"] };
	const results = [0, 1, 2].map((candidateIndex) =>
		resolveModel({ role: "arena-runners", roles, candidateIndex }),
	);
	assert.deepEqual(
		results.map((result) => result.ok ? result.value.model : undefined),
		["acme/one", "beta/two", "gamma/three"],
	);
	assert.deepEqual(
		results.map((result) => result.ok ? result.value.roleIndex : undefined),
		[0, 1, 2],
	);
});

test("explicit model requires a reason when overriding a role", () => {
	const roles = { feature: "acme/feature" };
	const rejected = resolveModel({ explicit: "x/y", role: "feature", roles });
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.equal(rejected.error.kind, "override-without-reason");

	const accepted = resolveModel({ explicit: "x/y", role: "feature", roles, overrideReason: "Comparison run" });
	assert.equal(accepted.ok, true);
	if (accepted.ok) assert.equal(accepted.value.model, "x/y");
});

test("loadConfig migrates legacy role names", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "dstack-models-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "models.json");
	await writeFile(path, JSON.stringify({ roles: { "hardest tasks": "acme/smart" } }), "utf8");
	const loaded = await loadConfig(path);
	assert.equal(loaded.ok, true);
	if (loaded.ok) {
		assert.equal(loaded.value.roles["hardest-tasks"], "acme/smart");
		assert.equal(loaded.value.roles["hardest tasks"], undefined);
	}
});

test("parseConfig reads worktree.from", () => {
	const parsed = parseConfig({
		roles: { "bug-fix": "acme/fast" },
		worktree: { base: "~/.dma/worktrees", from: "origin/main" },
	});
	assert.equal(parsed.ok, true);
	if (parsed.ok) assert.equal(parsed.value.worktree.from, "origin/main");
});
