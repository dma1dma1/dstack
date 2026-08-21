import { mkdtemp, writeFile, unlink, rmdir, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, packageRoot } from "./agents.ts";
import { richerAskPresent, parseAskParams } from "./ask.ts";
import { compactDetails, compactInstructions } from "./compact.ts";
import {
	defaultConfigPath,
	emptyConfig,
	formatConfigError,
	loadConfig,
	resolveModel,
	saveConfig,
	slugsFromRegistry,
	validateRoles,
} from "./models.ts";
import { dmodeReminder, modeStatusText, restoreMode, toggleMode, type SessionEntryLike } from "./mode.ts";
import { formatSessions } from "./sessions.ts";
import {
	companionStatus,
	formatCompanionReport,
	parseSettingsPackages,
	PERMISSION_RECIPES,
} from "./setup.ts";
import {
	assertNotNested,
	buildChildArgv,
	capOutput,
	childEnv,
	mapWithConcurrency,
	parseTaskRequest,
	resolveAgent,
	runChildProcess,
	MAX_CONCURRENCY,
	NestingError,
} from "./spawn.ts";
import {
	applyTodoOp,
	loadTodos,
	richerTodoPresent,
	saveTodos,
	todoFilePath,
} from "./todo.ts";
import { MODE_ENTRY, type DstackConfig, type ModeState, type TaskSpec, type TodoState } from "./types.ts";
import { createWorktree, WorktreeError } from "./worktree.ts";

const TaskItem = Type.Object({
	agent: Type.String({ description: "poteto-agent | general-purpose | comment-sicko" }),
	task: Type.String({ description: "Task to delegate" }),
	model: Type.Optional(Type.String({ description: "provider/model or inherit-parent / auto" })),
	role: Type.Optional(Type.String({ description: "Role name from models.json" })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist" })),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Boolean()),
	dmode: Type.Optional(Type.Boolean()),
});

const TaskParams = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	tools: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Boolean()),
	dmode: Type.Optional(Type.Boolean()),
	tasks: Type.Optional(Type.Array(TaskItem)),
	chain: Type.Optional(Type.Array(TaskItem)),
});

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "complete", "list"] as const),
	content: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
});

const AskParams = Type.Object({
	prompt: Type.String(),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String()),
				label: Type.Optional(Type.String()),
			}),
		),
	),
	allowMultiple: Type.Optional(Type.Boolean()),
	confirm: Type.Optional(Type.Boolean()),
});

const ConfigParams = Type.Object({
	action: StringEnum(["get", "set", "list"] as const),
	role: Type.Optional(Type.String()),
	value: Type.Optional(Type.String({ description: "Slug, inherit-parent, auto, or comma-separated list" })),
});

function skillPath(): string {
	return join(packageRoot(), "skills/dmode/SKILL.md");
}

function textResult(text: string, details: unknown = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

function branchEntries(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch() as SessionEntryLike[];
}

async function writeTempPrompt(text: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "dstack-"));
	const filePath = join(dir, "prompt.md");
	await writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

async function removeTemp(dir: string, filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		/* ignore */
	}
	try {
		await rmdir(dir);
	} catch {
		/* ignore */
	}
}

