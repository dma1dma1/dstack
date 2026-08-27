import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
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
	resolveModel,
	resolveNestedLaunchModel,
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
import { ACTIVE_WORKFLOW_ENTRY, MODE_ENTRY, type ActiveWorkflow, type ChildDepth, type ModeState, type TaskSpec, type TodoState } from "./types.ts";
import { createEventBusV1Port, type BackgroundTaskPort } from "./background/eventbus-v1.ts";
import { createTaskResultFiles, launchTaskGroup, sessionRoot } from "./background/launch.ts";
import { atomicWriteFile, toAbsolutePath } from "./background/artifacts.ts";
import { readDstackResult } from "./background/result.ts";
import { acquireChildSlot } from "./background/scheduler.ts";
import { DSTACK_ARTIFACT_DIR_ENV, DSTACK_CHILD_INDEX_ENV, ROOT_WORKFLOW_ENV, SCHEDULER_ROOT_ENV } from "./background/workflow.ts";
import { activityLines, buildTreeSnapshot, latestActivity, parseTreeSnapshot, renderTreeLines, taskPreviewOf, type SpawnChildV1, type SpawnRecordV1, type TreeSnapshot } from "./background/tree.ts";
import {
	AgentInspector,
	listSessionWorkflows,
	renderAmbientWidgetLine,
	type AgentInspectorResult,
	type AmbientStatus,
} from "./background/inspector.ts";
import { createWorktree, WorktreeError } from "./worktree.ts";
import { workflowSystemPrompt } from "./workflow-context.ts";

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

export type TaskResult = ChildResult & {
	agent: string;
	cwd: string;
	task: string;
	step?: number;
};

export type TaskDetails = {
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
			task: ownerResultText(result.task),
			messages: result.messages.map((message) => ({ ...message, content: [...message.content] })),
			usage: { ...result.usage },
		})),
	};
}

const OWNER_RESULT_CAP = 8 * 1024;

function ownerResultText(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= OWNER_RESULT_CAP) return text;
	let summary = text.slice(0, OWNER_RESULT_CAP);
	while (Buffer.byteLength(summary, "utf8") > OWNER_RESULT_CAP) summary = summary.slice(0, -1);
	return `${summary}\n\n[worker summary truncated]`;
}

