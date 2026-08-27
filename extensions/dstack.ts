import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, packageRoot } from "./agents.ts";
import { richerAskPresent, parseAskParams } from "./ask.ts";
import { compactDetails, compactInstructions, restoreActiveWorkflow } from "./compact.ts";
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
	childDepthFor,
	formatUsageStats,
	parseNestingDepth,
	parseTaskRequest,
	spawnableDepth,
	sumChildUsage,
	type ChildContentPart,
	type ChildMessage,
	type ChildResult,
	NestingError,
} from "./spawn.ts";
import {
	applyTodoOp,
	loadTodos,
	richerTodoPresent,
	saveTodos,
	todoFilePath,
} from "./todo.ts";
import { ACTIVE_WORKFLOW_ENTRY, MODE_ENTRY, NESTING_ENV, STATUS_FILE_ENV, type ActiveWorkflow, type ChildDepth, type ModeState, type TodoState } from "./types.ts";
import { createEventBusV1Port, type BackgroundTaskPort, type CompanionTaskState } from "./background/eventbus-v1.ts";
import { createTaskResultFiles, launchTaskGroup, sessionRoot } from "./background/launch.ts";
import { atomicWriteFile } from "./background/artifacts.ts";
import {
	MAX_STATUS_NOTE_CHARS,
	MAX_STATUS_PHASE_CHARS,
	sanitizeString,
	type SemanticStatus,
} from "./background/journal.ts";
import { readDstackResult, type CommittedResult, type DstackResultView } from "./background/result.ts";
import {
	formatStaleWakePrompt,
	launchNestedTask,
	NestedTaskRegistry,
	projectNestedResult,
	restoreFiredStaleWakes,
	shouldTriggerStaleWake,
	type DstackKillResult,
	type TaskDetails,
	type TaskResult,
} from "./task-registry.ts";
import { activityLines, buildTreeSnapshot, latestActivity, parseTreeSnapshot, renderTreeLines } from "./background/tree.ts";
import {
	AgentInspector,
	listSessionWorkflows,
	renderAmbientWidgetLine,
	type AgentInspectorResult,
	type AmbientStatus,
} from "./background/inspector.ts";

const WorkflowArtifactItem = Type.Object({
	name: Type.String(),
	path: Type.String(),
	sha256: Type.Optional(Type.String()),
});

const WorkflowParams = Type.Object({
	playbook: Type.String({ description: "Selected dmode playbook slug" }),
	assignment: StringEnum(["owner", "worker", "reviewer"] as const),
	phase: Type.String({ description: "Current playbook phase slug" }),
	completedPhases: Type.Array(Type.String()),
	artifacts: Type.Array(WorkflowArtifactItem),
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "poteto-agent | general-purpose | comment-sicko" }),
	task: Type.String({ description: "Task to delegate" }),
	model: Type.Optional(Type.String({ description: "provider/model or inherit-parent / auto" })),
	role: Type.Optional(Type.String({ description: "Role name from models.json" })),
	overrideReason: Type.Optional(Type.String({ description: "Required reason when model overrides role" })),
	tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist" })),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Boolean()),
	dmode: Type.Optional(Type.Boolean()),
	workflow: Type.Optional(WorkflowParams),
});

const TaskParams = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	overrideReason: Type.Optional(Type.String()),
	tools: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Boolean()),
	dmode: Type.Optional(Type.Boolean()),
	workflow: Type.Optional(WorkflowParams),
	tasks: Type.Optional(Type.Array(TaskItem)),
	chain: Type.Optional(Type.Array(TaskItem)),
});

const KillParams = Type.Object({
	taskId: Type.String({ description: "Task id returned by dstack_task to kill or cancel" }),
});