export default function dstack(pi: ExtensionAPI) {
	let mode: ModeState = { on: false };
	let playbook: string | undefined;
	let todos: TodoState = { items: [] };
	let sessionId = "unknown";

	function persistMode() {
		pi.appendEntry(MODE_ENTRY, mode);
	}

	function applyStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus("dstack", modeStatusText(mode));
	}

	async function refreshTodos() {
		todos = await loadTodos(todoFilePath(sessionId));
	}

	async function persistTodos() {
		await saveTodos(todoFilePath(sessionId), todos);
		pi.appendEntry("dstack-todos", todos);
	}

	let fallbacks = false;

	pi.on("session_start", async (_event, ctx) => {
		mode = restoreMode(branchEntries(ctx));
		sessionId = ctx.sessionManager.getSessionId();
		await refreshTodos();
		applyStatus(ctx);
		if (!fallbacks) {
			fallbacks = true;
			registerFallbackTools();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		mode = restoreMode(branchEntries(ctx));
		applyStatus(ctx);
	});

	pi.on("before_agent_start", async () => {
		if (!mode.on) return;
		return {
			message: {
				customType: "dstack-dmode-reminder",
				content: dmodeReminder(skillPath()),
				display: false,
			},
		};
	});

	pi.on("session_before_compact", async () => {
		const details = compactDetails({ playbook, todos });
		pi.appendEntry("dstack-compact-context", details);
		return undefined;
	});

	pi.on("session_before_tree", async () => {
		const extra = compactInstructions({ playbook, todos });
		if (!extra) return undefined;
		return { customInstructions: extra };
	});

	const modeHandler = async (args: string, ctx: ExtensionContext) => {
		mode = toggleMode(mode, args);
		persistMode();
		applyStatus(ctx);
		ctx.ui.notify(mode.on ? "dmode on" : "dmode off", "info");
	};

	pi.registerCommand("dmode", {
		description: "Turn dmode on. /dmode off turns it off.",
		handler: modeHandler,
	});
	pi.registerCommand("poteto-mode", {
		description: "Alias of /dmode.",
		handler: modeHandler,
	});

	pi.registerCommand("setup-dstack", {
		description: "Detect models, write models.json, list companions.",
		handler: async (_args, ctx) => {
			const slugs = slugsFromRegistry(ctx.modelRegistry.getAvailable());
			const path = defaultConfigPath();
			const loaded = await loadConfig(path);
			const current = loaded.ok ? loaded.value : emptyConfig();
			const defaults: DstackConfig = {
				roles: { ...current.roles },
				worktree: current.worktree,
			};
			const listRoles = [
				"how critics",
				"arena runners",
				"arena cross-judge pool",
				"architect runners",
				"interrogate reviewers",
			];
			for (const role of [
				"feature, refactoring",
				"bug-fix",
				"perf-issue",
				"hillclimb",
				"judgment and prose",
				"hardest tasks",
				"how explorer",
				"how explainer",
				"why investigators",
				"why synthesizer",
				"reflect tooling",
				"reflect judgment, divergent, synthesizer",
				"swarm workers",
			]) {
				if (!defaults.roles[role]) defaults.roles[role] = "inherit-parent";
			}
			if (slugs.length > 0) {
				const panel = slugs.slice(0, 4);
				for (const role of listRoles) {
					if (!defaults.roles[role]) defaults.roles[role] = panel;
				}
			}
			const known = new Set(slugs);
			const valid = validateRoles(defaults.roles, known);
			if (!valid.ok) {
				ctx.ui.notify(formatConfigError(valid.error), "error");
				return;
			}
			const ok = ctx.hasUI
				? await ctx.ui.confirm("Write dstack models.json?", `${path}\n${JSON.stringify(defaults, null, 2)}`)
				: true;
			if (!ok) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}
			await saveConfig(path, { ...defaults, roles: valid.value });
			let settingsRaw: unknown = {};
			try {
				settingsRaw = JSON.parse(await readFile(join(homedir(), ".pi/agent/settings.json"), "utf8")) as unknown;
			} catch {
				settingsRaw = {};
			}
			const companions = companionStatus(parseSettingsPackages(settingsRaw));
			const report = [`Wrote ${path}`, `Detected models: ${slugs.join(", ") || "(none)"}`, "", formatCompanionReport(companions)].join(
				"\n",
			);
			ctx.ui.notify(report, "info");
			if (companions.some((c) => c.source === "npm:@gotgenes/pi-permission-system" && c.installed) && ctx.hasUI) {
				const writePerms = await ctx.ui.confirm(
					"Write permission recipes?",
					`Ask: ${PERMISSION_RECIPES.ask.join(", ")}\nDeny: ${PERMISSION_RECIPES.deny.join(", ")}`,
				);
				if (writePerms) {
					const dest = join(homedir(), ".pi/agent/dstack/permission-recipes.json");
					const { mkdir, writeFile } = await import("node:fs/promises");
					const { dirname } = await import("node:path");
					await mkdir(dirname(dest), { recursive: true });
					await writeFile(dest, `${JSON.stringify(PERMISSION_RECIPES, null, 2)}\n`, "utf8");
					ctx.ui.notify(`Wrote ${dest}`, "info");
				}
			}
		},
	});

	pi.registerTool({
		name: "dstack_task",
		label: "dstack task",
		description:
			"Spawn an isolated child Pi process. Modes: single (agent+task), parallel (tasks), chain (chain). Children cannot spawn children.",
		parameters: TaskParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				assertNotNested();
			} catch (err) {
				if (err instanceof NestingError) {
					return textResult(err.message, {}, true);
				}
				throw err;
			}
			const request = parseTaskRequest(params);
			if ("error" in request) {
				return textResult(request.error, {}, true);
			}
			const loaded = await loadConfig(defaultConfigPath());
			const config = loaded.ok ? loaded.value : emptyConfig();
			const agents = discoverAgents();
			const runOne = async (spec: TaskSpec) => {
				const resolved = resolveAgent(spec);
				const agent = agents.find((a) => a.name === resolved.agent);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					throw new Error(`Unknown agent "${resolved.agent}". Available: ${available}.`);
				}
				const model = resolveModel({
					explicit: spec.model,
					role: spec.role,
					roles: config.roles,
				});
				let cwd = spec.cwd ?? ctx.cwd;
				if (spec.worktree) {
					cwd = await createWorktree({
						repoRoot: ctx.cwd,
						task: spec.task,
						base: config.worktree.base,
						from: config.worktree.from,
					});
				}
				const promptParts = [agent.systemPrompt.trim()];
				if (resolved.dmode) promptParts.push(dmodeReminder(skillPath()));
				let tmp: { dir: string; filePath: string } | undefined;
				const system = promptParts.filter(Boolean).join("\n\n");
				if (system) tmp = await writeTempPrompt(system);
				try {
					const args = buildChildArgv({
						task: spec.task,
						model: model.model,
						omitModel: model.omitModel,
						tools: resolved.tools ?? agent.tools?.join(","),
						systemPromptPath: tmp?.filePath,
					});
					const child = await runChildProcess({
						args,
						cwd,
						env: childEnv(),
						signal,
					});
					return {
						agent: resolved.agent,
						cwd,
						text: capOutput(child.text),
						exitCode: child.exitCode,
						model: child.model,
						usage: child.usage,
						stopReason: child.stopReason,
						errorMessage: child.errorMessage,
					};
				} finally {
					if (tmp) await removeTemp(tmp.dir, tmp.filePath);
				}
			};

			const specs =
				request.kind === "single" ? [request.spec] : request.kind === "parallel" ? request.specs : request.specs;
			try {
				if (request.kind === "chain") {
					const results = [];
					let previous = "";
					for (const spec of specs) {
						const task = spec.task.replace(/\{previous\}/g, previous);
						const result = await runOne({ ...spec, task });
						results.push(result);
						if (result.exitCode !== 0) {
							return textResult(`Chain stopped (${spec.agent}): ${result.text}`, { results }, true);
						}
						previous = result.text;
					}
					const last = results[results.length - 1];
					return textResult(last?.text ?? "(no output)", { results });
				}
				const results = await mapWithConcurrency(specs, MAX_CONCURRENCY, (spec) => runOne(spec));
				if (request.kind === "single") {
					const result = results[0];
					if (!result) return textResult("(no output)");
					return textResult(result.text, { results }, result.exitCode !== 0);
				}
				const text = results
					.map((r, i) => `### [${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}\n\n${r.text}`)
					.join("\n\n---\n\n");
				return textResult(text, { results });
			} catch (err) {
				if (err instanceof WorktreeError) {
					return textResult(err.message, {}, true);
				}
				return textResult(err instanceof Error ? err.message : String(err), {}, true);
			}
		},
	});

	function registerFallbackTools() {
		const names = pi.getAllTools().map((t) => t.name);
		if (!richerTodoPresent(names)) {
			pi.registerTool({
				name: "dstack_todo",
				label: "dstack todo",
				description: "Create, update, complete, or list durable todos. Survives /reload.",
				parameters: TodoParams,
				async execute(_id, params) {
					const op =
						params.action === "list"
							? { action: "list" as const }
							: params.action === "create"
								? { action: "create" as const, content: params.content ?? "" }
								: params.action === "complete"
									? { action: "complete" as const, id: params.id ?? "" }
									: {
											action: "update" as const,
											id: params.id ?? "",
											content: params.content,
											status: params.status,
										};
					if (op.action === "create" && !op.content.trim()) {
						return textResult("content is required to create a todo", {}, true);
					}
					if ((op.action === "update" || op.action === "complete") && !op.id) {
						return textResult("id is required", {}, true);
					}
					const next = applyTodoOp(todos, op);
					todos = next.state;
					await persistTodos();
					return textResult(next.text, todos);
				},
			});
		}
		if (!richerAskPresent(names)) {
			pi.registerTool({
				name: "dstack_ask",
				label: "dstack ask",
				description: "Ask the user a structured question with typed options.",
				parameters: AskParams,
				async execute(_id, params, _signal, _onUpdate, ctx) {
					const parsed = parseAskParams(params);
					if ("error" in parsed) return textResult(parsed.error, {}, true);
					if (!ctx.hasUI) {
						return textResult("dstack_ask requires UI", {}, true);
					}
					if (parsed.confirm || (!parsed.options && !parsed.allowMultiple)) {
						const yes = await ctx.ui.confirm(parsed.prompt, "");
						return textResult(yes ? "yes" : "no");
					}
					const labels = (parsed.options ?? []).map((o) => o.label);
					if (labels.length === 0) {
						return textResult("options are required unless confirm is true", {}, true);
					}
					const picked = await ctx.ui.select(parsed.prompt, labels);
					if (picked === undefined) return textResult("(cancelled)");
					const match = parsed.options?.find((o) => o.label === picked) ?? { id: picked, label: picked };
					return textResult(match.id, match);
				},
			});
		}
	}

	pi.registerTool({
		name: "dstack_sessions",
		label: "dstack sessions",
		description: "List Pi sessions for the current cwd via SessionManager.list.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const rows = await SessionManager.list(ctx.cwd);
			return textResult(formatSessions(rows), { sessions: rows });
		},
	});

	pi.registerTool({
		name: "dstack_config",
		label: "dstack config",
		description: "Get, set, or list role-to-model mappings in ~/.pi/agent/dstack/models.json.",
		parameters: ConfigParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = defaultConfigPath();
			const loaded = await loadConfig(path);
			if (!loaded.ok) {
				return textResult(formatConfigError(loaded.error), {}, true);
			}
			if (params.action === "list" || params.action === "get") {
				if (params.action === "get" && params.role) {
					const value = loaded.value.roles[params.role];
					return textResult(value === undefined ? "(unset)" : JSON.stringify(value));
				}
				return textResult(JSON.stringify(loaded.value, null, 2));
			}
			if (!params.role || params.value === undefined) {
				return textResult("set requires role and value", {}, true);
			}
			const value = params.value.includes(",")
				? params.value.split(",").map((s) => s.trim()).filter(Boolean)
				: params.value.trim();
			const next = { ...loaded.value, roles: { ...loaded.value.roles, [params.role]: value } };
			const known = new Set(slugsFromRegistry(ctx.modelRegistry.getAvailable()));
			const valid = validateRoles(next.roles, known);
			if (!valid.ok) {
				return textResult(formatConfigError(valid.error), {}, true);
			}
			next.roles = valid.value;
			await saveConfig(path, next);
			return textResult(JSON.stringify(next, null, 2));
		},
	});

}