function ownerResultDetails(details: TaskDetails): TaskDetails {
	return {
		mode: details.mode,
		results: details.results.map((result) => ({
			...result,
			text: ownerResultText(result.text),
			stderr: ownerResultText(result.stderr),
			messages: [],
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

	pi.on("session_start", async (_event, ctx) => {
		pendingContinuation = undefined;
		stopTreeTimer();
		ambientStatus = undefined;
		treeLastTaskId = undefined;
		treeLastWorkflowId = undefined;
		treeArtifactDir = undefined;
		treeSchedulerRoot = undefined;
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

			const root = sessionRoot(sessionId);
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
			"Launch child agents. For dmode, root sends one nontrivial request to a workflow owner; owners may launch as many bounded worker batches as needed. Pass workflow metadata so workers receive phase and artifact state without rereading dmode. Root calls return a task id immediately. Wait for completion, then call dstack_result once. Do not poll.",
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
		async execute(_id, params, signal, onUpdate, ctx) {
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
			const details: TaskDetails = {
				mode: request.kind,
				results: specs.map((spec, index) =>
					emptyTaskResult(spec, spec.cwd ?? ctx.cwd, request.kind === "chain" ? index + 1 : undefined),
				),
			};
			const nestedGroupId = randomUUID();
			const rootWorkflowId = process.env[ROOT_WORKFLOW_ENV];
			const schedulerRoot = process.env[SCHEDULER_ROOT_ENV];
			const childIndexEnv = process.env[DSTACK_CHILD_INDEX_ENV];
			const artifactDirEnv = process.env[DSTACK_ARTIFACT_DIR_ENV];
			const parentIndex = childIndexEnv !== undefined ? Number.parseInt(childIndexEnv, 10) : Number.NaN;
			const canPersistSpawns = rootWorkflowId !== undefined && artifactDirEnv !== undefined && Number.isSafeInteger(parentIndex) && parentIndex >= 0;
			const spawnsDir = canPersistSpawns ? join(artifactDirEnv, "children", String(parentIndex), "spawns") : undefined;
			const spawnRecordPath = spawnsDir !== undefined ? join(spawnsDir, `${nestedGroupId}.json`) : undefined;
			const initialCreatedAt = new Date().toISOString();
			const spawnPhase = specs.map((s) => s.workflow?.phase).find((p): p is string => typeof p === "string" && p.length > 0);

			const spawnChildren: SpawnChildV1[] = specs.map((spec, idx) => {
				const resolved = resolveAgent(spec);
				const modelRes = resolveModel({
					explicit: spec.model,
					role: spec.role,
					roles: config.roles,
					candidateIndex: request.kind === "parallel" ? idx : 0,
					overrideReason: spec.overrideReason,
				});
				const launchModel = resolveNestedLaunchModel({
					resolution: modelRes.ok ? modelRes.value : undefined,
					env: process.env,
				});
				return {
					nestedIndex: idx,
					agent: resolved.agent,
					role: spec.role,
					assignment: spec.workflow?.assignment,
					taskPreview: taskPreviewOf(spec.task),
					taskFull: spec.task,
					workflow: spec.workflow,
					model: launchModel,
					cwd: spec.cwd ?? ctx.cwd,
					tools: resolved.tools ?? spec.tools,
					state: "queued",
					updatedAt: initialCreatedAt,
				};
			});

			function createSpawnRecordWriter(options: {
				spawnsDir: string;
				filePath: string;
				getRecord: () => SpawnRecordV1;
				minIntervalMs?: number;
			}) {
				const minIntervalMs = options.minIntervalMs ?? 1000;
				let lastWriteTime = 0;
				let timer: NodeJS.Timeout | undefined;
				let writeChain: Promise<void> = Promise.resolve();
				let disposed = false;

				const doWrite = async () => {
					const record = options.getRecord();
					try {
						await mkdir(options.spawnsDir, { recursive: true, mode: 0o700 });
						await atomicWriteFile(options.filePath, `${JSON.stringify(record, null, 2)}\n`);
						lastWriteTime = Date.now();
					} catch {}
				};

				const scheduleWrite = (): Promise<void> => {
					if (disposed) return Promise.resolve();
					if (timer !== undefined) {
						clearTimeout(timer);
						timer = undefined;
					}
					writeChain = writeChain.then(doWrite, doWrite);
					return writeChain;
				};

				return {
					writeThrottled() {
						if (disposed) return;
						const elapsed = Date.now() - lastWriteTime;
						if (elapsed >= minIntervalMs && timer === undefined) {
							void scheduleWrite();
						} else if (timer === undefined) {
							const delay = Math.max(0, minIntervalMs - elapsed);
							timer = setTimeout(() => {
								timer = undefined;
								void scheduleWrite();
							}, delay);
							timer.unref?.();
						}
					},
					async flush() {
						if (disposed) return;
						if (timer !== undefined) {
							clearTimeout(timer);
							timer = undefined;
						}
						await scheduleWrite();
					},
					dispose() {
						disposed = true;
						if (timer !== undefined) {
							clearTimeout(timer);
							timer = undefined;
						}
					},
				};
			}

			const spawnRecordWriter = canPersistSpawns && spawnsDir !== undefined && spawnRecordPath !== undefined
				? createSpawnRecordWriter({
						spawnsDir,
						filePath: spawnRecordPath,
						getRecord: () => ({
							schemaVersion: "dstack.spawn-record.v1",
							workflowId: rootWorkflowId,
							parentIndex,
							groupId: nestedGroupId,
							mode: request.kind,
							phase: spawnPhase,
							createdAt: initialCreatedAt,
							children: spawnChildren.map((c) => ({ ...c })),
						}),
					})
				: undefined;

			await spawnRecordWriter?.flush();

			const publish = () => {
				const snapshot = cloneDetails(details);
				onUpdate?.(textResult(progressText(snapshot), snapshot));
			};
			publish();
			const runOne = async (spec: TaskSpec, index: number): Promise<TaskResult> => {
				try {
					const resolved = resolveAgent(spec);
					const agent = agents.find((candidate) => candidate.name === resolved.agent);
					if (!agent) {
						const available = agents.map((candidate) => candidate.name).join(", ") || "none";
						throw new Error(`Unknown agent "${resolved.agent}". Available: ${available}.`);
					}
					const model = resolveModel({
						explicit: spec.model,
						role: spec.role,
						roles: config.roles,
						candidateIndex: request.kind === "parallel" ? index : 0,
						overrideReason: spec.overrideReason,
					});
					if (!model.ok) throw new Error(formatConfigError(model.error));
					const launchModel = resolveNestedLaunchModel({
						resolution: model.value,
						env: process.env,
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
					const existing = details.results[index];
					if (existing !== undefined) {
						details.results[index] = { ...existing, agent: resolved.agent, cwd, task: spec.task };
					}
					publish();
					const promptParts = [agent.systemPrompt.trim()];
					if (spec.workflow !== undefined) promptParts.push(workflowSystemPrompt(skillPath(), childDepth, spec.workflow));
					else if (resolved.dmode) promptParts.push(dmodeReminder(skillPath(), childDepth));
					let tmp: { dir: string; filePath: string } | undefined;
					let lease: Awaited<ReturnType<typeof acquireChildSlot>> | undefined;
					const system = promptParts.filter(Boolean).join("\n\n");
					if (system) tmp = await writeTempPrompt(system);
					try {
						if (rootWorkflowId && schedulerRoot) {
							lease = await acquireChildSlot({
								schedulerRoot: toAbsolutePath(schedulerRoot),
								workflowId: rootWorkflowId,
								childId: `${nestedGroupId}-${index}`,
								work: {
									depth: childDepth,
									tools: (resolved.tools ?? agent.tools?.join(","))?.split(","),
								},
								signal: signal ?? new AbortController().signal,
							});
						}
						const startedAt = new Date().toISOString();
						const runningChild = spawnChildren[index];
						if (runningChild !== undefined) {
							spawnChildren[index] = {
								...runningChild,
								state: "running",
								taskFull: spec.task,
								taskPreview: taskPreviewOf(spec.task),
								cwd,
								model: runningChild.model ?? launchModel,
								startedAt,
								updatedAt: startedAt,
							};
							await spawnRecordWriter?.flush();
						}

						const args = buildChildArgv({
							task: spec.task,
							extensionPath: extensionPath(),
							model: model.value.model,
							omitModel: model.value.omitModel,
							tools: resolved.tools ?? agent.tools?.join(","),
							systemPromptPath: tmp?.filePath,
						});
						const child = await runChildProcess({
							args,
							cwd,
							env: childEnv(childDepth, process.env, spec.workflow?.assignment),
							signal,
							onSpawn: (pid) => lease?.bindChild(pid),
							onUpdate: (partial) => {
								details.results[index] = { ...partial, agent: resolved.agent, cwd, task: spec.task, step: details.results[index]?.step };
								publish();
								const now = new Date().toISOString();
								const existing = spawnChildren[index];
								if (existing !== undefined) {
									spawnChildren[index] = {
										...existing,
										activity: latestActivity(partial),
										updatedAt: now,
									};
									spawnRecordWriter?.writeThrottled();
								}
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
						const now = new Date().toISOString();
						const existing = spawnChildren[index];
						if (existing !== undefined) {
							spawnChildren[index] = {
								...existing,
								state: signal?.aborted ? "cancelled" : completed.exitCode === 0 ? "succeeded" : "failed",
								exitCode: completed.exitCode,
								finalResponse: completed.text,
								errorMessage: completed.errorMessage,
								stderr: completed.stderr,
								stopReason: completed.stopReason,
								usage: completed.usage,
								model: completed.model ?? existing.model ?? launchModel,
								activity: latestActivity(completed),
								updatedAt: now,
								endedAt: now,
							};
							await spawnRecordWriter?.flush();
						}
						return completed;
					} finally {
						await lease?.release();
						if (tmp) await removeTemp(tmp.dir, tmp.filePath);
					}
				} catch (err) {
					const now = new Date().toISOString();
					const existing = spawnChildren[index];
					if (existing !== undefined && existing.state !== "succeeded" && existing.state !== "failed" && existing.state !== "cancelled") {
						spawnChildren[index] = {
							...existing,
							state: signal?.aborted ? "cancelled" : "failed",
							errorMessage: err instanceof Error ? err.message : String(err),
							updatedAt: now,
							endedAt: now,
						};
						await spawnRecordWriter?.flush();
					}
					throw err;
				}
			};
			try {
				if (request.kind === "chain") {
					const results: TaskResult[] = [];
					let previous = "";
					for (const [index, spec] of specs.entries()) {
						const task = spec.task.replace(/\{previous\}/g, previous);
						try {
							const result = await runOne({ ...spec, task }, index);
							results.push(result);
							if (result.exitCode !== 0) {
								const now = new Date().toISOString();
								for (let i = index + 1; i < spawnChildren.length; i++) {
									const remaining = spawnChildren[i];
									if (remaining !== undefined && remaining.state === "queued") {
										spawnChildren[i] = {
											...remaining,
											state: "skipped",
											updatedAt: now,
											endedAt: now,
										};
									}
								}
								await spawnRecordWriter?.flush();
								return textResult(`Chain stopped (${spec.agent}): ${ownerResultText(result.text)}`, ownerResultDetails(details), true);
							}
							previous = result.text;
						} catch (err) {
							const now = new Date().toISOString();
							for (let i = index + 1; i < spawnChildren.length; i++) {
								const remaining = spawnChildren[i];
								if (remaining !== undefined && remaining.state === "queued") {
									spawnChildren[i] = {
										...remaining,
										state: "skipped",
										updatedAt: now,
										endedAt: now,
									};
								}
							}
							await spawnRecordWriter?.flush();
							throw err;
						}
					}
					const last = results[results.length - 1];
					return textResult(ownerResultText(last?.text ?? "(no output)"), ownerResultDetails(details));
				}
				const results = await mapWithConcurrency(specs, MAX_CONCURRENCY, (spec, index) => runOne(spec, index));
				if (request.kind === "single") {
					const result = results[0];
					if (!result) return textResult("(no output)");
					return textResult(ownerResultText(result.text), ownerResultDetails(details), result.exitCode !== 0);
				}
				const text = results
					.map((task) => `### [${task.agent}] ${task.exitCode === 0 ? "completed" : "failed"}\n\n${ownerResultText(task.text)}`)
					.join("\n\n---\n\n");
				return textResult(text, ownerResultDetails(details));
			} catch (err) {
				const now = new Date().toISOString();
				for (let i = 0; i < spawnChildren.length; i++) {
					const c = spawnChildren[i];
					if (c !== undefined && (c.state === "queued" || c.state === "running")) {
						spawnChildren[i] = {
							...c,
							state: signal?.aborted ? "cancelled" : "failed",
							updatedAt: now,
							endedAt: now,
						};
					}
				}
				await spawnRecordWriter?.flush();
				if (err instanceof WorktreeError) {
					return textResult(err.message, {}, true);
				}
				return textResult(err instanceof Error ? err.message : String(err), {}, true);
			} finally {
				spawnRecordWriter?.dispose();
			}
		},
	});

	pi.registerTool({
		name: "dstack_result",
		label: "dstack result",
		description: "Read a bounded summary for a background dstack task. Use detail=full only when the complete child transcript is necessary.",
		parameters: ResultParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
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
			return textResult(JSON.stringify(result), result);
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
