import type { Stats } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	buildTreeSnapshot,
	formatElapsed,
	formatGroupLabel,
	groupNestedChildren,
	isLeaseSnapshot,
	nestedChildDetail,
	parseActivityV1,
	parseChildUsage,
	parseManifestForTree,
	parseWorkflowContext,
	taskPreviewOf,
	type BuildTreeSnapshotInput,
	type NestedChild,
	type NestedGroup,
	type SessionRefCache,
	type SpawnNestedChild,
	type TreeChild,
	type TreeChildState,
	type TreeSnapshot,
	type TreeTheme,
} from "./tree.ts";
import { formatRecentActivity, type SemanticStatus } from "./journal.ts";
import type { OutputArtifactSeal } from "./artifacts.ts";
import {
	createSessionTailState,
	tailSessionFile,
	type ChildSessionRefV1,
	type SessionTailRecord,
	type SessionTailState,
} from "./session.ts";
import { snapshotActiveLeases, type LeaseSnapshot } from "./scheduler.ts";
import { sessionRoot } from "./launch.ts";
import { todoFilePath } from "../todo.ts";
import type { TodoItem, WorkflowContext } from "../types.ts";
import type { ChildUsage } from "../spawn.ts";

const STATUS_INTERVAL_MS = 1000;
const DETAIL_TAIL_BYTES = 128 * 1024;
const DEFAULT_FALLBACK_ROWS = 26;

export type InspectorLayoutMetrics = Readonly<{
	terminalRows: number;
	frameHeight: number;
	bodyRows: number;
	listVisibleRows: number;
	summaryVisibleRows: number;
	taskVisibleRows: number;
	finalVisibleRows: number;
	rawVisibleRows: number;
}>;

export function deriveInspectorLayoutMetrics(terminalRows?: number): InspectorLayoutMetrics {
	if (typeof terminalRows !== "number" || !Number.isFinite(terminalRows)) {
		return {
			terminalRows: DEFAULT_FALLBACK_ROWS,
			frameHeight: 23,
			bodyRows: 16,
			listVisibleRows: 14,
			summaryVisibleRows: 14,
			taskVisibleRows: 14,
			finalVisibleRows: 12,
			rawVisibleRows: 12,
		};
	}

	const effectiveTerminalRows = Math.max(8, Math.floor(terminalRows));
	const frameHeight = Math.max(8, Math.floor(effectiveTerminalRows * 0.9));
	const bodyRows = Math.max(1, frameHeight - 7);
	const listVisibleRows = Math.max(1, bodyRows - 2);
	const summaryVisibleRows = Math.max(1, bodyRows - 2);
	const taskVisibleRows = Math.max(1, bodyRows - 3);
	const finalVisibleRows = Math.max(1, bodyRows - 4);
	const rawVisibleRows = Math.max(1, bodyRows - 4);

	return {
		terminalRows: effectiveTerminalRows,
		frameHeight,
		bodyRows,
		listVisibleRows,
		summaryVisibleRows,
		taskVisibleRows,
		finalVisibleRows,
		rawVisibleRows,
	};
}

const LIGHT_BLUE_BG = "\x1b[48;2;183;223;255m";
const LIGHT_BLUE_FG = "\x1b[38;2;11;70;110m";
const LIGHT_BLUE_BORDER = "\x1b[38;2;83;160;215m";
const ANSI_RESET = "\x1b[0m";

function padAnsi(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function lightBlue(value: string): string {
	return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function blueBorder(value: string): string {
	return `${LIGHT_BLUE_BORDER}${value}${ANSI_RESET}`;
}

type WheelDirection = -1 | 1;

function parseWheelDirection(data: string): WheelDirection | undefined {
	const sgrMatch = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgrMatch !== null) {
		const button = Number.parseInt(sgrMatch[1] ?? "", 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		return direction === 0 ? -1 : direction === 1 ? 1 : undefined;
	}

	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTreeChildState(value: unknown): value is TreeChildState {
	return typeof value === "string" && VALID_CHILD_STATES.has(value);
}

function isSealedOutputState(value: unknown): value is SealedResultOutput["state"] {
	return value === "succeeded" || value === "failed" || value === "cancelled" || value === "skipped";
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function wrapText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [text];
	const rawLines = text.replace(/\r/g, "").split("\n");
	const result: string[] = [];

	for (const rawLine of rawLines) {
		if (rawLine.length === 0) {
			result.push("");
			continue;
		}

		let remaining = rawLine;
		while (visibleWidth(remaining) > maxWidth) {
			let splitIdx = maxWidth;
			const spaceIdx = remaining.lastIndexOf(" ", maxWidth);
			if (spaceIdx > 0 && spaceIdx >= Math.floor(maxWidth * 0.3)) {
				splitIdx = spaceIdx;
				result.push(remaining.slice(0, splitIdx));
				remaining = remaining.slice(splitIdx + 1);
			} else {
				result.push(remaining.slice(0, maxWidth));
				remaining = remaining.slice(maxWidth);
			}
		}
		if (remaining.length > 0) {
			result.push(remaining);
		}
	}

	return result;
}

export type BoundedReadResult = Readonly<{
	content: string;
	truncated: boolean;
	bytesRead: number;
	totalBytes: number;
}>;

export async function boundedTailRead(
	filePath: string,
	maxBytes = DETAIL_TAIL_BYTES,
): Promise<BoundedReadResult> {
	const stats = await stat(filePath);
	const totalBytes = stats.size;
	const bytesToRead = Math.min(totalBytes, maxBytes);
	if (bytesToRead === 0) {
		return { content: "", truncated: false, bytesRead: 0, totalBytes };
	}
	const file = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		const position = Math.max(0, totalBytes - bytesToRead);
		const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
		return {
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: totalBytes > bytesRead,
			bytesRead,
			totalBytes,
		};
	} finally {
		await file.close();
	}
}

export type WorkflowManifestState =
	| Readonly<{ kind: "pending" }>
	| Readonly<{ kind: "corrupt" }>
	| Readonly<{ kind: "ok"; createdAt: string; playbook?: string }>;

export type WorkflowSummary = Readonly<{
	workflowId: string;
	taskId: string;
	artifactDir: string;
	schedulerRoot: string;
	committed: boolean;
	createdAt: string;
	playbook?: string;
	manifest: WorkflowManifestState;
}>;

type BindingFile = Readonly<{ taskId: string; workflowId: string }>;

function parseBindingFile(raw: unknown): BindingFile | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.taskId !== "string" || raw.taskId === "") return undefined;
	if (typeof raw.workflowId !== "string" || raw.workflowId === "") return undefined;
	return { taskId: raw.taskId, workflowId: raw.workflowId };
}

export type DirectoryToken = Readonly<{
	dev: number;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
}>;

function directoryTokenOf(stats: { dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number }): DirectoryToken {
	return {
		dev: stats.dev,
		ino: stats.ino,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		size: stats.size,
	};
}

function directoryTokenMatches(a?: DirectoryToken, b?: DirectoryToken): boolean {
	if (a === undefined || b === undefined) return false;
	return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
}

export type WorkflowListCache = {
	readonly bindings: Map<string, string>;
	readonly summaries: Map<string, WorkflowSummary>;
	bindingsDirToken?: DirectoryToken;
	workflowsDirToken?: DirectoryToken;
	workflowIds?: readonly string[];
};

export function createWorkflowListCache(): WorkflowListCache {
	return {
		bindings: new Map(),
		summaries: new Map(),
	};
}

const defaultSessionWorkflowCaches = new Map<string, WorkflowListCache>();

export function getSessionWorkflowCache(sessionId: string): WorkflowListCache {
	let cache = defaultSessionWorkflowCaches.get(sessionId);
	if (cache === undefined) {
		if (defaultSessionWorkflowCaches.size >= 32) {
			const oldest = defaultSessionWorkflowCaches.keys().next().value;
			if (oldest !== undefined) defaultSessionWorkflowCaches.delete(oldest);
		}
		cache = createWorkflowListCache();
		defaultSessionWorkflowCaches.set(sessionId, cache);
	}
	return cache;
}

export function resetWorkflowListCache(sessionId?: string): void {
	if (sessionId !== undefined) {
		defaultSessionWorkflowCaches.delete(sessionId);
	} else {
		defaultSessionWorkflowCaches.clear();
	}
}

export type ListSessionWorkflowsIO = Readonly<{
	stat?: (path: string) => Promise<Stats>;
	readdir?: (path: string) => Promise<string[]>;
	readFile?: (path: string, encoding: "utf8") => Promise<string>;
}>;

export async function listSessionWorkflows(
	sessionId: string,
	cache?: WorkflowListCache,
	io: ListSessionWorkflowsIO = {},
): Promise<WorkflowSummary[]> {
	const effectiveStat = io.stat ?? ((path: string) => stat(path));
	const effectiveReaddir = io.readdir ?? ((path: string) => readdir(path));
	const effectiveReadFile = io.readFile ?? ((path: string, encoding: "utf8") => readFile(path, encoding));

	const effectiveCache = cache ?? getSessionWorkflowCache(sessionId);
	const root = sessionRoot(sessionId);
	const workflowsDir = join(root, "workflows");
	const bindingsDir = join(root, "bindings");
	const schedulerRoot = join(root, "scheduler");

	try {
		const bindingsStats = await effectiveStat(bindingsDir);
		const currentToken = directoryTokenOf(bindingsStats);
		if (!directoryTokenMatches(effectiveCache.bindingsDirToken, currentToken)) {
			const bindingEntries = await effectiveReaddir(bindingsDir);
			for (const entry of bindingEntries) {
				if (!entry.endsWith(".json")) continue;
				if (effectiveCache.bindings.has(entry)) continue;
				try {
					const content = await effectiveReadFile(join(bindingsDir, entry), "utf8");
					const binding = parseBindingFile(JSON.parse(content));
					if (binding !== undefined) {
						effectiveCache.bindings.set(entry, binding.taskId);
						effectiveCache.bindings.set(`wf:${binding.workflowId}`, binding.taskId);
					}
				} catch {}
			}
			effectiveCache.bindingsDirToken = currentToken;
		}
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			effectiveCache.bindingsDirToken = undefined;
		} else {
			throw error;
		}
	}

	let workflowEntries: readonly string[];
	try {
		const workflowsStats = await effectiveStat(workflowsDir);
		const currentWorkflowsToken = directoryTokenOf(workflowsStats);
		if (!directoryTokenMatches(effectiveCache.workflowsDirToken, currentWorkflowsToken) || effectiveCache.workflowIds === undefined) {
			const rawEntries = await effectiveReaddir(workflowsDir);
			workflowEntries = rawEntries;
			effectiveCache.workflowIds = rawEntries;
			effectiveCache.workflowsDirToken = currentWorkflowsToken;

			const activeWorkflowIds = new Set(workflowEntries);
			for (const cachedId of Array.from(effectiveCache.summaries.keys())) {
				if (!activeWorkflowIds.has(cachedId)) {
					effectiveCache.summaries.delete(cachedId);
				}
			}
		} else {
			workflowEntries = effectiveCache.workflowIds;
		}
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			effectiveCache.workflowsDirToken = undefined;
			effectiveCache.workflowIds = undefined;
			effectiveCache.summaries.clear();
			return [];
		}
		throw error;
	}

	const summaries: WorkflowSummary[] = [];
	for (const wfId of workflowEntries) {
		const artifactDir = join(workflowsDir, wfId);
		const cached = effectiveCache.summaries.get(wfId);

		if (cached !== undefined && cached.committed) {
			const taskId = effectiveCache.bindings.get(`wf:${wfId}`) ?? wfId;
			const current = cached.taskId === taskId ? cached : { ...cached, taskId };
			if (current !== cached) effectiveCache.summaries.set(wfId, current);
			summaries.push(current);
			continue;
		}

		let committed = false;
		try {
			await effectiveStat(join(artifactDir, "COMMITTED"));
			committed = true;
		} catch {
			committed = false;
		}

		let createdAt = cached?.createdAt ?? "";
		let playbook: string | undefined = cached?.playbook;
		let manifest: WorkflowManifestState = cached?.manifest ?? { kind: "pending" };

		if (cached === undefined || cached.manifest.kind !== "ok") {
			try {
				const manifestBytes = await effectiveReadFile(join(artifactDir, "manifest.json"), "utf8");
				try {
					const parsed = parseManifestForTree(JSON.parse(manifestBytes));
					if (parsed !== undefined) {
						createdAt = parsed.createdAt;
						playbook = parsed.specs[0]?.playbook;
						manifest = { kind: "ok", createdAt, playbook };
					} else {
						manifest = { kind: "corrupt" };
					}
				} catch {
					manifest = { kind: "corrupt" };
				}
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) {
					manifest = { kind: "pending" };
				} else {
					manifest = { kind: "corrupt" };
				}
			}

			if (createdAt === "") {
				try {
					const dirStat = await effectiveStat(artifactDir);
					createdAt = dirStat.mtime.toISOString();
				} catch {
					createdAt = new Date().toISOString();
				}
			}
		}

		const taskId = effectiveCache.bindings.get(`wf:${wfId}`) ?? wfId;
		const summary: WorkflowSummary = {
			workflowId: wfId,
			taskId,
			artifactDir,
			schedulerRoot,
			committed,
			createdAt,
			playbook,
			manifest,
		};

		effectiveCache.summaries.set(wfId, summary);
		summaries.push(summary);
	}

	return summaries.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export type ChildResultDetails = Readonly<{
	state?: TreeChildState;
	startedAt?: string;
	endedAt?: string;
	model?: string;
	turns?: number;
	contextTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
	stopReason?: string;
	errorMessage?: string;
	summaryText?: string;
	exitCode?: number;
	stderr?: string;
	outputSeal?: OutputArtifactSeal;
	resultSeal?: OutputArtifactSeal;
	usage?: ChildUsage;
}>;

