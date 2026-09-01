import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ROOT_TURN_ENTRY,
	ROOT_TURN_SCHEMA_VERSION,
	type ExecutionProvenance,
	type RootTurnTelemetryRecord,
	type WorkflowAssignment,
} from "./types.ts";
import type { WorkflowMode } from "./background/workflow.ts";

export const TELEMETRY_SCHEMA_VERSION = "dstack.telemetry-report.v2" as const;

export type QuantileDistribution = Readonly<{
	count: number;
	minMs: number;
	maxMs: number;
	meanMs: number;
	medianMs: number;
	p75Ms: number;
	p90Ms: number;
	p95Ms: number;
	p99Ms: number;
	totalMs: number;
}>;

export type WorkflowSelectionCounts = Readonly<{
	totalWorkflows: number;
	byPlaybook: Readonly<Record<string, number>>;
	byMode: Readonly<Record<string, number>>;
	byOutcome: Readonly<Record<string, number>>;
}>;

export type RolesAndModelsByPlaybook = Readonly<{
	byPlaybook: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>>;
	byRole: Readonly<Record<string, Readonly<Record<string, number>>>>;
}>;

export type RuntimeDistributions = Readonly<{
	owner: QuantileDistribution;
	worker: QuantileDistribution;
	reviewer: QuantileDistribution;
	unassigned: QuantileDistribution;
	all: QuantileDistribution;
}>;

export type OwnerDelegationCohorts = Readonly<{
	delegatedOwners: Readonly<{
		count: number;
		runtime: QuantileDistribution;
	}>;
	nonDelegatedOwners: Readonly<{
		count: number;
		runtime: QuantileDistribution;
	}>;
	causalityLimitation: string;
}>;

export type TelemetryProvenanceSummary = Readonly<{
	includedWorkflows: number;
	excludedTestWorkflows: number;
	byProvenance: Readonly<Record<ExecutionProvenance, number>>;
}>;

export type LaunchFailureSummary = Readonly<{
	preLaunchConfiguration: number;
	preLaunchOther: number;
	execution: number;
	unknown: number;
}>;

export type RoleModelAssociation = Readonly<{
	role: string;
	resolvedModel: string;
	totalInvocations: number;
	succeededCount: number;
	failedCount: number;
	abandonedCount: number;
	observableRepeatedDelegationCount: number;
	failureRate: number;
}>;

export type WorkerEconomics = Readonly<{
	lightweightWorkerRuns: number;
	lightweightWorkerRunsWithCost: number;
	lightweightWorkerDirectCost: number;
	ownerRuns: number;
	ownerRunsWithCost: number;
	ownerDirectCost: number;
	ownerAverageCostPerRun: number | null;
	lightweightWorkerAverageCostPerRun: number | null;
	directCostIsLower: boolean | "unsupported_due_to_missing_cost_data";
	costSavingsRatio: number | null;
	afterReworkEconomicsSupported: false;
	evaluationNote: string;
}>;

export type DataJoinReliability = Readonly<{
	manifestToSession: Readonly<{
		total: number;
		joined: number;
		missingSession: number;
		joinRate: number | null;
	}>;
	committedToResultIndex: Readonly<{
		totalCommitted: number;
		joined: number;
		missingResultIndex: number;
		joinRate: number | null;
	}>;
	manifestToChildResults: Readonly<{
		totalExpectedChildren: number;
		joinedChildResults: number;
		missingChildResults: number;
		joinRate: number | null;
	}>;
	bindingsToWorkflows: Readonly<{
		totalBindings: number;
		joined: number;
		danglingBindings: number;
		joinRate: number | null;
	}>;
	queueEventsToWorkflows: Readonly<{
		totalEvents: number;
		joined: number;
		danglingEvents: number;
		joinRate: number | null;
	}>;
	totalJoinsAttempted: number;
	totalJoinsSuccessful: number;
	overallJoinRate: number | null;
}>;

export type QueueEventSummary = Readonly<{
	ticketCreated: number;
	slotAcquired: number;
	matchedAcquisitions: number;
	missingAcquisitions: number;
	orphanAcquisitions: number;
	duplicateEventIds: number;
	byDepth: Readonly<Record<string, number>>;
	byCapacityClass: Readonly<Record<string, number>>;
	waitTime: QuantileDistribution;
}>;

export type WorkflowOutcomeReliability = Readonly<{
	totalWorkflows: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	uncommittedOrAbandoned: number;
	successRate: number | null;
	byMode: Readonly<
		Record<
			string,
			Readonly<{
				total: number;
				succeeded: number;
				failed: number;
				cancelled: number;
				uncommittedOrAbandoned: number;
				successRate: number | null;
			}>
		>
	>;
}>;

export type MetricLimitation = Readonly<{
	metric: string;
	reason: string;
	explicitLimitation: string;
}>;

export type RecoverableAndMissingMetrics = Readonly<{
	scannedSessions: number;
	scannedWorkflows: number;
	scannedChildren: number;
	corruptOrUnparseableRecords: Readonly<{
		sessionFiles: number;
		manifestFiles: number;
		resultIndexFiles: number;
		childResultFiles: number;
		spawnRecordFiles: number;
		bindingFiles: number;
		queueEventFiles: number;
	}>;
	recoverableMetrics: readonly string[];
	missingOrUnsupportedMetrics: readonly MetricLimitation[];
}>;

export type TelemetryReportV2 = Readonly<{
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	generatedAt: string;
	reportPeriod: Readonly<{
		earliestTimestamp?: string;
		latestTimestamp?: string;
	}>;
	workflowSelections: WorkflowSelectionCounts;
	rolesAndModels: RolesAndModelsByPlaybook;
	runtimeDistributions: RuntimeDistributions;
	rootTurnLatency: QuantileDistribution;
	ownerDelegationCohorts: OwnerDelegationCohorts;
	provenance: TelemetryProvenanceSummary;
	launchFailures: LaunchFailureSummary;
	roleModelReliability: readonly RoleModelAssociation[];
	workerEconomics: WorkerEconomics;
	queueEvents: QueueEventSummary;
	dataJoinReliability: DataJoinReliability;
	workflowOutcomeReliability: WorkflowOutcomeReliability;
	recoverableAndMissingMetrics: RecoverableAndMissingMetrics;
}>;

export type TimeInterval = Readonly<{
	startMs: number;
	endMs: number;
}>;

export type UsageMetrics = Readonly<{
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	contextTokens?: number;
	turns?: number;
}>;

export type NormalizedNestedSpawnTelemetry = Readonly<{
	spawnKey: string;
	groupId: string;
	nestedIndex: number;
	agent: string;
	role: string;
	model: string;
	assignment: WorkflowAssignment | "unassigned";
	phase?: string;
	state: "succeeded" | "failed" | "cancelled" | "running" | "queued" | "skipped" | "unknown";
	exitCode?: number;
	runtimeMs?: number;
	interval?: TimeInterval;
	usage?: UsageMetrics;
	launchState: "not_started" | "started" | "unknown";
	failureKind?: "pre_launch_configuration" | "pre_launch_other" | "execution";
}>;

export type NormalizedChildTelemetry = Readonly<{
	childKey: string;
	workflowId: string;
	index: number;
	agent: string;
	role: string;
	model: string;
	playbook: string;
	assignment: WorkflowAssignment | "unassigned";
	phase?: string;
	state: "succeeded" | "failed" | "cancelled" | "running" | "queued" | "skipped" | "unknown";
	exitCode?: number;
	runtimeMs?: number;
	interval?: TimeInterval;
	usage?: UsageMetrics;
	launchState: "not_started" | "started" | "unknown";
	failureKind?: "pre_launch_configuration" | "pre_launch_other" | "execution";
	hasChildResult: boolean;
	spawns: readonly NormalizedNestedSpawnTelemetry[];
	spawnGroupCount: number;
}>;

export type NormalizedWorkflowTelemetry = Readonly<{
	workflowId: string;
	sessionId?: string;
	mode: WorkflowMode | "unknown";
	playbook: string;
	createdAt?: string;
	provenance: ExecutionProvenance;
	isTopLevelOwnerWorkflow: boolean;
	outcome: "succeeded" | "failed" | "cancelled" | "uncommitted" | "abandoned";
	hasManifest: boolean;
	committed: boolean;
	hasResultIndex: boolean;
	childCount: number;
	succeededChildCount: number;
	failedChildCount: number;
	cancelledChildCount: number;
	children: readonly NormalizedChildTelemetry[];
}>;

export type NormalizedSessionTelemetry = Readonly<{
	sessionId: string;
	startedAt?: string;
	endedAt?: string;
	interval?: TimeInterval;
}>;

export type NormalizedBindingTelemetry = Readonly<{
	bindingId: string;
	workflowId: string;
}>;

