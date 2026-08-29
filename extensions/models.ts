import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_TOTAL_SLOTS,
	DEFAULT_WORKTREE_BASE,
	LIST_ROLES,
	MAX_TOTAL_SLOTS,
	MIN_TOTAL_SLOTS,
	MODEL_ALIASES,
	THINKING_LEVELS,
	type DstackConfig,
	type ModelRef,
	type RoleValue,
	type ThinkingLevel,
	type WorktreeFrom,
} from "./types.ts";

export const CONFIG_RELATIVE = ".pi/agent/dstack/models.json";

export function defaultConfigPath(home = homedir()): string {
	return join(home, CONFIG_RELATIVE);
}

export function isAlias(value: string): value is (typeof MODEL_ALIASES)[number] {
	return (MODEL_ALIASES as readonly string[]).includes(value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function knownSlugSet(slugs: readonly string[]): Set<string> {
	return new Set(slugs);
}

export type ConfigError =
	| { kind: "unknown-slug"; slug: string }
	| { kind: "unknown-role"; role: string; suggestion?: string }
	| { kind: "override-without-reason"; role: string }
	| { kind: "all-inherit-panel"; role: string }
	| { kind: "invalid-thinking"; role: string; thinking: string }
	| { kind: "invalid-json"; message: string }
	| { kind: "invalid-shape"; message: string };

export type ConfigResult<T> = { ok: true; value: T } | { ok: false; error: ConfigError };

function asModelRef(value: unknown): ModelRef | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return value.trim();
}

export function parseRoleValue(value: unknown): RoleValue | undefined {
	if (typeof value === "string") {
		return asModelRef(value);
	}
	if (Array.isArray(value)) {
		const refs = value.map(asModelRef);
		if (refs.some((r) => r === undefined)) return undefined;
		return refs as ModelRef[];
	}
	if (typeof value === "object" && value !== null) {
		const obj = value as Record<string, unknown>;
		if (!("model" in obj)) return undefined;
		const parsedModel = parseRoleValue(obj.model);
		if (parsedModel === undefined || (typeof parsedModel === "object" && !Array.isArray(parsedModel))) {
			return undefined;
		}
		const thinkingRaw = obj.thinking;
		if (thinkingRaw !== undefined) {
			if (!isThinkingLevel(thinkingRaw)) return undefined;
			return {
				model: parsedModel as ModelRef | ModelRef[],
				thinking: thinkingRaw,
			};
		}
		return {
			model: parsedModel as ModelRef | ModelRef[],
		};
	}
	return undefined;
}

function parseFrom(value: unknown): WorktreeFrom {
	return value === "origin/main" ? "origin/main" : "HEAD";
}

export function emptyConfig(): DstackConfig {
	return {
		roles: {},
		scheduler: { totalSlots: DEFAULT_TOTAL_SLOTS },
		worktree: { base: DEFAULT_WORKTREE_BASE, from: "HEAD" },
	};
}

export function parseConfig(raw: unknown): ConfigResult<DstackConfig> {
	if (raw === null || typeof raw !== "object") {
		return { ok: false, error: { kind: "invalid-shape", message: "config must be an object" } };
	}
	const obj = raw as Record<string, unknown>;
	const rolesIn = obj.roles;
	const roles: Record<string, RoleValue> = {};
	if (rolesIn !== undefined) {
		if (rolesIn === null || typeof rolesIn !== "object" || Array.isArray(rolesIn)) {
			return { ok: false, error: { kind: "invalid-shape", message: "roles must be an object" } };
		}
		for (const [name, value] of Object.entries(rolesIn)) {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const objVal = value as Record<string, unknown>;
				if ("thinking" in objVal && objVal.thinking !== undefined && !isThinkingLevel(objVal.thinking)) {
					return {
						ok: false,
						error: {
							kind: "invalid-thinking",
							role: name,
							thinking: String(objVal.thinking),
						},
					};
				}
			}
			const parsed = parseRoleValue(value);
			if (parsed === undefined) {
				return { ok: false, error: { kind: "invalid-shape", message: `invalid role value for ${name}` } };
			}
			roles[name] = parsed;
		}
	}
	const schedulerIn = obj.scheduler;
	let scheduler = emptyConfig().scheduler;
	if (schedulerIn !== undefined) {
		if (schedulerIn === null || typeof schedulerIn !== "object" || Array.isArray(schedulerIn)) {
			return { ok: false, error: { kind: "invalid-shape", message: "scheduler must be an object" } };
		}
		const totalSlots = (schedulerIn as Record<string, unknown>).totalSlots;
		if (!Number.isSafeInteger(totalSlots) || (totalSlots as number) < MIN_TOTAL_SLOTS || (totalSlots as number) > MAX_TOTAL_SLOTS) {
			return {
				ok: false,
				error: {
					kind: "invalid-shape",
					message: `scheduler.totalSlots must be an integer from ${MIN_TOTAL_SLOTS} to ${MAX_TOTAL_SLOTS}`,
				},
			};
		}
		scheduler = { totalSlots: totalSlots as number };
	}
	const worktreeIn = obj.worktree;
	let worktree = emptyConfig().worktree;
	if (worktreeIn !== undefined) {
		if (worktreeIn === null || typeof worktreeIn !== "object" || Array.isArray(worktreeIn)) {
			return { ok: false, error: { kind: "invalid-shape", message: "worktree must be an object" } };
		}
		const wt = worktreeIn as Record<string, unknown>;
		worktree = {
			base: typeof wt.base === "string" && wt.base.trim() ? wt.base : DEFAULT_WORKTREE_BASE,
			from: parseFrom(wt.from),
		};
	}
	return { ok: true, value: { roles, scheduler, worktree } };
}