const ResultParams = Type.Object({
	taskId: Type.String({ description: "Background task id returned by dstack_task" }),
	detail: Type.Optional(StringEnum(["summary", "full"] as const)),
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

const StatusParams = Type.Object({
	phase: Type.Optional(Type.String({ description: "Current phase slug or name" })),
	note: Type.Optional(Type.String({ description: "Brief status note or current focus" })),
	blocking: Type.Optional(Type.Boolean({ description: "Whether work is currently blocked" })),
});

function skillPath(): string {
	return join(packageRoot(), "skills/dmode/SKILL.md");
}

function extensionPath(): string {
	return join(packageRoot(), "extensions/dstack.ts");
}

function textResult(text: string, details: unknown = {}, isError = false, usage?: Usage) {
	return { content: [{ type: "text" as const, text }], details, isError, ...(usage ? { usage } : {}) };
}

function committedUsage(committed: CommittedResult): Usage | undefined {
	if (committed.kind === "complete") return sumChildUsage(committed.package.results.map((child) => child.usage));
	if (committed.kind === "artifact") return committed.usage;
	return undefined;
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

export type { TaskDetails, TaskResult } from "./task-registry.ts";

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

export { latestActivity };

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

export default function dstack(pi: ExtensionAPI) {
	let mode: ModeState = { on: true };
	let activeWorkflow: ActiveWorkflow | undefined;
	let todos: TodoState = { items: [] };
	let sessionId = "unknown";
	let pendingContinuation: { sessionId: string; tasks: TodoSnapshot[] } | undefined;
	let eventBusPort: BackgroundTaskPort | undefined;
	let treeTimer: NodeJS.Timeout | undefined;
	let ambientStatus: AmbientStatus | undefined;
	let inspectorOpen = false;
	let treeWidgetVisible = true;
	let treeLastTaskId: string | undefined;
	let treeLastWorkflowId: string | undefined;
	let treeArtifactDir: string | undefined;
	let treeSchedulerRoot: string | undefined;
	let lastContext: ExtensionContext | undefined;
	const nestedTaskRegistry = new NestedTaskRegistry();
	const firedStaleWakes = new Set<string>();

	function stopTreeTimer() {
		if (treeTimer !== undefined) {
			clearInterval(treeTimer);
			treeTimer = undefined;
		}
	}

	function updateTreeWidget(ctx: ExtensionContext) {
		lastContext = ctx;
		if (!treeWidgetVisible || !ambientStatus || !ctx.hasUI || inspectorOpen) {
			if (ctx.hasUI) {
				ctx.ui.setWidget("dstack-tree", undefined);
			}
			return;
		}
		ctx.ui.setWidget("dstack-tree", (_tui, theme) => ({
			render(width: number) {
				if (!ambientStatus || inspectorOpen || !treeWidgetVisible) return [];
				return renderAmbientWidgetLine(ambientStatus, width, theme);
			},
			invalidate() {},
		}));
	}

	async function openInspector(ctx: ExtensionContext, taskId?: string): Promise<void> {
		lastContext = ctx;
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"dstack agent inspector requires an interactive Pi UI. Use /dtree for a static in-chat snapshot.",
				"error",
			);
			return;
		}
		if (inspectorOpen) return;
		inspectorOpen = true;
		updateTreeWidget(ctx);
		try {
			await ctx.ui.custom<AgentInspectorResult>(
				(tui, theme, _keybindings, done) => {
					return new AgentInspector(tui, theme, done, {
						sessionId,
						initialTaskId: taskId,
						todoPath: todoFilePath(sessionId),
						terminalRows: () => tui.terminal.rows,
					});
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						minWidth: 64,
						maxHeight: "90%",
						margin: { bottom: 1, left: 1, right: 1 },
					},
				},
			);
		} finally {
			inspectorOpen = false;
			updateTreeWidget(ctx);
		}
	}

	async function pollTreeTick() {
		if (!treeArtifactDir || !treeSchedulerRoot || !treeLastTaskId || !treeLastWorkflowId) return;
		try {
			const snapshot = await buildTreeSnapshot({
				taskId: treeLastTaskId,
				workflowId: treeLastWorkflowId,
				artifactDir: treeArtifactDir,
				schedulerRoot: treeSchedulerRoot,
				todoPath: todoFilePath(sessionId),
				playbook: activeWorkflow?.playbook,
			});
			if (!snapshot) return;
			let activeWorkflowCount = snapshot.committed ? 0 : 1;
			try {
				const workflows = await listSessionWorkflows(sessionId);
				const uncommittedCount = workflows.filter((w) => !w.committed).length;
				activeWorkflowCount = Math.max(activeWorkflowCount, uncommittedCount);
			} catch {}
			ambientStatus = {
				snapshot,
				activeWorkflowCount,
			};
			if (lastContext) {
				updateTreeWidget(lastContext);
				const control = continuationControlState(lastContext);
				if (shouldTriggerStaleWake({ snapshot, firedTaskIds: firedStaleWakes, control })) {
					firedStaleWakes.add(snapshot.taskId);
					pi.appendEntry("dstack-stale-wake", { taskId: snapshot.taskId, timestamp: new Date().toISOString() });
					pi.sendMessage(
						{
							customType: "dstack-stale-wake",
							content: formatStaleWakePrompt(snapshot.taskId),
							display: false,
							details: { taskId: snapshot.taskId },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
			}
			if (snapshot.committed && activeWorkflowCount === 0) {
				stopTreeTimer();
			}
		} catch {}
	}

	function startTreePolling(taskId: string, workflowId: string, ctx: ExtensionContext) {
		treeLastTaskId = taskId;
		treeLastWorkflowId = workflowId;
		const root = sessionRoot(sessionId);
		treeArtifactDir = join(root, "workflows", workflowId);
		treeSchedulerRoot = join(root, "scheduler");
		lastContext = ctx;
		stopTreeTimer();
		void pollTreeTick();
		treeTimer = setInterval(() => {
			void pollTreeTick();
		}, 1000);
		treeTimer.unref();
	}

	function getEventBusPort(): BackgroundTaskPort {
		eventBusPort ??= createEventBusV1Port({ events: pi.events, makeRequestId: randomUUID });
		return eventBusPort;
	}

	function persistMode() {
		pi.appendEntry(MODE_ENTRY, mode);
	}

	function persistActiveWorkflow(next: ActiveWorkflow | undefined) {
		activeWorkflow = next;
		pi.appendEntry(ACTIVE_WORKFLOW_ENTRY, next ?? null);
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

	let nestingDepth = 0;
	try {
		nestingDepth = parseNestingDepth(process.env[NESTING_ENV]);
	} catch {
		nestingDepth = 0;
	}
	const isChild = nestingDepth > 0 || process.env[STATUS_FILE_ENV] !== undefined;
	if (isChild) {
		pi.registerTool({
			name: "dstack_status",
			label: "dstack status",
			description: "Publish a semantic progress update for the current phase or task. Child agents only.",
			parameters: StatusParams,
			async execute(_id, params) {
				const phase = params.phase ? sanitizeString(params.phase, MAX_STATUS_PHASE_CHARS) : undefined;
				const note = params.note ? sanitizeString(params.note, MAX_STATUS_NOTE_CHARS) : undefined;
				const blocking = typeof params.blocking === "boolean" ? params.blocking : undefined;
				const status: SemanticStatus = {
					...(phase !== undefined ? { phase } : {}),
					...(note !== undefined ? { note } : {}),
					...(blocking !== undefined ? { blocking } : {}),
					updatedAt: new Date().toISOString(),
				};
				const statusFile = process.env[STATUS_FILE_ENV];
				if (statusFile) {
					await atomicWriteFile(statusFile, `${JSON.stringify(status, null, 2)}\n`);
				}
				const parts: string[] = [];
				if (phase) parts.push(`phase: ${phase}`);
				if (note) parts.push(`note: ${note}`);
				if (blocking !== undefined) parts.push(`blocking: ${blocking}`);
				const text = parts.length > 0 ? parts.join(", ") : "status cleared";
				return textResult(`Status updated (${text})`, status);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		pendingContinuation = undefined;
		stopTreeTimer();
		ambientStatus = undefined;
		treeLastTaskId = undefined;
		treeLastWorkflowId = undefined;
		treeArtifactDir = undefined;
		treeSchedulerRoot = undefined;
		firedStaleWakes.clear();
		for (const id of restoreFiredStaleWakes(branchEntries(ctx))) firedStaleWakes.add(id);
		nestedTaskRegistry.clear();
		if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("dstack-tree", undefined);
		}
		mode = restoreMode(branchEntries(ctx));
		activeWorkflow = restoreActiveWorkflow(branchEntries(ctx));
		sessionId = ctx.sessionManager.getSessionId();
		await refreshTodos();
		applyStatus(ctx);
		if (activeWorkflow) {
			const files = createTaskResultFiles(sessionId);
			const binding = await files.readBinding(activeWorkflow.taskId);
			if (binding) {
				startTreePolling(binding.taskId, binding.workflowId, ctx);
			}
		}
		if (!fallbacks) {
			fallbacks = true;
			registerFallbackTools();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		mode = restoreMode(branchEntries(ctx));
		activeWorkflow = restoreActiveWorkflow(branchEntries(ctx));
		sessionId = ctx.sessionManager.getSessionId();
		firedStaleWakes.clear();
		for (const id of restoreFiredStaleWakes(branchEntries(ctx))) firedStaleWakes.add(id);
		nestedTaskRegistry.clear();
		applyStatus(ctx);
		if (activeWorkflow) {
			const files = createTaskResultFiles(sessionId);
			const binding = await files.readBinding(activeWorkflow.taskId);
			if (binding) {
				startTreePolling(binding.taskId, binding.workflowId, ctx);
				return;
			}
		}
		stopTreeTimer();
		ambientStatus = undefined;
		treeLastTaskId = undefined;
		treeLastWorkflowId = undefined;
		treeArtifactDir = undefined;
		treeSchedulerRoot = undefined;
		if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("dstack-tree", undefined);
		}
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

		const details = compactDetails({ activeWorkflow, todos });
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

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingContinuation = undefined;
		eventBusPort?.close();
		eventBusPort = undefined;
		nestedTaskRegistry.clear();
		stopTreeTimer();
		ambientStatus = undefined;
		if (ctx?.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("dstack-tree", undefined);
		}
	});

	pi.on("session_before_tree", async () => {
		const extra = compactInstructions({ activeWorkflow, todos });
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

	pi.registerCommand("dtree", {
		description: "Show dstack subagent tree. /dtree on | off toggles the live widget. /dtree [taskId] renders a snapshot.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "on") {
				treeWidgetVisible = true;
				if (ambientStatus && ctx.hasUI) {
					updateTreeWidget(ctx);
				}
				ctx.ui.notify("dstack tree widget enabled", "info");
				return;
			}
			if (trimmed === "off") {
				treeWidgetVisible = false;
				if (ctx.hasUI) {
					ctx.ui.setWidget("dstack-tree", undefined);
				}
				ctx.ui.notify("dstack tree widget disabled", "info");
				return;
			}

			const targetTaskId = trimmed !== "" ? trimmed : (activeWorkflow?.taskId ?? treeLastTaskId);
			if (!targetTaskId) {
				ctx.ui.notify("no dstack workflow in this session", "info");
				return;
			}

			const files = createTaskResultFiles(sessionId);
			const binding = await files.readBinding(targetTaskId);
			if (!binding) {
				ctx.ui.notify(`no dstack workflow found for task ${targetTaskId}`, "error");
				return;
			}

			const root = binding.root ?? sessionRoot(sessionId);
			const artifactDir = join(root, "workflows", binding.workflowId);
			const schedulerRoot = join(root, "scheduler");
			const snapshot = await buildTreeSnapshot({
				taskId: targetTaskId,
				workflowId: binding.workflowId,
				artifactDir,
				schedulerRoot,
				todoPath: todoFilePath(sessionId),
				playbook: activeWorkflow?.taskId === targetTaskId ? activeWorkflow?.playbook : undefined,
			});

			if (!snapshot) {
				ctx.ui.notify(`could not load workflow snapshot for ${targetTaskId}`, "error");
				return;
			}

			pi.appendEntry("dstack-tree-snapshot", snapshot);
		},
	});

	pi.registerEntryRenderer?.("dstack-tree-snapshot", (entry, { expanded }, theme) => {
		const snapshot = parseTreeSnapshot(entry.data);
		if (!snapshot) {
			return new Text(theme.fg("dim", "(corrupt dstack tree snapshot)"), 0, 0);
		}
		const lines = renderTreeLines(snapshot, {
			width: 80,
			maxLines: Number.POSITIVE_INFINITY,
			theme,
			includeTodos: true,
			expanded,
		});
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("dagents", {
		description: "Open the dstack agent inspector overlay: /dagents [taskId]",
		handler: async (args, ctx) => {
			const taskId = args.trim() || undefined;
			await openInspector(ctx, taskId);
		},
	});

	pi.registerShortcut?.("shift+up", {
		description: "Open dstack agent inspector overlay",
		handler: async (ctx) => {
			await openInspector(ctx);
		},
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
			"Launch child agents. For dmode, root sends one nontrivial request to a workflow owner; owners may launch as many bounded worker batches as needed. Pass workflow metadata so workers receive phase and artifact state without rereading dmode. Both root and nested calls return a task id immediately. Wait for completion notifications or a stale wake-up, then call dstack_result once. Do not poll.",
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
				if (!expanded) {
					const usage = formatUsageStats(task.usage, task.model);
					const summary = task.exitCode !== -1 && usage ? `: ${usage}` : `  ${latestActivity(task)}`;
					rows.push(`${icon} ${step}${task.agent}${summary}`);
					continue;
				}
				rows.push(`\n─── ${step}${task.agent} ${icon}`, `Task: ${task.task}`, `cwd: ${task.cwd}`);
				const activity = activityLines(task);
				if (activity.length) rows.push(...activity);
				else rows.push(task.exitCode === -1 ? "(running...)" : task.text || "(no output)");
				const usage = formatUsageStats(task.usage, task.model);
				if (usage) rows.push(`${task.agent}: ${usage}`);
			}
			if (!expanded) rows.push("(Ctrl+O for details)");
			return new Text(rows.join("\n"), 0, 0);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			let parentDepth: ReturnType<typeof spawnableDepth>;
			try {
				parentDepth = spawnableDepth();
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
			const owners = specs.filter((spec) => spec.workflow?.assignment === "owner");
			if (owners.length > 1) {
				return textResult("dstack_task refused: one task group may have at most one workflow owner.", {}, true);
			}
			if (owners.some((spec) => spec.agent !== "poteto-agent")) {
				return textResult('dstack_task refused: workflow owners must use agent "poteto-agent".', {}, true);
			}
			if (parentDepth === 0) {
				const port = getEventBusPort();
				const availabilitySignal = signal === undefined
					? AbortSignal.timeout(1000)
					: AbortSignal.any([signal, AbortSignal.timeout(1000)]);
				try {
					await port.capabilities(availabilitySignal);
				} catch (error) {
					return textResult(`pi-background-tasks EventBus v1 unavailable: ${error instanceof Error ? error.message : String(error)}`, {}, true);
				}
				try {
					const receipt = await launchTaskGroup({
						request,
						ctxCwd: ctx.cwd,
						sessionId,
						config,
						agents,
						extensionPath: extensionPath(),
						skillPath: skillPath(),
						runnerPath: join(packageRoot(), "extensions/background/runner.ts"),
						port,
						signal,
					});
					if (specs.length === 1 && specs[0]?.workflow?.assignment === "owner") {
						persistActiveWorkflow({
							taskId: receipt.taskId,
							playbook: specs[0].workflow.playbook,
						});
					}
					startTreePolling(receipt.taskId, receipt.workflowId, ctx);
					return textResult(JSON.stringify(receipt), receipt);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), {}, true);
				}
			}
			const childDepth: ChildDepth = childDepthFor(parentDepth);
			if (childDepth === 2 && specs.some((spec) => spec.workflow?.assignment === "owner")) {
				return textResult("dstack_task refused: depth-2 children cannot be task owners.", {}, true);
			}
			const launched = launchNestedTask({
				request,
				config,
				agents,
				ctxCwd: ctx.cwd,
				skillPath: skillPath(),
				extensionPath: extensionPath(),
				childDepth,
				registry: nestedTaskRegistry,
			});
			const receipt = {
				taskId: launched.taskId,
				mode: launched.mode,
				taskCount: launched.taskCount,
			};
			return textResult(JSON.stringify(receipt), receipt);
		},
	});

	pi.registerTool({
		name: "dstack_result",
		label: "dstack result",
		description:
			"Read a bounded summary for a background dstack task. Use detail=full only when the complete child transcript is necessary. Call after receiving a completion notification or a stale wake-up.",
		parameters: ResultParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (nestedTaskRegistry.has(params.taskId)) {
				const record = nestedTaskRegistry.get(params.taskId)!;
				const result = projectNestedResult(record, params.detail);
				const usage = record.status !== "running" && record.details !== undefined && !record.usageClaimed
					? sumChildUsage(record.details.results.map((child) => child.usage))
					: undefined;
				if (usage !== undefined) record.usageClaimed = true;
				nestedTaskRegistry.prune();
				return textResult(JSON.stringify(result), result, false, usage);
			}

			const files = createTaskResultFiles(sessionId);
			const result = await readDstackResult({
				taskId: params.taskId,
				detail: params.detail,
				statusExact: (taskId) => getEventBusPort().statusExact(taskId, signal),
				readBinding: files.readBinding,
				readProgress: files.readProgress,
				readCommittedResult: files.readCommittedResult,
			});
			const terminal = result.kind === "complete" || result.kind === "artifact" || result.kind === "cancelled" || result.kind === "runner_failed";
			if (activeWorkflow?.taskId === params.taskId && terminal) {
				if (ctx) lastContext = ctx;
				await pollTreeTick();
				if (!ambientStatus?.snapshot.committed) {
					ambientStatus = undefined;
					if (lastContext?.hasUI) {
						lastContext.ui.setWidget("dstack-tree", undefined);
					}
				}
				persistActiveWorkflow(undefined);
				stopTreeTimer();
			}
			let usage: Usage | undefined;
			if (result.kind === "complete" || result.kind === "artifact") {
				const binding = await files.readBinding(params.taskId);
				if (binding !== undefined) {
					const committed = await files.readCommittedResult(binding);
					const unreportedUsage = committed !== undefined ? committedUsage(committed) : undefined;
					if (unreportedUsage !== undefined && await files.claimUsage(binding)) usage = unreportedUsage;
				}
			}
			return textResult(JSON.stringify(result), result, false, usage);
		},
	});

	pi.registerTool({
		name: "dstack_kill",
		label: "dstack kill",
		description:
			"Cancel or abort a running dstack task by task id. Idempotent for already-terminal tasks.",
		parameters: KillParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (nestedTaskRegistry.has(params.taskId)) {
				const record = nestedTaskRegistry.get(params.taskId)!;
				if (record.status !== "running") {
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: "already_terminal",
						message: "Task is already terminal.",
					};
					return textResult(JSON.stringify(killRes), killRes);
				}
				nestedTaskRegistry.cancel(params.taskId);
				await record.completionPromise;
				const killRes: DstackKillResult = {
					taskId: params.taskId,
					status: "killed",
					message: "Task cancelled successfully.",
				};
				return textResult(JSON.stringify(killRes), killRes);
			}

			let parentDepth: ReturnType<typeof spawnableDepth>;
			try {
				parentDepth = spawnableDepth();
			} catch {
				parentDepth = 0;
			}

			if (parentDepth === 0) {
				const port = getEventBusPort();
				let task: CompanionTaskState | undefined;
				try {
					task = await port.statusExact(params.taskId, signal);
				} catch (err) {
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: "kill_failed",
						message: err instanceof Error ? err.message : String(err),
					};
					return textResult(JSON.stringify(killRes), killRes, true);
				}

				if (task === undefined) {
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: "unknown_task",
						message: `No task exists with id ${params.taskId}.`,
					};
					return textResult(JSON.stringify(killRes), killRes);
				}

				if (task.status === "completed" || task.status === "failed" || task.status === "killed") {
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: "already_terminal",
						message: "Task is already terminal.",
					};
					return textResult(JSON.stringify(killRes), killRes);
				}

				try {
					await port.kill(params.taskId, signal);
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: "killed",
						message: "Task cancelled successfully.",
					};
					if (activeWorkflow?.taskId === params.taskId) {
						if (ctx) lastContext = ctx;
						ambientStatus = undefined;
						if (lastContext?.hasUI) {
							lastContext.ui.setWidget("dstack-tree", undefined);
						}
						persistActiveWorkflow(undefined);
						stopTreeTimer();
					}
					return textResult(JSON.stringify(killRes), killRes);
				} catch (err) {
					let latest: CompanionTaskState | undefined;
					try {
						latest = await port.statusExact(params.taskId, signal);
					} catch {}
					const terminal = latest?.status === "completed" || latest?.status === "failed" || latest?.status === "killed";
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: terminal ? "already_terminal" : "kill_failed",
						message: terminal ? "Task is already terminal." : err instanceof Error ? err.message : String(err),
					};
					return textResult(JSON.stringify(killRes), killRes, !terminal);
				}
			}

			const killRes: DstackKillResult = {
				taskId: params.taskId,
				status: "unknown_task",
				message: `No task exists with id ${params.taskId}.`,
			};
			return textResult(JSON.stringify(killRes), killRes);
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
