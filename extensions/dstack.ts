import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, packageRoot } from "./agents.ts";
import { richerAskPresent, parseAskParams } from "./ask.ts";
import { compactDetails, compactInstructions } from "./compact.ts";
import {
	continuationPrompt,
	latestActiveTodoTasks,
	shouldArmContinuation,
	type TodoBranchEntry,
	type TodoSnapshot,
} from "./continuation.ts";
import {
	defaultConfigPath,
	emptyConfig,
	formatConfigError,
	loadConfig,
	parseConfig,
	resolveModel,
	saveConfig,
	slugsFromRegistry,
	validateRoles,
} from "./models.ts";
import { dmodeReminder, modeStatusText, restoreMode, toggleMode, type SessionEntryLike } from "./mode.ts";
import { formatSessions } from "./sessions.ts";
import {
	companionStatus,
	dedupeSlugs,
	ensurePermissionConfig,
	formatCompanionReport,
	formatInstallResults,
	formatSetupKickoff,
	installCompanionSources,
	loadSettingsPackages,
	optionalMissing,
	requiredMissing,
	suggestConfig,
} from "./setup.ts";
import {
	buildChildArgv,
	capOutput,
	childDepthFor,
	childEnv,
	formatUsageStats,
	mapWithConcurrency,
	parseTaskRequest,
	resolveAgent,
	spawnableDepth,
	runChildProcess,
	type ChildContentPart,
	type ChildMessage,
	type ChildResult,
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
import { MODE_ENTRY, type ChildDepth, type ModeState, type TaskSpec, type TodoState } from "./types.ts";
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
	action: StringEnum(["get", "set", "list", "write"] as const),
	role: Type.Optional(Type.String()),
	value: Type.Optional(Type.String({ description: "Slug, inherit-parent, auto, comma-separated list, or full models.json for write" })),
});

function skillPath(): string {
	return join(packageRoot(), "skills/dmode/SKILL.md");
}

function extensionPath(): string {
	return join(packageRoot(), "extensions/dstack.ts");
}

