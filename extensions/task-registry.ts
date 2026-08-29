import type { Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildDepth, DstackConfig, TaskRequest, TaskSpec, WorkflowAssignment } from "./types.ts";
import { SESSION_REF_ENV } from "./types.ts";
import type { ChildResult } from "./spawn.ts";
import {
	buildChildArgv,
	capOutput,
	childEnv,
	resolveAgent,
	runChildProcess,
	sumChildUsage,
} from "./spawn.ts";
import { formatConfigError, resolveModel, resolveNestedLaunchModel } from "./models.ts";
import { createWorktree } from "./worktree.ts";
import { workflowSystemPrompt } from "./workflow-context.ts";
import { dmodeReminder, type SessionEntryLike } from "./mode.ts";
import { atomicWriteFile, toAbsolutePath } from "./background/artifacts.ts";
import {
	allowStatusTool,
	ChildJournalRecorder,
	recentJournalActivity,
	type JournalEntry,
	type SemanticStatus,
} from "./background/journal.ts";
import { acquireChildSlot } from "./background/scheduler.ts";
import { readChildSessionRef } from "./background/session.ts";
import {
	DSTACK_ARTIFACT_DIR_ENV,
	DSTACK_CHILD_INDEX_ENV,
	ROOT_WORKFLOW_ENV,
	SCHEDULER_ROOT_ENV,
} from "./background/workflow.ts";
import {
	latestActivity,
	STALE_ACTIVITY_THRESHOLD_MS,
	taskPreviewOf,
	type SpawnChildV1,
	type SpawnNestedChild,
	parseSpawnRecordV1,
	type SpawnRecordV1,
	type TreeSnapshot,
} from "./background/tree.ts";
import {
	projectRunning,
	summaryPackage,
	type ChildStateView,
	type DstackResultView,
	type WorkflowProgress,
} from "./background/result.ts";

export type QueuedChildLifecycle = Readonly<{
	stage: "queued";
	queuedAt: string;
}>;

export type RunningChildLifecycle = Readonly<{
	stage: "running";
	startedAt: string;
	pid?: number;
	latestActivity?: string;
	latestStatus?: SemanticStatus;
	journal?: readonly JournalEntry[];
	usage?: ChildResult["usage"];
}>;

export type SucceededChildLifecycle = Readonly<{
	stage: "succeeded";
	startedAt: string;
	endedAt: string;
	exitCode: 0;
	finalResponse: string;
	usage: ChildResult["usage"];
	latestStatus?: SemanticStatus;
	journal?: readonly JournalEntry[];
	model?: string;
}>;

export type FailedChildLifecycle = Readonly<{
	stage: "failed";
	startedAt?: string;
	endedAt: string;
	exitCode: number;
	errorMessage?: string;
	stderr?: string;
	usage?: ChildResult["usage"];
	latestStatus?: SemanticStatus;
	journal?: readonly JournalEntry[];
	model?: string;
}>;

export type CancellationReason = "user_requested" | "parent_cancelled" | "registry_cleared";

export type CancelledChildLifecycle = Readonly<{
	stage: "cancelled";
	startedAt?: string;
	endedAt: string;
	message?: string;
	cancellationReason: CancellationReason;
	usage?: ChildResult["usage"];
	latestStatus?: SemanticStatus;
	journal?: readonly JournalEntry[];
	model?: string;
}>;

export type SkippedChildLifecycle = Readonly<{
	stage: "skipped";
	endedAt: string;
	reason?: string;
}>;

export type ChildLifecycleState =
	| QueuedChildLifecycle
	| RunningChildLifecycle
	| SucceededChildLifecycle
	| FailedChildLifecycle
	| CancelledChildLifecycle
	| SkippedChildLifecycle;

export type CompanionRootTaskControl = Readonly<{
	kind: "companion_root";
	taskId: string;
	workflowId: string;
	sessionId: string;
}>;

export type OwnerNestedTaskControl = Readonly<{
	kind: "owner_nested";
	taskId: string;
	groupId: string;
	mode: "single" | "parallel" | "chain";
	abortController: AbortController;
}>;

export type TaskOwnershipControl = CompanionRootTaskControl | OwnerNestedTaskControl;

export type DstackKillResult = Readonly<{
	taskId: string;
	status: "killed" | "already_terminal" | "unknown_task" | "kill_failed";
	message: string;
}>;

export type TaskResult = ChildResult & {
	agent: string;
	cwd: string;
	task: string;
	step?: number;
	cancellationReason?: CancellationReason;
	status?: SemanticStatus;
	journal?: readonly JournalEntry[];
};

export type TaskDetails = {
	mode: "single" | "parallel" | "chain";
	results: TaskResult[];
};

export type NestedTaskChildInfo = {
	readonly spec: TaskSpec;
	readonly agent: string;
	readonly role?: string;
	readonly assignment?: WorkflowAssignment;
	readonly cwd: string;
	readonly model?: string;
	readonly tools?: string;
	lifecycle: ChildLifecycleState;
};

export type NestedTaskStatus = "running" | "completed" | "cancelled" | "failed";

export type NestedTaskRecord = {
	readonly taskId: string;
	readonly groupId: string;
	readonly mode: "single" | "parallel" | "chain";
	readonly createdAt: string;
	readonly abortController: AbortController;
	readonly children: NestedTaskChildInfo[];
	status: NestedTaskStatus;
	cancellationRequested?: boolean;
	endedAt?: string;
	details?: TaskDetails;
	errorMessage?: string;
	cancelledMessage?: string;
	cancellationReason?: CancellationReason;
	markCollected?: () => Promise<void>;
	collected: boolean;
	collectionRequested: boolean;
	readCount: number;
	usageClaimed: boolean;
	completionPromise: Promise<TaskDetails>;
};

