import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyConfig, validateRoles } from "../extensions/models.ts";
import {
	classifySlug,
	companionStatus,
	dedupeSlugs,
	ensurePermissionConfig,
	formatSetupKickoff,
	installCompanionSources,
	permissionConfigPath,
	requiredMissing,
	SAFE_AUTO_PERMISSION_CONFIG,
	suggestConfig,
	suggestPanel,
} from "../extensions/setup.ts";

test("dedupe keeps the undated slug over a dated twin", () => {
	assert.deepEqual(
		dedupeSlugs(["anthropic/claude-haiku-4-5-20251001", "anthropic/claude-haiku-4-5"]),
		["anthropic/claude-haiku-4-5"],
	);
});

test("classify maps haiku, opus, and sol", () => {
	assert.equal(classifySlug("anthropic/claude-haiku-4-5"), "fast");
	assert.equal(classifySlug("anthropic/claude-opus-4-5"), "judgment");
	assert.equal(classifySlug("anthropic/claude-fable-5"), "judgment");
	assert.equal(classifySlug("openai/gpt-5.6-sol"), "instruction");
});

test("suggestConfig uses fast for explorers and judgment for prose", () => {
	const slugs = [
		"anthropic/claude-haiku-4-5",
		"anthropic/claude-haiku-4-5-20251001",
		"anthropic/claude-fable-5",
		"anthropic/claude-opus-4-5",
	];
	const suggested = suggestConfig(slugs, emptyConfig());
	assert.equal(suggested.roles["how-explorer"], "anthropic/claude-haiku-4-5");
	assert.equal(suggested.roles.judgment, "anthropic/claude-fable-5");
	assert.equal(suggested.roles.prose, "anthropic/claude-fable-5");
	assert.deepEqual(suggested.roles["how-critics"], [
		"anthropic/claude-fable-5",
		"anthropic/claude-haiku-4-5",
		"anthropic/claude-opus-4-5",
	]);
	const valid = validateRoles(suggested.roles, new Set(slugs));
	assert.equal(valid.ok, true);
});

test("suggestPanel does not emit four dated copies of one family", () => {
	const panel = suggestPanel([
		"anthropic/claude-haiku-4-5",
		"anthropic/claude-haiku-4-5-20251001",
		"anthropic/claude-opus-4-5",
	]);
	assert.ok(panel.length >= 2 && panel.length <= 4);
	assert.ok(panel.includes("anthropic/claude-opus-4-5"));
	assert.equal(panel.filter((s) => s.includes("haiku")).length, 1);
});

test("kickoff includes the suggestion and forbids a raw dump", () => {
	const suggestion = suggestConfig(["acme/fast", "acme/smart"], emptyConfig());
	const text = formatSetupKickoff({
		rawCount: 40,
		catalog: ["acme/fast", "acme/smart"],
		suggestion,
		current: emptyConfig(),
	});
	assert.match(text, /Do not open a model picker/);
	assert.match(text, /40 models/);
	assert.match(text, /how-explorer:/);
	assert.doesNotMatch(text, /Write dstack models.json/);
});

test("required companions are the three host packages", () => {
	const status = companionStatus([]);
	assert.deepEqual(requiredMissing(status), [
		"npm:pi-mcp-adapter",
		"npm:@gotgenes/pi-permission-system",
		"npm:pi-background-tasks",
	]);
	assert.deepEqual(requiredMissing(companionStatus([{ source: "npm:pi-mcp-adapter" }])), [
		"npm:@gotgenes/pi-permission-system",
		"npm:pi-background-tasks",
	]);
});

test("installCompanionSources runs pi install once per missing source", async () => {
	const calls: string[][] = [];
	const results = await installCompanionSources(["npm:pi-mcp-adapter", "npm:pi-background-tasks"], async (args) => {
		calls.push([...args]);
		return { ok: true, text: "Installed" };
	});
	assert.deepEqual(calls, [
		["install", "npm:pi-mcp-adapter"],
		["install", "npm:pi-background-tasks"],
	]);
	assert.equal(results.every((r) => r.ok), true);
});

test("safe-auto policy allows routine bash and denies rm -rf", () => {
	assert.equal(SAFE_AUTO_PERMISSION_CONFIG.yoloMode, false);
	assert.equal(SAFE_AUTO_PERMISSION_CONFIG.permission.bash["*"], "allow");
	assert.equal(SAFE_AUTO_PERMISSION_CONFIG.permission.bash["git push*"], "ask");
	assert.equal(SAFE_AUTO_PERMISSION_CONFIG.permission.bash["rm -rf *"], "deny");
	assert.equal(SAFE_AUTO_PERMISSION_CONFIG.permission.external_directory, "ask");
});

test("ensurePermissionConfig writes once and leaves an existing file", async () => {
	const home = await mkdtemp(join(tmpdir(), "dstack-perm-"));
	const path = permissionConfigPath(home);
	assert.equal(await ensurePermissionConfig(home), "wrote");
	const first = await readFile(path, "utf8");
	assert.match(first, /git push\*/);
	await mkdir(join(home, ".pi/agent/extensions/pi-permission-system"), { recursive: true });
	await writeFile(path, '{"yoloMode":true}\n', "utf8");
	assert.equal(await ensurePermissionConfig(home), "exists");
	assert.equal(await readFile(path, "utf8"), '{"yoloMode":true}\n');
});
