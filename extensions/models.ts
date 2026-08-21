import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_WORKTREE_BASE,
	LIST_ROLES,
	MODEL_ALIASES,
	type DstackConfig,
	type ModelRef,
	type RoleValue,
	type WorktreeFrom,
} from "./types.ts";

export const CONFIG_RELATIVE = ".pi/agent/dstack/models.json";

export function defaultConfigPath(home = homedir()): string {
	return join(home, CONFIG_RELATIVE);
}

export function isAlias(value: string): value is (typeof MODEL_ALIASES)[number] {
	return (MODEL_ALIASES as readonly string[]).includes(value);
}

export function knownSlugSet(slugs: readonly string[]): Set<string> {
	return new Set(slugs);
}

export type ConfigError =
	| { kind: "unknown-slug"; slug: string }
	| { kind: "all-inherit-panel"; role: string }
	| { kind: "invalid-json"; message: string }
	| { kind: "invalid-shape"; message: string };

export type ConfigResult<T> = { ok: true; value: T } | { ok: false; error: ConfigError };

function asModelRef(value: unknown): ModelRef | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return value.trim();
}

function parseRoleValue(value: unknown): RoleValue | undefined {
	if (Array.isArray(value)) {
		const refs = value.map(asModelRef);
		if (refs.some((r) => r === undefined)) return undefined;
		return refs as ModelRef[];
	}
	return asModelRef(value);
}

function parseFrom(value: unknown): WorktreeFrom {
	return value === "origin/main" ? "origin/main" : "HEAD";
}

export function emptyConfig(): DstackConfig {
	return {
		roles: {},
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
			const parsed = parseRoleValue(value);
			if (parsed === undefined) {
				return { ok: false, error: { kind: "invalid-shape", message: `invalid role value for ${name}` } };
			}
			roles[name] = parsed;
		}
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
	return { ok: true, value: { roles, worktree } };
}

function refsOf(value: RoleValue): ModelRef[] {
	return Array.isArray(value) ? value : [value];
}

export function validateRoles(
	roles: Record<string, RoleValue>,
	knownSlugs: ReadonlySet<string>,
): ConfigResult<Record<string, RoleValue>> {
	for (const [role, value] of Object.entries(roles)) {
		const refs = refsOf(value);
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
}): { model?: string; omitModel: boolean } {
	if (input.explicit) {
		if (isAlias(input.explicit)) return { omitModel: true };
		return { model: input.explicit, omitModel: false };
	}
	if (!input.role) return { omitModel: true };
	const value = input.roles[input.role];
	if (value === undefined) return { omitModel: true };
	const first = refsOf(value)[0];
	if (!first || isAlias(first)) return { omitModel: true };
	return { model: first, omitModel: false };
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
		return parseConfig(JSON.parse(text) as unknown);
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
		case "all-inherit-panel":
			return `Role "${error.role}" is all inherit-parent/auto. That panel is a no-op. Mix in at least one real slug.`;
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
