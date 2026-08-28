import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { SessionManager, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
import { buildCostSnapshot, formatCostOverlay, formatMergedCost, type CostSnapshot } from "./cost.ts";
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
import { ACTIVE_WORKFLOW_ENTRY, MODE_ENTRY, NESTING_ENV, SESSION_REF_ENV, STATUS_FILE_ENV, type ActiveWorkflow, type ChildDepth, type ModeState, type TodoState } from "./types.ts";
import { createEventBusV1Port, type BackgroundTaskPort, type CompanionTaskState } from "./background/eventbus-v1.ts";
import { createTaskResultFiles, launchTaskGroup, sessionRoot } from "./background/launch.ts";
import { atomicWriteFile } from "./background/artifacts.ts";
import {
	MAX_STATUS_NOTE_CHARS,
	MAX_STATUS_PHASE_CHARS,
	sanitizeString,
	type SemanticStatus,
	type SemanticStatusBlockedOn,
} from "./background/journal.ts";
import { readDstackResult, type CommittedResult, type DstackResultView } from "./background/result.ts";
import { buildChildSessionRef } from "./background/session.ts";
import { snapshotActiveLeases, type LeaseSnapshot } from "./background/scheduler.ts";
import {
	formatCompletionWakePrompt,
	formatNestedCompletionPrompt,
	formatRunnerFailureWakePrompt,
	claimNestedUsage,
	formatStaleWakePrompt,
	launchNestedTask,
	NestedTaskRegistry,
	projectNestedResult,
	restoreFiredCompletionWakes,
	restoreFiredStaleWakes,
	shouldTriggerCompletionWake,
	shouldTriggerStaleWake,
	type DstackKillResult,
	type NestedTaskRecord,
	type TaskDetails,
	type TaskResult,
} from "./task-registry.ts";
import {
	augmentRequestForRetry,
	classifyFailure,
	formatRecoveryRelaunchNotice,
	formatRecoveryStoppedNotice,
	MAX_OWNER_ATTEMPTS,
	nextRecoveryAction,
	RECOVERY_ENTRY,
	restoreRecoveryLineages,
	summarizeFailure,
	type RecoveryLineage,
} from "./background/recovery.ts";
import { activityLines, buildTreeSnapshot, latestActivity, parseTreeSnapshot, renderTreeLines, type SessionRefCache, type TreeSnapshot } from "./background/tree.ts";
import { DstackStatusWriter, type DstackRootState, type DstackStatusTask, type DstackTaskState } from "./status.ts";
import {
	parseTranscriptProgressEvent,
	PROGRESS_ENTRY,
	renderTranscriptProgress,
	TranscriptProgressTracker,
} from "./background/progress.ts";
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
	blockedOn: Type.Optional(StringEnum(["human", "approval", "dependency", "external"] as const)),
});

function skillPath(): string {
	return join(packageRoot(), "skills/dmode/SKILL.md");
}

type SwitchableSessionContext = Readonly<{
	switchSession: (path: string) => Promise<unknown>;
}>;

function isSwitchableSessionContext(candidate: unknown): candidate is SwitchableSessionContext {
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		"switchSession" in candidate &&
		typeof candidate.switchSession === "function"
	);
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

function formatDstackResultSummary(details: unknown): string {
	if (!isRecord(details) || typeof details.kind !== "string") return "(result output)";
	const target = typeof details.taskId === "string" ? ` ${details.taskId}` : "";

	if (details.kind === "running" && isRecord(details.progress)) {
		const complete = details.progress.complete;
		const total = details.progress.total;
		const counts = typeof complete === "number" && typeof total === "number" ? `: ${complete}/${total}` : "";
		return `⏳ running${target}${counts}`;
	}
	if (details.kind === "complete" && isRecord(details.package) && Array.isArray(details.package.results)) {
		const failed = details.package.results.filter(
			(item) => isRecord(item) && typeof item.exitCode === "number" && item.exitCode !== 0,
		).length;
		const succeeded = details.package.results.length - failed;
		return `${failed > 0 ? "✗" : "✓"} complete${target}: ${succeeded}/${details.package.results.length}${failed > 0 ? `, ${failed} failed` : ""}`;
	}

	switch (details.kind) {
		case "artifact": return `${details.outcome === "succeeded" ? "✓" : "✗"} artifact${target}`;
		case "runner_failed": return `✗ runner failed${target}`;
		case "cancelled": return `✗ cancelled${target}`;
		case "unknown_task": return `✗ unknown task${target}`;
		case "infrastructure_failure": return `✗ infrastructure failure${target}`;
		default: return `(result output${target})`;
	}
}