export type NormalizedQueueEventTelemetry =
	| Readonly<{
			eventId: string;
			kind: "ticket_created";
			ticketId: string;
			workflowId: string;
			childId: string;
			seq: number;
			depth: 1 | 2;
			capacityClass: "reserved" | "terminal";
			occurredAt: string;
	  }>
	| Readonly<{
			eventId: string;
			kind: "slot_acquired";
			ticketId: string;
			slotAcquisitionId: string;
			workflowId: string;
			childId: string;
			seq: number;
			depth: 1 | 2;
			capacityClass: "reserved" | "terminal";
			occurredAt: string;
	  }>;

export type NormalizedRootTurnTelemetry = RootTurnTelemetryRecord;

export type RawTelemetryData = Readonly<{
	sessions: readonly NormalizedSessionTelemetry[];
	workflows: readonly NormalizedWorkflowTelemetry[];
	bindings: readonly NormalizedBindingTelemetry[];
	rootTurns?: readonly NormalizedRootTurnTelemetry[];
	queueEvents?: readonly NormalizedQueueEventTelemetry[];
	duplicateQueueEventIds?: number;
	excludedTestWorkflows?: number;
	corruptCounts: Readonly<{
		sessionFiles: number;
		manifestFiles: number;
		resultIndexFiles: number;
		childResultFiles: number;
		spawnRecordFiles: number;
		bindingFiles: number;
		queueEventFiles?: number;
	}>;
}>;

