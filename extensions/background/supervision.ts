import { createHash } from "node:crypto";
import type { SessionEntryLike } from "../mode.ts";
import type { LeaseSnapshot } from "./scheduler.ts";
import { STALE_ACTIVITY_THRESHOLD_MS, type SpawnNestedChild, type TreeSnapshot } from "./tree.ts";

/**
 * Centralized supervision policy for background dstack work.
 *
 * This module owns:
 *   - wait/wake policy for `dstack_result` (bounded waits, nonblocking reads);
 *   - stale and completion wake decisions with persisted dedupe;
 *   - change/progress evidence for running reads (fingerprints, wake reasons);
 *   - descendant liveness and process/transport health aggregation so a quiet
 *     owner with active descendants is not falsely stale;
 *   - a breaker for repeated unchanged immediate reads.
 *
 * Persistence stays reload-compatible: stale and completion wakes keep their
 * historical entry types ("dstack-stale-wake", "dstack-completion-wake") and
 * shapes; per-task read dedupe adds a new entry type that old sessions simply
 * never contain.
 */

// --- Wait policy ------------------------------------------------------------

/** The bounded default wait used when a nested owner collects child work. */
export const SUPERVISION_INTERVAL_MS = STALE_ACTIVITY_THRESHOLD_MS;
export const MAX_EXPLICIT_WAIT_SECONDS = 30 * 60;
export const DEFAULT_SUPERVISION_POLL_MS = 1_000;

/**
 * Resolve a caller-supplied waitSeconds into a wait budget in milliseconds.
 * Root inspection defaults to a nonblocking read. Callers that join nested
 * work pass the supervision interval as their default wait.
 */
export function resolveWaitMs(waitSeconds: number | undefined, defaultWaitMs = 0): number {
	if (waitSeconds === undefined) return defaultWaitMs;
	if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_EXPLICIT_WAIT_SECONDS) {
		throw new Error(`waitSeconds must be finite and between 0 and ${MAX_EXPLICIT_WAIT_SECONDS}.`);
	}
	return waitSeconds * 1000;
}

// --- Wake reasons and evidence ----------------------------------------------

/** Why a supervision wait returned control to the caller. */
export type SuperviseOutcome = "terminal" | "wait_elapsed" | "nonblocking" | "aborted";

export type WakeReason =
	| Readonly<{ kind: "nonblocking" }>
	| Readonly<{ kind: "wait_elapsed"; waitedMs: number }>
	| Readonly<{ kind: "breaker_wait"; waitedMs: number }>
	| Readonly<{ kind: "aborted" }>;

export type SupervisionBreakerState = "idle" | "armed" | "tripped";

export type SupervisionTransport = "companion" | "in_process" | "artifact";

/** Aggregated descendant liveness evidence for a running task. */
export type DescendantEvidence = Readonly<{
	runningChildren: number;
	runningNested: number;
	liveDescendantLeases: number;
	latestActivityAt?: string;
}>;

/** Attached to every running view returned by dstack_result. */
export type SupervisionInfo = Readonly<{
	wakeReason: WakeReason;
	changed: boolean;
	unchangedImmediateReads: number;
	breaker: SupervisionBreakerState;
	transport: SupervisionTransport;
	descendants?: DescendantEvidence;
}>;

