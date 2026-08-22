import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { LIST_ROLES, ROLE_NAMES, type DstackConfig, type ListRoleName, type RoleValue } from "./types.ts";
import { emptyConfig, validateRoles } from "./models.ts";

const execFileAsync = promisify(execFile);

export const COMPANIONS = [
	{ need: "MCP", source: "npm:pi-mcp-adapter", optional: false },
	{ need: "Permission confirms", source: "npm:@gotgenes/pi-permission-system", optional: false },
	{ need: "Wake / background jobs", source: "npm:pi-background-tasks", optional: false },
	{ need: "Optional richer todos", source: "npm:@juicesharp/rpiv-todo", optional: true },
	{ need: "Optional richer questions", source: "npm:@juicesharp/rpiv-ask-user-question", optional: true },
	{ need: "Optional web", source: "npm:pi-web-access", optional: true },
] as const;

export const PERMISSION_CONFIG_RELATIVE = ".pi/agent/extensions/pi-permission-system/config.json";

export function permissionConfigPath(home = homedir()): string {
	return join(home, PERMISSION_CONFIG_RELATIVE);
}

export const SAFE_AUTO_PERMISSION_CONFIG = {
	yoloMode: false,
	permissionReviewLog: true,
	permission: {
		"*": "allow",
		read: "allow",
		grep: "allow",
		find: "allow",
		ls: "allow",
		write: "allow",
		edit: "allow",
		skill: { "*": "allow" },
		mcp: { "*": "allow" },
		path: {
			"*": "allow",
			"*.env": "deny",
			"*.env.*": "deny",
			"*.env.example": "allow",
			"~/.ssh/*": "deny",
			"**/id_rsa": "deny",
			"**/id_ed25519": "deny",
		},
		external_directory: "ask",
		bash: {
			"*": "allow",
			"sudo *": "ask",
			"chmod -R *": "ask",
			"chown -R *": "ask",
			"git push*": "ask",
			"git reset --hard*": "ask",
			"git clean *": "ask",
			"gt submit*": "ask",
			"gt merge*": "ask",
			"gh pr merge*": "ask",
			"npm publish*": "ask",
			"pnpm publish*": "ask",
			"kubectl apply*": "ask",
			"kubectl delete*": "ask",
			"terraform apply*": "ask",
			"terraform destroy*": "ask",
			"vercel deploy*": "ask",
			"docker push*": "ask",
			"docker system prune*": "ask",
			"rm -rf *": "deny",
			"rm -fr *": "deny",
			"mkfs *": "deny",
			"dd if=*": "deny",
		},
	},
} as const;

