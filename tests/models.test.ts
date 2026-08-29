import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig, resolveModel, resolveNestedLaunchModel, validateRoles } from "../extensions/models.ts";

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

test("role thinking level validates and resolves", () => {
	const valid = validateRoles(
		{
			feature: { model: "acme/fast", thinking: "high" },
			"hardest-tasks": { model: ["acme/fast", "acme/smart"], thinking: "max" },
		},
		new Set(["acme/fast", "acme/smart"]),
	);
	assert.equal(valid.ok, true);

	const invalidThinking = validateRoles(
		{ feature: { model: "acme/fast", thinking: "super-high" as never } },
		new Set(["acme/fast"]),
	);
	assert.equal(invalidThinking.ok, false);
	if (!invalidThinking.ok) assert.equal(invalidThinking.error.kind, "invalid-thinking");

	const invalidParse = parseConfig({
		roles: { feature: { model: "acme/fast", thinking: "super-high" } },
	});
	assert.equal(invalidParse.ok, false);
	if (!invalidParse.ok) assert.equal(invalidParse.error.kind, "invalid-thinking");

	const resolved = resolveModel({
		role: "feature",
		roles: { feature: { model: "acme/fast", thinking: "high" } },
	});
	assert.deepEqual(resolved, {
		ok: true,
		value: { model: "acme/fast", omitModel: false, thinking: "high", requestedRole: "feature" },
	});

	const resolvedArrayRole = resolveModel({
		role: "hardest-tasks",
		roles: { "hardest-tasks": { model: ["acme/fast", "acme/smart"], thinking: "minimal" } },
		candidateIndex: 1,
	});
	assert.deepEqual(resolvedArrayRole, {
		ok: true,
		value: { model: "acme/smart", omitModel: false, thinking: "minimal", requestedRole: "hardest-tasks", roleIndex: 1 },
	});
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

test("parseConfig reads worktree.from and scheduler.totalSlots", () => {
	const parsed = parseConfig({
		roles: { "bug-fix": "acme/fast" },
		scheduler: { totalSlots: 12 },
		worktree: { base: "~/.dma/worktrees", from: "origin/main" },
	});
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.value.scheduler.totalSlots, 12);
		assert.equal(parsed.value.worktree.from, "origin/main");
	}
	for (const totalSlots of [2, 65, 4.5]) {
		assert.equal(parseConfig({ scheduler: { totalSlots } }).ok, false);
	}
});

test("resolveNestedLaunchModel prefers resolved explicit model over env", () => {
	const model = resolveNestedLaunchModel({
		resolution: { model: "google/gemini-3.7-flash", omitModel: false },
		env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-3-5-sonnet" },
	});
	assert.equal(model, "google/gemini-3.7-flash");
});

test("resolveNestedLaunchModel extracts provider and model from environment when resolution omits model", () => {
	const model = resolveNestedLaunchModel({
		resolution: { omitModel: true },
		env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-3-7-sonnet" },
	});
	assert.equal(model, "anthropic/claude-3-7-sonnet");

	const alreadyPrefixed = resolveNestedLaunchModel({
		resolution: { omitModel: true },
		env: { PI_PROVIDER: "google", PI_MODEL: "google/gemini-2.5-pro" },
	});
	assert.equal(alreadyPrefixed, "google/gemini-2.5-pro");

	const differentProviderPrefix = resolveNestedLaunchModel({
		resolution: { omitModel: true },
		env: { PI_PROVIDER: "azure", PI_MODEL: "openai/gpt-4" },
	});
	assert.equal(differentProviderPrefix, "openai/gpt-4");
});

test("resolveNestedLaunchModel returns undefined when model resolution failed even if env is set", () => {
	const model = resolveNestedLaunchModel({
		resolution: undefined,
		env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-3-7-sonnet" },
	});
	assert.equal(model, undefined);
});

test("resolveNestedLaunchModel returns undefined when resolution omits model but env is incomplete or empty", () => {
	assert.equal(resolveNestedLaunchModel({ resolution: { omitModel: true }, env: { PI_PROVIDER: "", PI_MODEL: "gpt-4o" } }), undefined);
	assert.equal(resolveNestedLaunchModel({ resolution: { omitModel: true }, env: {} }), undefined);
	assert.equal(resolveNestedLaunchModel({ env: {} }), undefined);
});