/** Map a wait outcome to the explicit wake reason exposed on running views. */
export function wakeReasonFor(outcome: SuperviseOutcome, coerced: boolean, waitedMs: number): WakeReason {
	switch (outcome) {
		case "nonblocking":
		case "terminal":
			return { kind: "nonblocking" };
		case "aborted":
			return { kind: "aborted" };
		case "wait_elapsed":
			return coerced ? { kind: "breaker_wait", waitedMs } : { kind: "wait_elapsed", waitedMs };
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}

// --- Bounded waiting primitives ----------------------------------------------

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		let onAbort: (() => void) | undefined;
		const timer = setTimeout(() => {
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		if (signal !== undefined) {
			onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

export type AwaitCompletionResult = Readonly<{ outcome: SuperviseOutcome; waitedMs: number }>;

/**
 * Wait for an in-process completion promise within a bounded wait budget.
 * waitMs 0 is nonblocking; abort resolves promptly without cancelling work.
 */
export async function awaitCompletion(input: Readonly<{
	completion: Promise<unknown>;
	waitMs: number;
	signal?: AbortSignal;
}>): Promise<AwaitCompletionResult> {
	if (input.waitMs === 0) return { outcome: "nonblocking", waitedMs: 0 };
	const started = Date.now();
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const signal = input.signal;
	try {
		const waiters: Promise<SuperviseOutcome>[] = [
			input.completion.then(() => "terminal" as const, () => "terminal" as const),
			new Promise<SuperviseOutcome>((resolve) => {
				timer = setTimeout(() => resolve("wait_elapsed"), input.waitMs);
				timer.unref?.();
			}),
		];
		if (signal !== undefined) {
			waiters.push(
				new Promise<SuperviseOutcome>((resolve) => {
					if (signal.aborted) {
						resolve("aborted");
						return;
					}
					onAbort = () => resolve("aborted");
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);
		}
		const outcome = await Promise.race(waiters);
		return { outcome, waitedMs: Date.now() - started };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

export type SuperviseReadResult<T> = Readonly<{
	view: T;
	outcome: SuperviseOutcome;
	waitedMs: number;
}>;

/**
 * Repeatedly read a task view until it leaves the running state, the wait
 * budget elapses, or the signal aborts. waitMs 0 performs exactly one read.
 */
export async function superviseRead<T>(input: Readonly<{
	read: () => Promise<T>;
	isRunning: (view: T) => boolean;
	waitMs: number;
	signal?: AbortSignal;
	pollIntervalMs?: number;
}>): Promise<SuperviseReadResult<T>> {
	const started = Date.now();
	let view = await input.read();
	if (!input.isRunning(view)) return { view, outcome: "terminal", waitedMs: Date.now() - started };
	if (input.waitMs === 0) return { view, outcome: "nonblocking", waitedMs: Date.now() - started };
	const pollMs = input.pollIntervalMs ?? DEFAULT_SUPERVISION_POLL_MS;
	for (;;) {
		if (input.signal?.aborted) return { view, outcome: "aborted", waitedMs: Date.now() - started };
		const remaining = input.waitMs - (Date.now() - started);
		if (remaining <= 0) return { view, outcome: "wait_elapsed", waitedMs: Date.now() - started };
		await interruptibleSleep(Math.min(pollMs, remaining), input.signal);
		if (input.signal?.aborted) return { view, outcome: "aborted", waitedMs: Date.now() - started };
		view = await input.read();
		if (!input.isRunning(view)) return { view, outcome: "terminal", waitedMs: Date.now() - started };
	}
}

// --- Change/progress fingerprints ---------------------------------------------

/** Keys that vary with wall-clock time or supervision itself, not with progress. */
const FINGERPRINT_IGNORED_KEYS = new Set(["elapsedMs", "supervision"]);

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([key, field]) => !FINGERPRINT_IGNORED_KEYS.has(key) && field !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, field]) => `${JSON.stringify(key)}:${stableStringify(field)}`);
	return `{${entries.join(",")}}`;
}

/**
 * Fingerprint a running result view for change detection, ignoring fields that
 * change on every read without representing progress.
 */
export function fingerprintRunningView(view: unknown): string {
	return createHash("sha256").update(stableStringify(view)).digest("hex");
}

// --- Descendant liveness -------------------------------------------------------

/** Count live scheduler leases that prove descendant processes for a workflow. */
export function countLiveDescendantLeases(
	leases: readonly LeaseSnapshot[],
	filter: Readonly<{ workflowId: string; childIdPrefix?: string }>,
): number {
	return leases.filter((lease) => {
		if (lease.workflowId !== filter.workflowId) return false;
		if (filter.childIdPrefix !== undefined) return lease.childId.startsWith(filter.childIdPrefix);
		return lease.depth === 2;
	}).length;
}

/** Aggregate descendant liveness evidence from a tree snapshot plus live leases. */
export function descendantEvidenceFromSnapshot(
	snapshot: TreeSnapshot,
	activeLeases: readonly LeaseSnapshot[],
): DescendantEvidence {
	const runningChildren = snapshot.children.filter((child) => child.state === "running").length;
	let runningNested = 0;
	for (const child of snapshot.children) {
		for (const nested of child.nested) {
			if ("state" in nested && nested.state === "running") runningNested += 1;
		}
	}
	const latestActivityAt = extractLatestRunningActivityAt(snapshot);
	return {
		runningChildren,
		runningNested,
		liveDescendantLeases: countLiveDescendantLeases(activeLeases, { workflowId: snapshot.workflowId }),
		...(latestActivityAt !== undefined ? { latestActivityAt } : {}),
	};
}

// --- Stale and completion wake policy -------------------------------------------

export type StaleWakeRecord = Readonly<{
	taskId: string;
	attempts: number;
	lastFiredAt: string;
	lastActivityAt?: string;
}>;

export const BASE_STALE_WAKE_INTERVAL_MS = STALE_ACTIVITY_THRESHOLD_MS;
export const MAX_STALE_WAKE_INTERVAL_MS = 60 * 60 * 1000;
export { STALE_ACTIVITY_THRESHOLD_MS };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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
	/** Live scheduler leases: descendant process liveness evidence. */
	activeLeases?: readonly LeaseSnapshot[];
	now?: number;
	baseIntervalMs?: number;
	maxIntervalMs?: number;
}): boolean {
	if (!input.snapshot) return false;
	if (input.snapshot.committed) return false;
	if (!input.control.isIdle || input.control.hasPendingMessages) return false;

	const liveDescendantLeases = input.activeLeases === undefined
		? 0
		: countLiveDescendantLeases(input.activeLeases, { workflowId: input.snapshot.workflowId });
	const hasStaleChild = input.snapshot.children.some((child) => {
		if (child.state !== "running") return false;
		const runningNested = child.nested.filter(
			(nested): nested is SpawnNestedChild => "state" in nested && nested.state === "running",
		);
		if (runningNested.length === 0) {
			// A quiet owner whose descendant processes are proven live by the
			// scheduler is not stale, even when no nested records are visible.
			return child.stale === true && liveDescendantLeases === 0;
		}
		// The snapshot is the single source of truth for staleness: it weighs
		// process liveness and in-flight tool calls, which a bare timestamp
		// comparison here cannot see and would false-positive on.
		return runningNested.some((nested) => nested.stale === true);
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
	return `Task "${taskId}" has a child with no recorded activity for more than ${staleMinutes} minutes and may be stale. Call dstack_result with taskId "${taskId}" to inspect elapsed time, usage, and recent journal activity; the read returns immediately. If the task is still making progress, end your turn without waiting — you are woken again when it commits or goes stale again. Call dstack_kill only if it is unrecoverable.`;
}

export function restoreStaleWakes(entries: readonly SessionEntryLike[]): Map<string, StaleWakeRecord> {
	const map = new Map<string, StaleWakeRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STALE_WAKE_ENTRY) continue;
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
		if (entry.type !== "custom" || entry.customType !== COMPLETION_WAKE_ENTRY) continue;
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

// --- Persisted dedupe registry --------------------------------------------------

/** Entry types are stable identifiers; older sessions restore unchanged. */
export const STALE_WAKE_ENTRY = "dstack-stale-wake";
export const COMPLETION_WAKE_ENTRY = "dstack-completion-wake";
export const SUPERVISION_READ_ENTRY = "dstack-supervision-read";

/** Consecutive unchanged immediate reads before the breaker trips. */
export const READ_BREAKER_THRESHOLD = 3;

export type RunningReadVerdict = Readonly<{
	changed: boolean;
	unchangedImmediateReads: number;
	breaker: SupervisionBreakerState;
}>;

export type EffectiveWait = Readonly<{ waitMs: number; coerced: boolean }>;

type ReadDedupeState = { fingerprint: string; unchangedImmediateReads: number };

type AppendEntry = (customType: string, data: unknown) => void;

/**
 * Session-scoped supervision dedupe state: stale wakes, completion wakes, and
 * per-task running-read fingerprints, all persisted through session entries so
 * decisions survive reload and never double-fire.
 */
export class SupervisionRegistry {
	private readonly staleWakeRecords = new Map<string, StaleWakeRecord>();
	private readonly completionWakes = new Set<string>();
	private readonly reads = new Map<string, ReadDedupeState>();
	private readonly appendEntry: AppendEntry | undefined;
	private readonly breakerThreshold: number;

	constructor(options?: Readonly<{ appendEntry?: AppendEntry; breakerThreshold?: number }>) {
		this.appendEntry = options?.appendEntry;
		this.breakerThreshold = options?.breakerThreshold ?? READ_BREAKER_THRESHOLD;
	}

	/** Rebuild all dedupe state from persisted session entries. */
	restore(entries: readonly SessionEntryLike[]): void {
		this.clear();
		for (const [taskId, record] of restoreStaleWakes(entries).entries()) {
			this.staleWakeRecords.set(taskId, record);
		}
		for (const taskId of restoreFiredCompletionWakes(entries)) {
			this.completionWakes.add(taskId);
		}
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SUPERVISION_READ_ENTRY) continue;
			if (!isRecord(entry.data) || typeof entry.data.taskId !== "string") continue;
			if (entry.data.cleared === true) {
				this.reads.delete(entry.data.taskId);
				continue;
			}
			if (typeof entry.data.fingerprint !== "string") continue;
			const count = entry.data.unchangedImmediateReads;
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
			this.reads.set(entry.data.taskId, {
				fingerprint: entry.data.fingerprint,
				unchangedImmediateReads: count,
			});
		}
	}

	clear(): void {
		this.staleWakeRecords.clear();
		this.completionWakes.clear();
		this.reads.clear();
	}

	get staleWakes(): ReadonlyMap<string, StaleWakeRecord> {
		return this.staleWakeRecords;
	}

	recordStaleWakeFired(input: Readonly<{
		taskId: string;
		attempt: number;
		firedAt: string;
		lastActivityAt?: string;
	}>): void {
		this.staleWakeRecords.set(input.taskId, {
			taskId: input.taskId,
			attempts: input.attempt,
			lastFiredAt: input.firedAt,
			...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
		});
		this.appendEntry?.(STALE_WAKE_ENTRY, {
			taskId: input.taskId,
			attempt: input.attempt,
			timestamp: input.firedAt,
			...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
		});
	}

	get firedCompletionWakes(): ReadonlySet<string> {
		return this.completionWakes;
	}

	completionWakeFired(taskId: string): boolean {
		return this.completionWakes.has(taskId);
	}

	recordCompletionWakeFired(taskId: string, firedAt = new Date().toISOString()): void {
		if (this.completionWakes.has(taskId)) return;
		this.completionWakes.add(taskId);
		this.appendEntry?.(COMPLETION_WAKE_ENTRY, { taskId, timestamp: firedAt });
	}

	breakerState(taskId: string): SupervisionBreakerState {
		const count = this.reads.get(taskId)?.unchangedImmediateReads ?? 0;
		return count >= this.breakerThreshold ? "tripped" : count > 0 ? "armed" : "idle";
	}

	/** Preserve the requested wait exactly; breaker state is reporting-only. */
	effectiveWaitMs(_taskId: string, requestedWaitMs: number): EffectiveWait {
		return { waitMs: requestedWaitMs, coerced: false };
	}

	/** Record a running read and report change/progress plus breaker state. */
	noteRunningRead(input: Readonly<{ taskId: string; fingerprint: string; immediate: boolean }>): RunningReadVerdict {
		const prev = this.reads.get(input.taskId);
		const changed = prev === undefined || prev.fingerprint !== input.fingerprint;
		const unchangedImmediateReads = changed
			? 0
			: input.immediate
				? prev.unchangedImmediateReads + 1
				: prev.unchangedImmediateReads;
		this.reads.set(input.taskId, { fingerprint: input.fingerprint, unchangedImmediateReads });
		this.appendEntry?.(SUPERVISION_READ_ENTRY, {
			taskId: input.taskId,
			fingerprint: input.fingerprint,
			unchangedImmediateReads,
			timestamp: new Date().toISOString(),
		});
		return { changed, unchangedImmediateReads, breaker: this.breakerState(input.taskId) };
	}

	/** Clear read dedupe state once a task has been observed terminal. */
	noteTerminalRead(taskId: string): void {
		if (!this.reads.delete(taskId)) return;
		this.appendEntry?.(SUPERVISION_READ_ENTRY, {
			taskId,
			cleared: true,
			timestamp: new Date().toISOString(),
		});
	}
}