export type AgentDiscovery = {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
};

const OWNER_RESULT_CAP = 8 * 1024;

export function ownerResultText(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= OWNER_RESULT_CAP) return text;
	let summary = text.slice(0, OWNER_RESULT_CAP);
	while (Buffer.byteLength(summary, "utf8") > OWNER_RESULT_CAP) summary = summary.slice(0, -1);
	return `${summary}\n\n[worker summary truncated]`;
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

async function writeTempPrompt(text: string): Promise<{ dir: string; filePath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "dstack-"));
	const filePath = join(dir, "prompt.md");
	await writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

async function removeTemp(dir: string, filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {}
	try {
		await rmdir(dir);
	} catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export type StaleWakeRecord = Readonly<{
	taskId: string;
	attempts: number;
	lastFiredAt: string;
	lastActivityAt?: string;
}>;

export const BASE_STALE_WAKE_INTERVAL_MS = STALE_ACTIVITY_THRESHOLD_MS;
export const MAX_STALE_WAKE_INTERVAL_MS = 60 * 60 * 1000;
export { STALE_ACTIVITY_THRESHOLD_MS };

export function extractLatestRunningActivityAt(snapshot: TreeSnapshot): string | undefined {
	let latest: string | undefined;
	const updateLatest = (ts?: string) => {
		if (!ts) return;
		if (latest === undefined || Date.parse(ts) > Date.parse(latest)) {
			latest = ts;
		}
	};
	for (const child of snapshot.children) {
		if (child.state === "running") {
			updateLatest(child.activity?.updatedAt);
			if (child.journal) {
				for (const entry of child.journal) {
					updateLatest(entry.timestamp);
				}
			}
		}
		for (const nested of child.nested) {
			if ("state" in nested && nested.state === "running") {
				updateLatest(nested.updatedAt);
				if (nested.journal) {
					for (const entry of nested.journal) {
						updateLatest(entry.timestamp);
					}
				}
			}
		}
	}
	return latest;
}

export function shouldTriggerStaleWake(input: {
	snapshot?: TreeSnapshot;
	staleWakes?: ReadonlyMap<string, StaleWakeRecord>;
	control: { isIdle: boolean; hasPendingMessages: boolean };
	now?: number;
	baseIntervalMs?: number;
	maxIntervalMs?: number;
}): boolean {
	if (!input.snapshot) return false;
	if (input.snapshot.committed) return false;
	if (!input.control.isIdle || input.control.hasPendingMessages) return false;

	const capturedAtMs = Date.parse(input.snapshot.capturedAt);
	const hasStaleChild = input.snapshot.children.some((child) => {
		if (child.state !== "running") return false;
		const runningNested = child.nested.filter(
			(nested): nested is SpawnNestedChild => "state" in nested && nested.state === "running",
		);
		if (runningNested.length === 0) return child.stale === true;
		return runningNested.some((nested) => {
			if (nested.stale === true) return true;
			const updatedAtMs = Date.parse(nested.updatedAt);
			return !Number.isFinite(capturedAtMs) || !Number.isFinite(updatedAtMs) || capturedAtMs - updatedAtMs > STALE_ACTIVITY_THRESHOLD_MS;
		});
	});
	if (!hasStaleChild) return false;

	if (input.staleWakes !== undefined) {
		const existing = input.staleWakes.get(input.snapshot.taskId);
		if (existing === undefined) return true;
		const currentActivity = extractLatestRunningActivityAt(input.snapshot);
		const hasProgress =
			existing.lastActivityAt !== undefined &&
			currentActivity !== undefined &&
			Date.parse(currentActivity) > Date.parse(existing.lastActivityAt);
		const effectiveAttempts = hasProgress ? 1 : existing.attempts;
		const baseMs = input.baseIntervalMs ?? BASE_STALE_WAKE_INTERVAL_MS;
		const maxMs = input.maxIntervalMs ?? MAX_STALE_WAKE_INTERVAL_MS;
		const interval = Math.min(maxMs, baseMs * Math.pow(2, effectiveAttempts - 1));
		const now = input.now ?? Date.now();
		const elapsed = now - Date.parse(existing.lastFiredAt);
		return elapsed >= interval;
	}

	return true;
}

export function nextStaleWakeAttempt(existing: StaleWakeRecord | undefined, currentActivity: string | undefined): number {
	if (existing === undefined) return 1;
	if (
		existing.lastActivityAt !== undefined &&
		currentActivity !== undefined &&
		Date.parse(currentActivity) > Date.parse(existing.lastActivityAt)
	) {
		return 1;
	}
	return existing.attempts + 1;
}

export function formatStaleWakePrompt(taskId: string): string {
	const staleMinutes = STALE_ACTIVITY_THRESHOLD_MS / 60_000;
	return `Task "${taskId}" has a child that has been inactive for more than ${staleMinutes} minutes and may be stale. Call dstack_result with taskId "${taskId}" to inspect elapsed time, usage, and recent journal activity, then decide whether to continue waiting or call dstack_kill if it is unrecoverable.`;
}

export function restoreStaleWakes(entries: readonly SessionEntryLike[]): Map<string, StaleWakeRecord> {
	const map = new Map<string, StaleWakeRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "dstack-stale-wake") continue;
		if (!isRecord(entry.data) || typeof entry.data.taskId !== "string") continue;
		const taskId = entry.data.taskId;
		const timestamp = typeof entry.data.timestamp === "string" ? entry.data.timestamp : new Date(0).toISOString();
		const attemptNumber = typeof entry.data.attempt === "number" && Number.isSafeInteger(entry.data.attempt) ? entry.data.attempt : undefined;
		const lastActivityAt = typeof entry.data.lastActivityAt === "string" ? entry.data.lastActivityAt : undefined;
		const prev = map.get(taskId);
		const attempts = attemptNumber ?? (prev ? prev.attempts + 1 : 1);
		map.set(taskId, {
			taskId,
			attempts,
			lastFiredAt: timestamp,
			...(lastActivityAt !== undefined ? { lastActivityAt } : prev?.lastActivityAt !== undefined ? { lastActivityAt: prev.lastActivityAt } : {}),
		});
	}
	return map;
}