function textResult(text: string, details: unknown = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

type TaskUsageRow = {
	agent: string;
	model?: string;
	usage: ChildResult["usage"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isChildUsage(value: unknown): value is ChildResult["usage"] {
	if (!isRecord(value)) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"].every(
		(key) => typeof value[key] === "number",
	);
}

function taskUsageRows(details: unknown): TaskUsageRow[] {
	if (!isRecord(details) || !Array.isArray(details.results)) return [];
	const rows: TaskUsageRow[] = [];
	for (const result of details.results) {
		if (!isRecord(result) || typeof result.agent !== "string" || !isChildUsage(result.usage)) continue;
		rows.push({
			agent: result.agent,
			model: typeof result.model === "string" ? result.model : undefined,
			usage: result.usage,
		});
	}
	return rows;
}

type TaskResult = ChildResult & {
	agent: string;
	cwd: string;
	task: string;
	step?: number;
};

type TaskDetails = {
	mode: "single" | "parallel" | "chain";
	results: TaskResult[];
};

function isChildContentPart(value: unknown): value is ChildContentPart {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	if (value.type === "toolCall") return typeof value.name === "string" && isRecord(value.arguments);
	if (value.type === "toolUpdate") {
		return (
			typeof value.id === "string" &&
			typeof value.name === "string" &&
			typeof value.text === "string" &&
			Array.isArray(value.agents)
		);
	}
	return false;
}

function isChildMessage(value: unknown): value is ChildMessage {
	return isRecord(value) && typeof value.role === "string" && Array.isArray(value.content) && value.content.every(isChildContentPart);
}

function parseTaskDetails(value: unknown): TaskDetails | undefined {
	if (!isRecord(value) || !["single", "parallel", "chain"].includes(String(value.mode)) || !Array.isArray(value.results)) {
		return undefined;
	}
	const results: TaskResult[] = [];
	for (const result of value.results) {
		if (
			!isRecord(result) ||
			typeof result.agent !== "string" ||
			typeof result.cwd !== "string" ||
			typeof result.task !== "string" ||
			typeof result.text !== "string" ||
			typeof result.exitCode !== "number" ||
			typeof result.stderr !== "string" ||
			!Array.isArray(result.messages) ||
			!result.messages.every(isChildMessage) ||
			!isChildUsage(result.usage)
		) return undefined;
		results.push(result as TaskResult);
	}
	return { mode: value.mode as TaskDetails["mode"], results };
}

function cloneDetails(details: TaskDetails): TaskDetails {
	return {
		mode: details.mode,
		results: details.results.map((result) => ({
			...result,
			messages: result.messages.map((message) => ({ ...message, content: [...message.content] })),
			usage: { ...result.usage },
		})),
	};
}

function emptyTaskResult(spec: TaskSpec, cwd: string, step?: number): TaskResult {
	return {
		agent: spec.agent,
		cwd,
		task: spec.task,
		text: "",
		exitCode: -1,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
	};
}

function progressText(details: TaskDetails): string {
	const done = details.results.filter((result) => result.exitCode !== -1).length;
	return `${details.mode}: ${done}/${details.results.length} done, ${details.results.length - done} running...`;
}

function formatToolCall(part: Extract<ChildContentPart, { type: "toolCall" }>): string {
	const args = JSON.stringify(part.arguments);
	return `${part.name} ${args.length > 100 ? `${args.slice(0, 97)}...` : args}`;
}

function formatToolUpdate(part: Extract<ChildContentPart, { type: "toolUpdate" }>): string {
	const lines = [`↳ ${part.name}: ${part.text}`];
	for (const agent of part.agents) {
		const icon = agent.exitCode === -1 ? "⏳" : agent.exitCode === 0 ? "✓" : "✗";
		const preview = agent.text.split("\n")[0];
		lines.push(`  ${icon} ${agent.agent}${preview ? ` ${preview.slice(0, 80)}` : ""}`);
	}
	return lines.join("\n");
}

function activityLines(result: TaskResult, expanded: boolean): string[] {
	const parts = result.messages.flatMap((message) =>
		message.role === "assistant" || message.role === "activity" ? message.content : [],
	);
	const shown = expanded ? parts : parts.slice(-5);
	const lines: string[] = [];
	if (!expanded && parts.length > shown.length) lines.push(`... ${parts.length - shown.length} earlier items`);
	for (const part of shown) {
		if (part.type === "toolCall") lines.push(`→ ${formatToolCall(part)}`);
		else if (part.type === "toolUpdate") lines.push(formatToolUpdate(part));
		else lines.push(...part.text.split("\n").slice(0, expanded ? undefined : 3));
	}
	return lines;
}

function branchEntries(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch() as SessionEntryLike[];
}

function continuationControlState(ctx: ExtensionContext): { isIdle: boolean; hasPendingMessages: boolean } {
	const control = ctx as unknown as {
		isIdle?: () => boolean;
		hasPendingMessages?: () => boolean;
	};
	return {
		isIdle: control.isIdle?.() ?? false,
		hasPendingMessages: control.hasPendingMessages?.() ?? true,
	};
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
	let pendingContinuation: { sessionId: string; tasks: TodoSnapshot[] } | undefined;

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
		pendingContinuation = undefined;
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

	pi.on("session_before_compact", async (_event, ctx) => {
		const richTasks = latestActiveTodoTasks(ctx.sessionManager.getBranch() as TodoBranchEntry[]);
		const fallbackTasks: TodoSnapshot[] = todos.items.flatMap((task) => {
			if (task.status !== "pending" && task.status !== "in_progress") return [];
			return [{ id: task.id, subject: task.content, status: task.status }];
		});
		const tasks = richTasks.length > 0 ? richTasks : fallbackTasks;
		pendingContinuation = shouldArmContinuation(tasks, continuationControlState(ctx))
			? { sessionId: ctx.sessionManager.getSessionId(), tasks }
			: undefined;

		const details = compactDetails({ playbook, todos });
		pi.appendEntry("dstack-compact-context", details);
		return undefined;
	});

	pi.on("session_compact", async (event, ctx) => {
		const continuation = pendingContinuation;
		pendingContinuation = undefined;
		if (!continuation || event.willRetry) return;
		if (ctx.sessionManager.getSessionId() !== continuation.sessionId) return;
		const control = continuationControlState(ctx);
		if (!control.isIdle || control.hasPendingMessages) return;
		pi.sendMessage(
			{
				customType: "dstack-post-compact-continuation",
				content: continuationPrompt(continuation.tasks),
				display: false,
				details: { tasks: continuation.tasks },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("session_shutdown", async () => {
		pendingContinuation = undefined;
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
		description: "Suggest role models from your catalog, then change them in chat.",
		handler: async (_args, ctx) => {
			const slugs = slugsFromRegistry(ctx.modelRegistry.getAvailable());
			const path = defaultConfigPath();
			const loaded = await loadConfig(path);
			if (!loaded.ok) {
				ctx.ui.notify(formatConfigError(loaded.error), "error");
			}
			const current = loaded.ok ? loaded.value : emptyConfig();
			if (slugs.length === 0) {
				ctx.ui.notify("No models in the registry. Add a provider, then run /setup-dstack again.", "error");
				return;
			}
			const catalog = dedupeSlugs(slugs);
			const suggestion = suggestConfig(slugs, current);
			const status = companionStatus(await loadSettingsPackages());
			const missing = requiredMissing(status);
			if (missing.length > 0) {
				ctx.ui.notify(`Installing ${missing.length} required companions.`, "info");
			}
			const installed = await installCompanionSources(missing);
			const perm = await ensurePermissionConfig();
			const companions = [
				formatInstallResults(installed),
				perm === "wrote"
					? "Wrote a safe-auto permission policy (allow routine work, ask on deploys/pushes, deny rm -rf)."
					: "Left the existing permission policy in place.",
				formatCompanionReport(companionStatus(await loadSettingsPackages())),
				optionalMissing(status).length
					? `Still optional: ${optionalMissing(status).join(", ")}`
					: "",
			]
				.filter(Boolean)
				.join("\n");
			ctx.ui.notify(`Suggested mappings from ${catalog.length} of ${slugs.length} models. Reply here to change them.`, "info");
			pi.sendUserMessage(
				formatSetupKickoff({
					rawCount: slugs.length,
					catalog,
					suggestion,
					current,
					companions,
				}),
			);
		},
	});

	pi.registerTool({
		name: "dstack_task",
		label: "dstack task",
		description:
			"Spawn an isolated child Pi process. Modes: single (agent+task), parallel (tasks), chain (chain). Depth-1 children may spawn terminal depth-2 children.",
		parameters: TaskParams,
		renderCall(params, theme) {
			const request = parseTaskRequest(params);
			if ("error" in request) return new Text(theme.fg("error", request.error), 0, 0);
			const label = request.kind === "single" ? request.spec.agent : `${request.specs.length} agents`;
			return new Text(`${theme.fg("toolTitle", theme.bold("dstack_task"))} ${theme.fg("accent", label)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = parseTaskDetails(result.details);
			if (!details) {
				const text = result.content.find((part) => part.type === "text")?.text ?? "(no output)";
				return new Text(text, 0, 0);
			}
			const rows: string[] = [];
			const done = details.results.filter((task) => task.exitCode !== -1).length;
			const failed = details.results.filter((task) => task.exitCode > 0).length;
			const headerIcon = isPartial || done < details.results.length ? "⏳" : failed ? "✗" : "✓";
			rows.push(`${headerIcon} ${details.mode} ${done}/${details.results.length}${failed ? `, ${failed} failed` : ""}`);
			for (const task of details.results) {
				const icon = task.exitCode === -1 ? "⏳" : task.exitCode === 0 ? "✓" : "✗";
				const step = task.step ? `Step ${task.step}: ` : "";
				rows.push(`\n─── ${step}${task.agent} ${icon}`);
				if (expanded) rows.push(`Task: ${task.task}`, `cwd: ${task.cwd}`);
				const activity = activityLines(task, expanded);
				if (activity.length) rows.push(...activity);
				else rows.push(task.exitCode === -1 ? "(running...)" : task.text || "(no output)");
				const usage = formatUsageStats(task.usage, task.model);
				if (usage) rows.push(`${task.agent}: ${usage}`);
			}
			if (!expanded) rows.push("\n(expand for details)");
			return new Text(rows.join("\n"), 0, 0);
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			let childDepth: ChildDepth;
			try {
				childDepth = childDepthFor(spawnableDepth());
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
			const specs = request.kind === "single" ? [request.spec] : request.specs;
			const details: TaskDetails = {
				mode: request.kind,
				results: specs.map((spec, index) =>
					emptyTaskResult(spec, spec.cwd ?? ctx.cwd, request.kind === "chain" ? index + 1 : undefined),
				),
			};
			const publish = () => {
				const snapshot = cloneDetails(details);
				onUpdate?.(textResult(progressText(snapshot), snapshot));
			};
			publish();
			const runOne = async (spec: TaskSpec, index: number): Promise<TaskResult> => {
				const resolved = resolveAgent(spec);
				const agent = agents.find((candidate) => candidate.name === resolved.agent);
				if (!agent) {
					const available = agents.map((candidate) => candidate.name).join(", ") || "none";
					throw new Error(`Unknown agent "${resolved.agent}". Available: ${available}.`);
				}
				const model = resolveModel({ explicit: spec.model, role: spec.role, roles: config.roles });
				let cwd = spec.cwd ?? ctx.cwd;
				if (spec.worktree) {
					cwd = await createWorktree({
						repoRoot: ctx.cwd,
						task: spec.task,
						base: config.worktree.base,
						from: config.worktree.from,
					});
				}
				details.results[index] = { ...details.results[index], agent: resolved.agent, cwd, task: spec.task } as TaskResult;
				publish();
				const promptParts = [agent.systemPrompt.trim()];
				if (resolved.dmode) promptParts.push(dmodeReminder(skillPath(), childDepth));
				let tmp: { dir: string; filePath: string } | undefined;
				const system = promptParts.filter(Boolean).join("\n\n");
				if (system) tmp = await writeTempPrompt(system);
				try {
					const args = buildChildArgv({
						task: spec.task,
						extensionPath: extensionPath(),
						model: model.model,
						omitModel: model.omitModel,
						tools: resolved.tools ?? agent.tools?.join(","),
						systemPromptPath: tmp?.filePath,
					});
					const child = await runChildProcess({
						args,
						cwd,
						env: childEnv(childDepth),
						signal,
						onUpdate: (partial) => {
							details.results[index] = { ...partial, agent: resolved.agent, cwd, task: spec.task, step: details.results[index]?.step };
							publish();
						},
					});
					const completed: TaskResult = {
						...child,
						agent: resolved.agent,
						cwd,
						task: spec.task,
						text: capOutput(child.text),
						step: details.results[index]?.step,
					};
					details.results[index] = completed;
					publish();
					return completed;
				} finally {
					if (tmp) await removeTemp(tmp.dir, tmp.filePath);
				}
			};
			try {
				if (request.kind === "chain") {
					const results: TaskResult[] = [];
					let previous = "";
					for (const [index, spec] of specs.entries()) {
						const task = spec.task.replace(/\{previous\}/g, previous);
						const result = await runOne({ ...spec, task }, index);
						results.push(result);
						if (result.exitCode !== 0) {
							return textResult(`Chain stopped (${spec.agent}): ${result.text}`, cloneDetails(details), true);
						}
						previous = result.text;
					}
					const last = results[results.length - 1];
					return textResult(last?.text ?? "(no output)", cloneDetails(details));
				}
				const results = await mapWithConcurrency(specs, MAX_CONCURRENCY, (spec, index) => runOne(spec, index));
				if (request.kind === "single") {
					const result = results[0];
					if (!result) return textResult("(no output)");
					return textResult(result.text, cloneDetails(details), result.exitCode !== 0);
				}
				const text = results
					.map((task) => `### [${task.agent}] ${task.exitCode === 0 ? "completed" : "failed"}\n\n${task.text}`)
					.join("\n\n---\n\n");
				return textResult(text, cloneDetails(details));
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
			const known = new Set(slugsFromRegistry(ctx.modelRegistry.getAvailable()));
			if (params.action === "write") {
				if (!params.value) return textResult("write requires a models.json value", {}, true);
				let raw: unknown;
				try {
					raw = JSON.parse(params.value) as unknown;
				} catch (err) {
					return textResult(`write value is not JSON: ${(err as Error).message}`, {}, true);
				}
				const parsed = parseConfig(raw);
				if (!parsed.ok) return textResult(formatConfigError(parsed.error), {}, true);
				const valid = validateRoles(parsed.value.roles, known);
				if (!valid.ok) return textResult(formatConfigError(valid.error), {}, true);
				const next = { ...parsed.value, roles: valid.value };
				await saveConfig(path, next);
				return textResult(JSON.stringify(next, null, 2));
			}
			if (!params.role || params.value === undefined) {
				return textResult("set requires role and value", {}, true);
			}
			const value = params.value.includes(",")
				? params.value.split(",").map((s) => s.trim()).filter(Boolean)
				: params.value.trim();
			const next = { ...loaded.value, roles: { ...loaded.value.roles, [params.role]: value } };
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