export async function ensurePermissionConfig(home = homedir()): Promise<"wrote" | "exists"> {
	const path = permissionConfigPath(home);
	try {
		await readFile(path, "utf8");
		return "exists";
	} catch {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(SAFE_AUTO_PERMISSION_CONFIG, null, 2)}\n`, "utf8");
		return "wrote";
	}
}

export type InstalledPackage = { source: string };

export function packageSourceName(source: string): string {
	return source.replace(/^npm:/, "").replace(/@.+$/, "");
}

export function companionStatus(
	packages: readonly InstalledPackage[],
): Array<{ need: string; source: string; optional: boolean; installed: boolean }> {
	const names = new Set(packages.map((p) => packageSourceName(p.source)));
	return COMPANIONS.map((c) => ({
		...c,
		installed: names.has(packageSourceName(c.source)),
	}));
}

export function installLines(
	status: ReturnType<typeof companionStatus>,
	missingOnly = true,
): string[] {
	return status
		.filter((s) => (missingOnly ? !s.installed : true))
		.map((s) => `pi install ${s.source}`);
}

export function formatCompanionReport(status: ReturnType<typeof companionStatus>): string {
	const lines = status.map((s) => {
		const mark = s.installed ? "ok" : s.optional ? "missing (optional)" : "missing";
		return `${s.need}: ${s.source} [${mark}]`;
	});
	const missing = installLines(status, true);
	if (missing.length > 0) {
		lines.push("", "Install missing companions:", ...missing);
	} else {
		lines.push("", "All listed companions are installed.");
	}
	return lines.join("\n");
}

export function requiredMissing(status: ReturnType<typeof companionStatus>): string[] {
	return status.filter((s) => !s.optional && !s.installed).map((s) => s.source);
}

export function optionalMissing(status: ReturnType<typeof companionStatus>): string[] {
	return status.filter((s) => s.optional && !s.installed).map((s) => s.source);
}

export type RunPi = (args: readonly string[]) => Promise<{ ok: boolean; text: string }>;

export async function defaultRunPi(args: readonly string[]): Promise<{ ok: boolean; text: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("pi", [...args], { encoding: "utf8" });
		return { ok: true, text: `${stdout}${stderr}`.trim() };
	} catch (err) {
		const error = err as Error & { stdout?: string; stderr?: string };
		return { ok: false, text: (error.stderr || error.stdout || error.message).trim() };
	}
}

export async function installCompanionSources(
	sources: readonly string[],
	run: RunPi = defaultRunPi,
): Promise<Array<{ source: string; ok: boolean; text: string }>> {
	const results: Array<{ source: string; ok: boolean; text: string }> = [];
	for (const source of sources) {
		const result = await run(["install", source]);
		results.push({ source, ok: result.ok, text: result.text });
	}
	return results;
}

export function formatInstallResults(results: ReadonlyArray<{ source: string; ok: boolean; text: string }>): string {
	if (results.length === 0) return "Required companions were already installed.";
	return results
		.map((r) => `${r.ok ? "installed" : "failed"} ${r.source}${r.text ? ` (${r.text.slice(0, 160)})` : ""}`)
		.join("\n");
}

export async function loadSettingsPackages(home = homedir()): Promise<InstalledPackage[]> {
	try {
		const raw = JSON.parse(await readFile(join(home, ".pi/agent/settings.json"), "utf8")) as unknown;
		return parseSettingsPackages(raw);
	} catch {
		return [];
	}
}

export function parseSettingsPackages(raw: unknown): InstalledPackage[] {
	if (raw === null || typeof raw !== "object") return [];
	const packages = (raw as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return [];
	const out: InstalledPackage[] = [];
	for (const item of packages) {
		if (typeof item === "string") out.push({ source: item });
		else if (item && typeof item === "object" && typeof (item as { source?: unknown }).source === "string") {
			out.push({ source: (item as { source: string }).source });
		}
	}
	return out;
}

export type ModelKind = "fast" | "judgment" | "instruction" | "other";

export function isListRole(role: string): role is ListRoleName {
	return (LIST_ROLES as readonly string[]).includes(role);
}

export function formatRoleValue(value: RoleValue): string {
	return Array.isArray(value) ? value.join(", ") : value;
}

export function formatSetupSummary(config: DstackConfig): string {
	const lines = ROLE_NAMES.filter((role) => config.roles[role] !== undefined).map(
		(role) => `${role}: ${formatRoleValue(config.roles[role] as RoleValue)}`,
	);
	lines.push(`worktree.from: ${config.worktree.from}`);
	return lines.join("\n");
}

export function modelId(slug: string): string {
	const slash = slug.indexOf("/");
	return slash === -1 ? slug : slug.slice(slash + 1);
}

export function familyKey(slug: string): string {
	const id = modelId(slug)
		.replace(/-\d{8}$/, "")
		.replace(/-thinking.*$/i, "")
		.replace(/-preview.*$/i, "");
	const slash = slug.indexOf("/");
	const provider = slash === -1 ? "" : slug.slice(0, slash);
	return provider ? `${provider}/${id}` : id;
}

export function preferSlug(left: string, right: string): string {
	const leftDated = /-\d{8}$/.test(modelId(left));
	const rightDated = /-\d{8}$/.test(modelId(right));
	if (leftDated !== rightDated) return leftDated ? right : left;
	return left.length <= right.length ? left : right;
}

export function dedupeSlugs(slugs: readonly string[]): string[] {
	const byFamily = new Map<string, string>();
	for (const slug of slugs) {
		const key = familyKey(slug);
		const prev = byFamily.get(key);
		byFamily.set(key, prev ? preferSlug(prev, slug) : slug);
	}
	return [...byFamily.values()];
}

export function classifySlug(slug: string): ModelKind {
	const id = modelId(slug).toLowerCase();
	if (/(haiku|flash|mini|nano|lite|grok|composer-2)/.test(id)) return "fast";
	if (/(opus|fable|sonnet|o1|o3|claude-4|claude-3-7)/.test(id)) return "judgment";
	if (/(gpt|codex|sol)/.test(id)) return "instruction";
	return "other";
}

export function pickKind(slugs: readonly string[], kind: ModelKind): string | undefined {
	return slugs.find((slug) => classifySlug(slug) === kind);
}

export function suggestPanel(slugs: readonly string[]): string[] {
	const catalog = dedupeSlugs(slugs);
	const picks: string[] = [];
	for (const kind of ["judgment", "instruction", "fast", "other"] as const) {
		const hit = catalog.find((slug) => classifySlug(slug) === kind && !picks.includes(slug));
		if (hit) picks.push(hit);
	}
	for (const slug of catalog) {
		if (picks.length >= 4) break;
		if (!picks.includes(slug)) picks.push(slug);
	}
	if (picks.length === 1) picks.push("inherit-parent");
	if (picks.length === 0) picks.push("inherit-parent", "auto");
	return picks.slice(0, 4);
}

export function suggestConfig(slugs: readonly string[], current: DstackConfig = emptyConfig()): DstackConfig {
	const catalog = dedupeSlugs(slugs);
	const fast = pickKind(catalog, "fast") ?? "inherit-parent";
	const instruction = pickKind(catalog, "instruction") ?? fast;
	const judgment = pickKind(catalog, "judgment") ?? instruction;
	const panel = suggestPanel(catalog);
	const roles: DstackConfig["roles"] = {
		"feature, refactoring": fast,
		"bug-fix": instruction,
		"perf-issue": instruction,
		hillclimb: instruction,
		"judgment and prose": judgment,
		"hardest tasks": judgment,
		"how explorer": fast,
		"how explainer": judgment,
		"how critics": panel,
		"why investigators": fast,
		"why synthesizer": judgment,
		"reflect tooling": instruction,
		"reflect judgment, divergent, synthesizer": judgment,
		"arena runners": panel,
		"arena cross-judge pool": panel,
		"swarm workers": fast,
		"architect runners": panel,
		"interrogate reviewers": panel,
	};
	const valid = validateRoles(roles, new Set(slugs));
	return {
		roles: valid.ok ? valid.value : roles,
		worktree: { ...current.worktree },
	};
}

export function formatCatalog(slugs: readonly string[]): string {
	return dedupeSlugs(slugs)
		.map((slug) => `${slug} (${classifySlug(slug)})`)
		.join("\n");
}

export function formatSetupKickoff(input: {
	rawCount: number;
	catalog: readonly string[];
	suggestion: DstackConfig;
	current: DstackConfig;
	companions?: string;
}): string {
	const hasCurrent = ROLE_NAMES.some((role) => input.current.roles[role] !== undefined);
	const currentBlock = hasCurrent
		? `Current models.json:\n${formatSetupSummary(input.current)}`
		: "No models.json yet.";
	return [
		"I ran /setup-dstack. Do not open a model picker and do not dump the raw registry.",
		"",
		`I have ${input.rawCount} models. After collapsing dated and thinking variants, use this catalog:`,
		formatCatalog(input.catalog),
		"",
		"Suggested mapping from that catalog:",
		formatSetupSummary(input.suggestion),
		"",
		currentBlock,
		"",
		input.companions ? `Companions:\n${input.companions}\n` : "",
		"Read skills/setup-dstack/SKILL.md. Show the suggestion in short prose. Let me change it in plain language.",
		"When I accept, write the full file with dstack_config action=write.",
		"Only use slugs from the catalog, plus inherit-parent and auto. A panel of only inherit-parent/auto is invalid.",
		"Offer optional companions that are still missing. Do not install those unless I ask.",
	]
		.filter((line) => line !== "")
		.join("\n");
}