const VALID_CHILD_STATES = new Set<string>(["succeeded", "failed", "cancelled", "skipped", "running", "queued"]);

export function parseChildResultDetails(raw: unknown): ChildResultDetails | undefined {
	if (!isRecord(raw)) return undefined;
	const result = raw.result;
	if (!isRecord(result)) return undefined;

	let turns: number | undefined;
	let contextTokens: number | undefined;
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;
	let cost: number | undefined;

	let usage: ChildUsage | undefined;
	if (isRecord(result.usage)) {
		usage = parseChildUsage(result.usage);
		if (usage !== undefined) {
			turns = usage.turns;
			contextTokens = usage.contextTokens;
			inputTokens = usage.input;
			outputTokens = usage.output;
			cost = usage.cost;
		}
	}

	let outputSeal: OutputArtifactSeal | undefined;
	if (isRecord(raw.output)) {
		const o = raw.output;
		if (typeof o.path === "string" && typeof o.sha256 === "string" && typeof o.bytes === "number") {
			outputSeal = {
				path: o.path,
				sha256: o.sha256,
				bytes: o.bytes,
			};
		}
	}

	let resultSeal: OutputArtifactSeal | undefined;
	if (isRecord(raw.resultSeal)) {
		const rs = raw.resultSeal;
		if (typeof rs.path === "string" && typeof rs.sha256 === "string" && typeof rs.bytes === "number") {
			resultSeal = {
				path: rs.path,
				sha256: rs.sha256,
				bytes: rs.bytes,
			};
		}
	}

	const state = isTreeChildState(raw.state) ? raw.state : undefined;

	return {
		state,
		startedAt: typeof raw.startedAt === "string" && raw.startedAt !== "" ? raw.startedAt : undefined,
		endedAt: typeof raw.endedAt === "string" && raw.endedAt !== "" ? raw.endedAt : undefined,
		model: typeof result.model === "string" && result.model !== "" ? result.model : undefined,
		turns,
		contextTokens,
		inputTokens,
		outputTokens,
		cost,
		stopReason: typeof result.stopReason === "string" && result.stopReason !== "" ? result.stopReason : undefined,
		errorMessage: typeof result.errorMessage === "string" && result.errorMessage !== "" ? result.errorMessage : undefined,
		summaryText: typeof result.text === "string" && result.text !== "" ? result.text : undefined,
		exitCode: typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? result.exitCode : undefined,
		stderr: typeof result.stderr === "string" && result.stderr !== "" ? result.stderr : undefined,
		outputSeal,
		resultSeal,
		usage,
	};
}

export async function readChildResultDetails(
	artifactDir: string,
	childIndex: number,
): Promise<ChildResultDetails | undefined> {
	const resultPath = join(artifactDir, "children", String(childIndex), "result.json");
	try {
		const content = await readFile(resultPath, "utf8");
		return parseChildResultDetails(JSON.parse(content));
	} catch {
		return undefined;
	}
}