export function restoreFiredCompletionWakes(entries: readonly SessionEntryLike[]): Set<string> {
	const fired = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "dstack-completion-wake") continue;
		if (isRecord(entry.data) && typeof entry.data.taskId === "string") {
			fired.add(entry.data.taskId);
		}
	}
	return fired;
}

export function shouldTriggerCompletionWake(input: {
	snapshot?: TreeSnapshot;
	collected: boolean;
	firedTaskIds: ReadonlySet<string>;
	control: { isIdle: boolean; hasPendingMessages: boolean };
}): boolean {
	if (!input.snapshot) return false;
	if (!input.snapshot.committed) return false;
	if (input.collected) return false;
	if (input.firedTaskIds.has(input.snapshot.taskId)) return false;
	if (!input.control.isIdle || input.control.hasPendingMessages) return false;
	return true;
}

export function formatCompletionWakePrompt(taskId: string): string {
	return `Task "${taskId}" has committed its result (success or failure). Call dstack_result with taskId "${taskId}" now to collect it.`;
}

export function formatRunnerFailureWakePrompt(taskId: string, status: string): string {
	return `The background runner for task "${taskId}" is ${status} and no result was committed. Call dstack_result with taskId "${taskId}" to inspect the failure.`;
}

export function formatNestedCompletionPrompt(taskId: string, status: string): string {
	return `Nested task "${taskId}" reached terminal status ${status}. Call dstack_result once with taskId "${taskId}" to collect its success or failure.`;
}

export class NestedTaskRegistry {
	private readonly tasks = new Map<string, NestedTaskRecord>();

	register(record: NestedTaskRecord): void {
		this.tasks.set(record.taskId, record);
	}

	get(taskId: string): NestedTaskRecord | undefined {
		return this.tasks.get(taskId);
	}

	has(taskId: string): boolean {
		return this.tasks.has(taskId);
	}

	firstUncollected(): NestedTaskRecord | undefined {
		for (const record of this.tasks.values()) {
			if (!record.collected) return record;
		}
		return undefined;
	}

	cancel(taskId: string, reason: CancellationReason = "user_requested"): boolean {
		const record = this.tasks.get(taskId);
		if (!record) return false;
		if (record.status !== "running") return false;
		if (record.cancellationRequested) return true;
		record.cancellationRequested = true;
		record.cancellationReason = reason;
		record.abortController.abort(new Error(`Task cancelled: ${reason}`));
		return true;
	}

	prune(maxCompleted = 100): void {
		const completedKeys: string[] = [];
		for (const [taskId, record] of this.tasks.entries()) {
			if (record.status !== "running" && record.collected) {
				completedKeys.push(taskId);
			}
		}
		if (completedKeys.length > maxCompleted) {
			const toRemove = completedKeys.slice(0, completedKeys.length - maxCompleted);
			for (const key of toRemove) {
				this.tasks.delete(key);
			}
		}
	}

	clear(): void {
		for (const [taskId, record] of this.tasks.entries()) {
			if (record.status === "running") this.cancel(taskId, "registry_cleared");
		}
		this.tasks.clear();
	}
}