export function refsOf(value: RoleValue): ModelRef[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value;
	if (typeof value === "object" && value !== null && "model" in value) {
		return Array.isArray(value.model) ? value.model : [value.model];
	}
	return [];
}

export function thinkingOf(value: RoleValue | undefined): ThinkingLevel | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value) && "thinking" in value) {
		return isThinkingLevel(value.thinking) ? value.thinking : undefined;
	}
	return undefined;
}

const LEGACY_ROLE_NAMES: Readonly<Record<string, readonly string[]>> = {
	"feature, refactoring": ["feature", "refactoring"],
	"judgment and prose": ["judgment", "prose"],
	"hardest tasks": ["hardest-tasks"],
	"how explorer": ["how-explorer"],
	"how explainer": ["how-explainer"],
	"how critics": ["how-critics"],
	"why investigators": ["why-investigators"],
	"why synthesizer": ["why-synthesizer"],
	"reflect tooling": ["reflect-tooling"],
	"reflect judgment, divergent, synthesizer": ["reflect-judgment", "reflect-divergent", "reflect-synthesizer"],
	"arena runners": ["arena-runners"],
	"arena cross-judge pool": ["arena-cross-judge-pool"],
	"swarm workers": ["swarm-workers"],
	"architect runners": ["architect-runners"],
	"interrogate reviewers": ["interrogate-reviewers"],
};

function migrateLegacyRoles(roles: Record<string, RoleValue>): Record<string, RoleValue> {
	const migrated: Record<string, RoleValue> = {};
	for (const [role, value] of Object.entries(roles)) {
		if (LEGACY_ROLE_NAMES[role] === undefined) migrated[role] = value;
	}
	for (const [role, value] of Object.entries(roles)) {
		for (const replacement of LEGACY_ROLE_NAMES[role] ?? []) {
			if (migrated[replacement] === undefined) migrated[replacement] = value;
		}
	}
	return migrated;
}

function levenshtein(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
		const current = [leftIndex + 1];
		for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
			const substitution = previous[rightIndex] as number;
			current.push(Math.min(
				(current[rightIndex] as number) + 1,
				(previous[rightIndex + 1] as number) + 1,
				substitution + (left[leftIndex] === right[rightIndex] ? 0 : 1),
			));
		}
		previous = current;
	}
	return previous[right.length] as number;
}

function nearestRole(role: string, configuredRoles: readonly string[]): string | undefined {
	let nearest: string | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of configuredRoles) {
		const distance = levenshtein(role, candidate);
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	return nearest;
}

export function validateRoles(
	roles: Record<string, RoleValue>,
	knownSlugs: ReadonlySet<string>,
): ConfigResult<Record<string, RoleValue>> {
	for (const [role, value] of Object.entries(roles)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
				return { ok: false, error: { kind: "invalid-thinking", role, thinking: String(value.thinking) } };
			}
		}
		const refs = refsOf(value);
		if (refs.length === 0) {
			return { ok: false, error: { kind: "invalid-shape", message: `role "${role}" has no models configured` } };
		}
		for (const ref of refs) {
			if (!isAlias(ref) && !knownSlugs.has(ref)) {
				return { ok: false, error: { kind: "unknown-slug", slug: ref } };
			}
		}
		if ((LIST_ROLES as readonly string[]).includes(role) && refs.length > 0 && refs.every((r) => isAlias(r))) {
			return { ok: false, error: { kind: "all-inherit-panel", role } };
		}
	}
	return { ok: true, value: roles };
}