export type TelemetryCollectOptions = Readonly<{
	backgroundRoot?: string;
	sessionsDir?: string;
	timeWindow?: Readonly<{
		from?: string;
		to?: string;
	}>;
	includeTests?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseDateMs(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isFixtureModel(model: string): boolean {
	const provider = model.split("/", 1)[0]?.toLowerCase();
	return provider === "test" || provider === "fake" || provider === "fake-router" || provider === "acme";
}

function isPreLaunchConfigurationError(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && (
		errorMessage.startsWith("Unknown agent ") ||
		errorMessage.includes(" is not configured") ||
		errorMessage.includes("requires overrideReason") ||
		errorMessage.includes("model override")
	);
}

function parseLaunchState(value: unknown): "not_started" | "started" | undefined {
	return value === "not_started" || value === "started" ? value : undefined;
}

function parseFailureKind(value: unknown): "pre_launch_configuration" | "pre_launch_other" | "execution" | undefined {
	return value === "pre_launch_configuration" || value === "pre_launch_other" || value === "execution" ? value : undefined;
}

export function mergeTimeIntervals(intervals: readonly TimeInterval[]): readonly TimeInterval[] {
	const valid = intervals
		.filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs >= i.startMs)
		.slice()
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	if (valid.length === 0) return [];
	const merged: Array<{ startMs: number; endMs: number }> = [];
	let current = { startMs: valid[0]!.startMs, endMs: valid[0]!.endMs };
	for (let i = 1; i < valid.length; i++) {
		const next = valid[i]!;
		if (next.startMs <= current.endMs) {
			current.endMs = Math.max(current.endMs, next.endMs);
		} else {
			merged.push(current);
			current = { startMs: next.startMs, endMs: next.endMs };
		}
	}
	merged.push(current);
	return merged;
}

export function totalMergedDurationMs(intervals: readonly TimeInterval[]): number {
	const merged = mergeTimeIntervals(intervals);
	return merged.reduce((acc, i) => acc + (i.endMs - i.startMs), 0);
}

export function calculateQuantileDistribution(values: readonly number[]): QuantileDistribution {
	const valid = values.filter((v) => Number.isFinite(v) && v >= 0);
	if (valid.length === 0) {
		return {
			count: 0,
			minMs: 0,
			maxMs: 0,
			meanMs: 0,
			medianMs: 0,
			p75Ms: 0,
			p90Ms: 0,
			p95Ms: 0,
			p99Ms: 0,
			totalMs: 0,
		};
	}
	const sorted = [...valid].sort((a, b) => a - b);
	const totalMs = sorted.reduce((sum, v) => sum + v, 0);
	const count = sorted.length;
	const meanMs = totalMs / count;
	const minMs = sorted[0]!;
	const maxMs = sorted[count - 1]!;

	const quantile = (p: number): number => {
		if (count === 1) return sorted[0]!;
		const index = (count - 1) * p;
		const lower = Math.floor(index);
		const upper = Math.ceil(index);
		const weight = index - lower;
		const lowerVal = sorted[lower]!;
		const upperVal = sorted[upper]!;
		return lowerVal + (upperVal - lowerVal) * weight;
	};

	return {
		count,
		minMs,
		maxMs,
		meanMs,
		medianMs: quantile(0.5),
		p75Ms: quantile(0.75),
		p90Ms: quantile(0.9),
		p95Ms: quantile(0.95),
		p99Ms: quantile(0.99),
		totalMs,
	};
}

export function defaultBackgroundRoot(): string {
	return join(homedir(), ".pi", "agent", "dstack", "background");
}

export function defaultSessionsDir(): string {
	return join(homedir(), ".pi", "agent", "sessions");
}

function parseUsage(value: unknown): UsageMetrics | undefined {
	if (!isRecord(value)) return undefined;
	const input = parseOptionalNumber(value["input"]);
	const output = parseOptionalNumber(value["output"]);
	const cacheRead = parseOptionalNumber(value["cacheRead"]);
	const cacheWrite = parseOptionalNumber(value["cacheWrite"]);
	const cost = parseOptionalNumber(value["cost"]);
	const contextTokens = parseOptionalNumber(value["contextTokens"]);
	const turns = parseOptionalNumber(value["turns"]);
	if (
		input === undefined &&
		output === undefined &&
		cacheRead === undefined &&
		cacheWrite === undefined &&
		cost === undefined &&
		contextTokens === undefined &&
		turns === undefined
	) {
		return undefined;
	}
	return { input, output, cacheRead, cacheWrite, cost, contextTokens, turns };
}

async function readJsonFileSafe(
	filePath: string,
): Promise<{ status: "ok"; data: unknown } | { status: "missing" } | { status: "corrupt"; error: unknown }> {
	try {
		const raw = await readFile(filePath, "utf8");
		try {
			const parsed: unknown = JSON.parse(raw);
			return { status: "ok", data: parsed };
		} catch (err) {
			return { status: "corrupt", error: err };
		}
	} catch (err: unknown) {
		if (isRecord(err) && err["code"] === "ENOENT") {
			return { status: "missing" };
		}
		return { status: "corrupt", error: err };
	}
}

export async function scanSessions(
	sessionsDir: string,
	corruptTracker: { sessionFiles: number },
): Promise<{ sessions: NormalizedSessionTelemetry[]; rootTurns: NormalizedRootTurnTelemetry[] }> {
	const sessions: NormalizedSessionTelemetry[] = [];
	const rootTurns: NormalizedRootTurnTelemetry[] = [];
	let topEntries;
	try {
		topEntries = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return { sessions, rootTurns };
	}

	for (const topEntry of topEntries) {
		if (!topEntry.isDirectory()) continue;
		const subDir = join(sessionsDir, topEntry.name);
		let fileEntries;
		try {
			fileEntries = await readdir(subDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const fileEntry of fileEntries) {
			if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
			const filePath = join(subDir, fileEntry.name);
			try {
				const content = await readFile(filePath, "utf8");
				const lines = content.split("\n");
				let sessionId: string | undefined;
				let earliestMs: number | undefined;
				let latestMs: number | undefined;
				let hasCorruptLine = false;

				for (const line of lines) {
					if (line.trim().length === 0) continue;
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						hasCorruptLine = true;
						continue;
					}
					if (!isRecord(parsed)) continue;

					// Parse ONLY allowlisted session metadata
					const type = parsed["type"];
					if (type === "session") {
						const id = parseOptionalString(parsed["id"]);
						if (id !== undefined) sessionId = id;
					}

					if (type === "custom" && parsed["customType"] === ROOT_TURN_ENTRY) {
						const rootTurn = parseRootTurnRecord(parsed["data"]);
						if (rootTurn !== undefined) {
							rootTurns.push(rootTurn);
						}
					}

					const ts = parseDateMs(parsed["timestamp"]);
					if (ts !== undefined) {
						earliestMs = earliestMs === undefined ? ts : Math.min(earliestMs, ts);
						latestMs = latestMs === undefined ? ts : Math.max(latestMs, ts);
					}
				}

				if (hasCorruptLine) {
					corruptTracker.sessionFiles += 1;
				}

				if (sessionId === undefined) {
					const match = fileEntry.name.match(/_([0-9a-fA-F-]+)\.jsonl$/);
					if (match && match[1]) sessionId = match[1];
				}

				if (sessionId !== undefined) {
					const interval =
						earliestMs !== undefined && latestMs !== undefined && latestMs >= earliestMs
							? { startMs: earliestMs, endMs: latestMs }
							: undefined;
					sessions.push({
						sessionId,
						startedAt: earliestMs !== undefined ? new Date(earliestMs).toISOString() : undefined,
						endedAt: latestMs !== undefined ? new Date(latestMs).toISOString() : undefined,
						interval,
					});
				}
			} catch (err: unknown) {
				if (!isRecord(err) || err["code"] !== "ENOENT") {
					corruptTracker.sessionFiles += 1;
				}
			}
		}
	}
	return { sessions, rootTurns };
}

export function parseRootTurnRecord(value: unknown): NormalizedRootTurnTelemetry | undefined {
	if (!isRecord(value) || value["schemaVersion"] !== ROOT_TURN_SCHEMA_VERSION) return undefined;
	const startedAt = parseOptionalString(value["startedAt"]);
	const endedAt = parseOptionalString(value["endedAt"]);
	const durationMs = parseOptionalNumber(value["durationMs"]);
	const provenance = parseOptionalString(value["provenance"]);
	const startedAtMs = parseDateMs(startedAt);
	const endedAtMs = parseDateMs(endedAt);

	if (
		startedAt === undefined ||
		startedAtMs === undefined ||
		endedAt === undefined ||
		endedAtMs === undefined ||
		endedAtMs < startedAtMs ||
		durationMs === undefined ||
		durationMs < 0 ||
		Math.abs(endedAtMs - startedAtMs - durationMs) > 1_000 ||
		(provenance !== "production" && provenance !== "test" && provenance !== "unknown")
	) {
		return undefined;
	}

	return {
		schemaVersion: ROOT_TURN_SCHEMA_VERSION,
		startedAt,
		endedAt,
		durationMs,
		provenance,
	};
}

function parseQueueEvent(value: unknown): NormalizedQueueEventTelemetry | undefined {
	if (!isRecord(value) || value["schemaVersion"] !== "dstack.scheduler.queue-event.v1") return undefined;
	const eventId = parseOptionalString(value["eventId"]);
	const kind = parseOptionalString(value["kind"]);
	const ticketId = parseOptionalString(value["ticketId"]);
	const workflowId = parseOptionalString(value["workflowId"]);
	const childId = parseOptionalString(value["childId"]);
	const seq = parseOptionalNumber(value["seq"]);
	const depth = value["depth"];
	const capacityClass = value["capacityClass"];
	const occurredAt = parseOptionalString(value["occurredAt"]);
	if (
		eventId === undefined ||
		ticketId === undefined ||
		workflowId === undefined ||
		childId === undefined ||
		seq === undefined ||
		!Number.isSafeInteger(seq) ||
		seq <= 0 ||
		(depth !== 1 && depth !== 2) ||
		(capacityClass !== "reserved" && capacityClass !== "terminal") ||
		occurredAt === undefined ||
		parseDateMs(occurredAt) === undefined
	) return undefined;
	const nonce = ticketId.startsWith("dstack.scheduler-ticket.v2:")
		? ticketId.slice("dstack.scheduler-ticket.v2:".length)
		: "";
	if (nonce === "") return undefined;
	if (kind === "ticket_created") {
		if (eventId !== `dstack.scheduler-queue-event.v1:ticket_created:${nonce}`) return undefined;
		return { eventId, kind, ticketId, workflowId, childId, seq, depth, capacityClass, occurredAt };
	}
	if (kind === "slot_acquired") {
		const slotAcquisitionId = parseOptionalString(value["slotAcquisitionId"]);
		if (
			eventId !== `dstack.scheduler-queue-event.v1:slot_acquired:${nonce}` ||
			slotAcquisitionId !== `dstack.scheduler-slot-acquisition.v1:${nonce}`
		) return undefined;
		return { eventId, kind, ticketId, slotAcquisitionId, workflowId, childId, seq, depth, capacityClass, occurredAt };
	}
	return undefined;
}

export async function scanBackgroundArtifacts(
	backgroundRoot: string,
	corruptTracker: {
		manifestFiles: number;
		resultIndexFiles: number;
		childResultFiles: number;
		spawnRecordFiles: number;
		bindingFiles: number;
		queueEventFiles: number;
	},
): Promise<{
	workflows: NormalizedWorkflowTelemetry[];
	bindings: NormalizedBindingTelemetry[];
	queueEvents: NormalizedQueueEventTelemetry[];
	duplicateQueueEventIds: number;
}> {
	const workflows: NormalizedWorkflowTelemetry[] = [];
	const bindings: NormalizedBindingTelemetry[] = [];
	const queueEvents: NormalizedQueueEventTelemetry[] = [];
	const seenQueueEventIds = new Set<string>();
	let duplicateQueueEventIds = 0;
	const seenWorkflows = new Set<string>();

	let sessionDirs;
	try {
		sessionDirs = await readdir(backgroundRoot, { withFileTypes: true });
	} catch {
		return { workflows, bindings, queueEvents, duplicateQueueEventIds };
	}

	for (const sessEntry of sessionDirs) {
		if (!sessEntry.isDirectory()) continue;
		const sessionPath = join(backgroundRoot, sessEntry.name);

		const eventsPath = join(sessionPath, "scheduler", "events");
		let eventEntries;
		try {
			eventEntries = await readdir(eventsPath, { withFileTypes: true });
		} catch {
			eventEntries = undefined;
		}
		for (const eventEntry of eventEntries ?? []) {
			if (!eventEntry.isFile() || !eventEntry.name.endsWith(".json")) continue;
			const eventResult = await readJsonFileSafe(join(eventsPath, eventEntry.name));
			if (eventResult.status !== "ok") {
				if (eventResult.status === "corrupt") corruptTracker.queueEventFiles += 1;
				continue;
			}
			const event = parseQueueEvent(eventResult.data);
			if (event === undefined) {
				corruptTracker.queueEventFiles += 1;
				continue;
			}
			if (seenQueueEventIds.has(event.eventId)) {
				duplicateQueueEventIds += 1;
				continue;
			}
			seenQueueEventIds.add(event.eventId);
			queueEvents.push(event);
		}

		// Scan bindings directory
		const bindingsPath = join(sessionPath, "bindings");
		let bindingEntries;
		try {
			bindingEntries = await readdir(bindingsPath, { withFileTypes: true });
		} catch {
			bindingEntries = undefined;
		}

		if (bindingEntries !== undefined) {
			for (const bEntry of bindingEntries) {
				if (!bEntry.isFile() || !bEntry.name.endsWith(".json")) continue;
				const bindingFilePath = join(bindingsPath, bEntry.name);
				const bRes = await readJsonFileSafe(bindingFilePath);
				if (bRes.status === "corrupt") {
					corruptTracker.bindingFiles += 1;
				} else if (bRes.status === "ok" && isRecord(bRes.data)) {
					const taskId = parseOptionalString(bRes.data["taskId"]) ?? bEntry.name.replace(/\.json$/, "");
					const workflowId = parseOptionalString(bRes.data["workflowId"]);
					if (workflowId !== undefined) {
						bindings.push({ bindingId: taskId, workflowId });
					}
				}
			}
		}

		// Scan workflows directory
		const workflowsPath = join(sessionPath, "workflows");
		let wfEntries;
		try {
			wfEntries = await readdir(workflowsPath, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const wfEntry of wfEntries) {
			if (!wfEntry.isDirectory()) continue;
			const workflowId = wfEntry.name;
			if (seenWorkflows.has(workflowId)) continue;
			seenWorkflows.add(workflowId);

			const wfDir = join(workflowsPath, workflowId);
			const wfTelemetry = await parseWorkflowDirectory(wfDir, workflowId, corruptTracker);
			if (wfTelemetry !== undefined) {
				workflows.push(wfTelemetry);
			}
		}
	}

	return { workflows, bindings, queueEvents, duplicateQueueEventIds };
}

async function parseWorkflowDirectory(
	wfDir: string,
	workflowId: string,
	corruptTracker: {
		manifestFiles: number;
		resultIndexFiles: number;
		childResultFiles: number;
		spawnRecordFiles: number;
	},
): Promise<NormalizedWorkflowTelemetry | undefined> {
	let manifestData: Record<string, unknown> | undefined;
	const manifestRes = await readJsonFileSafe(join(wfDir, "manifest.json"));
	if (manifestRes.status === "corrupt") {
		corruptTracker.manifestFiles += 1;
	} else if (manifestRes.status === "ok" && isRecord(manifestRes.data)) {
		manifestData = manifestRes.data;
	}
	const hasManifest = manifestData !== undefined;

	let committed = false;
	const commitRes = await readJsonFileSafe(join(wfDir, "COMMITTED"));
	if (commitRes.status === "ok" && isRecord(commitRes.data) && commitRes.data["schemaVersion"] === "dstack.commit.v1") {
		committed = true;
	}

	let resultIndexData: Record<string, unknown> | undefined;
	const resultIndexRes = await readJsonFileSafe(join(wfDir, "result-index.json"));
	if (resultIndexRes.status === "corrupt") {
		corruptTracker.resultIndexFiles += 1;
	} else if (resultIndexRes.status === "ok" && isRecord(resultIndexRes.data)) {
		resultIndexData = resultIndexRes.data;
	}
	const hasResultIndex = resultIndexData !== undefined;

	const sessionId = manifestData ? parseOptionalString(manifestData["sessionId"]) : undefined;
	const createdAt = manifestData ? parseOptionalString(manifestData["createdAt"]) : undefined;
	const modeRaw = manifestData ? parseOptionalString(manifestData["mode"]) : undefined;
	const mode: WorkflowMode | "unknown" =
		modeRaw === "single" || modeRaw === "parallel" || modeRaw === "chain" ? modeRaw : "unknown";
	const provenanceRaw = manifestData ? parseOptionalString(manifestData["provenance"]) : undefined;
	const explicitProvenance: ExecutionProvenance | undefined =
		provenanceRaw === "production" || provenanceRaw === "test" || provenanceRaw === "unknown" ? provenanceRaw : undefined;

	const rawSpecs = manifestData && Array.isArray(manifestData["specs"]) ? manifestData["specs"] : [];

	let workflowPlaybook = "unspecified";
	let hasOwnerSpec = false;
	let hasWorkerOrReviewerSpec = false;

	for (const rawSpec of rawSpecs) {
		if (isRecord(rawSpec) && isRecord(rawSpec["workflow"])) {
			const pb = parseOptionalString(rawSpec["workflow"]["playbook"]);
			if (pb !== undefined && workflowPlaybook === "unspecified") {
				workflowPlaybook = pb;
			}
			const asgn = parseOptionalString(rawSpec["workflow"]["assignment"]);
			if (asgn === "owner") {
				hasOwnerSpec = true;
			} else if (asgn === "worker" || asgn === "reviewer") {
				hasWorkerOrReviewerSpec = true;
			}
		}
	}

	// Top-level owner assignment workflow: contains assignment: "owner" spec or is top-level unassigned workflow
	const isTopLevelOwnerWorkflow = hasOwnerSpec || (!hasWorkerOrReviewerSpec && rawSpecs.length > 0);

	// Enumerate children from manifest specs and filesystem
	let childDirs: string[] = [];
	try {
		const entries = await readdir(join(wfDir, "children"), { withFileTypes: true });
		childDirs = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name);
	} catch {
		childDirs = [];
	}

	const maxChildIndexFromDisk = childDirs.reduce((max, d) => Math.max(max, parseInt(d, 10) + 1), 0);
	const resultIndexChildrenLength =
		resultIndexData && Array.isArray(resultIndexData["children"]) ? resultIndexData["children"].length : 0;
	const childCount = Math.max(rawSpecs.length, resultIndexChildrenLength, maxChildIndexFromDisk);

	const children: NormalizedChildTelemetry[] = [];
	let succeededCount = 0;
	let failedCount = 0;
	let cancelledCount = 0;

	for (let index = 0; index < childCount; index++) {
		const rawSpec = isRecord(rawSpecs[index]) ? rawSpecs[index] : undefined;
		const childDir = join(wfDir, "children", String(index));
		const childTelemetry = await parseChildDirectory({
			childDir,
			workflowId,
			index,
			spec: rawSpec,
			workflowPlaybook,
			corruptTracker,
		});

		if (childTelemetry !== undefined) {
			children.push(childTelemetry);
			if (childTelemetry.state === "succeeded") succeededCount += 1;
			else if (childTelemetry.state === "failed") failedCount += 1;
			else if (childTelemetry.state === "cancelled") cancelledCount += 1;
		}
	}

	let outcome: NormalizedWorkflowTelemetry["outcome"] = "uncommitted";
	if (committed && resultIndexData !== undefined) {
		const outcomeRaw = parseOptionalString(resultIndexData["outcome"]);
		if (outcomeRaw === "succeeded" || outcomeRaw === "failed" || outcomeRaw === "cancelled") {
			outcome = outcomeRaw;
		} else {
			outcome = failedCount > 0 ? "failed" : cancelledCount > 0 ? "cancelled" : "succeeded";
		}
	} else if (!committed && (failedCount > 0 || cancelledCount > 0)) {
		outcome = "abandoned";
	}

	const fixtureProviderFound = children.some((child) =>
		isFixtureModel(child.model) || child.spawns.some((spawn) => isFixtureModel(spawn.model)),
	);
	const provenance: ExecutionProvenance = explicitProvenance ?? (fixtureProviderFound ? "test" : "unknown");

	return {
		workflowId,
		sessionId,
		mode,
		playbook: workflowPlaybook,
		createdAt,
		provenance,
		isTopLevelOwnerWorkflow,
		outcome,
		hasManifest,
		committed,
		hasResultIndex,
		childCount,
		succeededChildCount: succeededCount,
		failedChildCount: failedCount,
		cancelledChildCount: cancelledCount,
		children,
	};
}

async function parseChildDirectory(input: {
	childDir: string;
	workflowId: string;
	index: number;
	spec?: Record<string, unknown>;
	workflowPlaybook: string;
	corruptTracker: {
		childResultFiles: number;
		spawnRecordFiles: number;
	};
}): Promise<NormalizedChildTelemetry | undefined> {
	const { childDir, workflowId, index, spec, workflowPlaybook, corruptTracker } = input;
	const childKey = `${workflowId}:${index}`;

	let agent = "unspecified";
	let role = "unassigned";
	let model = "unresolved";
	let playbook = workflowPlaybook;
	let assignment: WorkflowAssignment | "unassigned" = "unassigned";
	let phase: string | undefined;

	if (spec !== undefined) {
		const specAgent = parseOptionalString(spec["agent"]);
		if (specAgent !== undefined) agent = specAgent;

		const specRole = parseOptionalString(spec["requestedRole"]) ?? parseOptionalString(spec["role"]);
		if (specRole !== undefined) role = specRole;

		const specModel = parseOptionalString(spec["model"]);
		if (specModel !== undefined) model = specModel;

		if (isRecord(spec["workflow"])) {
			const specPlaybook = parseOptionalString(spec["workflow"]["playbook"]);
			if (specPlaybook !== undefined) playbook = specPlaybook;

			const specAssignment = parseOptionalString(spec["workflow"]["assignment"]);
			if (specAssignment === "owner" || specAssignment === "worker" || specAssignment === "reviewer") {
				assignment = specAssignment;
			}

			const specPhase = parseOptionalString(spec["workflow"]["phase"]);
			if (specPhase !== undefined) phase = specPhase;
		}
	}

	// Read child result.json safely - parse allowlisted metadata only!
	let childResultData: Record<string, unknown> | undefined;
	let hasChildResult = false;
	const crRes = await readJsonFileSafe(join(childDir, "result.json"));
	if (crRes.status === "corrupt") {
		corruptTracker.childResultFiles += 1;
	} else if (crRes.status === "ok" && isRecord(crRes.data)) {
		childResultData = crRes.data;
		hasChildResult = true;
	}

	let state: NormalizedChildTelemetry["state"] = "unknown";
	let exitCode: number | undefined;
	let usage: UsageMetrics | undefined;
	let errorMessage: string | undefined;
	let startedAtIso: string | undefined;
	let endedAtIso: string | undefined;

	if (childResultData !== undefined) {
		const rawState = parseOptionalString(childResultData["state"]);
		if (
			rawState === "succeeded" ||
			rawState === "failed" ||
			rawState === "cancelled" ||
			rawState === "running" ||
			rawState === "queued" ||
			rawState === "skipped"
		) {
			state = rawState;
		}

		// Top-level startedAt and endedAt timestamps
		startedAtIso = parseOptionalString(childResultData["startedAt"]);
		endedAtIso = parseOptionalString(childResultData["endedAt"]);

		// Fields under childResultData["result"]
		const innerResult = isRecord(childResultData["result"]) ? childResultData["result"] : undefined;
		if (innerResult !== undefined) {
			exitCode = parseOptionalNumber(innerResult["exitCode"]);
			const resModel = parseOptionalString(innerResult["model"]);
			if (resModel !== undefined && model === "unresolved") {
				model = resModel;
			}
			if (isRecord(innerResult["usage"])) {
				usage = parseUsage(innerResult["usage"]);
			}
			errorMessage = parseOptionalString(innerResult["errorMessage"]);
		}

		if (state === "unknown" && exitCode !== undefined) {
			state = exitCode === 0 ? "succeeded" : "failed";
		}
	}

	// Runtime MUST use top-level startedAt/endedAt
	let runtimeMs: number | undefined;
	let interval: TimeInterval | undefined;
	const startMs = parseDateMs(startedAtIso);
	const endMs = parseDateMs(endedAtIso);
	const launchState: NormalizedChildTelemetry["launchState"] = startMs !== undefined
		? "started"
		: isPreLaunchConfigurationError(errorMessage)
			? "not_started"
			: "unknown";
	const failureKind: NormalizedChildTelemetry["failureKind"] = state !== "failed"
		? undefined
		: launchState === "started"
			? "execution"
			: isPreLaunchConfigurationError(errorMessage)
				? "pre_launch_configuration"
				: undefined;
	if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
		runtimeMs = endMs - startMs;
		interval = { startMs, endMs };
	}

	// Scan metadata-only fields from children/<index>/spawns/*.json
	const spawns: NormalizedNestedSpawnTelemetry[] = [];
	let spawnGroupCount = 0;
	const spawnsDir = join(childDir, "spawns");
	let spawnEntries;
	try {
		spawnEntries = await readdir(spawnsDir, { withFileTypes: true });
	} catch {
		spawnEntries = undefined;
	}

	if (spawnEntries !== undefined) {
		for (const spEntry of spawnEntries) {
			if (!spEntry.isFile() || !spEntry.name.endsWith(".json")) continue;
			const spawnFilePath = join(spawnsDir, spEntry.name);
			const spRes = await readJsonFileSafe(spawnFilePath);
			if (spRes.status === "corrupt") {
				corruptTracker.spawnRecordFiles += 1;
				continue;
			}
			if (spRes.status !== "ok" || !isRecord(spRes.data)) continue;

			spawnGroupCount += 1;
			const groupId = parseOptionalString(spRes.data["groupId"]) ?? spEntry.name.replace(/\.json$/, "");
			const rawChildren = Array.isArray(spRes.data["children"]) ? spRes.data["children"] : [];

			for (const rawNested of rawChildren) {
				if (!isRecord(rawNested)) continue;

				// Parse ONLY allowlisted metadata fields from spawn records
				const nestedIndex = parseOptionalNumber(rawNested["nestedIndex"]) ?? spawns.length;
				const nestedAgent = parseOptionalString(rawNested["agent"]) ?? "unspecified";
				const nestedModel = parseOptionalString(rawNested["model"]) ?? "unresolved";
				const nestedRawState = parseOptionalString(rawNested["state"]);
				const nestedState: NormalizedNestedSpawnTelemetry["state"] =
					nestedRawState === "succeeded" ||
					nestedRawState === "failed" ||
					nestedRawState === "cancelled" ||
					nestedRawState === "running" ||
					nestedRawState === "queued" ||
					nestedRawState === "skipped"
						? nestedRawState
						: "unknown";

				const nestedExitCode = parseOptionalNumber(rawNested["exitCode"]);
				const nestedUsage = parseUsage(rawNested["usage"]);
				const nestedErrorMessage = parseOptionalString(rawNested["errorMessage"]);

				const nestedRole =
					parseOptionalString(rawNested["role"]) ??
					parseOptionalString(rawNested["requestedRole"]) ??
					nestedAgent;

				const rawAssignment = parseOptionalString(rawNested["assignment"]);
				const nestedAssignment: WorkflowAssignment | "unassigned" =
					rawAssignment === "worker" || rawAssignment === "reviewer" || rawAssignment === "owner"
						? rawAssignment
						: "worker";

				let nestedPhase: string | undefined;
				if (isRecord(rawNested["status"])) {
					nestedPhase = parseOptionalString(rawNested["status"]["phase"]);
				} else if (typeof rawNested["phase"] === "string") {
					nestedPhase = parseOptionalString(rawNested["phase"]);
				}

				const nestedStartMs = parseDateMs(rawNested["startedAt"]);
				const nestedEndMs = parseDateMs(rawNested["endedAt"]) ?? parseDateMs(rawNested["updatedAt"]);
				const explicitLaunchState = parseLaunchState(rawNested["launchState"]);
				const nestedLaunchState: NormalizedNestedSpawnTelemetry["launchState"] = explicitLaunchState ?? (
					nestedStartMs !== undefined
						? "started"
						: isPreLaunchConfigurationError(nestedErrorMessage)
							? "not_started"
							: "unknown"
				);
				const nestedFailureKind: NormalizedNestedSpawnTelemetry["failureKind"] = parseFailureKind(rawNested["failureKind"]) ?? (
					nestedState !== "failed"
						? undefined
						: nestedLaunchState === "started"
							? "execution"
							: isPreLaunchConfigurationError(nestedErrorMessage)
								? "pre_launch_configuration"
								: undefined
				);
				let nestedRuntimeMs: number | undefined;
				let nestedInterval: TimeInterval | undefined;
				if (nestedStartMs !== undefined && nestedEndMs !== undefined && nestedEndMs >= nestedStartMs) {
					nestedRuntimeMs = nestedEndMs - nestedStartMs;
					nestedInterval = { startMs: nestedStartMs, endMs: nestedEndMs };
				}

				spawns.push({
					spawnKey: `${groupId}:${nestedIndex}`,
					groupId,
					nestedIndex,
					agent: nestedAgent,
					role: nestedRole,
					model: nestedFailureKind === "pre_launch_configuration" ? "unknown" : nestedModel,
					assignment: nestedAssignment,
					phase: nestedPhase,
					state: nestedState,
					exitCode: nestedExitCode,
					runtimeMs: nestedRuntimeMs,
					interval: nestedInterval,
					usage: nestedUsage,
					launchState: nestedLaunchState,
					failureKind: nestedFailureKind,
				});
			}
		}
	}

	return {
		childKey,
		workflowId,
		index,
		agent,
		role,
		model,
		playbook,
		assignment,
		phase,
		state,
		exitCode,
		runtimeMs,
		interval,
		usage,
		launchState,
		failureKind,
		hasChildResult,
		spawns,
		spawnGroupCount,
	};
}