export { latestActivity };

const NESTED_RESULT_WAIT_MS = 15 * 60 * 1000;
const COMPANION_CHECK_INTERVAL_MS = 15_000;

async function awaitNestedCompletion(completion: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const waiters: Promise<unknown>[] = [
			completion,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, NESTED_RESULT_WAIT_MS);
				timer.unref();
			}),
		];
		if (signal !== undefined) {
			waiters.push(
				new Promise<void>((resolve) => {
					onAbort = () => resolve();
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);
		}
		await Promise.race(waiters);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
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

export default function dstack(pi: ExtensionAPI) {
	let mode: ModeState = { on: true };
	let activeWorkflow: ActiveWorkflow | undefined;
	let todos: TodoState = { items: [] };
	let sessionId = "unknown";
	let pendingContinuation: { sessionId: string; tasks: TodoSnapshot[] } | undefined;
	let eventBusPort: BackgroundTaskPort | undefined;
	let treeTimer: NodeJS.Timeout | undefined;
	let statusHeartbeatTimer: NodeJS.Timeout | undefined;
	let statusWriter: DstackStatusWriter | undefined;
	let rootState: DstackRootState = "idle";
	let rootSemanticStatus: SemanticStatus | undefined;
	let statusTree: TreeSnapshot | undefined;
	let currentNestedTaskId: string | undefined;
	let taskTerminalState: "completed" | "failed" | "cancelled" | undefined;
	let costTimer: NodeJS.Timeout | undefined;
	let costPollGeneration = 0;
	let latestCostSnapshot: CostSnapshot | undefined;
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
	const firedCompletionWakes = new Set<string>();
	let lastCompanionCheck = 0;
	const recoveryLineages = new Map<string, RecoveryLineage>();
	const lineageIdByTaskId = new Map<string, string>();
	const recoveryInFlight = new Set<string>();
	let treePollGeneration = 0;
	const transcriptProgress = new TranscriptProgressTracker();

	function stopTreeTimer() {
		treePollGeneration += 1;
		transcriptProgress.reset();
		if (treeTimer !== undefined) {
			clearInterval(treeTimer);
			treeTimer = undefined;
		}
	}

	function stopStatusHeartbeat() {
		if (statusHeartbeatTimer !== undefined) {
			clearInterval(statusHeartbeatTimer);
			statusHeartbeatTimer = undefined;
		}
	}

	function nestedStatusTask(record: NestedTaskRecord): DstackStatusTask {
		const taskState: DstackTaskState = record.status === "running" ? "working" : record.status === "completed" ? "completed" : record.status;
		return {
			id: record.taskId,
			kind: "workflow",
			state: taskState,
			summary: `${record.mode} nested task`,
			children: record.children.map((child, index) => {
				const stage = child.lifecycle.stage;
				const state: DstackTaskState = stage === "running" ? "working" : stage === "succeeded" ? "completed" : stage === "skipped" ? "cancelled" : stage;
				const status = "latestStatus" in child.lifecycle ? child.lifecycle.latestStatus : undefined;
				return {
					id: String(index),
					kind: "agent",
					state,
					summary: sanitizeString(child.spec.task, 160),
					...(status?.phase !== undefined ? { phase: status.phase } : {}),
					...(status !== undefined ? { status } : {}),
					children: [],
				};
			}),
		};
	}

	async function publishMachineStatus(shutdownAt?: string): Promise<void> {
		if (statusWriter === undefined) return;
		const nestedRecord = currentNestedTaskId === undefined ? undefined : nestedTaskRegistry.get(currentNestedTaskId);
		try {
			await statusWriter.write({
				heartbeatAt: new Date().toISOString(),
				rootState,
				...(rootSemanticStatus !== undefined ? { rootStatus: rootSemanticStatus } : {}),
				...(statusTree !== undefined ? { tree: statusTree } : {}),
				...(nestedRecord !== undefined ? { task: nestedStatusTask(nestedRecord) } : {}),
				...(taskTerminalState !== undefined ? { taskTerminalState } : {}),
				...(shutdownAt !== undefined ? { shutdownAt } : {}),
			});
		} catch {}
	}

	function startStatusHeartbeat() {
		stopStatusHeartbeat();
		statusHeartbeatTimer = setInterval(() => {
			void publishMachineStatus();
		}, statusWriter?.heartbeatIntervalMs ?? 5_000);
		statusHeartbeatTimer.unref();
	}

	function stopCostTimer() {
		costPollGeneration += 1;
		if (costTimer !== undefined) {
			clearInterval(costTimer);
			costTimer = undefined;
		}
	}

	async function refreshCost(ctx: ExtensionContext, generation = costPollGeneration): Promise<CostSnapshot | undefined> {
		try {
			const snapshot = await buildCostSnapshot({
				entries: ctx.sessionManager.getEntries(),
				sessionId,
				files: createTaskResultFiles(sessionId),
				todoPath: todoFilePath(sessionId),
			});
			if (generation !== costPollGeneration) return undefined;
			latestCostSnapshot = snapshot;
			ctx.ui.setStatus("dstack-cost", formatMergedCost(snapshot.total));
			return snapshot;
		} catch {
			return undefined;
		}
	}

	function startCostPolling(ctx: ExtensionContext) {
		stopCostTimer();
		const generation = costPollGeneration;
		void refreshCost(ctx, generation);
		costTimer = setInterval(() => {
			void refreshCost(ctx, generation);
		}, 1000);
		costTimer.unref();
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
			const result = await ctx.ui.custom<AgentInspectorResult>(
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
			if (result && typeof result === "object" && "action" in result) {
				const switchable = isSwitchableSessionContext(ctx) ? ctx : undefined;
				if (result.action === "resume") {
					try {
						if (switchable !== undefined) {
							await switchable.switchSession(result.sessionFile);
						}
					} catch (error) {
						ctx.ui.notify(`Failed to resume session: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				} else if (result.action === "fork") {
					try {
						const targetCwd = result.cwd ?? ctx.cwd ?? process.cwd();
						const forkedManager = SessionManager.forkFrom(result.sessionFile, targetCwd);
						const forkedFile = forkedManager.getSessionFile();
						if (forkedFile && switchable !== undefined) {
							await switchable.switchSession(forkedFile);
						}
					} catch (error) {
						ctx.ui.notify(`Failed to fork session: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
			}
		} finally {
			inspectorOpen = false;
			updateTreeWidget(ctx);
		}
	}

	const treeSessionRefCache: SessionRefCache = new Map();

	async function pollTreeTick(generation = treePollGeneration) {
		if (!treeArtifactDir || !treeSchedulerRoot || !treeLastTaskId || !treeLastWorkflowId) return;
		try {
			let activeLeases: readonly LeaseSnapshot[] = [];
			try {
				activeLeases = await snapshotActiveLeases(treeSchedulerRoot);
			} catch {}
			const snapshot = await buildTreeSnapshot({
				taskId: treeLastTaskId,
				workflowId: treeLastWorkflowId,
				artifactDir: treeArtifactDir,
				schedulerRoot: treeSchedulerRoot,
				todoPath: todoFilePath(sessionId),
				playbook: activeWorkflow?.playbook,
				activeLeases,
				sessionRefCache: treeSessionRefCache,
			});
			if (!snapshot || generation !== treePollGeneration) return;
			for (const progressEvent of transcriptProgress.ingest(snapshot)) {
				pi.appendEntry(PROGRESS_ENTRY, progressEvent);
			}
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
			statusTree = snapshot;
			await publishMachineStatus();
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
				const collected = activeWorkflow?.taskId !== snapshot.taskId;
				if (shouldTriggerCompletionWake({ snapshot, collected, firedTaskIds: firedCompletionWakes, control })) {
					firedCompletionWakes.add(snapshot.taskId);
					pi.appendEntry("dstack-completion-wake", { taskId: snapshot.taskId, timestamp: new Date().toISOString() });
					pi.sendMessage(
						{
							customType: "dstack-completion-wake",
							content: formatCompletionWakePrompt(snapshot.taskId),
							display: false,
							details: { taskId: snapshot.taskId },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					void recoverFromCommitted(snapshot.taskId);
				}
				if (
					!snapshot.committed &&
					!collected &&
					!firedCompletionWakes.has(snapshot.taskId) &&
					control.isIdle &&
					!control.hasPendingMessages &&
					Date.now() - lastCompanionCheck >= COMPANION_CHECK_INTERVAL_MS
				) {
					lastCompanionCheck = Date.now();
					try {
						const state = await getEventBusPort().statusExact(snapshot.taskId);
						if (
							(state?.status === "failed" || state?.status === "killed") &&
							activeWorkflow?.taskId === snapshot.taskId &&
							!firedCompletionWakes.has(snapshot.taskId)
						) {
							firedCompletionWakes.add(snapshot.taskId);
							pi.appendEntry("dstack-completion-wake", { taskId: snapshot.taskId, timestamp: new Date().toISOString() });
							pi.sendMessage(
								{
									customType: "dstack-completion-wake",
									content: formatRunnerFailureWakePrompt(snapshot.taskId, state.status),
									display: false,
									details: { taskId: snapshot.taskId },
								},
								{ deliverAs: "followUp", triggerTurn: true },
							);
							// killed companions map to a cancelled view so recovery never retries user-cancelled work
							const view: DstackResultView = state.status === "failed"
								? { kind: "runner_failed", taskId: snapshot.taskId, message: "The background task runner failed.", companionOutputPath: state.outputPath }
								: { kind: "cancelled", taskId: snapshot.taskId, message: "The background task was killed." };
							void maybeRecover(snapshot.taskId, view, lastContext);
						}
					} catch {}
				}
			}
			// keep ticking on uncollected committed workflows until the completion wake fires
			if (
				snapshot.committed &&
				activeWorkflowCount === 0 &&
				(activeWorkflow?.taskId !== snapshot.taskId || firedCompletionWakes.has(snapshot.taskId))
			) {
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
		const generation = treePollGeneration;
		void pollTreeTick(generation);
		treeTimer = setInterval(() => {
			void pollTreeTick(generation);
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

	function indexLineage(lineage: RecoveryLineage) {
		recoveryLineages.set(lineage.lineageId, lineage);
		lineageIdByTaskId.set(lineage.currentTaskId, lineage.lineageId);
		for (const attempt of lineage.attempts) lineageIdByTaskId.set(attempt.taskId, lineage.lineageId);
	}

	function persistLineage(lineage: RecoveryLineage) {
		indexLineage(lineage);
		pi.appendEntry(RECOVERY_ENTRY, lineage);
	}

	function restoreRecoveryState(entries: readonly SessionEntryLike[]) {
		recoveryLineages.clear();
		lineageIdByTaskId.clear();
		for (const lineage of restoreRecoveryLineages(entries).values()) indexLineage(lineage);
	}

	async function evidenceDirFor(taskId: string): Promise<string | undefined> {
		try {
			const binding = await createTaskResultFiles(sessionId).readBinding(taskId);
			if (binding === undefined) return undefined;
			return join(binding.root ?? sessionRoot(sessionId), "workflows", binding.workflowId);
		} catch {
			return undefined;
		}
	}

	async function maybeRecover(taskId: string, view: DstackResultView, ctx: ExtensionContext | undefined): Promise<void> {
		const lineageId = lineageIdByTaskId.get(taskId);
		if (lineageId === undefined) return;
		const lineage = recoveryLineages.get(lineageId);
		if (lineage === undefined) return;
		const action = nextRecoveryAction(lineage, taskId, classifyFailure(view));
		if (action.kind === "ignore") return;
		if (recoveryInFlight.has(lineageId)) return;
		recoveryInFlight.add(lineageId);
		try {
			if (action.kind === "stop" && action.status === "resolved") {
				persistLineage({ ...lineage, status: "resolved" });
				return;
			}
			const reason = summarizeFailure(view);
			const endedAt = new Date().toISOString();
			const attempts = [...lineage.attempts, { taskId, endedAt, reason }];
			const evidenceDir = await evidenceDirFor(taskId);
			if (action.kind === "stop") {
				persistLineage({ ...lineage, attempts, status: action.status });
				// a user-cancelled task is a deliberate stop; recording it is enough, waking the agent is noise
				if (view.kind === "cancelled") return;
				pi.sendMessage(
					{
						customType: RECOVERY_ENTRY,
						content: formatRecoveryStoppedNotice({ status: action.status, attempts, evidenceDir }),
						display: false,
						details: { lineageId, taskId, status: action.status },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				return;
			}
			const augmented = augmentRequestForRetry(lineage.request, {
				attemptNumber: action.attemptNumber,
				maxAttempts: MAX_OWNER_ATTEMPTS,
				priorTaskId: taskId,
				reason,
				evidenceDir,
			});
			try {
				const port = getEventBusPort();
				await port.capabilities(AbortSignal.timeout(1000));
				const loaded = await loadConfig(defaultConfigPath());
				const config = loaded.ok ? loaded.value : emptyConfig();
				const launchCtx = ctx ?? lastContext;
				const receipt = await launchTaskGroup({
					request: augmented,
					ctxCwd: launchCtx?.cwd ?? process.cwd(),
					sessionId,
					config,
					agents: discoverAgents(),
					extensionPath: extensionPath(),
					skillPath: skillPath(),
					runnerPath: join(packageRoot(), "extensions/background/runner.ts"),
					port,
				});
				persistLineage({ ...lineage, currentTaskId: receipt.taskId, attempts, status: "active" });
				persistActiveWorkflow({ taskId: receipt.taskId, playbook: lineage.playbook ?? activeWorkflow?.playbook ?? "" });
				if (launchCtx !== undefined) startTreePolling(receipt.taskId, receipt.workflowId, launchCtx);
				pi.sendMessage(
					{
						customType: RECOVERY_ENTRY,
						content: formatRecoveryRelaunchNotice({
							priorTaskId: taskId,
							newTaskId: receipt.taskId,
							attemptNumber: action.attemptNumber,
							maxAttempts: MAX_OWNER_ATTEMPTS,
							reason,
						}),
						display: false,
						details: { lineageId, priorTaskId: taskId, taskId: receipt.taskId, attemptNumber: action.attemptNumber },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch (error) {
				const launchFailure = `recovery relaunch failed: ${error instanceof Error ? error.message : String(error)}`;
				const failedAttempts = [...attempts.slice(0, -1), { taskId, endedAt, reason: `${reason}; ${launchFailure}` }];
				persistLineage({ ...lineage, attempts: failedAttempts, status: "unrecoverable" });
				pi.sendMessage(
					{
						customType: RECOVERY_ENTRY,
						content: formatRecoveryStoppedNotice({ status: "unrecoverable", attempts: failedAttempts, evidenceDir }),
						display: false,
						details: { lineageId, taskId, status: "unrecoverable" },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		} finally {
			recoveryInFlight.delete(lineageId);
		}
	}

	async function recoverFromCommitted(taskId: string): Promise<void> {
		try {
			const files = createTaskResultFiles(sessionId);
			const binding = await files.readBinding(taskId);
			if (binding === undefined) return;
			const committed = await files.readCommittedResult(binding);
			if (committed?.kind !== "complete") return;
			await maybeRecover(taskId, { kind: "complete", taskId, detail: "full", package: committed.package }, lastContext);
		} catch {}
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

	let sessionRefWritten = false;
	async function maybeWriteChildSessionRef(ctx: ExtensionContext): Promise<void> {
		if (sessionRefWritten) return;
		const refFile = process.env[SESSION_REF_ENV];
		if (refFile === undefined || refFile === "") return;
		try {
			const ref = buildChildSessionRef(ctx.sessionManager);
			if (ref === undefined) return;
			await atomicWriteFile(refFile, `${JSON.stringify(ref)}\n`);
			sessionRefWritten = true;
		} catch {}
	}

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
				const blockedOn: SemanticStatusBlockedOn | undefined = params.blockedOn;
				const status: SemanticStatus = {
					...(phase !== undefined ? { phase } : {}),
					...(note !== undefined ? { note } : {}),
					...(blocking !== undefined ? { blocking } : {}),
					...(blockedOn !== undefined ? { blockedOn } : {}),
					updatedAt: new Date().toISOString(),
				};
				const statusFile = process.env[STATUS_FILE_ENV];
				if (statusFile) {
					await atomicWriteFile(statusFile, `${JSON.stringify(status, null, 2)}\n`);
				}
				rootSemanticStatus = status;
				await publishMachineStatus();
				const parts: string[] = [];
				if (phase) parts.push(`phase: ${phase}`);
				if (note) parts.push(`note: ${note}`);
				if (blocking !== undefined) parts.push(`blocking: ${blocking}`);
				if (blockedOn !== undefined) parts.push(`blockedOn: ${blockedOn}`);
				const text = parts.length > 0 ? parts.join(", ") : "status cleared";
				return textResult(`Status updated (${text})`, status);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		pendingContinuation = undefined;
		stopTreeTimer();
		stopStatusHeartbeat();
		rootState = "idle";
		rootSemanticStatus = undefined;
		statusTree = undefined;
		currentNestedTaskId = undefined;
		taskTerminalState = undefined;
		stopCostTimer();
		ambientStatus = undefined;
		treeLastTaskId = undefined;
		treeLastWorkflowId = undefined;
		treeArtifactDir = undefined;
		treeSchedulerRoot = undefined;
		firedStaleWakes.clear();
		for (const id of restoreFiredStaleWakes(branchEntries(ctx))) firedStaleWakes.add(id);
		firedCompletionWakes.clear();
		for (const id of restoreFiredCompletionWakes(branchEntries(ctx))) firedCompletionWakes.add(id);
		restoreRecoveryState(branchEntries(ctx));
		nestedTaskRegistry.clear();
		if (ctx.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("dstack-tree", undefined);
		}
		mode = restoreMode(branchEntries(ctx));
		activeWorkflow = restoreActiveWorkflow(branchEntries(ctx));
		sessionId = ctx.sessionManager.getSessionId();
		statusWriter = new DstackStatusWriter(sessionId);
		await publishMachineStatus();
		startStatusHeartbeat();
		await maybeWriteChildSessionRef(ctx);
		await refreshTodos();
		applyStatus(ctx);
		if (!isChild) startCostPolling(ctx);
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
		statusTree = undefined;
		currentNestedTaskId = undefined;
		taskTerminalState = undefined;
		rootSemanticStatus = undefined;
		if (statusWriter?.sessionId !== sessionId) {
			stopStatusHeartbeat();
			await publishMachineStatus(new Date().toISOString());
			statusWriter = new DstackStatusWriter(sessionId);
			startStatusHeartbeat();
		}
		await publishMachineStatus();
		firedStaleWakes.clear();
		for (const id of restoreFiredStaleWakes(branchEntries(ctx))) firedStaleWakes.add(id);
		firedCompletionWakes.clear();
		for (const id of restoreFiredCompletionWakes(branchEntries(ctx))) firedCompletionWakes.add(id);
		restoreRecoveryState(branchEntries(ctx));
		nestedTaskRegistry.clear();
		applyStatus(ctx);
		if (!isChild) void refreshCost(ctx);
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

	pi.on("agent_start", async () => {
		rootState = "working";
		await publishMachineStatus();
	});

	pi.on("agent_settled", async () => {
		rootState = "idle";
		await publishMachineStatus();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await maybeWriteChildSessionRef(ctx);
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
		stopStatusHeartbeat();
		rootState = "idle";
		await publishMachineStatus(new Date().toISOString());
		stopCostTimer();
		latestCostSnapshot = undefined;
		eventBusPort?.close();
		eventBusPort = undefined;
		nestedTaskRegistry.clear();
		stopTreeTimer();
		ambientStatus = undefined;
		if (ctx?.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("dstack-tree", undefined);
			ctx.ui.setStatus("dstack-cost", undefined);
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

	pi.registerEntryRenderer?.(PROGRESS_ENTRY, (entry, { expanded }, theme) => {
		const progressEvent = parseTranscriptProgressEvent(entry.data);
		if (!progressEvent) {
			return new Text(theme.fg("dim", "(corrupt dstack progress entry)"), 0, 0);
		}
		return new Text(renderTranscriptProgress(progressEvent, expanded, theme), 0, 0);
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

	pi.registerCommand("dcost", {
		description: "Open the dstack persisted and live cost breakdown.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/dcost requires the interactive Pi UI", "error");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let snapshot = latestCostSnapshot;
				let disposed = false;
				const refresh = async () => {
					const next = await refreshCost(ctx);
					if (next !== undefined && !disposed) {
						snapshot = next;
						tui.requestRender();
					}
				};
				void refresh();
				const timer = setInterval(() => void refresh(), 1000);
				timer.unref();
				return {
					render(width: number) {
						const lines = snapshot === undefined ? ["dstack cost", "Loading..."] : formatCostOverlay(snapshot);
						return lines.map((line, index) => truncateToWidth(index === 0 ? theme.bold(theme.fg("accent", line)) : line, width));
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape")) done();
					},
					invalidate() {},
					dispose() {
						disposed = true;
						clearInterval(timer);
					},
				};
			}, {
				overlay: true,
				overlayOptions: { anchor: "center", width: "80%", minWidth: 56, maxHeight: "80%", margin: 1 },
			});
		},
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
			statusTree = undefined;
			currentNestedTaskId = undefined;
			taskTerminalState = undefined;
			await publishMachineStatus();
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
						if (!lineageIdByTaskId.has(receipt.taskId)) {
							persistLineage({
								lineageId: receipt.taskId,
								request,
								playbook: specs[0].workflow.playbook,
								currentTaskId: receipt.taskId,
								attempts: [],
								status: "active",
							});
						}
					}
					startTreePolling(receipt.taskId, receipt.workflowId, ctx);
					await publishMachineStatus();
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
			let completionWakeSent = false;
			void launched.record.completionPromise.then(() => {
				// reads before resolution only peeked at running state; suppress the wake
				// only when a read lands after terminal (an in-flight blocking collect)
				const readsAtResolve = launched.record.readCount;
				setImmediate(() => {
					if (completionWakeSent || launched.record.readCount > readsAtResolve) return;
					completionWakeSent = true;
					pi.sendMessage(
						{
							customType: "dstack-nested-complete",
							content: formatNestedCompletionPrompt(launched.taskId, launched.record.status),
							display: false,
							details: { taskId: launched.taskId },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				});
			});
			const receipt = {
				taskId: launched.taskId,
				mode: launched.mode,
				taskCount: launched.taskCount,
			};
			currentNestedTaskId = launched.taskId;
			await publishMachineStatus();
			return textResult(JSON.stringify(receipt), receipt);
		},
	});

	pi.registerTool({
		name: "dstack_result",
		label: "dstack result",
		description:
			"Read a bounded summary for a background dstack task. Use detail=full only when the complete child transcript is necessary. Call after receiving a completion notification or a stale wake-up.",
		parameters: ResultParams,
		renderResult(result, { expanded, isPartial }) {
			if (expanded) {
				const text = result.content.find((part) => part.type === "text")?.text ?? "(no output)";
				return new Text(text, 0, 0);
			}
			const summary = isPartial ? "⏳ (reading...)" : formatDstackResultSummary(result.details);
			return new Text(`${summary} (${keyHint("app.tools.expand", "to expand")})`, 0, 0);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			await publishMachineStatus();
			if (nestedTaskRegistry.has(params.taskId)) {
				const record = nestedTaskRegistry.get(params.taskId)!;
				if (record.status === "running") {
					await awaitNestedCompletion(record.completionPromise, signal);
				}
				const result = projectNestedResult(record, params.detail);
				const usage = claimNestedUsage(record);
				nestedTaskRegistry.prune();
				if (record.status !== "running") taskTerminalState = record.status === "completed" ? "completed" : "failed";
				await publishMachineStatus();
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
			if (terminal) {
				taskTerminalState = result.kind === "cancelled" ? "cancelled" : result.kind === "runner_failed" ? "failed" : "completed";
			}
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
			await publishMachineStatus();
			if (terminal || result.kind === "infrastructure_failure") {
				void maybeRecover(params.taskId, result, ctx);
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
			await publishMachineStatus();
			if (nestedTaskRegistry.has(params.taskId)) {
				const record = nestedTaskRegistry.get(params.taskId)!;
				if (record.status !== "running") {
					const usage = claimNestedUsage(record);
					const killRes: DstackKillResult = {
						taskId: params.taskId,
						status: "already_terminal",
						message: "Task is already terminal.",
					};
					return textResult(JSON.stringify(killRes), killRes, false, usage);
				}
				nestedTaskRegistry.cancel(params.taskId);
				await record.completionPromise;
				const usage = claimNestedUsage(record);
				taskTerminalState = "cancelled";
				await publishMachineStatus();
				const killRes: DstackKillResult = {
					taskId: params.taskId,
					status: "killed",
					message: "Task cancelled successfully.",
				};
				return textResult(JSON.stringify(killRes), killRes, false, usage);
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
					taskTerminalState = "cancelled";
					if (activeWorkflow?.taskId === params.taskId) {
						if (ctx) lastContext = ctx;
						ambientStatus = undefined;
						if (lastContext?.hasUI) {
							lastContext.ui.setWidget("dstack-tree", undefined);
						}
						persistActiveWorkflow(undefined);
						stopTreeTimer();
					}
					await publishMachineStatus();
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
					const previousStatus = rootSemanticStatus;
					rootSemanticStatus = { blockedOn: parsed.confirm ? "approval" : "human", updatedAt: new Date().toISOString() };
					await publishMachineStatus();
					try {
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
					} finally {
						rootSemanticStatus = previousStatus;
						await publishMachineStatus();
					}
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