export function resolveModel(input: {
	explicit?: string;
	role?: string;
	roles: Record<string, RoleValue>;
	candidateIndex?: number;
	overrideReason?: string;
}): ConfigResult<{
	model?: string;
	omitModel: boolean;
	thinking?: ThinkingLevel;
	requestedRole?: string;
	roleIndex?: number;
}> {
	if (input.role !== undefined && !Object.hasOwn(input.roles, input.role)) {
		return {
			ok: false,
			error: {
				kind: "unknown-role",
				role: input.role,
				suggestion: nearestRole(input.role, Object.keys(input.roles)),
			},
		};
	}
	const roleValue = input.role !== undefined ? input.roles[input.role] : undefined;
	const thinking = thinkingOf(roleValue);
	const thinkingProp = thinking !== undefined ? { thinking } : {};

	if (input.explicit) {
		if (input.role !== undefined && !input.overrideReason?.trim()) {
			return { ok: false, error: { kind: "override-without-reason", role: input.role } };
		}
		const requestedRole = input.role === undefined ? {} : { requestedRole: input.role };
		if (isAlias(input.explicit)) return { ok: true, value: { omitModel: true, ...requestedRole, ...thinkingProp } };
		return { ok: true, value: { model: input.explicit, omitModel: false, ...requestedRole, ...thinkingProp } };
	}
	if (input.role === undefined) return { ok: true, value: { omitModel: true, ...thinkingProp } };
	const value = input.roles[input.role];
	const refs = refsOf(value);
	if (Array.isArray(value) || (typeof value === "object" && value !== null && Array.isArray(value.model))) {
		if (refs.length === 0) return { ok: true, value: { omitModel: true, requestedRole: input.role, ...thinkingProp } };
		const candidateIndex = Number.isSafeInteger(input.candidateIndex) ? (input.candidateIndex as number) : 0;
		const roleIndex = ((candidateIndex % refs.length) + refs.length) % refs.length;
		const selected = refs[roleIndex] as ModelRef;
		if (isAlias(selected)) return { ok: true, value: { omitModel: true, requestedRole: input.role, roleIndex, ...thinkingProp } };
		return { ok: true, value: { model: selected, omitModel: false, requestedRole: input.role, roleIndex, ...thinkingProp } };
	}
	const single = refs[0];
	if (single === undefined || isAlias(single)) {
		return { ok: true, value: { omitModel: true, requestedRole: input.role, ...thinkingProp } };
	}
	return { ok: true, value: { model: single, omitModel: false, requestedRole: input.role, ...thinkingProp } };
}

export function resolveNestedLaunchModel(input: {
	resolution?: { model?: string; omitModel: boolean };
	env?: NodeJS.Dict<string>;
}): string | undefined {
	if (!input.resolution) return undefined;
	if (input.resolution.model !== undefined && input.resolution.model.trim() !== "" && !isAlias(input.resolution.model)) {
		return input.resolution.model.trim();
	}
	if (input.resolution.omitModel) {
		const env = input.env ?? process.env;
		const provider = env.PI_PROVIDER?.trim();
		const model = env.PI_MODEL?.trim();
		if (provider && model) {
			if (model.includes("/")) return model;
			return `${provider}/${model}`;
		}
	}
	return undefined;
}

export async function loadConfig(path: string): Promise<ConfigResult<DstackConfig>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: true, value: emptyConfig() };
		return { ok: false, error: { kind: "invalid-json", message: String(err) } };
	}
	try {
		const parsed = parseConfig(JSON.parse(text) as unknown);
		if (!parsed.ok) return parsed;
		return { ok: true, value: { ...parsed.value, roles: migrateLegacyRoles(parsed.value.roles) } };
	} catch (err) {
		return { ok: false, error: { kind: "invalid-json", message: (err as Error).message } };
	}
}

export async function saveConfig(path: string, config: DstackConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function formatConfigError(error: ConfigError): string {
	switch (error.kind) {
		case "unknown-slug":
			return `Unknown model slug ${error.slug}. Write only slugs from the detected set, or inherit-parent / auto.`;
		case "unknown-role":
			return error.suggestion
				? `Unknown role "${error.role}". Did you mean "${error.suggestion}"?`
				: `Unknown role "${error.role}".`;
		case "override-without-reason":
			return `Explicit model override for role "${error.role}" requires a non-empty overrideReason.`;
		case "all-inherit-panel":
			return `Role "${error.role}" is all inherit-parent/auto. That panel is a no-op. Mix in at least one real slug.`;
		case "invalid-thinking":
			return `Invalid thinking level "${error.thinking}" for role "${error.role}". Must be one of: ${THINKING_LEVELS.join(", ")}.`;
		case "invalid-json":
			return `Could not parse models.json: ${error.message}`;
		case "invalid-shape":
			return error.message;
		default: {
			const _exhaustive: never = error;
			return _exhaustive;
		}
	}
}

export function slugsFromRegistry(models: readonly { provider: string; id: string }[]): string[] {
	return models.map((m) => `${m.provider}/${m.id}`);
}