export function aggregateTelemetry(data: RawTelemetryData): TelemetryReportV2 {
	const { sessions, workflows, bindings } = data;
	const corruptCounts = {
		...data.corruptCounts,
		queueEventFiles: data.corruptCounts.queueEventFiles ?? 0,
	};
	const queueEvents = data.queueEvents ?? [];
	const provenanceCounts: Record<ExecutionProvenance, number> = { production: 0, test: 0, unknown: 0 };
	const launchFailures = {
		preLaunchConfiguration: 0,
		preLaunchOther: 0,
		execution: 0,
		unknown: 0,
	};

	let earliestTimestamp: string | undefined;
	let latestTimestamp: string | undefined;

	const considerTimestamp = (iso?: string) => {
		if (!iso) return;
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return;
		if (earliestTimestamp === undefined || ms < Date.parse(earliestTimestamp)) {
			earliestTimestamp = new Date(ms).toISOString();
		}
		if (latestTimestamp === undefined || ms > Date.parse(latestTimestamp)) {
			latestTimestamp = new Date(ms).toISOString();
		}
	};

	const scannedSessionIds = new Set<string>();
	for (const session of sessions) {
		scannedSessionIds.add(session.sessionId);
		considerTimestamp(session.startedAt);
		considerTimestamp(session.endedAt);
	}

	for (const turn of data.rootTurns ?? []) {
		considerTimestamp(turn.startedAt);
		considerTimestamp(turn.endedAt);
	}

	const rootTurnDurations = (data.rootTurns ?? []).map((t) => t.durationMs);
	const rootTurnLatency = calculateQuantileDistribution(rootTurnDurations);

	const knownWorkflowIds = new Set<string>();
	for (const wf of workflows) {
		knownWorkflowIds.add(wf.workflowId);
	}

	const ticketEvents = new Map<string, Extract<NormalizedQueueEventTelemetry, { kind: "ticket_created" }>>();
	const acquisitionEvents = new Map<string, Extract<NormalizedQueueEventTelemetry, { kind: "slot_acquired" }>>();
	const queueByDepth: Record<string, number> = {};
	const queueByCapacityClass: Record<string, number> = {};
	for (const event of queueEvents) {
		considerTimestamp(event.occurredAt);
		if (event.kind === "ticket_created") {
			ticketEvents.set(event.ticketId, event);
			queueByDepth[String(event.depth)] = (queueByDepth[String(event.depth)] ?? 0) + 1;
			queueByCapacityClass[event.capacityClass] = (queueByCapacityClass[event.capacityClass] ?? 0) + 1;
		} else {
			acquisitionEvents.set(event.ticketId, event);
		}
	}
	const queueWaitTimes: number[] = [];
	let matchedAcquisitions = 0;
	let orphanAcquisitions = 0;
	for (const acquisition of acquisitionEvents.values()) {
		const ticket = ticketEvents.get(acquisition.ticketId);
		if (
			ticket === undefined ||
			ticket.workflowId !== acquisition.workflowId ||
			ticket.childId !== acquisition.childId ||
			ticket.seq !== acquisition.seq
		) {
			orphanAcquisitions += 1;
			continue;
		}
		const waitMs = Date.parse(acquisition.occurredAt) - Date.parse(ticket.occurredAt);
		if (Number.isFinite(waitMs) && waitMs >= 0) queueWaitTimes.push(waitMs);
		matchedAcquisitions += 1;
	}
	const queueEventSummary: QueueEventSummary = {
		ticketCreated: ticketEvents.size,
		slotAcquired: acquisitionEvents.size,
		matchedAcquisitions,
		missingAcquisitions: [...ticketEvents.keys()].filter((id) => !acquisitionEvents.has(id)).length,
		orphanAcquisitions,
		duplicateEventIds: data.duplicateQueueEventIds ?? 0,
		byDepth: queueByDepth,
		byCapacityClass: queueByCapacityClass,
		waitTime: calculateQuantileDistribution(queueWaitTimes),
	};

	// 1. Workflow Selections (counted from top-level owner assignment workflows only)
	let totalTopLevelWorkflows = 0;
	const byPlaybookCount: Record<string, number> = {};
	const byModeCount: Record<string, number> = {};
	const byOutcomeCount: Record<string, number> = {};

	// Workflow outcome reliability across all workflows
	let totalAllWorkflows = 0;
	let succeededWorkflows = 0;
	let failedWorkflows = 0;
	let cancelledWorkflows = 0;
	let uncommittedOrAbandonedWorkflows = 0;
	const outcomeByMode: Record<
		string,
		{
			total: number;
			succeeded: number;
			failed: number;
			cancelled: number;
			uncommittedOrAbandoned: number;
		}
	> = {};

	// Roles and models aggregation (across top-level children AND nested spawns)
	const rolesAndModelsByPlaybook: Record<string, Record<string, Record<string, number>>> = {};
	const rolesAndModelsByRole: Record<string, Record<string, number>> = {};

	// Runtime distributions
	const ownerRuntimes: number[] = [];
	const workerRuntimes: number[] = [];
	const reviewerRuntimes: number[] = [];
	const unassignedRuntimes: number[] = [];
	const allRuntimes: number[] = [];

	// Owner delegation cohorts
	let delegatedOwnerCount = 0;
	const delegatedOwnerRuntimes: number[] = [];
	let nonDelegatedOwnerCount = 0;
	const nonDelegatedOwnerRuntimes: number[] = [];

	// Role & model reliability stats
	type RoleModelStats = {
		role: string;
		resolvedModel: string;
		total: number;
		succeeded: number;
		failed: number;
		abandoned: number;
		repeatedDelegations: number;
	};
	const roleModelMap = new Map<string, RoleModelStats>();

	const recordRoleModel = (
		role: string,
		model: string,
		state: string,
		isWorkflowCommitted: boolean,
		repeatedDelegationContribution: number,
	) => {
		const rmKey = `${role}::${model}`;
		let rmStats = roleModelMap.get(rmKey);
		if (rmStats === undefined) {
			rmStats = {
				role,
				resolvedModel: model,
				total: 0,
				succeeded: 0,
				failed: 0,
				abandoned: 0,
				repeatedDelegations: 0,
			};
			roleModelMap.set(rmKey, rmStats);
		}
		rmStats.total += 1;
		if (state === "succeeded") rmStats.succeeded += 1;
		if (state === "failed") rmStats.failed += 1;
		if (state === "cancelled" || !isWorkflowCommitted) rmStats.abandoned += 1;
		rmStats.repeatedDelegations += repeatedDelegationContribution;
	};

	const directChildCost = (child: NormalizedChildTelemetry): number | undefined => {
		const inclusiveCost = child.usage?.cost;
		if (inclusiveCost === undefined || inclusiveCost < 0) return undefined;
		let descendantCost = 0;
		for (const spawn of child.spawns) {
			const cost = spawn.usage?.cost;
			if (cost === undefined || cost < 0) return undefined;
			descendantCost += cost;
		}
		const directCost = inclusiveCost - descendantCost;
		if (directCost < -1e-9) return undefined;
		return directCost <= 1e-9 ? 0 : Math.round(directCost * 1_000_000) / 1_000_000;
	};

	let lightweightWorkerRuns = 0;
	let lightweightWorkerRunsWithCost = 0;
	let lightweightWorkerDirectCost = 0;
	let ownerRuns = 0;
	let ownerRunsWithCost = 0;
	let ownerDirectCost = 0;

	// Joins tracking
	let totalManifestsWithSession = 0;
	let joinedManifestToSession = 0;
	let totalCommittedWorkflows = 0;
	let joinedCommittedToResultIndex = 0;
	let totalExpectedChildren = 0;
	let joinedManifestToChildResults = 0;

	let totalScannedChildrenCount = 0;

	for (const wf of workflows) {
		considerTimestamp(wf.createdAt);
		provenanceCounts[wf.provenance] += 1;
		totalAllWorkflows += 1;

		// Outcome tracking by mode
		const modeKey = wf.mode;
		const modeStats =
			outcomeByMode[modeKey] ??
			(outcomeByMode[modeKey] = {
				total: 0,
				succeeded: 0,
				failed: 0,
				cancelled: 0,
				uncommittedOrAbandoned: 0,
			});
		modeStats.total += 1;

		if (wf.outcome === "succeeded") {
			succeededWorkflows += 1;
			modeStats.succeeded += 1;
		} else if (wf.outcome === "failed") {
			failedWorkflows += 1;
			modeStats.failed += 1;
		} else if (wf.outcome === "cancelled") {
			cancelledWorkflows += 1;
			modeStats.cancelled += 1;
		} else {
			uncommittedOrAbandonedWorkflows += 1;
			modeStats.uncommittedOrAbandoned += 1;
		}

		// Count workflow selection frequency ONLY from top-level owner assignment workflows
		if (wf.isTopLevelOwnerWorkflow) {
			totalTopLevelWorkflows += 1;
			byPlaybookCount[wf.playbook] = (byPlaybookCount[wf.playbook] ?? 0) + 1;
			byModeCount[wf.mode] = (byModeCount[wf.mode] ?? 0) + 1;
			byOutcomeCount[wf.outcome] = (byOutcomeCount[wf.outcome] ?? 0) + 1;
		}

		// Join tracking: manifest -> session
		if (wf.sessionId !== undefined) {
			totalManifestsWithSession += 1;
			if (scannedSessionIds.has(wf.sessionId)) {
				joinedManifestToSession += 1;
			}
		}

		// Join tracking: committed -> result-index
		if (wf.committed) {
			totalCommittedWorkflows += 1;
			if (wf.hasResultIndex) {
				joinedCommittedToResultIndex += 1;
			}
		}

		for (const child of wf.children) {
			totalScannedChildrenCount += 1;
			if (child.state === "failed") {
				if (child.failureKind === "pre_launch_configuration") launchFailures.preLaunchConfiguration += 1;
				else if (child.failureKind === "pre_launch_other") launchFailures.preLaunchOther += 1;
				else if (child.failureKind === "execution") launchFailures.execution += 1;
				else launchFailures.unknown += 1;
			}

			// Join tracking: manifest -> child result
			totalExpectedChildren += 1;
			if (child.hasChildResult) {
				joinedManifestToChildResults += 1;
			}

			if (child.interval) {
				considerTimestamp(new Date(child.interval.startMs).toISOString());
				considerTimestamp(new Date(child.interval.endMs).toISOString());
			}

			// Roles and models by playbook
			const pbObj = rolesAndModelsByPlaybook[child.playbook] ?? (rolesAndModelsByPlaybook[child.playbook] = {});
			const roleObj = pbObj[child.role] ?? (pbObj[child.role] = {});
			roleObj[child.model] = (roleObj[child.model] ?? 0) + 1;

			const globalRoleObj = rolesAndModelsByRole[child.role] ?? (rolesAndModelsByRole[child.role] = {});
			globalRoleObj[child.model] = (globalRoleObj[child.model] ?? 0) + 1;

			// Runtimes
			if (child.runtimeMs !== undefined && child.runtimeMs >= 0) {
				allRuntimes.push(child.runtimeMs);
				if (child.assignment === "owner") ownerRuntimes.push(child.runtimeMs);
				else if (child.assignment === "worker") workerRuntimes.push(child.runtimeMs);
				else if (child.assignment === "reviewer") reviewerRuntimes.push(child.runtimeMs);
				else unassignedRuntimes.push(child.runtimeMs);
			}

			// Owner delegation cohorts
			if (child.assignment === "owner") {
				const hasDelegated = child.spawns.length > 0 || child.spawnGroupCount > 0;
				if (hasDelegated) {
					delegatedOwnerCount += 1;
					if (child.runtimeMs !== undefined && child.runtimeMs >= 0) {
						delegatedOwnerRuntimes.push(child.runtimeMs);
					}
				} else {
					nonDelegatedOwnerCount += 1;
					if (child.runtimeMs !== undefined && child.runtimeMs >= 0) {
						nonDelegatedOwnerRuntimes.push(child.runtimeMs);
					}
				}
			}

			const childCost = directChildCost(child);
			if (child.assignment === "owner") {
				ownerRuns += 1;
				if (childCost !== undefined) {
					ownerRunsWithCost += 1;
					ownerDirectCost += childCost;
				}
			} else if (child.assignment === "worker") {
				lightweightWorkerRuns += 1;
				if (childCost !== undefined) {
					lightweightWorkerRunsWithCost += 1;
					lightweightWorkerDirectCost += childCost;
				}
			}

			if (child.launchState === "started" && child.model !== "unknown" && child.model !== "unresolved") {
				recordRoleModel(child.role, child.model, child.state, wf.committed, 0);
			}

			// Process nested spawns
			// Conservative observable repeated delegation: count if owner issued repeated nested delegation batches
			const isRepeatedBatch = child.spawnGroupCount > 1;
			for (const spawn of child.spawns) {
				totalScannedChildrenCount += 1;
				if (spawn.state === "failed") {
					if (spawn.failureKind === "pre_launch_configuration") launchFailures.preLaunchConfiguration += 1;
					else if (spawn.failureKind === "pre_launch_other") launchFailures.preLaunchOther += 1;
					else if (spawn.failureKind === "execution") launchFailures.execution += 1;
					else launchFailures.unknown += 1;
				}

				if (spawn.interval) {
					considerTimestamp(new Date(spawn.interval.startMs).toISOString());
					considerTimestamp(new Date(spawn.interval.endMs).toISOString());
				}

				// Roles & Models for nested spawn
				const spPbObj = rolesAndModelsByPlaybook[child.playbook] ?? (rolesAndModelsByPlaybook[child.playbook] = {});
				const spRoleObj = spPbObj[spawn.role] ?? (spPbObj[spawn.role] = {});
				spRoleObj[spawn.model] = (spRoleObj[spawn.model] ?? 0) + 1;

				const spGlobalRoleObj = rolesAndModelsByRole[spawn.role] ?? (rolesAndModelsByRole[spawn.role] = {});
				spGlobalRoleObj[spawn.model] = (spGlobalRoleObj[spawn.model] ?? 0) + 1;

				// Runtime distributions for nested spawn
				if (spawn.runtimeMs !== undefined && spawn.runtimeMs >= 0) {
					allRuntimes.push(spawn.runtimeMs);
					if (spawn.assignment === "worker") workerRuntimes.push(spawn.runtimeMs);
					else if (spawn.assignment === "reviewer") reviewerRuntimes.push(spawn.runtimeMs);
					else if (spawn.assignment === "owner") ownerRuntimes.push(spawn.runtimeMs);
					else unassignedRuntimes.push(spawn.runtimeMs);
				}

				// Costs for nested spawn
				const spawnCost = spawn.usage?.cost;
				if (spawn.assignment === "worker") {
					lightweightWorkerRuns += 1;
					if (spawnCost !== undefined && spawnCost >= 0) {
						lightweightWorkerRunsWithCost += 1;
						lightweightWorkerDirectCost += spawnCost;
					}
				} else if (spawn.assignment === "owner") {
					ownerRuns += 1;
					if (spawnCost !== undefined && spawnCost >= 0) {
						ownerRunsWithCost += 1;
						ownerDirectCost += spawnCost;
					}
				}

				if (spawn.launchState === "started" && spawn.model !== "unknown" && spawn.model !== "unresolved") {
					recordRoleModel(spawn.role, spawn.model, spawn.state, wf.committed, isRepeatedBatch ? 1 : 0);
				}
			}
		}
	}

	// Join tracking: bindings -> workflows
	const totalBindings = bindings.length;
	let joinedBindingsToWorkflows = 0;
	for (const binding of bindings) {
		if (knownWorkflowIds.has(binding.workflowId)) {
			joinedBindingsToWorkflows += 1;
		}
	}

	// Role & Model reliability array
	const roleModelReliability: RoleModelAssociation[] = Array.from(roleModelMap.values())
		.map((stats) => ({
			role: stats.role,
			resolvedModel: stats.resolvedModel,
			totalInvocations: stats.total,
			succeededCount: stats.succeeded,
			failedCount: stats.failed,
			abandonedCount: stats.abandoned,
			observableRepeatedDelegationCount: stats.repeatedDelegations,
			failureRate: stats.total > 0 ? stats.failed / stats.total : 0,
		}))
		.sort((a, b) => b.totalInvocations - a.totalInvocations || a.role.localeCompare(b.role));

	const ownerAverageCostPerRun = ownerRunsWithCost > 0 ? ownerDirectCost / ownerRunsWithCost : null;
	const lightweightWorkerAverageCostPerRun =
		lightweightWorkerRunsWithCost > 0 ? lightweightWorkerDirectCost / lightweightWorkerRunsWithCost : null;

	let directCostIsLower: boolean | "unsupported_due_to_missing_cost_data" = "unsupported_due_to_missing_cost_data";
	let costSavingsRatio: number | null = null;
	let workerEconomicsNote: string;

	if (ownerAverageCostPerRun === null || lightweightWorkerAverageCostPerRun === null) {
		directCostIsLower = "unsupported_due_to_missing_cost_data";
		workerEconomicsNote =
			"Token cost figures are not reported by the model provider or local harness; economic comparisons cannot be derived.";
	} else {
		directCostIsLower = lightweightWorkerAverageCostPerRun < ownerAverageCostPerRun;
		costSavingsRatio =
			ownerAverageCostPerRun > 0
				? (ownerAverageCostPerRun - lightweightWorkerAverageCostPerRun) / ownerAverageCostPerRun
				: null;
		workerEconomicsNote = `Direct lightweight worker average cost per run ($${lightweightWorkerAverageCostPerRun.toFixed(4)}) vs owner direct average ($${ownerAverageCostPerRun.toFixed(4)}). Post-worker owner rework cost cannot be attributed from metadata alone; after-rework economics are unsupported.`;
	}

	// Data Join Reliability
	const manifestToSessionJoinRate =
		totalManifestsWithSession > 0 ? joinedManifestToSession / totalManifestsWithSession : null;
	const committedToResultIndexJoinRate =
		totalCommittedWorkflows > 0 ? joinedCommittedToResultIndex / totalCommittedWorkflows : null;
	const manifestToChildResultsJoinRate =
		totalExpectedChildren > 0 ? joinedManifestToChildResults / totalExpectedChildren : null;
	const bindingsToWorkflowsJoinRate =
		totalBindings > 0 ? joinedBindingsToWorkflows / totalBindings : null;
	const joinedQueueEventsToWorkflows = queueEvents.filter((event) => knownWorkflowIds.has(event.workflowId)).length;
	const queueEventsToWorkflowsJoinRate =
		queueEvents.length > 0 ? joinedQueueEventsToWorkflows / queueEvents.length : null;

	const totalJoinsAttempted =
		totalManifestsWithSession + totalCommittedWorkflows + totalExpectedChildren + totalBindings + queueEvents.length;
	const totalJoinsSuccessful =
		joinedManifestToSession + joinedCommittedToResultIndex + joinedManifestToChildResults + joinedBindingsToWorkflows + joinedQueueEventsToWorkflows;
	const overallJoinRate = totalJoinsAttempted > 0 ? totalJoinsSuccessful / totalJoinsAttempted : null;

	const dataJoinReliability: DataJoinReliability = {
		manifestToSession: {
			total: totalManifestsWithSession,
			joined: joinedManifestToSession,
			missingSession: totalManifestsWithSession - joinedManifestToSession,
			joinRate: manifestToSessionJoinRate,
		},
		committedToResultIndex: {
			totalCommitted: totalCommittedWorkflows,
			joined: joinedCommittedToResultIndex,
			missingResultIndex: totalCommittedWorkflows - joinedCommittedToResultIndex,
			joinRate: committedToResultIndexJoinRate,
		},
		manifestToChildResults: {
			totalExpectedChildren,
			joinedChildResults: joinedManifestToChildResults,
			missingChildResults: totalExpectedChildren - joinedManifestToChildResults,
			joinRate: manifestToChildResultsJoinRate,
		},
		bindingsToWorkflows: {
			totalBindings,
			joined: joinedBindingsToWorkflows,
			danglingBindings: totalBindings - joinedBindingsToWorkflows,
			joinRate: bindingsToWorkflowsJoinRate,
		},
		queueEventsToWorkflows: {
			totalEvents: queueEvents.length,
			joined: joinedQueueEventsToWorkflows,
			danglingEvents: queueEvents.length - joinedQueueEventsToWorkflows,
			joinRate: queueEventsToWorkflowsJoinRate,
		},
		totalJoinsAttempted,
		totalJoinsSuccessful,
		overallJoinRate,
	};

	// Workflow outcome reliability
	const formattedOutcomeByMode: Record<
		string,
		{
			total: number;
			succeeded: number;
			failed: number;
			cancelled: number;
			uncommittedOrAbandoned: number;
			successRate: number | null;
		}
	> = {};
	for (const [m, stats] of Object.entries(outcomeByMode)) {
		formattedOutcomeByMode[m] = {
			...stats,
			successRate: stats.total > 0 ? stats.succeeded / stats.total : null,
		};
	}

	const workflowOutcomeReliability: WorkflowOutcomeReliability = {
		totalWorkflows: totalAllWorkflows,
		succeeded: succeededWorkflows,
		failed: failedWorkflows,
		cancelled: cancelledWorkflows,
		uncommittedOrAbandoned: uncommittedOrAbandonedWorkflows,
		successRate: totalAllWorkflows > 0 ? succeededWorkflows / totalAllWorkflows : null,
		byMode: formattedOutcomeByMode,
	};

	const recoverableMetrics = [
		"Workflow selection counts partitioned by playbook, mode, and completion outcome for top-level owner workflows",
		"Role and resolved model frequency mappings nested by playbook and aggregate across top-level and nested spawns",
		"Completed root-turn wall-clock latency from user input receipt through final settlement",
		"Runtime distributions with quantiles (min, median, p75, p90, p95, p99, max) partitioned by assignment role",
		"Observational delegated-owner versus non-delegated-owner runtime cohorts",
		"Observational associations between role/model pairs and failures, abandonment, and repeated delegation",
		"Direct worker economics comparing lightweight worker direct cost against owner direct cost",
		"Data join reliability between workflow manifests, committed results, child results, bindings, queue events, and Pi session IDs",
		"Durable scheduler ticket creation, slot acquisition, and queue wait distributions",
		"Production, test, and unknown workflow provenance with test runs excluded by default",
		"Pre-launch configuration, other pre-launch, execution, and unknown failure classification",
	];

	const missingOrUnsupportedMetrics: MetricLimitation[] = [
		{
			metric: "delegation_causality",
			reason:
				"Observational runtime cohorts compare different tasks with varying complexity and instructions.",
			explicitLimitation:
				"Do not interpret runtime differences between delegated and non-delegated owners as causal benchmarks for delegation efficiency.",
		},
		{
			metric: "retries_and_abandonment_intent",
			reason:
				"Repeated roles or phases within parallel/chain steps and uncommitted workflows cannot be proven as error retries or deliberate abandonment without explicit intent markers.",
			explicitLimitation:
				"Retries and abandonment intent are unsupported; only observable repeated delegation is reported.",
		},
		{
			metric: "after_rework_worker_economics",
			reason:
				"Post-worker owner incremental cost and rework time cannot be attributed or separated from routine task synthesis from metadata alone.",
			explicitLimitation:
				"After-rework economics are unsupported; only direct worker vs owner costs are reported without double-counting failure costs.",
		},
		{
			metric: "token_costs_when_unreported",
			reason: "Local runners or zero-cost providers do not emit cost telemetry.",
			explicitLimitation: "Economic evaluation flags 'unsupported_due_to_missing_cost_data' when cost metrics are absent.",
		},
		{
			metric: "legacy_provenance",
			reason: "Older workflow manifests lack explicit provenance. Known fixture model providers are classified as tests; all other legacy records remain unknown.",
			explicitLimitation:
				"Unknown legacy records remain included by default because excluding them would hide real historical production runs.",
		},
		{
			metric: "top_level_pre_launch_failures",
			reason: "Top-level role and agent configuration errors occur before a workflow manifest is sealed.",
			explicitLimitation: "Only persisted nested pre-launch failures can be counted from historical artifacts.",
		},
	];

	return {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		reportPeriod: {
			earliestTimestamp,
			latestTimestamp,
		},
		workflowSelections: {
			totalWorkflows: totalTopLevelWorkflows,
			byPlaybook: byPlaybookCount,
			byMode: byModeCount,
			byOutcome: byOutcomeCount,
		},
		rolesAndModels: {
			byPlaybook: rolesAndModelsByPlaybook,
			byRole: rolesAndModelsByRole,
		},
		runtimeDistributions: {
			owner: calculateQuantileDistribution(ownerRuntimes),
			worker: calculateQuantileDistribution(workerRuntimes),
			reviewer: calculateQuantileDistribution(reviewerRuntimes),
			unassigned: calculateQuantileDistribution(unassignedRuntimes),
			all: calculateQuantileDistribution(allRuntimes),
		},
		rootTurnLatency,
		ownerDelegationCohorts: {
			delegatedOwners: {
				count: delegatedOwnerCount,
				runtime: calculateQuantileDistribution(delegatedOwnerRuntimes),
			},
			nonDelegatedOwners: {
				count: nonDelegatedOwnerCount,
				runtime: calculateQuantileDistribution(nonDelegatedOwnerRuntimes),
			},
			causalityLimitation:
				"Observational runtime comparison between delegated and non-delegated owners cannot establish delegation causality because tasks differ in complexity and scope.",
		},
		provenance: {
			includedWorkflows: workflows.length,
			excludedTestWorkflows: data.excludedTestWorkflows ?? 0,
			byProvenance: provenanceCounts,
		},
		launchFailures,
		roleModelReliability,
		workerEconomics: {
			lightweightWorkerRuns,
			lightweightWorkerRunsWithCost,
			lightweightWorkerDirectCost,
			ownerRuns,
			ownerRunsWithCost,
			ownerDirectCost,
			ownerAverageCostPerRun,
			lightweightWorkerAverageCostPerRun,
			directCostIsLower,
			costSavingsRatio,
			afterReworkEconomicsSupported: false,
			evaluationNote: workerEconomicsNote,
		},
		queueEvents: queueEventSummary,
		dataJoinReliability,
		workflowOutcomeReliability,
		recoverableAndMissingMetrics: {
			scannedSessions: sessions.length,
			scannedWorkflows: totalAllWorkflows,
			scannedChildren: totalScannedChildrenCount,
			corruptOrUnparseableRecords: corruptCounts,
			recoverableMetrics,
			missingOrUnsupportedMetrics,
		},
	};
}