export function projectNestedResult(record: NestedTaskRecord, detail: "summary" | "full" = "summary"): DstackResultView {
	record.readCount++;
	if (record.status === "running") {
		const queued = record.children.filter((c) => c.lifecycle.stage === "queued").length;
		const running = record.children.filter((c) => c.lifecycle.stage === "running").length;
		const complete = record.children.length - queued - running;
		const childViews: ChildStateView[] = record.children.map((c, idx) => {
			const lifecycle = c.lifecycle;
			const startedAt = "startedAt" in lifecycle ? lifecycle.startedAt : undefined;
			const endedAt = "endedAt" in lifecycle ? lifecycle.endedAt : undefined;
			const elapsedMs = startedAt ? (endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt) : undefined;
			let activity = lifecycle.stage === "running" ? lifecycle.latestActivity : undefined;
			if (!activity && "journal" in lifecycle && lifecycle.journal && lifecycle.journal.length > 0) {
				activity = latestActivity({ messages: [], text: "", exitCode: -1, journal: lifecycle.journal, status: "latestStatus" in lifecycle ? lifecycle.latestStatus : undefined });
			}
			return {
				index: idx,
				state: lifecycle.stage,
				agent: c.agent,
				task: c.spec.task,
				cwd: c.cwd,
				model: c.model,
				latestStatus:
					lifecycle.stage === "running" || lifecycle.stage === "succeeded" || lifecycle.stage === "failed"
						? lifecycle.latestStatus
						: undefined,
				latestActivity: activity,
				recentActivity: "journal" in lifecycle && lifecycle.journal ? recentJournalActivity(lifecycle.journal) : undefined,
				startedAt,
				endedAt,
				elapsedMs,
				journal:
					lifecycle.stage === "running" || lifecycle.stage === "succeeded" || lifecycle.stage === "failed"
						? lifecycle.journal
						: undefined,
				usage:
					lifecycle.stage !== "queued" && lifecycle.stage !== "skipped"
						? lifecycle.usage
						: undefined,
				exitCode:
					lifecycle.stage === "succeeded"
						? 0
						: lifecycle.stage === "failed"
							? lifecycle.exitCode
							: undefined,
			};
		});
		const progress: WorkflowProgress = {
			queued,
			running,
			complete,
			total: record.children.length,
			children: childViews,
		};
		return projectRunning(record.taskId, progress, detail);
	}

	if (record.status === "cancelled") {
		return {
			kind: "cancelled",
			taskId: record.taskId,
			message: record.cancelledMessage ?? "The task was cancelled.",
		};
	}

	if (record.status === "failed" && !record.details) {
		return {
			kind: "runner_failed",
			taskId: record.taskId,
			message: record.errorMessage ?? "Nested task execution failed.",
			companionOutputPath: "",
		};
	}

	if (record.details) {
		if (detail === "full") {
			return {
				kind: "complete",
				taskId: record.taskId,
				detail: "full",
				package: record.details,
			};
		}
		return {
			kind: "complete",
			taskId: record.taskId,
			detail: "summary",
			package: summaryPackage({ kind: "complete", package: record.details }),
		};
	}

	return {
		kind: "unknown_task",
		taskId: record.taskId,
		message: `Nested task ${record.taskId} is in an unexpected state.`,
	};
}

export async function markNestedTaskCollected(record: NestedTaskRecord): Promise<void> {
	if (record.status === "running") return;
	await record.markCollected?.();
	record.collected = true;
}

function persistedNestedDetails(record: SpawnRecordV1): TaskDetails {
	return {
		mode: record.mode,
		results: record.children.map((child, index) => ({
			agent: child.agent,
			cwd: child.cwd ?? process.cwd(),
			task: child.taskFull ?? child.taskPreview,
			text: child.finalResponse ?? "",
			exitCode: child.exitCode ?? (child.state === "succeeded" ? 0 : 1),
			stderr: child.stderr ?? "",
			messages: [],
			usage: child.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			...(record.mode === "chain" ? { step: index + 1 } : {}),
			...(child.model !== undefined ? { model: child.model } : {}),
			...(child.errorMessage !== undefined ? { errorMessage: child.errorMessage } : {}),
			...(child.stopReason !== undefined ? { stopReason: child.stopReason } : {}),
			...(child.status !== undefined ? { status: child.status } : {}),
			...(child.journal !== undefined ? { journal: child.journal } : {}),
			...(child.cancellationReason !== undefined ? { cancellationReason: child.cancellationReason } : {}),
		})),
	};
}