export async function readChildActivityDetails(
	artifactDir: string,
	childIndex: number,
	workflowId: string,
): Promise<ChildResultDetails | undefined> {
	const activityPath = join(artifactDir, "children", String(childIndex), "activity.json");
	try {
		const content = await readFile(activityPath, "utf8");
		const raw: unknown = JSON.parse(content);
		const parsed = parseActivityV1(raw);
		if (parsed !== undefined && parsed.workflowId === workflowId && parsed.index === childIndex) {
			return {
				turns: parsed.turns,
				contextTokens: parsed.contextTokens,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function computeWorkflowElapsed(snapshot: TreeSnapshot, nowMs: number): number {
	const createdMs = Date.parse(snapshot.createdAt);
	if (Number.isNaN(createdMs)) return 0;
	if (!snapshot.committed) {
		return Math.max(0, nowMs - createdMs);
	}
	let latestEndMs = 0;
	for (const child of snapshot.children) {
		if (child.endedAt) {
			const ms = Date.parse(child.endedAt);
			if (!Number.isNaN(ms) && ms > latestEndMs) latestEndMs = ms;
		}
		for (const nested of child.nested) {
			if ("endedAt" in nested && typeof nested.endedAt === "string" && nested.endedAt !== "") {
				const ms = Date.parse(nested.endedAt);
				if (!Number.isNaN(ms) && ms > latestEndMs) latestEndMs = ms;
			}
		}
	}
	if (latestEndMs > 0) {
		return Math.max(0, latestEndMs - createdMs);
	}
	const capturedMs = Date.parse(snapshot.capturedAt);
	if (!Number.isNaN(capturedMs) && capturedMs >= createdMs) {
		return Math.max(0, capturedMs - createdMs);
	}
	return 0;
}

export type AmbientStatus = Readonly<{
	snapshot: TreeSnapshot;
	activeWorkflowCount: number;
	rootTurn?: Readonly<{
		elapsedMs: number;
	}>;
}>;

export function renderAmbientWidgetLine(
	status: AmbientStatus,
	width: number,
	theme: TreeTheme,
): string[] {
	const { snapshot, activeWorkflowCount, rootTurn } = status;
	const label = snapshot.playbook ?? snapshot.mode;
	const workflowElapsed = formatElapsed(computeWorkflowElapsed(snapshot, Date.now()));

	const durationSegment = rootTurn !== undefined
		? `root turn ${formatElapsed(rootTurn.elapsedMs)} · workflow ${workflowElapsed}`
		: `workflow ${workflowElapsed}`;

	let text = "";
	if (snapshot.committed && activeWorkflowCount > 0) {
		const glyph = theme.fg("accent", "⛁");
		const workflowLabel = activeWorkflowCount === 1 ? "workflow" : "workflows";
		text = `${glyph} dstack · ${durationSegment} · ${activeWorkflowCount} active ${workflowLabel} · slots ${snapshot.slots.active}/${snapshot.slots.capacity} · shift+up to inspect`;
	} else if (snapshot.committed) {
		const stateText = snapshot.counts.complete === snapshot.counts.total && snapshot.children.every((c) => c.state === "succeeded")
			? "complete"
			: "finished";
		const glyph = snapshot.children.some((c) => c.state === "failed")
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");
		text = `${glyph} dstack · ${label} ${stateText} · ${durationSegment} · shift+up to inspect`;
	} else {
		const runningCount = snapshot.counts.running;
		const queuedCount = snapshot.counts.queued;
		const glyph = theme.fg("accent", "⛁");
		const runningSegment = activeWorkflowCount > 1
			? `${activeWorkflowCount} active workflows`
			: `${runningCount} running`;
		const queuedSegment = queuedCount > 0 ? ` · ${queuedCount} queued` : "";
		const slotsSegment = ` · slots ${snapshot.slots.active}/${snapshot.slots.capacity}`;
		text = `${glyph} dstack · ${label} · ${durationSegment} · ${runningSegment}${queuedSegment}${slotsSegment} · shift+up to inspect`;
	}

	return [truncateToWidth(text, Math.max(10, width))];
}

export type AgentIdentity = Readonly<{
	depth: 1 | 2;
	agent: string;
	role?: string;
	assignment?: "owner" | "worker" | "reviewer";
	model?: string;
	workflowId: string;
	childIndex: number;
	parentIdentity?: Readonly<{
		agent: string;
		childIndex: number;
	}>;
	nestedGroupId?: string;
	nestedIndex?: number;
}>;

export type AgentStatus = Readonly<{
	state: TreeChildState;
	phase?: string;
	activity?: string;
	semanticStatus?: SemanticStatus;
	recentActivity?: readonly string[];
	stale?: boolean;
	todos?: readonly TodoItem[];
	outcome?: string;
}>;

export type AgentTiming = Readonly<{
	createdAt?: string;
	startedAt?: string;
	endedAt?: string;
	elapsedMs?: number;
	turns?: number;
	contextTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}>;

export type AgentInput = Readonly<{
	task: string;
	taskPreview: string;
	workflow?: WorkflowContext;
	cwd?: string;
	requestedRole?: string;
	tools?: string;
	model?: string;
}>;

export type SealedResultOutput = Readonly<{
	provenance: "sealed-result";
	state: "succeeded" | "failed" | "cancelled" | "skipped";
	exitCode: number;
	finalText?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	model?: string;
	usage?: ChildUsage;
	seal?: OutputArtifactSeal;
	resultSeal?: OutputArtifactSeal;
}>;

export type SpawnRecordOutput = Readonly<{
	provenance: "spawn-record";
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
	exitCode?: number;
	finalText?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	model?: string;
	usage?: ChildUsage;
}>;

export type AgentOutput = SealedResultOutput | SpawnRecordOutput;

export type RawAvailability =
	| Readonly<{ kind: "output-tail"; filePath: string; bytes?: number; truncated?: boolean }>
	| Readonly<{ kind: "recorded-final-only" }>
	| Readonly<{ kind: "none"; reason?: string }>;

export type AgentInspection = Readonly<{
	identity: AgentIdentity;
	status: AgentStatus;
	timing: AgentTiming;
	input: AgentInput;
	output?: AgentOutput;
	raw: RawAvailability;
	session?: ChildSessionRefV1;
}>;

export type DetailViewMode = "conversation" | "summary" | "task" | "final" | "raw";

export function buildAgentInspection(
	snapshot: TreeSnapshot,
	child: TreeChild,
	nested: NestedChild | undefined,
	resultDetails: ChildResultDetails | undefined,
	activityDetails: ChildResultDetails | undefined,
	rawResult: BoundedReadResult | undefined,
	rawError: string | undefined,
	nowMs: number,
): AgentInspection {
	if (nested !== undefined) {
		if (isLeaseSnapshot(nested)) {
			const leaseStartMs = Date.parse(nested.acquiredAt);
			const elapsedMs = !Number.isNaN(leaseStartMs) ? Math.max(0, nowMs - leaseStartMs) : undefined;
			return {
				identity: {
					depth: 2,
					agent: "agent details pending",
					workflowId: snapshot.workflowId,
					childIndex: child.index,
					parentIdentity: { agent: child.agent, childIndex: child.index },
				},
				status: {
					state: "running",
					phase: child.phase,
				},
				timing: {
					startedAt: nested.acquiredAt,
					elapsedMs,
				},
				input: {
					task: "(lease acquired, awaiting spawn record)",
					taskPreview: "nested lease",
					cwd: child.cwd,
				},
				raw: { kind: "none", reason: "Lease in progress" },
			};
		}

		const startMs = nested.startedAt ? Date.parse(nested.startedAt) : undefined;
		const endMs = nested.endedAt ? Date.parse(nested.endedAt) : undefined;
		const elapsedMs = startMs !== undefined
			? (endMs !== undefined ? endMs - startMs : Math.max(0, nowMs - startMs))
			: undefined;

		let output: SpawnRecordOutput | undefined;
		if (
			nested.state === "succeeded" ||
			nested.state === "failed" ||
			nested.state === "cancelled" ||
			nested.state === "skipped" ||
			nested.finalResponse !== undefined ||
			nested.errorMessage !== undefined ||
			nested.exitCode !== undefined
		) {
			output = {
				provenance: "spawn-record",
				state: nested.state,
				exitCode: nested.exitCode ?? (nested.state === "succeeded" ? 0 : nested.state === "failed" ? 1 : undefined),
				finalText: nested.finalResponse,
				stopReason: nested.stopReason,
				errorMessage: nested.errorMessage,
				stderr: nested.stderr,
				model: nested.model,
				usage: nested.usage,
			};
		}

		let raw: RawAvailability;
		if (nested.finalResponse !== undefined && nested.finalResponse.length > 0) {
			raw = { kind: "recorded-final-only" };
		} else {
			raw = { kind: "none", reason: "Raw output tail is unavailable for depth-2 child agents" };
		}

		const recentActivity = !isLeaseSnapshot(nested) && nested.state === "running" && nested.journal && nested.journal.length > 0
			? formatRecentActivity(nested.journal)
			: undefined;

		return {
			identity: {
				depth: 2,
				agent: nested.agent,
				role: nested.role,
				assignment: nested.assignment,
				model: nested.model,
				workflowId: snapshot.workflowId,
				childIndex: child.index,
				parentIdentity: { agent: child.agent, childIndex: child.index },
				nestedGroupId: nested.groupId,
				nestedIndex: nested.nestedIndex,
			},
			status: {
				state: nested.state,
				phase: nested.workflow?.phase ?? child.phase,
				activity: nested.activity,
				semanticStatus: nested.status,
				recentActivity,
				stale: nested.stale,
				outcome: nested.state === "failed" ? (nested.errorMessage ?? nested.stderr ?? "failed") : undefined,
			},
			timing: {
				createdAt: nested.updatedAt,
				startedAt: nested.startedAt,
				endedAt: nested.endedAt,
				elapsedMs,
				turns: nested.usage?.turns,
				contextTokens: nested.usage?.contextTokens,
				inputTokens: nested.usage?.input,
				outputTokens: nested.usage?.output,
				cost: nested.usage?.cost,
			},
			input: {
				task: nested.taskFull ?? nested.taskPreview,
				taskPreview: nested.taskPreview,
				workflow: nested.workflow,
				cwd: nested.cwd,
				requestedRole: nested.role,
				tools: nested.tools,
				model: nested.model,
			},
			output,
			raw,
			session: !isLeaseSnapshot(nested) ? nested.session : undefined,
		};
	}

	const startMs = child.startedAt ? Date.parse(child.startedAt) : undefined;
	const endMs = child.endedAt ? Date.parse(child.endedAt) : undefined;
	const elapsedMs = startMs !== undefined
		? (endMs !== undefined ? endMs - startMs : Math.max(0, nowMs - startMs))
		: undefined;

	const turns = resultDetails?.turns ?? activityDetails?.turns;
	const contextTokens = resultDetails?.contextTokens ?? activityDetails?.contextTokens;
	const inputTokens = resultDetails?.inputTokens;
	const outputTokens = resultDetails?.outputTokens;
	const cost = resultDetails?.cost;
	const model = resultDetails?.model ?? child.model;

	const isOwner = child.assignment === "owner" || child.role === "owner" || (child.index === 0 && snapshot.todos.length > 0);
	const todos = isOwner && snapshot.todos.length > 0 ? snapshot.todos : undefined;

	let output: SealedResultOutput | undefined;
	if (resultDetails !== undefined && (resultDetails.state !== undefined || resultDetails.summaryText !== undefined)) {
		const candidateState = resultDetails.state ?? child.state;
		const state: SealedResultOutput["state"] = isSealedOutputState(candidateState) ? candidateState : "succeeded";
		output = {
			provenance: "sealed-result",
			state,
			exitCode: resultDetails.exitCode ?? (child.state === "succeeded" ? 0 : 1),
			finalText: resultDetails.summaryText,
			stopReason: resultDetails.stopReason,
			errorMessage: resultDetails.errorMessage,
			stderr: resultDetails.stderr,
			model,
			usage: resultDetails.usage,
			seal: resultDetails.outputSeal,
			resultSeal: resultDetails.resultSeal,
		};
	}

	let raw: RawAvailability;
	if (rawResult !== undefined && (rawResult.bytesRead > 0 || rawResult.totalBytes === 0)) {
		raw = {
			kind: "output-tail",
			filePath: `children/${child.index}/output.txt`,
			bytes: rawResult.bytesRead,
			truncated: rawResult.truncated,
		};
	} else if (rawError) {
		raw = { kind: "none", reason: rawError };
	} else {
		raw = { kind: "none", reason: "No output recorded" };
	}

	const recentActivity = child.state === "running" && child.journal && child.journal.length > 0
		? formatRecentActivity(child.journal)
		: undefined;

	return {
		identity: {
			depth: 1,
			agent: child.agent,
			role: child.role,
			assignment: child.assignment,
			model,
			workflowId: snapshot.workflowId,
			childIndex: child.index,
		},
		status: {
			state: child.state,
			phase: child.phase,
			activity: child.activity?.text,
			semanticStatus: child.status,
			recentActivity,
			stale: child.stale,
			todos,
			outcome: child.outcome,
		},
		timing: {
			createdAt: snapshot.createdAt,
			startedAt: child.startedAt,
			endedAt: child.endedAt,
			elapsedMs,
			turns,
			contextTokens,
			inputTokens,
			outputTokens,
			cost,
		},
		input: {
			task: child.taskFull ?? child.taskPreview,
			taskPreview: child.taskPreview,
			workflow: child.workflow,
			cwd: child.cwd,
			requestedRole: child.role,
			tools: child.tools,
			model: child.model,
		},
		output,
		raw,
		session: child.session,
	};
}

export type Frame =
	| Readonly<{ kind: "list" }>
	| Readonly<{
			kind: "agent-detail";
			workflowId: string;
			childIndex: number;
			nestedGroupId?: string;
			nestedIndex?: number;
	  }>;

export type NavigableItem =
	| Readonly<{ type: "workflow"; workflowId: string }>
	| Readonly<{ type: "child"; workflowId: string; childIndex: number }>
	| Readonly<{
			type: "nested-group";
			workflowId: string;
			childIndex: number;
			groupId: string;
	  }>
	| Readonly<{
			type: "nested";
			workflowId: string;
			childIndex: number;
			nestedGroupId: string;
			nestedIndex: number;
	  }>;

export type AgentInspectorAction =
	| Readonly<{ action: "resume"; sessionFile: string }>
	| Readonly<{ action: "fork"; sessionFile: string; cwd?: string }>;

export type AgentInspectorResult = AgentInspectorAction | "closed";

export interface InspectorTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	strikethrough?(text: string): string;
}

export type AgentInspectorOptions = Readonly<{
	sessionId: string;
	initialTaskId?: string;
	initialWorkflowId?: string;
	initialChildIndex?: number;
	initialNestedGroupId?: string;
	initialNestedIndex?: number;
	initialView?: DetailViewMode;
	todoPath?: string;
	refreshIntervalMs?: number;
	pollIntervalMs?: number;
	terminalRows?: number | (() => number);
	listWorkflows?: (sessionId: string) => Promise<readonly WorkflowSummary[]>;
	getSnapshot?: (input: BuildTreeSnapshotInput) => Promise<TreeSnapshot | undefined>;
	readOutputTail?: (filePath: string, maxBytes?: number) => Promise<BoundedReadResult>;
	readChildResult?: (artifactDir: string, childIndex: number) => Promise<ChildResultDetails | undefined>;
	readChildActivity?: (artifactDir: string, childIndex: number, workflowId: string) => Promise<ChildResultDetails | undefined>;
	tailSession?: typeof tailSessionFile;
	now?: () => Date;
}>;

function glyphForState(state: TreeChildState, theme: InspectorTheme): string {
	switch (state) {
		case "succeeded":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "running":
			return theme.fg("accent", "◐");
		case "queued":
			return theme.fg("dim", "○");
		case "cancelled":
		case "skipped":
			return theme.fg("dim", "⊘");
	}
}

function toOutputLines(content: string): string[] {
	return content
		.replace(/\r/g, "")
		.split("\n")
		.filter((line, index, array) => line.length > 0 || index < array.length - 1);
}

export function formatConversationRecords(
	records: readonly SessionTailRecord[],
	theme: InspectorTheme,
	width: number,
): string[] {
	const lines: string[] = [];
	const contentWidth = Math.max(10, width - 4);

	for (const record of records) {
		if (!isRecord(record)) continue;
		if (record.type === "session") {
			continue;
		}

		if (record.type === "message" && isRecord(record.message)) {
			const msg = record.message;
			const role = typeof msg.role === "string" ? msg.role : "";

			if (role === "user") {
				if (lines.length > 0) lines.push("");
				const userHeading = theme.bold ? theme.bold(theme.fg("accent", "👤 User")) : theme.fg("accent", "👤 User");
				lines.push(` ${userHeading}`);
				let text = "";
				if (typeof msg.content === "string") {
					text = msg.content;
				} else if (Array.isArray(msg.content)) {
					text = msg.content
						.filter((p) => isRecord(p) && p.type === "text" && typeof p.text === "string")
						.map((p) => p.text)
						.join("\n");
				}
				if (text) {
					for (const line of wrapText(text, contentWidth)) {
						lines.push(`   ${line}`);
					}
				}
			} else if (role === "assistant") {
				if (lines.length > 0) lines.push("");
				const modelLabel = typeof msg.model === "string" && msg.model ? ` ${theme.fg("dim", `(${msg.model})`)}` : "";
				const asstHeading = theme.bold ? theme.bold(theme.fg("success", "🤖 Assistant")) : theme.fg("success", "🤖 Assistant");
				lines.push(` ${asstHeading}${modelLabel}`);

				if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (!isRecord(part)) continue;
						if (part.type === "thinking" && typeof part.thinking === "string") {
							const thinkingLines = wrapText(part.thinking.trim(), contentWidth - 2);
							if (thinkingLines.length > 0) {
								lines.push(`   ${theme.fg("dim", `💭 ${thinkingLines[0]}`)}`);
								for (let i = 1; i < thinkingLines.length; i++) {
									lines.push(`      ${theme.fg("dim", thinkingLines[i])}`);
								}
							}
						} else if (part.type === "text" && typeof part.text === "string") {
							for (const line of wrapText(part.text, contentWidth)) {
								lines.push(`   ${line}`);
							}
						} else if (part.type === "toolCall" && typeof part.name === "string") {
							const argsStr = formatToolArgsPreview(part.arguments);
							lines.push(`   ${theme.fg("warning", `🔧 ${part.name}(${argsStr})`)}`);
						}
					}
				} else if (typeof msg.content === "string") {
					for (const line of wrapText(msg.content, contentWidth)) {
						lines.push(`   ${line}`);
					}
				}

				if (typeof msg.errorMessage === "string" && msg.errorMessage) {
					lines.push(`   ${theme.fg("error", `Error: ${msg.errorMessage}`)}`);
				}
			} else if (role === "toolResult") {
				const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
				const isError = Boolean(msg.isError);
				const statusBadge = isError ? ` ${theme.fg("error", "[error]")}` : "";
				lines.push(`   ${theme.fg("dim", `⎿ ${toolName}${statusBadge}`)}`);

				let text = "";
				if (typeof msg.content === "string") {
					text = msg.content;
				} else if (Array.isArray(msg.content)) {
					text = msg.content
						.filter((p) => isRecord(p) && p.type === "text" && typeof p.text === "string")
						.map((p) => p.text)
						.join("\n");
				}
				if (text) {
					const wrapped = wrapText(text, contentWidth - 4);
					const maxPreviewLines = 15;
					const preview = wrapped.slice(0, maxPreviewLines);
					for (const line of preview) {
						lines.push(`     ${theme.fg("dim", line)}`);
					}
					if (wrapped.length > maxPreviewLines) {
						lines.push(`     ${theme.fg("dim", `... (${wrapped.length - maxPreviewLines} more lines)`)}`);
					}
				}
			} else if (role === "bashExecution") {
				const cmd = typeof msg.command === "string" ? msg.command : "";
				const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : 0;
				const statusBadge = exitCode !== 0 ? ` ${theme.fg("error", `(exit ${exitCode})`)}` : "";
				lines.push(`   ${theme.fg("dim", `⚡ bash: ${cmd}${statusBadge}`)}`);
				if (typeof msg.output === "string" && msg.output) {
					const wrapped = wrapText(msg.output, contentWidth - 4);
					const maxPreviewLines = 15;
					const preview = wrapped.slice(0, maxPreviewLines);
					for (const line of preview) {
						lines.push(`     ${theme.fg("dim", line)}`);
					}
					if (wrapped.length > maxPreviewLines) {
						lines.push(`     ${theme.fg("dim", `... (${wrapped.length - maxPreviewLines} more lines)`)}`);
					}
				}
			}
		} else if (record.type === "compaction" && typeof record.summary === "string") {
			if (lines.length > 0) lines.push("");
			lines.push(` ${theme.fg("dim", "─── Context Compacted ───")}`);
			for (const line of wrapText(record.summary, contentWidth)) {
				lines.push(`   ${theme.fg("dim", line)}`);
			}
		} else if (record.type === "model_change" && typeof record.modelId === "string") {
			const provider = typeof record.provider === "string" ? `${record.provider}/` : "";
			lines.push(` ${theme.fg("dim", `─── Model changed to ${provider}${record.modelId} ───`)}`);
		}
	}

	return lines;
}

function formatToolArgsPreview(args: unknown): string {
	if (!isRecord(args)) return "";
	if (typeof args.path === "string") return `path: "${args.path}"`;
	if (typeof args.command === "string") {
		const cmd = args.command.length > 35 ? `${args.command.slice(0, 32)}...` : args.command;
		return `"${cmd}"`;
	}
	if (typeof args.task === "string") {
		const task = args.task.length > 35 ? `${args.task.slice(0, 32)}...` : args.task;
		return `task: "${task}"`;
	}
	try {
		const raw = JSON.stringify(args);
		return raw.length > 40 ? `${raw.slice(0, 37)}...` : raw;
	} catch {
		return "";
	}
}

export class AgentInspector implements Component {
	private stack: Frame[] = [{ kind: "list" }];
	private workflows: WorkflowSummary[] = [];
	private snapshots: Map<string, TreeSnapshot> = new Map();
	private collapsedWorkflows: Set<string> = new Set();
	private showHistory = false;
	private selectedIndex = 0;
	private listScroll = 0;
	private visibleItems: NavigableItem[] = [];

	private detailView: DetailViewMode = "summary";
	private summaryScrollTop = 0;
	private lastSummaryLineCount = 0;
	private taskScrollTop = 0;
	private lastTaskLineCount = 0;
	private finalScrollTop = 0;
	private lastFinalLineCount = 0;
	private lastFinalVisibleRows = deriveInspectorLayoutMetrics().finalVisibleRows;

	private conversationLines: string[] = [];
	private conversationScrollTop = 0;
	private conversationFollow = true;
	private readonly tailStates = new Map<string, SessionTailState>();
	private readonly sessionRefCache: SessionRefCache = new Map();
	private readonly tailSessionFn: typeof tailSessionFile;

	private loadError?: string;
	private disposed = false;
	private polling = false;
	private doneCalled = false;

	private detailLines: string[] = [];
	private detailFollow = true;
	private detailScrollTop = 0;
	private tailBytesRead = 0;
	private tailTotalBytes = 0;
	private tailTruncated = false;
	private tailError?: string;
	private childResultDetails?: ChildResultDetails;
	private childActivityDetails?: ChildResultDetails;

	private refreshTimer?: NodeJS.Timeout;
	private readonly listWorkflowsFn: (sessionId: string) => Promise<readonly WorkflowSummary[]>;
	private readonly getSnapshotFn: (input: BuildTreeSnapshotInput) => Promise<TreeSnapshot | undefined>;
	private readonly readOutputTailFn: (filePath: string, maxBytes?: number) => Promise<BoundedReadResult>;
	private readonly readChildResultFn: (artifactDir: string, childIndex: number) => Promise<ChildResultDetails | undefined>;
	private readonly readChildActivityFn: (artifactDir: string, childIndex: number, workflowId: string) => Promise<ChildResultDetails | undefined>;
	private readonly nowFn: () => Date;

	private readonly tui: Pick<TUI, "requestRender">;
	private readonly theme: InspectorTheme;
	private readonly done: (result: AgentInspectorResult) => void;
	private readonly options: AgentInspectorOptions;

	constructor(
		tui: Pick<TUI, "requestRender">,
		theme: InspectorTheme,
		done: (result: AgentInspectorResult) => void,
		options: AgentInspectorOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.options = options;
		this.listWorkflowsFn = options.listWorkflows ?? listSessionWorkflows;
		this.getSnapshotFn = options.getSnapshot ?? buildTreeSnapshot;
		this.readOutputTailFn = options.readOutputTail ?? boundedTailRead;
		this.readChildResultFn = options.readChildResult ?? readChildResultDetails;
		this.readChildActivityFn = options.readChildActivity ?? readChildActivityDetails;
		this.tailSessionFn = options.tailSession ?? tailSessionFile;
		this.nowFn = options.now ?? (() => new Date());

		if (options.initialView !== undefined) {
			this.detailView = options.initialView;
		}

		if (options.initialWorkflowId !== undefined && options.initialChildIndex !== undefined) {
			this.stack = [
				{ kind: "list" },
				{
					kind: "agent-detail",
					workflowId: options.initialWorkflowId,
					childIndex: options.initialChildIndex,
					nestedGroupId: options.initialNestedGroupId,
					nestedIndex: options.initialNestedIndex,
				},
			];
		}

		void this.initialLoad();

		const intervalMs = options.refreshIntervalMs ?? options.pollIntervalMs ?? STATUS_INTERVAL_MS;
		if (intervalMs > 0) {
			this.refreshTimer = setInterval(() => {
				void this.poll();
			}, intervalMs);
			this.refreshTimer.unref();
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer !== undefined) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.tailStates.clear();
		this.sessionRefCache.clear();
	}

	invalidate(): void {
		if (this.disposed) return;
		this.tui.requestRender();
	}

	private async initialLoad(): Promise<void> {
		if (this.disposed || this.polling) return;
		this.polling = true;
		try {
			const list = await this.listWorkflowsFn(this.options.sessionId);
			if (this.disposed) return;
			this.workflows = [...list];
			this.loadError = undefined;
			await this.refreshSnapshots();
			if (this.disposed) return;

			const hasRunning = Array.from(this.snapshots.values()).some((s) => !s.committed || s.counts.running > 0)
				|| this.workflows.some((w) => !w.committed && w.manifest.kind === "pending");
			if (!hasRunning && this.workflows.length > 0) {
				this.showHistory = true;
			}

			if (this.options.initialTaskId !== undefined && this.stack.length === 1) {
				const matching = this.workflows.find((w) => w.taskId === this.options.initialTaskId);
				if (matching !== undefined) {
					this.stack.push({
						kind: "agent-detail",
						workflowId: matching.workflowId,
						childIndex: this.options.initialChildIndex ?? 0,
						nestedGroupId: this.options.initialNestedGroupId,
						nestedIndex: this.options.initialNestedIndex,
					});
				}
			}

			if (this.currentFrame().kind === "agent-detail") {
				await this.refreshDetailData();
				if (this.disposed) return;
			}
		} catch (error) {
			if (this.disposed) return;
			if (this.workflows.length === 0) {
				this.loadError = error instanceof Error ? error.message : String(error);
			}
		} finally {
			this.polling = false;
		}
		if (!this.disposed) {
			this.tui.requestRender();
		}
	}

	private async refreshSnapshots(): Promise<void> {
		const todoPath = this.options.todoPath ?? todoFilePath(this.options.sessionId);
		let activeLeases: readonly LeaseSnapshot[] = [];
		try {
			const root = sessionRoot(this.options.sessionId);
			activeLeases = await snapshotActiveLeases(join(root, "scheduler"));
		} catch {
			activeLeases = [];
		}

		for (const wf of this.workflows) {
			if (this.disposed) return;
			if (wf.manifest.kind === "corrupt") continue;
			const existing = this.snapshots.get(wf.workflowId);
			if (existing !== undefined && existing.committed) {
				continue;
			}
			try {
				const snapshot = await this.getSnapshotFn({
					taskId: wf.taskId,
					workflowId: wf.workflowId,
					artifactDir: wf.artifactDir,
					schedulerRoot: wf.schedulerRoot,
					todoPath,
					playbook: wf.playbook,
					activeLeases,
					sessionRefCache: this.sessionRefCache,
					now: this.nowFn(),
				});
				if (this.disposed) return;
				if (snapshot !== undefined) {
					this.snapshots.set(wf.workflowId, snapshot);
				}
			} catch {}
		}
	}

	private async poll(): Promise<void> {
		if (this.disposed || this.polling) return;
		this.polling = true;
		try {
			const list = await this.listWorkflowsFn(this.options.sessionId);
			if (this.disposed) return;
			this.workflows = [...list];
			this.loadError = undefined;
			await this.refreshSnapshots();
			if (this.disposed) return;
			if (this.currentFrame().kind === "agent-detail") {
				await this.refreshDetailData();
				if (this.disposed) return;
			}
			if (!this.disposed) {
				this.tui.requestRender();
			}
		} catch (error) {
			if (this.disposed) return;
			if (this.workflows.length === 0) {
				this.loadError = error instanceof Error ? error.message : String(error);
			}
			this.tui.requestRender();
		} finally {
			this.polling = false;
		}
	}

	private currentFrame(): Frame {
		return this.stack[this.stack.length - 1] ?? { kind: "list" };
	}

	private closeWithResult(result: AgentInspectorResult): void {
		if (this.doneCalled) return;
		this.doneCalled = true;
		this.done(result);
	}

	private close(): void {
		this.closeWithResult("closed");
	}

	handleInput(data: string): void {
		const wheelDirection = parseWheelDirection(data);
		if (wheelDirection !== undefined) {
			const frame = this.currentFrame();
			if (frame.kind === "list") {
				const maxIndex = Math.max(0, this.visibleItems.length - 1);
				this.selectedIndex = Math.min(maxIndex, Math.max(0, this.selectedIndex + wheelDirection));
				this.ensureSelectionVisible();
				this.tui.requestRender();
			} else {
				this.scrollActiveDetailView(wheelDirection);
			}
			return;
		}

		if (data === "q" || data === "Q") {
			this.close();
			return;
		}

		const frame = this.currentFrame();
		if (matchesKey(data, "escape")) {
			if (this.stack.length > 1) {
				this.stack.pop();
				this.detailView = "summary";
				this.summaryScrollTop = 0;
				this.taskScrollTop = 0;
				this.finalScrollTop = 0;
				this.tui.requestRender();
				return;
			}
			this.close();
			return;
		}

		if (frame.kind === "list") {
			if (data === "x" || data === "X") {
				this.close();
				return;
			}
			this.handleListInput(data);
		} else {
			this.handleDetailInput(data, frame);
		}
	}

	private handleListInput(data: string): void {
		if (data === "h" || data === "H") {
			this.showHistory = !this.showHistory;
			this.selectedIndex = 0;
			this.listScroll = 0;
			this.tui.requestRender();
			return;
		}

		const maxIndex = Math.max(0, this.visibleItems.length - 1);
		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(maxIndex, this.selectedIndex + 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 5);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.selectedIndex = Math.min(maxIndex, this.selectedIndex + 5);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.selectedIndex = 0;
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.selectedIndex = maxIndex;
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "right")) {
			const item = this.visibleItems[this.selectedIndex];
			if (item === undefined) return;
			if (item.type === "workflow") {
				if (this.collapsedWorkflows.has(item.workflowId)) {
					this.collapsedWorkflows.delete(item.workflowId);
				} else {
					this.collapsedWorkflows.add(item.workflowId);
				}
				this.tui.requestRender();
				return;
			}
			if (item.type === "child") {
				this.stack.push({
					kind: "agent-detail",
					workflowId: item.workflowId,
					childIndex: item.childIndex,
				});
				this.detailView = "summary";
				this.conversationScrollTop = 0;
				this.conversationFollow = true;
				this.summaryScrollTop = 0;
				this.taskScrollTop = 0;
				this.finalScrollTop = 0;
				this.detailFollow = true;
				this.detailScrollTop = 0;
				void this.refreshDetailData();
				this.tui.requestRender();
				return;
			}
			if (item.type === "nested-group") {
				const snapshot = this.snapshots.get(item.workflowId);
				const child = snapshot?.children[item.childIndex];
				const childGroups = child?.nestedGroups ?? (child?.nested ? groupNestedChildren(child.nested) : []);
				const group = childGroups.find((g) => g.groupId === item.groupId);
				const firstChild = group?.children[0];
				if (firstChild !== undefined && !isLeaseSnapshot(firstChild)) {
					this.stack.push({
						kind: "agent-detail",
						workflowId: item.workflowId,
						childIndex: item.childIndex,
						nestedGroupId: firstChild.groupId,
						nestedIndex: firstChild.nestedIndex,
					});
					this.detailView = "summary";
					this.summaryScrollTop = 0;
					this.taskScrollTop = 0;
					this.finalScrollTop = 0;
					this.detailFollow = true;
					this.detailScrollTop = 0;
					void this.refreshDetailData();
					this.tui.requestRender();
				}
				return;
			}
			if (item.type === "nested") {
				this.stack.push({
					kind: "agent-detail",
					workflowId: item.workflowId,
					childIndex: item.childIndex,
					nestedGroupId: item.nestedGroupId,
					nestedIndex: item.nestedIndex,
				});
				this.detailView = "summary";
				this.conversationScrollTop = 0;
				this.conversationFollow = true;
				this.summaryScrollTop = 0;
				this.taskScrollTop = 0;
				this.finalScrollTop = 0;
				this.detailFollow = true;
				this.detailScrollTop = 0;
				void this.refreshDetailData();
				this.tui.requestRender();
				return;
			}
		}

		if (matchesKey(data, "left")) {
			const item = this.visibleItems[this.selectedIndex];
			if (item !== undefined && item.type !== "workflow") {
				const headerIdx = this.visibleItems.findIndex(
					(v) => v.type === "workflow" && v.workflowId === item.workflowId,
				);
				if (headerIdx >= 0) {
					this.selectedIndex = headerIdx;
					this.ensureSelectionVisible();
					this.tui.requestRender();
				}
			}
		}
	}

	private handleDetailInput(data: string, frame: Extract<Frame, { kind: "agent-detail" }>): void {
		const snapshot = this.snapshots.get(frame.workflowId);
		const child = snapshot?.children[frame.childIndex];
		let nestedMatch: SpawnNestedChild | undefined;
		if (child && frame.nestedGroupId !== undefined && frame.nestedIndex !== undefined) {
			const candidate = child.nested.find((n) => !isLeaseSnapshot(n) && n.groupId === frame.nestedGroupId && n.nestedIndex === frame.nestedIndex);
			if (candidate && !isLeaseSnapshot(candidate)) {
				nestedMatch = candidate;
			}
		}

		const isCompleted = nestedMatch
			? (nestedMatch.state !== "running" && nestedMatch.state !== "queued")
			: (child !== undefined && child.state !== "running" && child.state !== "queued");
		const targetSession = nestedMatch ? nestedMatch.session : child?.session;
		const targetCwd = nestedMatch?.cwd ?? child?.cwd;

		if (isCompleted && targetSession !== undefined) {
			if (data === "u" || data === "U" || (data === "r" && this.detailView !== "raw") || (data === "R" && this.detailView !== "raw")) {
				this.closeWithResult({ action: "resume", sessionFile: targetSession.sessionFile });
				return;
			}
			if (data === "k" || data === "K" || data === "F") {
				this.closeWithResult({ action: "fork", sessionFile: targetSession.sessionFile, cwd: targetCwd });
				return;
			}
		}

		if (data === "c" || data === "C") {
			this.detailView = "conversation";
			this.tui.requestRender();
			return;
		}
		if (data === "s" || data === "S") {
			this.detailView = "summary";
			this.summaryScrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "t" || data === "T") {
			this.detailView = "task";
			this.taskScrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "f") {
			this.detailView = "final";
			this.finalScrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "o" || data === "O") {
			this.detailView = "raw";
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "left")) {
			this.stack.pop();
			this.detailView = "conversation";
			this.summaryScrollTop = 0;
			this.taskScrollTop = 0;
			this.finalScrollTop = 0;
			this.conversationScrollTop = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			this.detailFollow = true;
			this.detailScrollTop = 0;
			void this.refreshDetailData();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollActiveDetailView(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollActiveDetailView(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollActiveDetailView(-6);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollActiveDetailView(6);
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollActiveDetailViewTo(0);
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollActiveDetailViewTo(Number.MAX_SAFE_INTEGER);
			return;
		}

		if ((matchesKey(data, "return") || matchesKey(data, "right")) && this.detailView === "summary" && frame.nestedGroupId === undefined) {
			const snapshot = this.snapshots.get(frame.workflowId);
			const child = snapshot?.children[frame.childIndex];
			if (child !== undefined && child.nested.length > 0) {
				const firstNested = child.nested[0];
				if (firstNested !== undefined && !isLeaseSnapshot(firstNested)) {
					this.stack.push({
						kind: "agent-detail",
						workflowId: frame.workflowId,
						childIndex: frame.childIndex,
						nestedGroupId: firstNested.groupId,
						nestedIndex: firstNested.nestedIndex,
					});
					this.detailView = "summary";
					this.conversationScrollTop = 0;
					this.conversationFollow = true;
					this.summaryScrollTop = 0;
					this.taskScrollTop = 0;
					this.finalScrollTop = 0;
					this.detailFollow = true;
					this.detailScrollTop = 0;
					void this.refreshDetailData();
					this.tui.requestRender();
				}
			}
		}
	}

	private getTuiTerminalRows(): number | undefined {
		if (
			"terminal" in this.tui &&
			typeof this.tui.terminal === "object" &&
			this.tui.terminal !== null &&
			"rows" in this.tui.terminal &&
			typeof this.tui.terminal.rows === "number"
		) {
			return this.tui.terminal.rows;
		}
		return undefined;
	}

	get layoutMetrics(): InspectorLayoutMetrics {
		const rawRows = typeof this.options.terminalRows === "function"
			? this.options.terminalRows()
			: this.options.terminalRows ?? this.getTuiTerminalRows();
		return deriveInspectorLayoutMetrics(rawRows);
	}

	private scrollActiveDetailView(delta: number): void {
		if (this.detailView === "conversation") {
			const visibleRows = Math.max(1, this.layoutMetrics.bodyRows);
			const maxTop = Math.max(0, this.conversationLines.length - visibleRows);
			if (delta < 0) {
				this.conversationFollow = false;
			}
			this.conversationScrollTop = Math.min(maxTop, Math.max(0, this.conversationScrollTop + delta));
			if (this.conversationScrollTop >= maxTop) {
				this.conversationFollow = true;
			}
		} else if (this.detailView === "task") {
			const maxTop = Math.max(0, this.lastTaskLineCount - this.layoutMetrics.taskVisibleRows);
			this.taskScrollTop = Math.min(maxTop, Math.max(0, this.taskScrollTop + delta));
		} else if (this.detailView === "final") {
			const visibleRows = Math.max(1, this.lastFinalVisibleRows);
			const maxTop = Math.max(0, this.lastFinalLineCount - visibleRows);
			this.finalScrollTop = Math.min(maxTop, Math.max(0, this.finalScrollTop + delta));
		} else if (this.detailView === "raw") {
			this.scrollRawDetail(delta);
		} else {
			const maxTop = Math.max(0, this.lastSummaryLineCount - this.layoutMetrics.summaryVisibleRows);
			this.summaryScrollTop = Math.min(maxTop, Math.max(0, this.summaryScrollTop + delta));
		}
		this.tui.requestRender();
	}

	private scrollActiveDetailViewTo(target: number): void {
		if (this.detailView === "conversation") {
			const visibleRows = Math.max(1, this.layoutMetrics.bodyRows);
			const maxTop = Math.max(0, this.conversationLines.length - visibleRows);
			this.conversationFollow = target >= maxTop;
			this.conversationScrollTop = Math.min(maxTop, Math.max(0, target));
		} else if (this.detailView === "task") {
			const maxTop = Math.max(0, this.lastTaskLineCount - this.layoutMetrics.taskVisibleRows);
			this.taskScrollTop = Math.min(maxTop, Math.max(0, target));
		} else if (this.detailView === "final") {
			const visibleRows = Math.max(1, this.lastFinalVisibleRows);
			const maxTop = Math.max(0, this.lastFinalLineCount - visibleRows);
			this.finalScrollTop = Math.min(maxTop, Math.max(0, target));
		} else if (this.detailView === "raw") {
			const maxTop = Math.max(0, this.detailLines.length - this.layoutMetrics.rawVisibleRows);
			this.detailFollow = target >= maxTop;
			this.detailScrollTop = Math.min(maxTop, Math.max(0, target));
		} else {
			const maxTop = Math.max(0, this.lastSummaryLineCount - this.layoutMetrics.summaryVisibleRows);
			this.summaryScrollTop = Math.min(maxTop, Math.max(0, target));
		}
		this.tui.requestRender();
	}

	private scrollRawDetail(delta: number): void {
		const maxTop = Math.max(0, this.detailLines.length - this.layoutMetrics.rawVisibleRows);
		if (maxTop === 0) return;
		if (this.detailFollow) {
			this.detailFollow = false;
			this.detailScrollTop = maxTop;
		}
		this.detailScrollTop = Math.min(maxTop, Math.max(0, this.detailScrollTop + delta));
		if (this.detailScrollTop >= maxTop) {
			this.detailFollow = true;
			this.detailScrollTop = 0;
			void this.refreshDetailData();
		}
		this.tui.requestRender();
	}

	private async refreshDetailData(): Promise<void> {
		const frame = this.currentFrame();
		if (frame.kind !== "agent-detail") return;
		const wf = this.workflows.find((w) => w.workflowId === frame.workflowId);
		if (wf === undefined) return;

		try {
			const res = await this.readChildResultFn(wf.artifactDir, frame.childIndex);
			if (this.disposed) return;
			this.childResultDetails = res;
			const act = await this.readChildActivityFn(wf.artifactDir, frame.childIndex, frame.workflowId);
			if (this.disposed) return;
			this.childActivityDetails = act;
		} catch {
			if (this.disposed) return;
			this.childResultDetails = undefined;
			this.childActivityDetails = undefined;
		}

		const snapshot = this.snapshots.get(frame.workflowId);
		const child = snapshot?.children[frame.childIndex];
		let targetSession: ChildSessionRefV1 | undefined = child?.session;

		if (frame.nestedGroupId !== undefined && frame.nestedIndex !== undefined && child !== undefined) {
			const nested = child.nested.find(
				(n) => !isLeaseSnapshot(n) && n.groupId === frame.nestedGroupId && n.nestedIndex === frame.nestedIndex,
			);
			if (nested && !isLeaseSnapshot(nested)) {
				targetSession = nested.session;
			}
		}

		if (targetSession !== undefined && targetSession.sessionFile) {
			let tailState = this.tailStates.get(targetSession.sessionFile);
			if (tailState === undefined) {
				if (this.tailStates.size >= 50) {
					const oldest = this.tailStates.keys().next().value;
					if (oldest !== undefined) this.tailStates.delete(oldest);
				}
				tailState = createSessionTailState();
				this.tailStates.set(targetSession.sessionFile, tailState);
			}
			const tailRes = await this.tailSessionFn(tailState, targetSession.sessionFile);
			if (this.disposed) return;
			if (tailRes.changed || this.conversationLines.length === 0) {
				this.conversationLines = formatConversationRecords(tailRes.records, this.theme, Math.max(30, this.layoutMetrics.summaryVisibleRows * 4));
				if (this.conversationFollow) {
					this.conversationScrollTop = Math.max(0, this.conversationLines.length - this.layoutMetrics.bodyRows);
				}
			}
		} else {
			this.conversationLines = [];
		}

		if (frame.nestedGroupId !== undefined) {
			this.detailLines = [];
			this.tailBytesRead = 0;
			this.tailTotalBytes = 0;
			this.tailTruncated = false;
			this.tailError = undefined;
			if (!this.disposed) this.tui.requestRender();
			return;
		}

		if (!this.detailFollow) return;
		const outputPath = join(wf.artifactDir, "children", String(frame.childIndex), "output.txt");
		try {
			const read = await this.readOutputTailFn(outputPath, DETAIL_TAIL_BYTES);
			if (this.disposed) return;
			this.detailLines = toOutputLines(read.content);
			this.tailBytesRead = read.bytesRead;
			this.tailTotalBytes = read.totalBytes;
			this.tailTruncated = read.truncated;
			this.tailError = undefined;
		} catch (error) {
			if (this.disposed) return;
			this.detailLines = [];
			this.tailBytesRead = 0;
			this.tailTotalBytes = 0;
			this.tailTruncated = false;
			this.tailError = hasErrorCode(error, "ENOENT")
				? "No output yet"
				: `Output read error: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!this.disposed) {
			this.tui.requestRender();
		}
	}

	private ensureSelectionVisible(): void {
		const listVisibleRows = this.layoutMetrics.listVisibleRows;
		if (this.selectedIndex < this.listScroll) {
			this.listScroll = this.selectedIndex;
		} else if (this.selectedIndex >= this.listScroll + listVisibleRows) {
			this.listScroll = this.selectedIndex - listVisibleRows + 1;
		}
	}

	render(width: number): string[] {
		const boxWidth = Math.max(3, Math.floor(width));
		const frame = this.currentFrame();
		if (frame.kind === "agent-detail") {
			return this.renderDetail(boxWidth, frame);
		}
		return this.renderList(boxWidth);
	}

	private frameBox(
		title: string,
		subtitle: string,
		body: readonly string[],
		footer: string,
		width: number,
	): string[] {
		const inner = Math.max(1, width - 2);
		const top = blueBorder(`╭${"─".repeat(inner)}╮`);
		const bottom = blueBorder(`╰${"─".repeat(inner)}╯`);
		const row = (content = "") =>
			`${blueBorder("│")}${padAnsi(truncateToWidth(content, inner), inner)}${blueBorder("│")}`;
		const header = lightBlue(padAnsi(` ${title}`, inner));
		const subtitleLine = subtitle
			? lightBlue(padAnsi(` ${subtitle}`, inner))
			: lightBlue(" ".repeat(inner));
		const lines = [top, row(header), row(subtitleLine), row()];
		for (const line of body) lines.push(row(line));
		lines.push(row());
		lines.push(row(footer));
		lines.push(bottom);
		return lines;
	}

	private renderList(width: number): string[] {
		const now = this.nowFn();
		const nowMs = now.getTime();

		let activeWorkflowCount = 0;
		let sharedSlots: number | undefined;
		for (const wf of this.workflows) {
			const s = this.snapshots.get(wf.workflowId);
			if (s !== undefined) {
				if (!s.committed || s.counts.running > 0) {
					activeWorkflowCount++;
					if (sharedSlots === undefined && typeof s.slots?.active === "number") {
						sharedSlots = s.slots.active;
					}
				}
			} else if (!wf.committed) {
				activeWorkflowCount++;
			}
		}

		if (sharedSlots === undefined) {
			for (const s of this.snapshots.values()) {
				if (typeof s.slots?.active === "number") {
					sharedSlots = s.slots.active;
					break;
				}
			}
		}
		const activeSlots = sharedSlots ?? 0;

		const filteredWorkflows = this.workflows.filter((wf) => {
			if (this.showHistory) return true;
			const s = this.snapshots.get(wf.workflowId);
			if (s === undefined) {
				return !wf.committed;
			}
			return !s.committed || s.counts.running > 0;
		});

		const rows: Array<{ item: NavigableItem; text: string }> = [];
		for (const wf of filteredWorkflows) {
			const snapshot = this.snapshots.get(wf.workflowId);
			if (wf.manifest.kind === "pending" && snapshot === undefined) {
				const title = `  dstack · launching (${wf.workflowId.slice(0, 8)})`;
				rows.push({
					item: { type: "workflow", workflowId: wf.workflowId },
					text: this.theme.fg("accent", title),
				});
				continue;
			}

			if (wf.manifest.kind === "corrupt" || snapshot === undefined) {
				const title = `  dstack · (unreadable workflow ${wf.workflowId.slice(0, 8)})`;
				rows.push({
					item: { type: "workflow", workflowId: wf.workflowId },
					text: this.theme.fg("dim", title),
				});
				continue;
			}

			const label = snapshot.playbook ?? snapshot.mode;
			const totalElapsed = formatElapsed(computeWorkflowElapsed(snapshot, nowMs));
			const isCollapsed = this.collapsedWorkflows.has(wf.workflowId);
			const expandIcon = isCollapsed ? "[+]" : "[-]";
			let headerText = `  ${expandIcon} dstack · ${label} · ${snapshot.counts.complete}/${snapshot.counts.total} done · ${totalElapsed}`;
			if (!snapshot.committed) {
				headerText += ` · slots ${snapshot.slots.active}/${snapshot.slots.capacity}`;
			}
			rows.push({
				item: { type: "workflow", workflowId: wf.workflowId },
				text: this.theme.fg("accent", headerText),
			});

			if (!isCollapsed) {
				for (let i = 0; i < snapshot.children.length; i++) {
					const child = snapshot.children[i];
					if (child === undefined) continue;
					const childOrdinal = i + 1;
					const dimOrdinal = this.theme.fg("dim", `${childOrdinal}`);
					const childGroups = child.nestedGroups ?? (child.nested ? groupNestedChildren(child.nested) : []);
					const isLastChild = i === snapshot.children.length - 1 && childGroups.length === 0;
					const guide = this.theme.fg("dim", isLastChild ? "    └─ " : "    ├─ ");
					const glyph = glyphForState(child.state, this.theme);
					const role = child.assignment ? `${child.assignment} ${child.agent}` : child.role ? `${child.role} ${child.agent}` : child.agent;
					const phase = child.phase ? ` · phase ${child.phase}` : "";
					const duration = child.state === "queued"
						? `queued ${formatElapsed(Math.max(0, nowMs - Date.parse(snapshot.createdAt)))}`
						: child.startedAt
							? formatElapsed(Math.max(0, (child.endedAt ? Date.parse(child.endedAt) : nowMs) - Date.parse(child.startedAt)))
							: "";
					const durationFormatted = duration ? ` (${duration})` : "";
					const staleTag = child.stale ? ` ${this.theme.fg("warning", "⚠ stale")}` : "";
					const detail = child.outcome
						? ` — ${child.outcome}`
						: child.activity?.text
							? ` — ${child.activity.text}`
							: child.taskPreview
								? ` ${child.taskPreview}`
								: "";

					const childRow = `${guide}${dimOrdinal} ${glyph} ${role}${phase}${durationFormatted}${staleTag}${detail}`;
					rows.push({
						item: { type: "child", workflowId: wf.workflowId, childIndex: i },
						text: childRow,
					});

					for (let gIdx = 0; gIdx < childGroups.length; gIdx++) {
						const group = childGroups[gIdx];
						if (group === undefined) continue;
						const isLastGroup = gIdx === childGroups.length - 1;
						const groupGuide = this.theme.fg("dim", isLastGroup ? "       └─ " : "       ├─ ");
						const groupLabelText = formatGroupLabel(group);

						rows.push({
							item: {
								type: "nested-group",
								workflowId: wf.workflowId,
								childIndex: i,
								groupId: group.groupId,
							},
							text: `${groupGuide}${this.theme.fg("dim", groupLabelText)}`,
						});

						for (let j = 0; j < group.children.length; j++) {
							const nested = group.children[j];
							if (nested === undefined) continue;
							const nestedOrdinal = j + 1;
							const dimNestedOrdinal = this.theme.fg("dim", `${nestedOrdinal}`);
							const isLastNested = j === group.children.length - 1;
							const nestedPrefix = isLastGroup ? "          " : "       │  ";
							const nestedGuide = this.theme.fg("dim", `${nestedPrefix}${isLastNested ? "└─ " : "├─ "}`);

							if (isLeaseSnapshot(nested)) {
								const leaseElapsed = formatElapsed(Math.max(0, nowMs - Date.parse(nested.acquiredAt)));
								const nestedRow = `${nestedGuide}${dimNestedOrdinal} ${this.theme.fg("accent", "◐")} agent details pending (${leaseElapsed})`;
								rows.push({
									item: { type: "child", workflowId: wf.workflowId, childIndex: i },
									text: nestedRow,
								});
							} else {
								const nGlyph = glyphForState(nested.state, this.theme);
								const nRole = nested.assignment ? `${nested.assignment} ${nested.agent}` : nested.role ? `${nested.role} ${nested.agent}` : nested.agent;
								const nDuration = nested.startedAt
									? ` (${formatElapsed(Math.max(0, (nested.endedAt ? Date.parse(nested.endedAt) : nowMs) - Date.parse(nested.startedAt)))})`
									: "";
								const nDetailText = nestedChildDetail(nested);
								const nDetail = nDetailText ? (nested.state === "queued" || nested.state === "skipped" ? ` ${nDetailText}` : ` — ${nDetailText}`) : "";
								const nStale = nested.stale ? ` ${this.theme.fg("warning", "⚠ stale")}` : "";
								const nestedRow = `${nestedGuide}${dimNestedOrdinal} ${nGlyph} ${nRole}${nDuration}${nStale}${nDetail}`;
								rows.push({
									item: {
										type: "nested",
										workflowId: wf.workflowId,
										childIndex: i,
										nestedGroupId: nested.groupId,
										nestedIndex: nested.nestedIndex,
									},
									text: nestedRow,
								});
							}
						}
					}
				}
			}
		}

		this.visibleItems = rows.map((r) => r.item);
		if (this.selectedIndex >= this.visibleItems.length) {
			this.selectedIndex = Math.max(0, this.visibleItems.length - 1);
		}
		this.ensureSelectionVisible();

		const subtitleParts: string[] = [];
		if (this.showHistory) {
			subtitleParts.push(`${activeWorkflowCount} active`, `${this.workflows.length} total`);
		} else {
			subtitleParts.push(activeWorkflowCount > 0 ? `${activeWorkflowCount} active workflow${activeWorkflowCount === 1 ? "" : "s"}` : "No active workflows");
		}
		subtitleParts.push(`slots ${activeSlots}`, this.theme.fg("dim", "↓ new"));
		const subtitle = subtitleParts.join(" · ");

		const listVisibleRows = this.layoutMetrics.listVisibleRows;
		const bodyRows = this.layoutMetrics.bodyRows;
		const body: string[] = [];
		if (this.loadError !== undefined && this.workflows.length === 0) {
			body.push(this.theme.fg("error", `  Failed to load dstack workflows: ${this.loadError}`));
		} else if (rows.length === 0) {
			const msg = this.workflows.length === 0
				? "  No dstack agents in this session yet. dstack_task launches appear here."
				: "  No active dstack workflows. Press h to show recent history.";
			body.push(this.theme.fg("dim", msg));
		} else {
			const visibleSlice = rows.slice(this.listScroll, this.listScroll + listVisibleRows);
			for (let i = 0; i < visibleSlice.length; i++) {
				const r = visibleSlice[i];
				if (r === undefined) continue;
				const realIdx = this.listScroll + i;
				const isSelected = realIdx === this.selectedIndex;
				const pointer = isSelected ? "›" : " ";
				let rowLine = `${pointer} ${r.text}`;
				if (isSelected) {
					rowLine = lightBlue(padAnsi(truncateToWidth(rowLine, width - 2), width - 2));
				}
				body.push(rowLine);
			}

			if (rows.length > listVisibleRows) {
				const start = this.listScroll + 1;
				const end = Math.min(rows.length, this.listScroll + listVisibleRows);
				body.push(this.theme.fg("dim", `  Showing ${start}-${end} of ${rows.length}`));
			}
		}

		while (body.length < bodyRows) {
			body.push("");
		}
		if (body.length > bodyRows) {
			body.length = bodyRows;
		}

		const footer = ` ${this.theme.fg("dim", `↑/↓ select · Enter/→ inspect · h ${this.showHistory ? "hide" : "show"} history · Esc/q close`)}`;
		return this.frameBox("dstack agent inspector", subtitle, body, footer, width);
	}

	private renderDetail(width: number, frame: Extract<Frame, { kind: "agent-detail" }>): string[] {
		const now = this.nowFn();
		const nowMs = now.getTime();
		const snapshot = this.snapshots.get(frame.workflowId);
		const wf = this.workflows.find((w) => w.workflowId === frame.workflowId);

		if (snapshot === undefined || wf === undefined) {
			const body = [this.theme.fg("dim", "Workflow snapshot unavailable.")];
			while (body.length < this.layoutMetrics.bodyRows) {
				body.push("");
			}
			return this.frameBox("agent detail", "unknown", body, " Esc/← back · q close", width);
		}

		const child = snapshot.children[frame.childIndex];
		if (child === undefined) {
			const body = [this.theme.fg("dim", "Child agent record unavailable.")];
			while (body.length < this.layoutMetrics.bodyRows) {
				body.push("");
			}
			return this.frameBox("agent detail", "unknown", body, " Esc/← back · q close", width);
		}

		let nestedMatch: NestedChild | undefined;
		if (frame.nestedGroupId !== undefined && frame.nestedIndex !== undefined) {
			const allNested = child.nested.length > 0
				? child.nested
				: (child.nestedGroups ?? []).flatMap((g) => g.children);
			nestedMatch = allNested.find((n) => !isLeaseSnapshot(n) && n.groupId === frame.nestedGroupId && n.nestedIndex === frame.nestedIndex);
		}

		const rawResult: BoundedReadResult | undefined = this.detailLines.length > 0 || this.tailBytesRead > 0
			? {
					content: this.detailLines.join("\n"),
					truncated: this.tailTruncated,
					bytesRead: this.tailBytesRead,
					totalBytes: this.tailTotalBytes,
				}
			: undefined;

		const inspection = buildAgentInspection(
			snapshot,
			child,
			nestedMatch,
			this.childResultDetails,
			this.childActivityDetails,
			rawResult,
			this.tailError,
			nowMs,
		);

		const title = inspection.identity.depth === 2
			? `nested agent: ${inspection.identity.agent} (depth 2)`
			: `agent: ${inspection.identity.agent} (depth 1)`;

		const subtitle = this.renderDetailSubtitle(inspection);

		let body: string[] = [];
		let footer = "";

		const isCompleted = inspection.status.state !== "running" && inspection.status.state !== "queued";
		const hasSession = inspection.session !== undefined;
		const actionHint = isCompleted && hasSession ? " · u resume · k fork" : "";

		switch (this.detailView) {
			case "conversation":
				body = this.renderConversationView(width, inspection);
				footer = ` ${this.theme.fg("dim", `wheel/PgUp/PgDn scroll · Home/End · s Summary · t Task · f Final · o Raw${actionHint} · Esc/← back · q close`)}`;
				break;
			case "task":
				body = this.renderTaskView(width, inspection);
				footer = ` ${this.theme.fg("dim", `wheel/PgUp/PgDn scroll · Home/End · c Conversation · s Summary · f Final · o Raw${actionHint} · Esc/← back · q close`)}`;
				break;
			case "final":
				body = this.renderFinalView(width, inspection);
				footer = ` ${this.theme.fg("dim", `wheel/PgUp/PgDn scroll · Home/End · c Conversation · s Summary · t Task · o Raw${actionHint} · Esc/← back · q close`)}`;
				break;
			case "raw":
				body = this.renderRawView(width, inspection);
				footer = ` ${this.theme.fg("dim", `wheel/keys · r refresh · c Conversation · s Summary · t Task · f Final${actionHint} · Esc/← back · q close`)}`;
				break;
			case "summary":
			default:
				body = this.renderSummaryView(width, inspection, snapshot, child, nowMs);
				footer = ` ${this.theme.fg("dim", `wheel/PgUp/PgDn scroll · Home/End · c Conversation · t Task · f Final · o Raw${actionHint} · Enter nested · Esc/← back · q close`)}`;
				break;
		}

		return this.frameBox(title, subtitle, body, footer, width);
	}

	private renderDetailSubtitle(inspection: AgentInspection): string {
		const tabs: Array<{ key: string; label: string; mode: DetailViewMode }> = [
			{ key: "c", label: "Conversation", mode: "conversation" },
			{ key: "s", label: "Summary", mode: "summary" },
			{ key: "t", label: "Task", mode: "task" },
			{ key: "f", label: "Final response", mode: "final" },
			{ key: "o", label: "Raw diagnostics", mode: "raw" },
		];

		const formattedTabs = tabs
			.map((t) => {
				if (t.mode === this.detailView) {
					return `[${t.mode === "conversation" ? "Conversation" : `${t.key} ${t.label}`}]`;
				}
				return t.mode === "conversation" ? "c Conversation" : `${t.key} ${t.label}`;
			})
			.join("   ");

		return `${inspection.identity.agent} · ${formattedTabs}`;
	}

	private renderConversationView(width: number, inspection: AgentInspection): string[] {
		const bodyRows = this.layoutMetrics.bodyRows;
		if (this.conversationLines.length === 0) {
			const emptyBody: string[] = [];
			if (inspection.status.state === "running" || inspection.status.state === "queued") {
				emptyBody.push("");
				emptyBody.push(`  ${this.theme.fg("dim", "Session starting / awaiting conversation records...")}`);
				if (inspection.status.recentActivity && inspection.status.recentActivity.length > 0) {
					for (const act of inspection.status.recentActivity) {
						emptyBody.push(`  ${this.theme.fg("dim", `• ${act}`)}`);
					}
				}
			} else if (inspection.session === undefined) {
				emptyBody.push("");
				emptyBody.push(`  ${this.theme.fg("dim", "No native Pi conversation recorded for this agent.")}`);
				emptyBody.push(`  ${this.theme.fg("dim", "Press 's' for Summary, 't' for Task, or 'o' for Raw diagnostics.")}`);
			} else {
				emptyBody.push("");
				emptyBody.push(`  ${this.theme.fg("dim", "(empty conversation)")}`);
			}
			while (emptyBody.length < bodyRows) {
				emptyBody.push("");
			}
			return emptyBody;
		}

		if (this.conversationFollow) {
			this.conversationScrollTop = Math.max(0, this.conversationLines.length - bodyRows);
		}

		const maxTop = Math.max(0, this.conversationLines.length - bodyRows);
		const start = Math.min(this.conversationScrollTop, maxTop);
		const windowLines = this.conversationLines.slice(start, start + bodyRows);
		const body: string[] = [...windowLines];

		while (body.length < bodyRows) {
			body.push("");
		}
		if (body.length > bodyRows) {
			body.length = bodyRows;
		}
		return body;
	}

	private renderSummaryView(
		width: number,
		inspection: AgentInspection,
		snapshot: TreeSnapshot,
		child: TreeChild,
		nowMs: number,
	): string[] {
		const lines: string[] = [];
		const { identity, status, timing, input, output } = inspection;

		const stateGlyph = glyphForState(status.state, this.theme);
		const durationText = timing.elapsedMs !== undefined ? formatElapsed(timing.elapsedMs) : "queued";

		lines.push(
			` ${this.theme.fg("toolTitle", "Agent:")} ${this.theme.fg("accent", identity.agent)} ${this.theme.fg("dim", `· depth ${identity.depth}`)}`,
		);
		if (identity.assignment) {
			lines.push(` ${this.theme.fg("toolTitle", "Assignment:")} ${this.theme.fg("accent", identity.assignment)}`);
		}
		if (identity.role) {
			const resolvedModel = identity.model ? ` → ${identity.model}` : "";
			lines.push(` ${this.theme.fg("toolTitle", "Role:")} ${this.theme.fg("accent", identity.role)}${this.theme.fg("dim", resolvedModel)}`);
		}

		if (identity.parentIdentity !== undefined) {
			lines.push(
				` ${this.theme.fg("toolTitle", "Parent:")} ${this.theme.fg("accent", identity.parentIdentity.agent)} ${this.theme.fg("dim", `(child #${identity.parentIdentity.childIndex}) · workflow ${snapshot.playbook ?? snapshot.mode}`)}`,
			);
		} else {
			lines.push(
				` ${this.theme.fg("toolTitle", "Workflow:")} ${this.theme.fg("accent", snapshot.playbook ?? snapshot.mode)} ${this.theme.fg("dim", `· task ${snapshot.taskId} · wf ${snapshot.workflowId.slice(0, 8)}`)}`,
			);
		}

		lines.push(
			` ${this.theme.fg("toolTitle", "Status:")} ${stateGlyph} ${status.state} ${this.theme.fg("dim", `(${durationText})`)}`,
		);

		if (status.phase) {
			lines.push(` ${this.theme.fg("toolTitle", "Phase:")} ${this.theme.fg("accent", status.phase)}`);
		}

		if (status.activity) {
			lines.push(` ${this.theme.fg("toolTitle", "Activity:")} ${status.activity}`);
		}

		if (status.stale) {
			lines.push(` ${this.theme.fg("warning", "⚠ Stale: agent heartbeat missing in > 120s")}`);
		}

		if (status.outcome) {
			lines.push(` ${this.theme.fg("toolTitle", "Outcome:")} ${status.outcome}`);
		}

		if (timing.startedAt || timing.endedAt) {
			const startStr = timing.startedAt ? timing.startedAt.slice(11, 19) : "-";
			const endStr = timing.endedAt ? timing.endedAt.slice(11, 19) : "-";
			lines.push(` ${this.theme.fg("toolTitle", "Timing:")} ${this.theme.fg("dim", `started ${startStr} · ended ${endStr} (${durationText})`)}`);
		}

		if (identity.model) {
			lines.push(` ${this.theme.fg("toolTitle", "Model:")} ${this.theme.fg("dim", identity.model)}`);
		} else if (identity.depth === 2) {
			lines.push(` ${this.theme.fg("toolTitle", "Model:")} ${this.theme.fg("dim", "unavailable")}`);
		}

		const turnCount = timing.turns;
		const ctxTokens = timing.contextTokens;
		const inTok = timing.inputTokens;
		const outTok = timing.outputTokens;
		const cost = timing.cost;
		if (turnCount !== undefined || ctxTokens !== undefined || inTok !== undefined || cost !== undefined) {
			const parts: string[] = [];
			if (turnCount !== undefined) parts.push(`${turnCount} turn${turnCount === 1 ? "" : "s"}`);
			if (ctxTokens !== undefined) parts.push(`ctx ${ctxTokens.toLocaleString()} tok`);
			if (inTok !== undefined && outTok !== undefined) parts.push(`${inTok.toLocaleString()}/${outTok.toLocaleString()} in/out`);
			if (cost !== undefined) parts.push(`$${cost.toFixed(4)}`);
			lines.push(` ${this.theme.fg("toolTitle", "Telemetry:")} ${this.theme.fg("dim", parts.join(" · "))}`);
		}

		if (status.recentActivity !== undefined && status.recentActivity.length > 0) {
			lines.push("");
			lines.push(` ${this.theme.fg("toolTitle", "Recent Activity:")}`);
			for (const act of status.recentActivity) {
				lines.push(`   ${this.theme.fg("dim", "•")} ${truncateToWidth(act, width - 8)}`);
			}
		}

		lines.push("");
		lines.push(` ${this.theme.fg("toolTitle", "Input Envelope:")}`);
		const taskPreview = input.taskPreview || "(no task)";
		lines.push(`   Task: ${truncateToWidth(taskPreview.replace(/\n/g, " "), width - 20)} ${this.theme.fg("dim", "(press 't' for full task)")}`);
		if (input.cwd) lines.push(`   Cwd: ${this.theme.fg("dim", input.cwd)}`);
		if (input.tools) lines.push(`   Tools: ${this.theme.fg("dim", input.tools)}`);
		if (input.workflow) {
			lines.push(`   Workflow: ${this.theme.fg("dim", `playbook: ${input.workflow.playbook} · phase: ${input.workflow.phase}`)}`);
			if (input.workflow.completedPhases.length > 0) {
				lines.push(`   Completed phases: ${this.theme.fg("dim", `[${input.workflow.completedPhases.join(", ")}]`)}`);
			}
			if (input.workflow.artifacts.length > 0) {
				lines.push(`   Artifacts: ${this.theme.fg("dim", `[${input.workflow.artifacts.map((a) => a.name).join(", ")}]`)}`);
			}
		}

		lines.push("");
		lines.push(` ${this.theme.fg("toolTitle", "Output Envelope:")}`);
		if (output !== undefined) {
			const outGlyph = glyphForState(output.state, this.theme);
			const exitCodeStr = output.exitCode !== undefined ? `exitCode ${output.exitCode}` : "";
			const stopStr = output.stopReason ? `stop: ${output.stopReason}` : "";
			const headParts = [exitCodeStr, stopStr].filter((s) => s.length > 0).join(" · ");
			lines.push(`   ${outGlyph} ${output.state}${headParts ? ` (${headParts})` : ""} ${this.theme.fg("dim", `[provenance: ${output.provenance}]`)}`);
			if (output.provenance === "sealed-result" && output.seal) {
				lines.push(`   Artifact seal: ${this.theme.fg("dim", `${output.seal.path} (sha256: ${output.seal.sha256.slice(0, 12)}..., ${output.seal.bytes} B)`)}`);
			}
			if (output.finalText) {
				lines.push(`   Final response: ${this.theme.fg("dim", `${output.finalText.length} chars (press 'f' to view)`)}`);
			}
			if (output.errorMessage) {
				lines.push(`   ${this.theme.fg("error", `Error: ${truncateToWidth(output.errorMessage, width - 12)}`)}`);
			}
			if (output.stderr) {
				lines.push(`   ${this.theme.fg("error", `Stderr: ${truncateToWidth(output.stderr.split("\n")[0] ?? "", width - 12)}`)}`);
			}
		} else {
			lines.push(`   ${this.theme.fg("dim", "(no output envelope recorded yet)")}`);
		}

		if (status.todos !== undefined && status.todos.length > 0) {
			lines.push("");
			lines.push(` ${this.theme.fg("toolTitle", "Todos:")}`);
			for (const item of status.todos) {
				const check = item.status === "completed"
					? this.theme.fg("success", "☑")
					: item.status === "in_progress"
						? this.theme.fg("accent", "◐")
						: this.theme.fg("dim", "☐");
				const itemText = item.status === "completed" && this.theme.strikethrough !== undefined
					? this.theme.fg("dim", this.theme.strikethrough(item.content))
					: item.content;
				lines.push(`   ${check} ${truncateToWidth(itemText, width - 10)}`);
			}
		}

		if (identity.depth === 1 && child.nested.length > 0) {
			lines.push("");
			lines.push(` ${this.theme.fg("toolTitle", "Nested agents (Enter/→ to inspect):")}`);
			for (const n of child.nested) {
				if (isLeaseSnapshot(n)) {
					const leaseElapsed = formatElapsed(Math.max(0, nowMs - Date.parse(n.acquiredAt)));
					lines.push(`   ${this.theme.fg("accent", "◐")} agent details pending (${leaseElapsed})`);
				} else {
					const nGlyph = glyphForState(n.state, this.theme);
					const nRole = n.assignment ? `${n.assignment} ${n.agent}` : n.role ? `${n.role} ${n.agent}` : n.agent;
					const nDuration = n.startedAt
						? ` (${formatElapsed(Math.max(0, (n.endedAt ? Date.parse(n.endedAt) : nowMs) - Date.parse(n.startedAt)))})`
						: "";
					const nDetailText = nestedChildDetail(n);
					const nDetail = nDetailText ? ` — ${nDetailText}` : "";
					lines.push(`   ${nGlyph} ${nRole}${nDuration}${nDetail}`);
				}
			}
		}

		this.lastSummaryLineCount = lines.length;
		const summaryVisibleRows = this.layoutMetrics.summaryVisibleRows;
		const bodyRows = this.layoutMetrics.bodyRows;
		const maxTop = Math.max(0, lines.length - summaryVisibleRows);
		const start = Math.min(this.summaryScrollTop, maxTop);
		const end = Math.min(lines.length, start + summaryVisibleRows);
		const windowLines = lines.slice(start, end);
		const body: string[] = [...windowLines];

		if (lines.length > summaryVisibleRows) {
			if (body.length < bodyRows - 1) {
				body.push("");
			}
			body.push(` ${this.theme.fg("dim", `lines ${start + 1}-${end} of ${lines.length}`)}`);
		}

		while (body.length < bodyRows) {
			body.push("");
		}
		if (body.length > bodyRows) {
			body.length = bodyRows;
		}

		return body;
	}

	private renderTaskView(width: number, inspection: AgentInspection): string[] {
		const inner = Math.max(1, width - 4);
		const fullTask = inspection.input.task.trim() || "(no task content)";
		const wrappedLines = wrapText(fullTask, inner - 2);
		this.lastTaskLineCount = wrappedLines.length;

		const body: string[] = [
			` ${this.theme.fg("toolTitle", "Full Task Content:")} ${this.theme.fg("dim", `(${fullTask.length} chars · no truncation)`)}`,
			"",
		];

		const taskVisibleRows = this.layoutMetrics.taskVisibleRows;
		const bodyRows = this.layoutMetrics.bodyRows;
		const maxTop = Math.max(0, wrappedLines.length - taskVisibleRows);
		const start = Math.min(this.taskScrollTop, maxTop);
		const end = Math.min(wrappedLines.length, start + taskVisibleRows);
		const windowLines = wrappedLines.slice(start, end);

		for (const line of windowLines) {
			body.push(`  ${line}`);
		}

		if (body.length < bodyRows - 1) {
			body.push("");
		}
		body.push(` ${this.theme.fg("dim", `lines ${start + 1}-${end} of ${wrappedLines.length} · ↑/↓ PgUp/PgDn scroll · Home/End top/bottom · s Summary`)}`);

		while (body.length < bodyRows) {
			body.push("");
		}
		if (body.length > bodyRows) {
			body.length = bodyRows;
		}

		return body;
	}

	private renderFinalView(width: number, inspection: AgentInspection): string[] {
		const inner = Math.max(1, width - 4);
		const output = inspection.output;
		const headerLines: string[] = [];

		if (output !== undefined) {
			const exitCodeStr = output.exitCode !== undefined ? `exitCode ${output.exitCode}` : "exitCode -";
			const stopStr = output.stopReason ? `stop: ${output.stopReason}` : "";
			const modelStr = output.model ? `model: ${output.model}` : "";
			const headerMeta = [exitCodeStr, stopStr, modelStr].filter((s) => s.length > 0).join(" · ");
			headerLines.push(` ${this.theme.fg("toolTitle", "Envelope:")} ${this.theme.fg("dim", `provenance: ${output.provenance} · ${headerMeta}`)}`);

			if (output.provenance === "sealed-result" && output.seal) {
				headerLines.push(` ${this.theme.fg("toolTitle", "Seal:")} ${this.theme.fg("dim", `${output.seal.path} (sha256: ${output.seal.sha256}, ${output.seal.bytes} B)`)}`);
			}
			if (output.usage) {
				headerLines.push(` ${this.theme.fg("toolTitle", "Usage:")} ${this.theme.fg("dim", `${output.usage.turns} turns · ${output.usage.contextTokens} ctx tok · $${output.usage.cost}`)}`);
			}
			if (output.errorMessage) {
				headerLines.push(` ${this.theme.fg("error", `Error: ${output.errorMessage}`)}`);
			}
			if (output.stderr) {
				headerLines.push(` ${this.theme.fg("error", `Stderr: ${output.stderr.split("\n")[0] ?? ""}`)}`);
			}
		} else {
			headerLines.push(` ${this.theme.fg("dim", "No output envelope recorded yet.")}`);
		}

		const finalHeading = ` ${this.theme.fg("toolTitle", "Final Response (free-form text):")}`;
		headerLines.push("", finalHeading);

		const finalText = output?.finalText?.trim() || "(no final response text recorded)";
		const wrappedLines = wrapText(finalText, inner - 2);
		this.lastFinalLineCount = wrappedLines.length;

		const bodyRows = this.layoutMetrics.bodyRows;
		const maxHeaderRows = Math.max(0, bodyRows - 2);
		const visibleHeaderLines = headerLines.length <= maxHeaderRows
			? headerLines
			: maxHeaderRows >= 2
				? [headerLines[0] ?? finalHeading, finalHeading]
				: maxHeaderRows === 1
					? [finalHeading]
					: [];
		const statusLineSpace = bodyRows - visibleHeaderLines.length >= 3 ? 2 : 1;
		const actualVisibleRows = Math.max(0, bodyRows - visibleHeaderLines.length - statusLineSpace);
		this.lastFinalVisibleRows = Math.max(1, actualVisibleRows);

		const maxTop = Math.max(0, wrappedLines.length - this.lastFinalVisibleRows);
		const start = Math.min(this.finalScrollTop, maxTop);
		const end = Math.min(wrappedLines.length, start + actualVisibleRows);
		const windowLines = wrappedLines.slice(start, end);

		const body: string[] = [...visibleHeaderLines];
		for (const line of windowLines) {
			body.push(`  ${line}`);
		}

		while (body.length < bodyRows - 1) {
			body.push("");
		}
		body.push(` ${this.theme.fg("dim", `lines ${start + 1}-${end} of ${wrappedLines.length} · ↑/↓ PgUp/PgDn scroll · Home/End top/bottom · s Summary`)}`);

		while (body.length < bodyRows) {
			body.push("");
		}
		if (body.length > bodyRows) {
			body.length = bodyRows;
		}

		return body;
	}

	private renderRawView(width: number, inspection: AgentInspection): string[] {
		const body: string[] = [];
		const raw = inspection.raw;
		const bodyRows = this.layoutMetrics.bodyRows;

		if (raw.kind === "output-tail") {
			body.push(` ${this.theme.fg("toolTitle", "Raw output.txt tail (secondary view):")}`);
			body.push(...this.renderOutputBox(width - 4));
			while (body.length < bodyRows) {
				body.push("");
			}
			if (body.length > bodyRows) {
				body.length = bodyRows;
			}
			return body;
		}

		if (raw.kind === "recorded-final-only") {
			body.push(` ${this.theme.fg("toolTitle", "Raw Output:")}`);
			body.push("");
			body.push(`  ${this.theme.fg("dim", "Raw output.txt tail is not captured separately for depth-2 child agents.")}`);
			body.push(`  ${this.theme.fg("dim", "The recorded final response is available in the Final response view (press 'f').")}`);
			while (body.length < bodyRows - 1) {
				body.push("");
			}
			body.push(` ${this.theme.fg("dim", "f Final response · s Summary · Esc/← back")}`);
			while (body.length < bodyRows) {
				body.push("");
			}
			if (body.length > bodyRows) {
				body.length = bodyRows;
			}
			return body;
		}

		body.push(` ${this.theme.fg("toolTitle", "Raw Output:")}`);
		body.push("");
		body.push(`  ${this.theme.fg("dim", `Raw output tail unavailable: ${raw.reason ?? "no output file"}`)}`);
		while (body.length < bodyRows - 1) {
			body.push("");
		}
		body.push(` ${this.theme.fg("dim", "s Summary · t Task · f Final · Esc/← back")}`);
		while (body.length < bodyRows) {
			body.push("");
		}
		if (body.length > bodyRows) {
			body.length = bodyRows;
		}
		return body;
	}

	private renderOutputBox(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const rawVisibleRows = this.layoutMetrics.rawVisibleRows;
		const top = ` ${blueBorder(`╭${"─".repeat(inner)}╮`)}`;
		const bottom = ` ${blueBorder(`╰${"─".repeat(inner)}╯`)}`;
		const row = (content = "") =>
			` ${blueBorder("│")}${padAnsi(truncateToWidth(content, inner), inner)}${blueBorder("│")}`;
		const lines = [top];

		if (this.tailError) {
			lines.push(row(this.theme.fg("dim", `  ${this.tailError}`)));
		} else if (this.detailLines.length === 0) {
			lines.push(row(this.theme.fg("dim", "  (no output recorded)")));
		} else {
			const maxTop = Math.max(0, this.detailLines.length - rawVisibleRows);
			const start = this.detailFollow ? maxTop : Math.min(this.detailScrollTop, maxTop);
			const windowLines = this.detailLines.slice(start, start + rawVisibleRows);
			for (const line of windowLines) {
				lines.push(row(`  ${line}`));
			}
		}

		while (lines.length < rawVisibleRows + 1) {
			lines.push(row());
		}
		lines.push(bottom);
		lines.push(` ${this.theme.fg("dim", this.outputStatusLine())}`);
		return lines;
	}

	private outputStatusLine(): string {
		const total = this.detailLines.length;
		const rawVisibleRows = this.layoutMetrics.rawVisibleRows;
		if (!this.detailFollow && total > 0) {
			const maxTop = Math.max(0, total - rawVisibleRows);
			const start = Math.min(this.detailScrollTop, maxTop);
			const end = Math.min(total, start + rawVisibleRows);
			return `lines ${start + 1}-${end} of ${total} · ↑/↓ PgUp/PgDn scroll · ↓ at bottom follows · r resume`;
		}
		const suffix = this.tailTruncated ? ` of ${this.tailTotalBytes} bytes` : "";
		return `following tail ${this.tailBytesRead} bytes${suffix} · ↑ scroll to pause · r refresh`;
	}
}