export async function collectTelemetryData(options?: TelemetryCollectOptions): Promise<TelemetryReportV2> {
	const backgroundRoot = options?.backgroundRoot ?? defaultBackgroundRoot();
	const sessionsDir = options?.sessionsDir ?? defaultSessionsDir();

	const corruptCounts = {
		sessionFiles: 0,
		manifestFiles: 0,
		resultIndexFiles: 0,
		childResultFiles: 0,
		spawnRecordFiles: 0,
		bindingFiles: 0,
		queueEventFiles: 0,
	};

	const [{ sessions, rootTurns }, { workflows, bindings, queueEvents, duplicateQueueEventIds }] = await Promise.all([
		scanSessions(sessionsDir, corruptCounts),
		scanBackgroundArtifacts(backgroundRoot, corruptCounts),
	]);

	const fromMs = options?.timeWindow?.from ? parseDateMs(options.timeWindow.from) : undefined;
	const toMs = options?.timeWindow?.to ? parseDateMs(options.timeWindow.to) : undefined;

	let filteredSessions = sessions;
	let filteredRootTurns = rootTurns;
	let filteredWorkflows = workflows;
	let filteredQueueEvents = queueEvents;
	let filteredBindings = bindings;

	if (fromMs !== undefined || toMs !== undefined) {
		filteredSessions = sessions.filter((s) => {
			if (!s.interval) return true;
			if (fromMs !== undefined && s.interval.endMs < fromMs) return false;
			if (toMs !== undefined && s.interval.startMs > toMs) return false;
			return true;
		});

		filteredRootTurns = rootTurns.filter((turn) => {
			const ms = parseDateMs(turn.startedAt);
			if (ms === undefined) return false;
			if (fromMs !== undefined && ms < fromMs) return false;
			if (toMs !== undefined && ms > toMs) return false;
			return true;
		});

		filteredWorkflows = workflows.filter((w) => {
			if (!w.createdAt) return true;
			const ms = parseDateMs(w.createdAt);
			if (ms === undefined) return true;
			if (fromMs !== undefined && ms < fromMs) return false;
			if (toMs !== undefined && ms > toMs) return false;
			return true;
		});
		filteredQueueEvents = queueEvents.filter((event) => {
			const ms = parseDateMs(event.occurredAt);
			if (ms === undefined) return false;
			if (fromMs !== undefined && ms < fromMs) return false;
			if (toMs !== undefined && ms > toMs) return false;
			return true;
		});
		const filteredWorkflowIds = new Set(filteredWorkflows.map((workflow) => workflow.workflowId));
		filteredBindings = bindings.filter((binding) => filteredWorkflowIds.has(binding.workflowId));
	}

	const excludedTestWorkflows = options?.includeTests ? 0 : filteredWorkflows.filter((workflow) => workflow.provenance === "test").length;
	if (!options?.includeTests) {
		filteredRootTurns = filteredRootTurns.filter((turn) => turn.provenance !== "test");
		filteredWorkflows = filteredWorkflows.filter((workflow) => workflow.provenance !== "test");
		const includedWorkflowIds = new Set(filteredWorkflows.map((workflow) => workflow.workflowId));
		filteredBindings = filteredBindings.filter((binding) => includedWorkflowIds.has(binding.workflowId));
		filteredQueueEvents = filteredQueueEvents.filter((event) => includedWorkflowIds.has(event.workflowId));
	}

	return aggregateTelemetry({
		sessions: filteredSessions,
		workflows: filteredWorkflows,
		bindings: filteredBindings,
		rootTurns: filteredRootTurns,
		queueEvents: filteredQueueEvents,
		duplicateQueueEventIds,
		excludedTestWorkflows,
		corruptCounts,
	});
}