export async function readPersistedNestedResult(input: Readonly<{
	artifactDir: string;
	parentIndex: number;
	taskId: string;
	detail?: "summary" | "full";
}>): Promise<DstackResultView | undefined> {
	if (!/^nested-[a-f0-9-]{36}$/u.test(input.taskId)) return undefined;
	const path = join(input.artifactDir, "children", String(input.parentIndex), "spawns", `${input.taskId}.json`);
	let rawText: string;
	try {
		rawText = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const raw: unknown = JSON.parse(rawText);
	const persisted = parseSpawnRecordV1(raw);
	if (persisted === undefined || persisted.groupId !== input.taskId || persisted.parentIndex !== input.parentIndex) {
		throw new Error("persisted nested task record is invalid");
	}
	const live = persisted.children.some((child) => child.state === "queued" || child.state === "running");
	if (live) {
		const children: ChildStateView[] = persisted.children.map((child) => {
			let activity = child.activity;
			if (!activity && ((child.journal && child.journal.length > 0) || child.status)) {
				activity = latestActivity({ messages: [], text: "", exitCode: -1, journal: child.journal, status: child.status });
			}
			const startedAt = child.startedAt;
			const endedAt = child.endedAt;
			const elapsedMs = startedAt ? (endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt) : undefined;
			return {
				index: child.nestedIndex,
				state: child.state,
				agent: child.agent,
				...(activity !== undefined ? { latestActivity: activity } : {}),
				...(child.journal !== undefined ? { recentActivity: recentJournalActivity(child.journal) } : {}),
				...(child.status !== undefined ? { latestStatus: child.status } : {}),
				...(startedAt !== undefined ? { startedAt } : {}),
				...(endedAt !== undefined ? { endedAt } : {}),
				...(elapsedMs !== undefined ? { elapsedMs } : {}),
				...(child.usage !== undefined ? { usage: child.usage } : {}),
			};
		});
		return projectRunning(input.taskId, {
			queued: children.filter((child) => child.state === "queued").length,
			running: children.filter((child) => child.state === "running").length,
			complete: children.filter((child) => child.state !== "queued" && child.state !== "running").length,
			total: children.length,
			children,
		}, input.detail);
	}
	if (!isRecord(raw)) throw new Error("persisted nested task record is invalid");
	if (persisted.collectedAt === undefined) {
		await atomicWriteFile(path, `${JSON.stringify({ ...raw, collectedAt: new Date().toISOString() }, null, 2)}\n`);
	}
	const details = persistedNestedDetails(persisted);
	return input.detail === "full"
		? { kind: "complete", taskId: input.taskId, detail: "full", package: details }
		: { kind: "complete", taskId: input.taskId, detail: "summary", package: summaryPackage({ kind: "complete", package: details }) };
}

export function claimNestedUsage(record: NestedTaskRecord): Usage | undefined {
	if (record.status === "running" || record.details === undefined || record.usageClaimed) {
		return undefined;
	}
	const usage = sumChildUsage(record.details.results.map((child) => child.usage));
	if (usage !== undefined) record.usageClaimed = true;
	return usage;
}

export function launchNestedTask(options: {
	request: TaskRequest;
	config: DstackConfig;
	agents: AgentDiscovery[];
	ctxCwd: string;
	skillPath: string;
	extensionPath: string;
	companionExtensionPaths: readonly string[];
	childDepth: ChildDepth;
	registry: NestedTaskRegistry;
}): { taskId: string; mode: string; taskCount: number; record: NestedTaskRecord } {
	const { request, config, agents, ctxCwd, skillPath, extensionPath, companionExtensionPaths, childDepth, registry } = options;
	const taskId = `nested-${randomUUID()}`;
	const groupId = taskId;
	const specs = request.kind === "single" ? [request.spec] : request.specs;
	const abortController = new AbortController();
	const initialCreatedAt = new Date().toISOString();

	const initialChildren: NestedTaskChildInfo[] = specs.map((spec, idx) => {
		const resolved = resolveAgent(spec);
		const modelRes = resolveModel({
			explicit: spec.model,
			role: spec.role,
			roles: config.roles,
			candidateIndex: request.kind === "parallel" ? idx : 0,
			overrideReason: spec.overrideReason,
		});
		const agentExists = agents.some((candidate) => candidate.name === resolved.agent);
		const launchModel = agentExists && modelRes.ok
			? resolveNestedLaunchModel({ resolution: modelRes.value, env: process.env })
			: undefined;
		return {
			spec,
			agent: resolved.agent,
			role: spec.role,
			assignment: spec.workflow?.assignment,
			cwd: spec.cwd ?? ctxCwd,
			model: launchModel,
			tools: resolved.tools ?? spec.tools,
			lifecycle: {
				stage: "queued",
				queuedAt: initialCreatedAt,
			},
		};
	});

	const details: TaskDetails = {
		mode: request.kind,
		results: specs.map((spec, index) =>
			emptyTaskResult(spec, spec.cwd ?? ctxCwd, request.kind === "chain" ? index + 1 : undefined),
		),
	};

	const rootWorkflowId = process.env[ROOT_WORKFLOW_ENV];
	const schedulerRoot = process.env[SCHEDULER_ROOT_ENV];
	const childIndexEnv = process.env[DSTACK_CHILD_INDEX_ENV];
	const artifactDirEnv = process.env[DSTACK_ARTIFACT_DIR_ENV];
	const parentIndex = childIndexEnv !== undefined ? Number.parseInt(childIndexEnv, 10) : Number.NaN;
	const canPersistSpawns =
		rootWorkflowId !== undefined &&
		artifactDirEnv !== undefined &&
		Number.isSafeInteger(parentIndex) &&
		parentIndex >= 0;
	const spawnsDir = canPersistSpawns ? join(artifactDirEnv, "children", String(parentIndex), "spawns") : undefined;
	const spawnRecordPath = spawnsDir !== undefined ? join(spawnsDir, `${groupId}.json`) : undefined;
	const spawnPhase = specs.map((s) => s.workflow?.phase).find((p): p is string => typeof p === "string" && p.length > 0);
	let collectedAt: string | undefined;

	const spawnChildren: SpawnChildV1[] = specs.map((spec, idx) => {
		const childInfo = initialChildren[idx]!;
		return {
			nestedIndex: idx,
			agent: childInfo.agent,
			role: spec.role,
			assignment: spec.workflow?.assignment,
			taskPreview: taskPreviewOf(spec.task),
			taskFull: spec.task,
			workflow: spec.workflow,
			model: childInfo.model,
			cwd: childInfo.cwd,
			tools: childInfo.tools,
			state: "queued",
			updatedAt: initialCreatedAt,
		};
	});

	function createSpawnRecordWriter() {
		if (!canPersistSpawns || !spawnsDir || !spawnRecordPath) return undefined;
		const minIntervalMs = 1000;
		let lastWriteTime = 0;
		let timer: NodeJS.Timeout | undefined;
		let writeChain: Promise<void> = Promise.resolve();
		let lastError: Error | undefined;

		const doWrite = async () => {
			const record: SpawnRecordV1 = {
				schemaVersion: "dstack.spawn-record.v1",
				workflowId: rootWorkflowId!,
				parentIndex,
				groupId,
				mode: request.kind,
				phase: spawnPhase,
				createdAt: initialCreatedAt,
				collectedAt,
				children: spawnChildren.map((c) => ({ ...c })),
			};
			try {
				await mkdir(spawnsDir, { recursive: true, mode: 0o700 });
				await atomicWriteFile(spawnRecordPath, `${JSON.stringify(record, null, 2)}\n`);
				lastWriteTime = Date.now();
				lastError = undefined;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		};

		const scheduleWrite = (): Promise<void> => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			writeChain = writeChain.then(doWrite, doWrite);
			return writeChain;
		};

		return {
			writeThrottled() {
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
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				await scheduleWrite();
				if (lastError !== undefined) throw new Error(`nested task artifact write failed: ${lastError.message}`);
			},
			async dispose() {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				await writeChain;
			},
		};
	}

	const spawnRecordWriter = createSpawnRecordWriter();

	const runOne = async (spec: TaskSpec, index: number, signal: AbortSignal): Promise<TaskResult> => {
		let childTmpDir: string | undefined;
		let recorder: ChildJournalRecorder | undefined;
		const launch = { stage: "configuration" as "configuration" | "pre_launch" | "execution" };
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
			launch.stage = "pre_launch";
			let cwd = spec.cwd ?? ctxCwd;
			if (spec.worktree) {
				cwd = await createWorktree({
					repoRoot: ctxCwd,
					task: spec.task,
					base: config.worktree.base,
					from: config.worktree.from,
				});
			}
			const existing = details.results[index];
			if (existing !== undefined) {
				details.results[index] = { ...existing, agent: resolved.agent, cwd, task: spec.task };
			}

			const promptParts = [agent.systemPrompt.trim()];
			if (spec.workflow !== undefined) promptParts.push(workflowSystemPrompt(skillPath, childDepth, spec.workflow));
			else if (resolved.dmode) promptParts.push(dmodeReminder(skillPath, childDepth));
			let tmp: { dir: string; filePath: string } | undefined;
			let lease: Awaited<ReturnType<typeof acquireChildSlot>> | undefined;
			const system = promptParts.filter(Boolean).join("\n\n");
			if (system) tmp = await writeTempPrompt(system);
			try {
				childTmpDir = await mkdtemp(join(tmpdir(), "dstack-child-"));
				const sessionBase = canPersistSpawns && artifactDirEnv !== undefined
					? join(artifactDirEnv, "children", String(parentIndex), "sessions", `${groupId}-${index}`)
					: childTmpDir;
				const sessionDir = join(sessionBase, "session");
				await mkdir(sessionDir, { recursive: true, mode: 0o700 });
				const sessionRefPath = join(sessionBase, "session-ref.json");
				const statusPath = join(childTmpDir, "status.json");
				const journalPath = join(childTmpDir, "journal.json");
				recorder = new ChildJournalRecorder({ statusPath, journalPath });
				recorder.recordSpawn({
					agent: resolved.agent,
					task: spec.task,
					cwd,
					model: model.value.model,
					role: spec.role,
					step: details.results[index]?.step,
				});
				await recorder.persist();
				if (rootWorkflowId && schedulerRoot) {
					lease = await acquireChildSlot({
						schedulerRoot: toAbsolutePath(schedulerRoot),
						workflowId: rootWorkflowId,
						childId: `${groupId}-${index}`,
						work: {
							depth: childDepth,
							tools: (resolved.tools ?? agent.tools?.join(","))?.split(","),
						},
						requestedTotalSlots: config.scheduler.totalSlots,
						signal,
					});
				}
				const startedAt = new Date().toISOString();
				initialChildren[index]!.lifecycle = {
					stage: "running",
					startedAt,
				};
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

				const childTools = allowStatusTool(resolved.tools ?? agent.tools?.join(","));
				const args = buildChildArgv({
					task: spec.task,
					extensionPath,
					companionExtensionPaths,
					model: model.value.model,
					omitModel: model.value.omitModel,
					thinking: model.value.thinking,
					tools: childTools,
					systemPromptPath: tmp?.filePath,
					sessionDir,
				});
				const env = childEnv(childDepth, process.env, spec.workflow?.assignment);
				env["DSTACK_STATUS_FILE"] = statusPath;
				env[SESSION_REF_ENV] = sessionRefPath;
				let journalUpdates = Promise.resolve();
				const child = await runChildProcess({
					args,
					cwd,
					env,
					signal,
					budget: spec.budget,
					onSpawn: async (pid) => {
						launch.stage = "execution";
						const spawned = spawnChildren[index];
						if (spawned !== undefined) {
							spawnChildren[index] = { ...spawned, launchState: "started" };
							spawnRecordWriter?.writeThrottled();
						}
						await lease?.bindChild(pid);
						const cur = initialChildren[index]!.lifecycle;
						if (cur.stage === "running") {
							initialChildren[index]!.lifecycle = { ...cur, pid };
						}
					},
					onUpdate: (partial) => {
						journalUpdates = journalUpdates
							.then(async () => {
								recorder?.recordMessages(partial.messages);
								if (partial.usage.turns > 0) {
									recorder?.recordTurn({ turn: partial.usage.turns, text: partial.text, usage: partial.usage });
								}
								await recorder?.checkStatusFile();
								await recorder?.persist();
								const updatedStatus = recorder?.getLatestStatus();
								const updatedJournal = recorder?.getEntries();
								const partialWithStatus: TaskResult = {
									...partial,
									agent: resolved.agent,
									cwd,
									task: spec.task,
									step: details.results[index]?.step,
									journal: updatedJournal,
									status: updatedStatus,
								};
								details.results[index] = partialWithStatus;
								initialChildren[index]!.lifecycle = {
									stage: "running",
									startedAt,
									latestActivity: latestActivity(partialWithStatus),
									latestStatus: updatedStatus,
									journal: updatedJournal,
									usage: partial.usage,
								};
								const now = new Date().toISOString();
								const existingSpawn = spawnChildren[index];
								if (existingSpawn !== undefined) {
									spawnChildren[index] = {
										...existingSpawn,
										activity: latestActivity(partialWithStatus),
										status: updatedStatus,
										journal: updatedJournal,
										updatedAt: now,
									};
									spawnRecordWriter?.writeThrottled();
								}
							})
							.catch(() => undefined);
					},
				});
				await journalUpdates;
				await recorder.checkStatusFile();
				const wasCancelled = signal.aborted && child.stopReason !== "budget_exceeded";
				if (wasCancelled) recorder.recordFailure({ error: "Child agent was aborted" });
				else if (child.stopReason === "budget_exceeded") recorder.recordFailure({ error: child.errorMessage ?? "Budget exceeded" });
				else recorder.recordExit({ exitCode: child.exitCode, text: child.text });
				await recorder.persist();
				const session = await readChildSessionRef({ refPath: sessionRefPath, sessionDir });
				const completed: TaskResult = {
					...child,
					...(wasCancelled ? { cancellationReason: record.cancellationReason ?? "parent_cancelled" } : {}),
					agent: resolved.agent,
					cwd,
					task: spec.task,
					text: capOutput(child.text),
					step: details.results[index]?.step,
					journal: recorder.getEntries(),
					status: recorder.getLatestStatus(),
				};
				details.results[index] = completed;
				const now = new Date().toISOString();
				if (wasCancelled) {
					initialChildren[index]!.lifecycle = {
						stage: "cancelled",
						startedAt,
						endedAt: now,
						message: "Child agent was aborted",
						cancellationReason: record.cancellationReason ?? "parent_cancelled",
						usage: completed.usage,
						latestStatus: completed.status,
						journal: completed.journal,
						model: completed.model ?? launchModel,
					};
				} else if (completed.exitCode === 0) {
					initialChildren[index]!.lifecycle = {
						stage: "succeeded",
						startedAt,
						endedAt: now,
						exitCode: 0,
						finalResponse: completed.text,
						usage: completed.usage,
						latestStatus: completed.status,
						journal: completed.journal,
						model: completed.model ?? launchModel,
					};
				} else {
					initialChildren[index]!.lifecycle = {
						stage: "failed",
						startedAt,
						endedAt: now,
						exitCode: completed.exitCode,
						errorMessage: completed.errorMessage,
						stderr: completed.stderr,
						usage: completed.usage,
						latestStatus: completed.status,
						journal: completed.journal,
						model: completed.model ?? launchModel,
					};
				}

				const existingSpawn = spawnChildren[index];
				if (existingSpawn !== undefined) {
					spawnChildren[index] = {
						...existingSpawn,
						state: wasCancelled ? "cancelled" : completed.exitCode === 0 ? "succeeded" : "failed",
						launchState: "started",
						failureKind: completed.exitCode === 0 || wasCancelled ? undefined : "execution",
						cancellationReason: wasCancelled ? record.cancellationReason ?? "parent_cancelled" : undefined,
						exitCode: completed.exitCode,
						finalResponse: completed.text,
						errorMessage: completed.errorMessage,
						stderr: completed.stderr,
						stopReason: completed.stopReason,
						usage: completed.usage,
						model: completed.model ?? existingSpawn.model ?? launchModel,
						activity: latestActivity(completed),
						status: completed.status,
						journal: completed.journal,
						session: session ?? existingSpawn.session,
						updatedAt: now,
						endedAt: now,
					};
					await spawnRecordWriter?.flush();
				}
				return completed;
			} finally {
				await lease?.release();
				if (tmp) await removeTemp(tmp.dir, tmp.filePath);
				if (childTmpDir) await rm(childTmpDir, { recursive: true, force: true }).catch(() => undefined);
			}
		} catch (err) {
			const now = new Date().toISOString();
			const childInfo = initialChildren[index]!;
			const errorMsg = err instanceof Error ? err.message : String(err);
			const wasCancelled = (signal.aborted || record.cancellationRequested === true) && !errorMsg.startsWith("Budget exceeded");
			if (childInfo.lifecycle.stage !== "succeeded" && childInfo.lifecycle.stage !== "failed" && childInfo.lifecycle.stage !== "cancelled") {
				if (wasCancelled) {
					childInfo.lifecycle = {
						stage: "cancelled",
						endedAt: now,
						message: errorMsg,
						cancellationReason: record.cancellationReason ?? "parent_cancelled",
					};
				} else {
					childInfo.lifecycle = {
						stage: "failed",
						endedAt: now,
						exitCode: 1,
						errorMessage: errorMsg,
					};
				}
			}
			const existing = details.results[index];
			if (existing !== undefined) {
				details.results[index] = {
					...existing,
					exitCode: 1,
					errorMessage: errorMsg,
					...(wasCancelled ? { cancellationReason: record.cancellationReason ?? "parent_cancelled" } : {}),
				};
			}
			const existingSpawn = spawnChildren[index];
			if (existingSpawn !== undefined && existingSpawn.state !== "succeeded" && existingSpawn.state !== "failed" && existingSpawn.state !== "cancelled") {
				const failureKind = launch.stage === "configuration"
					? "pre_launch_configuration"
					: launch.stage === "execution"
						? "execution"
						: "pre_launch_other";
				spawnChildren[index] = {
					...existingSpawn,
					state: wasCancelled ? "cancelled" : "failed",
					launchState: launch.stage === "execution" ? "started" : "not_started",
					failureKind: wasCancelled ? undefined : failureKind,
					cancellationReason: wasCancelled ? record.cancellationReason ?? "parent_cancelled" : undefined,
					model: launch.stage === "configuration" ? undefined : existingSpawn.model,
					errorMessage: err instanceof Error ? err.message : String(err),
					updatedAt: now,
					endedAt: now,
				};
				await spawnRecordWriter?.flush();
			}
			throw err;
		}
	};

	let resolveCompletion: (value: TaskDetails) => void = () => {};
	const completionPromise = new Promise<TaskDetails>((resolve) => {
		resolveCompletion = resolve;
	});

	const record: NestedTaskRecord = {
		taskId,
		groupId,
		mode: request.kind,
		createdAt: initialCreatedAt,
		abortController,
		children: initialChildren,
		status: "running",
		collected: false,
		collectionRequested: false,
		readCount: 0,
		usageClaimed: false,
		completionPromise,
		markCollected: spawnRecordWriter === undefined ? undefined : async () => {
			if (collectedAt !== undefined) return;
			collectedAt = new Date().toISOString();
			try {
				await spawnRecordWriter.flush();
			} catch (error) {
				collectedAt = undefined;
				throw error;
			}
		},
	};

	async function settleRecord(input: Readonly<{
		status: Exclude<NestedTaskStatus, "running">;
		endedAt: string;
		errorMessage?: string;
	}>): Promise<void> {
		await spawnRecordWriter?.flush().catch(() => undefined);
		record.details = details;
		record.endedAt = input.endedAt;
		record.errorMessage = input.errorMessage;
		if (input.status === "cancelled") {
			record.cancelledMessage = `The task was cancelled (${record.cancellationReason ?? "parent_cancelled"}).`;
		}
		record.status = input.status;
		resolveCompletion(details);
	}

	void (async () => {
		const signal = abortController.signal;
		let parallelFailure: unknown;
		try {
			await spawnRecordWriter?.flush();
			if (request.kind === "chain") {
				const results: TaskResult[] = [];
				let previous = "";
				for (const [index, spec] of specs.entries()) {
					if (signal.aborted) {
						break;
					}
					const task = spec.task.replace(/\{previous\}/g, previous);
					try {
						const result = await runOne({ ...spec, task }, index, signal);
						results.push(result);
						if (result.exitCode !== 0) {
							const now = new Date().toISOString();
							for (let i = index + 1; i < specs.length; i++) {
								initialChildren[i]!.lifecycle = {
									stage: "skipped",
									endedAt: now,
									reason: "Chain stopped on previous step failure",
								};
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
							const wasCancelled = signal.aborted || record.cancellationRequested === true;
							await settleRecord({
								status: wasCancelled ? "cancelled" : (details.results.some((r) => r.exitCode !== 0) ? "failed" : "completed"),
								endedAt: now,
							});
							return;
						}
						previous = result.text;
					} catch (err) {
						const now = new Date().toISOString();
						for (let i = index + 1; i < specs.length; i++) {
							initialChildren[i]!.lifecycle = {
								stage: "skipped",
								endedAt: now,
								reason: "Chain stopped on previous step error",
							};
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
						const wasCancelled = signal.aborted || record.cancellationRequested === true;
						await settleRecord({
							status: wasCancelled ? "cancelled" : "failed",
							endedAt: now,
							...(!wasCancelled ? { errorMessage: err instanceof Error ? err.message : String(err) } : {}),
						});
						return;
					}
				}
				const now = new Date().toISOString();
				const wasCancelled = signal.aborted || record.cancellationRequested === true;
				await settleRecord({
					status: wasCancelled ? "cancelled" : (details.results.some((r) => r.exitCode !== 0) ? "failed" : "completed"),
					endedAt: now,
				});
				return;
			}

			const outcomes = await Promise.allSettled(
				specs.map((spec, index) =>
					runOne(spec, index, signal).catch((error: unknown) => {
						if (!signal.aborted) {
							parallelFailure = error;
							abortController.abort(error);
						}
						throw error;
					}),
				),
			);
			const rejected = outcomes.find((outcome) => outcome.status === "rejected");
			if (rejected?.status === "rejected") throw rejected.reason;
			const now = new Date().toISOString();
			const wasCancelled = signal.aborted || record.cancellationRequested === true;
			await settleRecord({
				status: wasCancelled ? "cancelled" : (details.results.some((r) => r.exitCode !== 0) ? "failed" : "completed"),
				endedAt: now,
			});
		} catch (err) {
			const now = new Date().toISOString();
			const errorMessage = err instanceof Error ? err.message : String(err);
			const wasCancelled = parallelFailure === undefined && (signal.aborted || record.cancellationRequested === true) && !errorMessage.startsWith("Budget exceeded");
			for (let i = 0; i < specs.length; i++) {
				const c = spawnChildren[i];
				if (c !== undefined && (c.state === "queued" || c.state === "running")) {
					spawnChildren[i] = {
						...c,
						state: wasCancelled ? "cancelled" : "failed",
						cancellationReason: wasCancelled ? record.cancellationReason ?? "parent_cancelled" : undefined,
						errorMessage: wasCancelled ? undefined : errorMessage,
						updatedAt: now,
						endedAt: now,
					};
				}
				const result = details.results[i];
				if (result !== undefined && result.exitCode === -1) {
					details.results[i] = {
						...result,
						exitCode: 1,
						errorMessage,
						...(wasCancelled ? { cancellationReason: record.cancellationReason ?? "parent_cancelled" } : {}),
					};
				}
			}
			await settleRecord({
				status: wasCancelled ? "cancelled" : "failed",
				endedAt: now,
				...(!wasCancelled ? { errorMessage } : {}),
			});
		} finally {
			await spawnRecordWriter?.dispose().catch(() => undefined);
		}
	})();

	registry.register(record);

	return {
		taskId,
		mode: request.kind,
		taskCount: specs.length,
		record,
	};
}
