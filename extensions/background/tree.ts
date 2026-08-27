import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TodoItem, TodoStatus, WorkflowArtifact, WorkflowAssignment, WorkflowContext } from "../types.ts";
import type { ChildContentPart, ChildMessage, ChildResult, ChildUsage } from "../spawn.ts";
import { emptyTodos, loadTodos, parseTodoState } from "../todo.ts";
import {
	formatJournalEntry,
	formatRecentActivity,
	parseChildUsage,
	parseJournalEntries,
	parseJournalSnapshot,
	parseSemanticStatus,
	readJournalFile,
	readSemanticStatusFile,
	recentJournal,
	type JournalEntry,
	type SemanticStatus,
} from "./journal.ts";
import { MAX_ACTIVE_CHILDREN, snapshotActiveLeases, type LeaseSnapshot } from "./scheduler.ts";

export {
	formatJournalEntry,
	formatRecentActivity,
	parseChildUsage,
	parseJournalEntries,
	parseJournalSnapshot,
	parseSemanticStatus,
};

export const STALE_ACTIVITY_THRESHOLD_MS = 120_000;

function isFreshActivity(updatedAt: string, nowMs: number): boolean {
	const updatedMs = Date.parse(updatedAt);
	return Number.isFinite(updatedMs) && nowMs - updatedMs <= STALE_ACTIVITY_THRESHOLD_MS;
}

function semanticStatusText(status: SemanticStatus): string | undefined {
	const parts = [status.phase, status.note].filter((part): part is string => part !== undefined && part.length > 0);
	if (status.blocking) parts.push("[blocking]");
	return parts.length > 0 ? parts.join(": ") : undefined;
}

export type TreeChildState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export type ChildActivityV1 = Readonly<{
	schemaVersion: "dstack.child-activity.v1";
	workflowId: string;
	index: number;
	activity: string;
	updatedAt: string;
	turns: number;
	contextTokens: number;
}>;

export type SpawnChildV1 = Readonly<{
	nestedIndex: number;
	agent: string;
	role?: string;
	assignment?: "owner" | "worker" | "reviewer";
	taskPreview: string;
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
	activity?: string;
	status?: SemanticStatus;
	journal?: readonly JournalEntry[];
	updatedAt: string;
	startedAt?: string;
	endedAt?: string;
	taskFull?: string;
	workflow?: WorkflowContext;
	model?: string;
	cwd?: string;
	tools?: string;
	finalResponse?: string;
	errorMessage?: string;
	stderr?: string;
	stopReason?: string;
	exitCode?: number;
	usage?: ChildUsage;
}>;

export type SpawnRecordV1 = Readonly<{
	schemaVersion: "dstack.spawn-record.v1";
	workflowId: string;
	parentIndex: number;
	groupId: string;
	mode: "single" | "parallel" | "chain";
	phase?: string;
	createdAt: string;
	children: readonly SpawnChildV1[];
}>;

export type SpawnNestedChild = Readonly<{
	groupId: string;
	nestedIndex: number;
	agent: string;
	role?: string;
	assignment?: "owner" | "worker" | "reviewer";
	taskPreview: string;
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
	activity?: string;
	status?: SemanticStatus;
	journal?: readonly JournalEntry[];
	startedAt?: string;
	endedAt?: string;
	updatedAt: string;
	live: boolean;
	lease?: LeaseSnapshot;
	stale?: boolean;
	taskFull?: string;
	workflow?: WorkflowContext;
	model?: string;
	cwd?: string;
	tools?: string;
	finalResponse?: string;
	errorMessage?: string;
	stderr?: string;
	stopReason?: string;
	exitCode?: number;
	usage?: ChildUsage;
}>;

export type NestedChild = SpawnNestedChild | LeaseSnapshot;

export type ProgressChildV1 = Readonly<{
	index: number;
	agent: string;
	state: TreeChildState;
	role?: string;
	assignment?: "owner" | "worker" | "reviewer";
	startedAt?: string;
	endedAt?: string;
}>;

export type WorkflowProgressV2 = Readonly<{
	queued: number;
	running: number;
	complete: number;
	total: number;
	children: readonly ProgressChildV1[];
}>;

export type TreeChild = ProgressChildV1 & Readonly<{
	taskPreview: string;
	taskFull?: string;
	phase?: string;
	activity?: Readonly<{ text: string; updatedAt: string }>;
	status?: SemanticStatus;
	journal?: readonly JournalEntry[];
	stale?: boolean;
	outcome?: string;
	workflow?: WorkflowContext;
	cwd?: string;
	model?: string;
	tools?: string;
	nested: readonly NestedChild[];
}>;

export type TreeSnapshot = Readonly<{
	taskId: string;
	workflowId: string;
	mode: "single" | "parallel" | "chain";
	playbook?: string;
	createdAt: string;
	committed: boolean;
	counts: Readonly<{ queued: number; running: number; complete: number; total: number }>;
	slots: Readonly<{ active: number; capacity: number }>;
	children: readonly TreeChild[];
	todos: readonly TodoItem[];
	todoOwner?: string;
	todoCounts: Readonly<{ total: number; completed: number; inProgress: number }>;
	capturedAt: string;
}>;

export interface TreeTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	strikethrough?(text: string): string;
}

export type RenderTreeOptions = Readonly<{
	width: number;
	maxLines?: number;
	now?: Date;
	theme?: TreeTheme;
	includeTodos?: boolean;
	expanded?: boolean;
}>;

const ANSI_REGEX = /\x1b\[[0-9;]*m/gu;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

export function visibleWidth(text: string): number {
	return stripAnsi(text).length;
}

export function truncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const plain = stripAnsi(text);
	if (plain.length <= width) return text;
	if (width <= 3) return plain.slice(0, width);
	return `${plain.slice(0, width - 1)}…`;
}

export function formatElapsed(durationMs: number): string {
	const nonNegative = Math.max(0, Math.floor(durationMs));
	if (nonNegative < 3600_000) {
		const minutes = Math.floor(nonNegative / 60_000);
		const seconds = Math.floor((nonNegative % 60_000) / 1000);
		return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	}
	const hours = Math.floor(nonNegative / 3600_000);
	const minutes = Math.floor((nonNegative % 3600_000) / 60_000);
	return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

export function parseLeaseChildId(childId: string): { groupId: string; nestedIndex: number } {
	const lastHyphen = childId.lastIndexOf("-");
	if (lastHyphen === -1) {
		return { groupId: childId, nestedIndex: 0 };
	}
	const groupId = childId.slice(0, lastHyphen);
	const idxStr = childId.slice(lastHyphen + 1);
	const parsedIndex = Number.parseInt(idxStr, 10);
	return {
		groupId,
		nestedIndex: Number.isSafeInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0,
	};
}

const VALID_CHILD_STATES = new Set<string>([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"skipped",
]);

const VALID_SPAWN_CHILD_STATES = new Set<string>([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"skipped",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTreeChildState(value: unknown): value is TreeChildState {
	return typeof value === "string" && VALID_CHILD_STATES.has(value);
}

function isSpawnChildState(value: unknown): value is SpawnChildV1["state"] {
	return typeof value === "string" && VALID_SPAWN_CHILD_STATES.has(value);
}

function isWorkflowAssignment(value: unknown): value is "owner" | "worker" | "reviewer" {
	return value === "owner" || value === "worker" || value === "reviewer";
}

export function parseActivityV1(raw: unknown): ChildActivityV1 | undefined {
	if (!isRecord(raw)) return undefined;
	const { schemaVersion, workflowId, index, activity, updatedAt, turns, contextTokens } = raw;
	if (schemaVersion !== "dstack.child-activity.v1") return undefined;
	if (typeof workflowId !== "string" || workflowId === "") return undefined;
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return undefined;
	if (typeof activity !== "string") return undefined;
	if (typeof updatedAt !== "string" || updatedAt === "") return undefined;
	if (typeof turns !== "number" || !Number.isSafeInteger(turns) || turns < 0) return undefined;
	if (typeof contextTokens !== "number" || !Number.isSafeInteger(contextTokens) || contextTokens < 0) return undefined;

	return {
		schemaVersion: "dstack.child-activity.v1",
		workflowId,
		index,
		activity,
		updatedAt,
		turns,
		contextTokens,
	};
}

export function parseWorkflowContext(raw: unknown): WorkflowContext | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.playbook !== "string" || raw.playbook === "") return undefined;
	if (!isWorkflowAssignment(raw.assignment)) return undefined;
	if (typeof raw.phase !== "string") return undefined;

	const completedPhases: string[] = [];
	if (Array.isArray(raw.completedPhases)) {
		for (const p of raw.completedPhases) {
			if (typeof p === "string") completedPhases.push(p);
		}
	}

	const artifacts: WorkflowArtifact[] = [];
	if (Array.isArray(raw.artifacts)) {
		for (const a of raw.artifacts) {
			if (isRecord(a) && typeof a.name === "string" && typeof a.path === "string") {
				artifacts.push({
					name: a.name,
					path: a.path,
					sha256: typeof a.sha256 === "string" && a.sha256 !== "" ? a.sha256 : undefined,
				});
			}
		}
	}

	return {
		playbook: raw.playbook,
		assignment: raw.assignment,
		phase: raw.phase,
		completedPhases,
		artifacts,
	};
}

export function parseSpawnRecordV1(raw: unknown): SpawnRecordV1 | undefined {
	if (!isRecord(raw)) return undefined;
	const { schemaVersion, workflowId, parentIndex, groupId, mode, phase, createdAt, children: rawChildren } = raw;
	if (schemaVersion !== "dstack.spawn-record.v1") return undefined;
	if (typeof workflowId !== "string" || workflowId === "") return undefined;
	if (typeof parentIndex !== "number" || !Number.isSafeInteger(parentIndex) || parentIndex < 0) return undefined;
	if (typeof groupId !== "string" || groupId === "") return undefined;
	if (mode !== "single" && mode !== "parallel" && mode !== "chain") return undefined;
	if (typeof createdAt !== "string" || createdAt === "") return undefined;
	if (!Array.isArray(rawChildren)) return undefined;

	const children: SpawnChildV1[] = [];
	for (const item of rawChildren) {
		if (!isRecord(item)) continue;
		const {
			nestedIndex,
			agent,
			role,
			assignment,
			taskPreview,
			state,
			activity,
			status,
			journal,
			updatedAt,
			startedAt,
			endedAt,
			taskFull,
			workflow,
			model,
			cwd,
			tools,
			finalResponse,
			errorMessage,
			stderr,
			stopReason,
			exitCode,
			usage,
		} = item;
		if (typeof nestedIndex !== "number" || !Number.isSafeInteger(nestedIndex) || nestedIndex < 0) continue;
		if (typeof agent !== "string" || agent === "") continue;
		if (!isSpawnChildState(state)) continue;
		if (typeof taskPreview !== "string") continue;
		if (typeof updatedAt !== "string" || updatedAt === "") continue;

		children.push({
			nestedIndex,
			agent,
			role: typeof role === "string" && role !== "" ? role : undefined,
			assignment: isWorkflowAssignment(assignment) ? assignment : undefined,
			taskPreview,
			state,
			activity: typeof activity === "string" && activity !== "" ? activity : undefined,
			status: parseSemanticStatus(status),
			journal: parseJournalEntries(journal),
			updatedAt,
			startedAt: typeof startedAt === "string" && startedAt !== "" ? startedAt : undefined,
			endedAt: typeof endedAt === "string" && endedAt !== "" ? endedAt : undefined,
			taskFull: typeof taskFull === "string" && taskFull !== "" ? taskFull : undefined,
			workflow: parseWorkflowContext(workflow),
			model: typeof model === "string" && model !== "" ? model : undefined,
			cwd: typeof cwd === "string" && cwd !== "" ? cwd : undefined,
			tools: typeof tools === "string" && tools !== "" ? tools : undefined,
			finalResponse: typeof finalResponse === "string" ? finalResponse : undefined,
			errorMessage: typeof errorMessage === "string" && errorMessage !== "" ? errorMessage : undefined,
			stderr: typeof stderr === "string" && stderr !== "" ? stderr : undefined,
			stopReason: typeof stopReason === "string" && stopReason !== "" ? stopReason : undefined,
			exitCode: typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : undefined,
			usage: parseChildUsage(usage),
		});
	}

	return {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId,
		parentIndex,
		groupId,
		mode,
		phase: typeof phase === "string" && phase !== "" ? phase : undefined,
		createdAt,
		children,
	};
}

export function parseProgressV2(raw: unknown): WorkflowProgressV2 | undefined {
	if (!isRecord(raw)) return undefined;
	const { queued, running, complete, total, children: rawChildren } = raw;
	if (
		typeof queued !== "number" || !Number.isSafeInteger(queued) || queued < 0 ||
		typeof running !== "number" || !Number.isSafeInteger(running) || running < 0 ||
		typeof complete !== "number" || !Number.isSafeInteger(complete) || complete < 0 ||
		typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
	) {
		return undefined;
	}

	const children: ProgressChildV1[] = [];
	if (Array.isArray(rawChildren)) {
		for (const item of rawChildren) {
			if (!isRecord(item)) continue;
			const { index, agent, state, role, assignment, startedAt, endedAt } = item;
			if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue;
			if (typeof agent !== "string" || agent === "") continue;
			if (!isTreeChildState(state)) continue;

			children.push({
				index,
				agent,
				state,
				role: typeof role === "string" && role !== "" ? role : undefined,
				assignment: isWorkflowAssignment(assignment) ? assignment : undefined,
				startedAt: typeof startedAt === "string" && startedAt !== "" ? startedAt : undefined,
				endedAt: typeof endedAt === "string" && endedAt !== "" ? endedAt : undefined,
			});
		}
	}

	return { queued, running, complete, total, children };
}

export type ManifestSpecForTree = Readonly<{
	agent: string;
	task: string;
	requestedRole?: string;
	assignment?: "owner" | "worker" | "reviewer";
	playbook?: string;
	phase?: string;
	workflow?: WorkflowContext;
	cwd?: string;
	model?: string;
	tools?: string;
}>;

export type ManifestForTree = Readonly<{
	workflowId: string;
	mode: "single" | "parallel" | "chain";
	createdAt: string;
	specs: readonly ManifestSpecForTree[];
}>;

export function parseManifestForTree(raw: unknown): ManifestForTree | undefined {
	if (!isRecord(raw)) return undefined;
	const { workflowId, mode, createdAt, specs: rawSpecs } = raw;
	if (typeof workflowId !== "string" || workflowId === "") return undefined;
	if (mode !== "single" && mode !== "parallel" && mode !== "chain") return undefined;
	if (typeof createdAt !== "string" || createdAt === "") return undefined;
	if (!Array.isArray(rawSpecs) || rawSpecs.length === 0) return undefined;

	const specs: ManifestSpecForTree[] = [];
	for (const item of rawSpecs) {
		if (!isRecord(item)) return undefined;
		const { agent, task, requestedRole, workflow, cwd, model, tools } = item;
		if (typeof agent !== "string" || agent === "") return undefined;
		if (typeof task !== "string") return undefined;

		let assignment: "owner" | "worker" | "reviewer" | undefined;
		let playbook: string | undefined;
		let phase: string | undefined;
		let parsedWorkflow: WorkflowContext | undefined;

		if (isRecord(workflow)) {
			if (isWorkflowAssignment(workflow.assignment)) assignment = workflow.assignment;
			if (typeof workflow.playbook === "string" && workflow.playbook !== "") playbook = workflow.playbook;
			if (typeof workflow.phase === "string" && workflow.phase !== "") phase = workflow.phase;
			parsedWorkflow = parseWorkflowContext(workflow);
		}

		specs.push({
			agent,
			task,
			requestedRole: typeof requestedRole === "string" && requestedRole !== "" ? requestedRole : undefined,
			assignment,
			playbook,
			phase,
			workflow: parsedWorkflow,
			cwd: typeof cwd === "string" && cwd !== "" ? cwd : undefined,
			model: typeof model === "string" && model !== "" ? model : undefined,
			tools: typeof tools === "string" && tools !== "" ? tools : undefined,
		});
	}

	return { workflowId, mode, createdAt, specs };
}

export function taskPreviewOf(task: string, maxChars = 60): string {
	const firstLine = task.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
	if (firstLine.length <= maxChars) return firstLine;
	return `${firstLine.slice(0, maxChars - 1)}…`;
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

function activityParts(result: Pick<ChildResult, "messages">): ChildContentPart[] {
	return result.messages.flatMap((message) =>
		message.role === "assistant" || message.role === "activity" ? message.content : [],
	);
}

function oneLine(text: string, limit = 100): string {
	const line = text.split("\n").find((candidate) => candidate.trim())?.trim() ?? "";
	return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

export function activityLines(result: Pick<ChildResult, "messages">): string[] {
	const lines: string[] = [];
	for (const part of activityParts(result)) {
		if (part.type === "toolCall") lines.push(`→ ${formatToolCall(part)}`);
		else if (part.type === "toolUpdate") lines.push(formatToolUpdate(part));
		else lines.push(...part.text.split("\n"));
	}
	return lines;
}

export function latestActivity(
	result: Pick<ChildResult, "messages" | "text" | "exitCode"> & {
		status?: SemanticStatus;
		journal?: readonly JournalEntry[];
	},
): string {
	if (result.status?.phase || result.status?.note) {
		const parts = [result.status.phase, result.status.note].filter(Boolean);
		if (result.status.blocking) parts.push("[blocking]");
		return parts.join(": ");
	}
	if (result.journal && result.journal.length > 0) {
		const last = result.journal[result.journal.length - 1]!;
		if (last.kind === "phase") {
			const parts = [last.phase, last.note].filter(Boolean);
			if (last.blocking) parts.push("[blocking]");
			return parts.join(": ");
		}
		if (last.kind === "tool") return `→ ${last.name} ${last.gist}`;
		if (last.kind === "turn") return last.summary ?? `turn ${last.turn}`;
		if (last.kind === "spawn") return `spawned (${last.agent})`;
		if (last.kind === "exit") return last.exitCode === 0 ? "completed" : `failed (exit ${last.exitCode})`;
		if (last.kind === "failure") return `failed: ${last.error}`;
	}
	const part = activityParts(result).at(-1);
	if (!part) return result.exitCode === -1 ? "running" : oneLine(result.text) || "no output";
	if (part.type === "toolCall") return `→ ${formatToolCall(part)}`;
	if (part.type === "toolUpdate") {
		if (part.agents.length > 0) {
			const agentSummary = part.agents
				.map((agent) => `${agent.agent}:${agent.exitCode === -1 ? "running" : agent.exitCode === 0 ? "ok" : "err"}`)
				.join(" ");
			return `→ ${part.name} [${agentSummary}]`;
		}
		return `→ ${part.name} ${oneLine(part.text, 72)}`;
	}
	return oneLine(part.text) || (result.exitCode === -1 ? "running" : "no output");
}

type TerminalChildProjection = Readonly<{
	state: "succeeded" | "failed" | "cancelled" | "skipped";
	startedAt?: string;
	endedAt: string;
	outcome?: string;
}>;

function firstNonEmptyLine(text: string, maxLen = 80): string | undefined {
	const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
	if (line === undefined || line.length === 0) return undefined;
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

function extractOutcome(raw: Record<string, unknown>, state: TreeChildState): string | undefined {
	const resultObj = isRecord(raw.result) ? raw.result : undefined;
	const errorMessage = typeof resultObj?.errorMessage === "string" && resultObj.errorMessage.trim()
		? resultObj.errorMessage
		: typeof raw.errorMessage === "string" && raw.errorMessage.trim()
			? raw.errorMessage
			: undefined;
	const text = typeof resultObj?.text === "string" && resultObj.text.trim()
		? resultObj.text
		: typeof raw.text === "string" && raw.text.trim()
			? raw.text
			: undefined;
	const stderr = typeof resultObj?.stderr === "string" && resultObj.stderr.trim()
		? resultObj.stderr
		: typeof raw.stderr === "string" && raw.stderr.trim()
			? raw.stderr
			: undefined;

	if (state === "failed") {
		if (errorMessage !== undefined) {
			const line = firstNonEmptyLine(errorMessage);
			if (line !== undefined) return line;
		}
		if (stderr !== undefined) {
			const line = firstNonEmptyLine(stderr);
			if (line !== undefined) return line;
		}
		if (text !== undefined) {
			const line = firstNonEmptyLine(text);
			if (line !== undefined) return line;
		}
		return undefined;
	}

	if (state === "succeeded") {
		if (text !== undefined) {
			const line = firstNonEmptyLine(text);
			if (line !== undefined) return line;
		}
		return undefined;
	}

	if (state === "cancelled") {
		if (errorMessage !== undefined) {
			const line = firstNonEmptyLine(errorMessage);
			if (line !== undefined) return line;
		}
		return "cancelled";
	}

	return undefined;
}

async function readTerminalChild(artifactDir: string, index: number): Promise<TerminalChildProjection | undefined> {
	const path = join(artifactDir, "children", String(index), "result.json");
	try {
		const raw: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(raw)) return undefined;
		const state = raw.state;
		if (state !== "succeeded" && state !== "failed" && state !== "cancelled" && state !== "skipped") return undefined;
		const file = await stat(path);
		return {
			state,
			startedAt: typeof raw.startedAt === "string" && raw.startedAt !== "" ? raw.startedAt : undefined,
			endedAt: typeof raw.endedAt === "string" && raw.endedAt !== "" ? raw.endedAt : file.mtime.toISOString(),
			outcome: extractOutcome(raw, state),
		};
	} catch {
		return undefined;
	}
}

async function readActivity(artifactDir: string, index: number, expectedWorkflowId: string): Promise<ChildActivityV1 | undefined> {
	const path = join(artifactDir, "children", String(index), "activity.json");
	try {
		const raw: unknown = JSON.parse(await readFile(path, "utf8"));
		const parsed = parseActivityV1(raw);
		if (parsed === undefined) return undefined;
		if (parsed.workflowId !== expectedWorkflowId || parsed.index !== index) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

async function readSealedParentResult(artifactDir: string, index: number): Promise<unknown | undefined> {
	const path = join(artifactDir, "children", String(index), "result.json");
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function recoverNestedModelFromParentResult(
	parentResultRaw: unknown,
	nestedIndex: number,
	agent?: string,
): string | undefined {
	if (!isRecord(parentResultRaw)) return undefined;
	const resObj = isRecord(parentResultRaw.result) ? parentResultRaw.result : parentResultRaw;

	const checkCandidate = (candidate: unknown): string | undefined => {
		if (!isRecord(candidate)) return undefined;
		if (typeof candidate.model !== "string" || candidate.model.trim() === "") return undefined;
		if (agent !== undefined && typeof candidate.agent === "string" && candidate.agent !== agent) {
			return undefined;
		}
		return candidate.model.trim();
	};

	const candidates: string[] = [];

	const collectFromResults = (results: unknown) => {
		if (!Array.isArray(results)) return;
		const model = checkCandidate(results[nestedIndex]);
		if (model !== undefined) {
			candidates.push(model);
		}
	};

	if (isRecord(resObj.details)) {
		collectFromResults(resObj.details.results);
	}

	if (Array.isArray(resObj.messages)) {
		for (const msg of resObj.messages) {
			if (!isRecord(msg)) continue;
			if (isRecord(msg.details)) {
				collectFromResults(msg.details.results);
			}
			if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (!isRecord(part)) continue;
					if (isRecord(part.details)) {
						collectFromResults(part.details.results);
					}
				}
			}
		}
	}

	const unique = new Set(candidates);
	if (unique.size === 1) {
		return candidates[0];
	}
	return undefined;
}

async function readSpawns(artifactDir: string, parentIndex: number, expectedWorkflowId: string): Promise<readonly SpawnRecordV1[]> {
	const spawnsDir = join(artifactDir, "children", String(parentIndex), "spawns");
	try {
		const entries = await readdir(spawnsDir);
		const records: SpawnRecordV1[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			try {
				const raw: unknown = JSON.parse(await readFile(join(spawnsDir, entry), "utf8"));
				const parsed = parseSpawnRecordV1(raw);
				if (parsed !== undefined && parsed.workflowId === expectedWorkflowId && parsed.parentIndex === parentIndex) {
					records.push(parsed);
				}
			} catch {
				// Ignore malformed or uncommitted file
			}
		}
		return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	} catch {
		return [];
	}
}

export function parseTreeSnapshot(raw: unknown): TreeSnapshot | undefined {
	if (!isRecord(raw)) return undefined;
	const {
		taskId,
		workflowId,
		mode,
		playbook,
		createdAt,
		committed,
		counts,
		slots,
		children,
		todos,
		todoOwner,
		todoCounts,
		capturedAt,
	} = raw;

	if (typeof taskId !== "string" || typeof workflowId !== "string") return undefined;
	if (mode !== "single" && mode !== "parallel" && mode !== "chain") return undefined;
	if (typeof createdAt !== "string" || typeof committed !== "boolean" || typeof capturedAt !== "string") return undefined;
	if (!isRecord(counts) || !isRecord(slots) || !Array.isArray(children) || !Array.isArray(todos) || !isRecord(todoCounts)) {
		return undefined;
	}

	const parsedTodoState = parseTodoState({ items: todos });
	const validatedCounts = {
		queued: Number(counts.queued) || 0,
		running: Number(counts.running) || 0,
		complete: Number(counts.complete) || 0,
		total: Number(counts.total) || 0,
	};
	const validatedSlots = {
		active: Number(slots.active) || 0,
		capacity: Number(slots.capacity) || MAX_ACTIVE_CHILDREN,
	};
	const validatedTodoCounts = {
		total: Number(todoCounts.total) || 0,
		completed: Number(todoCounts.completed) || 0,
		inProgress: Number(todoCounts.inProgress) || 0,
	};

	const validatedChildren: TreeChild[] = [];
	for (const child of children) {
		if (!isRecord(child)) continue;
		if (typeof child.index !== "number" || typeof child.agent !== "string" || !isTreeChildState(child.state)) continue;
		const nested: NestedChild[] = [];
		if (Array.isArray(child.nested)) {
			for (const item of child.nested) {
				if (!isRecord(item)) continue;
				if (typeof item.groupId === "string" && typeof item.agent === "string") {
					const state: SpawnChildV1["state"] = isSpawnChildState(item.state)
						? item.state
						: "running";
					nested.push({
						groupId: item.groupId,
						nestedIndex: typeof item.nestedIndex === "number" ? item.nestedIndex : 0,
						agent: item.agent,
						role: typeof item.role === "string" ? item.role : undefined,
						assignment: isWorkflowAssignment(item.assignment) ? item.assignment : undefined,
						taskPreview: typeof item.taskPreview === "string" ? item.taskPreview : "",
						state,
						activity: typeof item.activity === "string" ? item.activity : undefined,
						status: parseSemanticStatus(item.status),
						journal: parseJournalEntries(item.journal),
						startedAt: typeof item.startedAt === "string" ? item.startedAt : undefined,
						endedAt: typeof item.endedAt === "string" ? item.endedAt : undefined,
						updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
						live: typeof item.live === "boolean" ? item.live : true,
						stale: typeof item.stale === "boolean" ? item.stale : undefined,
						taskFull: typeof item.taskFull === "string" ? item.taskFull : undefined,
						workflow: parseWorkflowContext(item.workflow),
						model: typeof item.model === "string" ? item.model : undefined,
						cwd: typeof item.cwd === "string" ? item.cwd : undefined,
						tools: typeof item.tools === "string" ? item.tools : undefined,
						finalResponse: typeof item.finalResponse === "string" ? item.finalResponse : undefined,
						errorMessage: typeof item.errorMessage === "string" ? item.errorMessage : undefined,
						stderr: typeof item.stderr === "string" ? item.stderr : undefined,
						stopReason: typeof item.stopReason === "string" ? item.stopReason : undefined,
						exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
						usage: parseChildUsage(item.usage),
					});
				} else if (typeof item.workflowId === "string" && typeof item.childId === "string" && (item.depth === 1 || item.depth === 2) && typeof item.acquiredAt === "string") {
					const { groupId, nestedIndex } = parseLeaseChildId(item.childId);
					nested.push({
						groupId,
						nestedIndex,
						agent: "nested",
						taskPreview: "",
						state: "running",
						startedAt: item.acquiredAt,
						updatedAt: item.acquiredAt,
						live: true,
						lease: {
							workflowId: item.workflowId,
							childId: item.childId,
							depth: item.depth,
							acquiredAt: item.acquiredAt,
						},
					});
				}
			}
		}

		let activityObj: Readonly<{ text: string; updatedAt: string }> | undefined;
		if (isRecord(child.activity) && typeof child.activity.text === "string" && typeof child.activity.updatedAt === "string") {
			activityObj = { text: child.activity.text, updatedAt: child.activity.updatedAt };
		}

		validatedChildren.push({
			index: child.index,
			agent: child.agent,
			state: child.state,
			role: typeof child.role === "string" ? child.role : undefined,
			assignment: isWorkflowAssignment(child.assignment) ? child.assignment : undefined,
			startedAt: typeof child.startedAt === "string" ? child.startedAt : undefined,
			endedAt: typeof child.endedAt === "string" ? child.endedAt : undefined,
			taskPreview: typeof child.taskPreview === "string" ? child.taskPreview : "",
			taskFull: typeof child.taskFull === "string" ? child.taskFull : undefined,
			phase: typeof child.phase === "string" ? child.phase : undefined,
			activity: activityObj,
			status: parseSemanticStatus(child.status),
			journal: parseJournalEntries(child.journal),
			stale: typeof child.stale === "boolean" ? child.stale : undefined,
			outcome: typeof child.outcome === "string" ? child.outcome : undefined,
			nested,
		});
	}

	return {
		taskId,
		workflowId,
		mode,
		playbook: typeof playbook === "string" ? playbook : undefined,
		createdAt,
		committed,
		counts: validatedCounts,
		slots: validatedSlots,
		children: validatedChildren,
		todos: parsedTodoState.items,
		todoOwner: typeof todoOwner === "string" ? todoOwner : undefined,
		todoCounts: validatedTodoCounts,
		capturedAt,
	};
}

export type BuildTreeSnapshotInput = Readonly<{
	taskId: string;
	workflowId: string;
	artifactDir: string;
	schedulerRoot: string;
	todoPath?: string;
	playbook?: string;
	activeLeases?: readonly LeaseSnapshot[];
	now?: Date;
}>;

export async function buildTreeSnapshot(input: BuildTreeSnapshotInput): Promise<TreeSnapshot | undefined> {
	let rawManifest: unknown;
	try {
		const bytes = await readFile(join(input.artifactDir, "manifest.json"), "utf8");
		rawManifest = JSON.parse(bytes);
	} catch {
		return undefined;
	}

	const manifest = parseManifestForTree(rawManifest);
	if (manifest === undefined) return undefined;

	let committed = false;
	let committedAt: Date | undefined;
	try {
		const marker = await stat(join(input.artifactDir, "COMMITTED"));
		committed = true;
		committedAt = marker.mtime;
	} catch {
		committed = false;
	}

	let progress: WorkflowProgressV2;
	try {
		const bytes = await readFile(join(input.artifactDir, "progress.json"), "utf8");
		const parsed = parseProgressV2(JSON.parse(bytes));
		if (parsed !== undefined) {
			progress = parsed;
		} else {
			progress = {
				queued: manifest.specs.length,
				running: 0,
				complete: 0,
				total: manifest.specs.length,
				children: [],
			};
		}
	} catch {
		progress = {
			queued: manifest.specs.length,
			running: 0,
			complete: 0,
			total: manifest.specs.length,
			children: [],
		};
	}

	let allLeases: readonly LeaseSnapshot[] = input.activeLeases ?? [];
	if (input.activeLeases === undefined) {
		try {
			allLeases = await snapshotActiveLeases(input.schedulerRoot);
		} catch {
			allLeases = [];
		}
	}

	const workflowLeases = allLeases.filter((lease) => lease.workflowId === input.workflowId);
	const depth1Leases = workflowLeases.filter((lease) => lease.depth === 1);
	const depth2Leases = workflowLeases.filter((lease) => lease.depth === 2);
	const terminalChildren = await Promise.all(
		manifest.specs.map((_spec, index) => readTerminalChild(input.artifactDir, index)),
	);
	const statusRecords = await Promise.all(
		manifest.specs.map((_spec, index) =>
			readSemanticStatusFile(join(input.artifactDir, "children", String(index), "status.json")),
		),
	);
	const journalRecords = await Promise.all(
		manifest.specs.map((_spec, index) =>
			readJournalFile(join(input.artifactDir, "children", String(index), "journal.json")),
		),
	);
	const activityRecords = await Promise.all(
		manifest.specs.map((_spec, index) =>
			terminalChildren[index] === undefined
				? readActivity(input.artifactDir, index, manifest.workflowId)
				: Promise.resolve(undefined),
		),
	);
	const spawnRecordsByChild = await Promise.all(
		manifest.specs.map((_spec, index) => readSpawns(input.artifactDir, index, manifest.workflowId)),
	);
	const parentResultsByChild = await Promise.all(
		manifest.specs.map((_spec, index) => {
			const spawns = spawnRecordsByChild[index] ?? [];
			const needsParentResult = spawns.some((s) => s.children.some((c) => c.model === undefined));
			return needsParentResult ? readSealedParentResult(input.artifactDir, index) : Promise.resolve(undefined);
		}),
	);

	let todoState = emptyTodos();
	if (input.todoPath !== undefined) {
		try {
			todoState = await loadTodos(input.todoPath);
		} catch {
			todoState = emptyTodos();
		}
	}

	const completedTodos = todoState.items.filter((item) => item.status === "completed").length;
	const inProgressTodos = todoState.items.filter((item) => item.status === "in_progress").length;
	const now = input.now ?? committedAt ?? new Date();
	const nowMs = now.getTime();

	const children: TreeChild[] = manifest.specs.map((spec, index) => {
		const progressChild = progress.children.find((child) => child.index === index);
		const terminalChild = terminalChildren[index];
		const semanticStatus = statusRecords[index];
		const journalSnapshot = journalRecords[index];
		const allJournal = journalSnapshot?.entries;
		const journal = allJournal !== undefined ? recentJournal(allJournal) : undefined;
		const liveLease = depth1Leases.find((lease) => lease.childId === String(index));
		const state: TreeChildState = terminalChild?.state ?? progressChild?.state ?? (liveLease === undefined ? "queued" : "running");
		const role = progressChild?.role ?? spec.requestedRole;
		const assignment = progressChild?.assignment ?? spec.assignment;
		const startedAt = progressChild?.startedAt ?? terminalChild?.startedAt ?? liveLease?.acquiredAt;
		const endedAt = progressChild?.endedAt ?? terminalChild?.endedAt;
		const activityRecord = terminalChild === undefined ? activityRecords[index] : undefined;
		const spawns = spawnRecordsByChild[index] ?? [];
		const parentResultRaw = parentResultsByChild[index];

		const newestSpawnPhase = spawns.map((s) => s.phase).filter((p): p is string => typeof p === "string" && p.length > 0).at(-1);
		const statusText = semanticStatus === undefined ? undefined : semanticStatusText(semanticStatus);
		const statusIsFresh = semanticStatus !== undefined && isFreshActivity(semanticStatus.updatedAt, nowMs);
		const phase = statusIsFresh ? semanticStatus.phase ?? newestSpawnPhase ?? spec.phase : newestSpawnPhase ?? spec.phase;

		let activityRecordObj: Readonly<{ text: string; updatedAt: string }> | undefined;
		let stale = false;

		if (terminalChild === undefined && state === "running") {
			const lastJournalEntry = journal?.at(-1);
			let latestActivityText: string | undefined;
			let latestUpdatedAt: string | undefined;

			if (statusText !== undefined && (statusIsFresh || (lastJournalEntry === undefined && activityRecord === undefined))) {
				latestActivityText = statusText;
				latestUpdatedAt = semanticStatus?.updatedAt;
			} else if (lastJournalEntry !== undefined) {
				latestActivityText = formatJournalEntry(lastJournalEntry);
				latestUpdatedAt = lastJournalEntry.timestamp;
			} else if (activityRecord !== undefined) {
				latestActivityText = activityRecord.activity;
				latestUpdatedAt = activityRecord.updatedAt;
			}

			if (latestUpdatedAt !== undefined) {
				stale = !isFreshActivity(latestUpdatedAt, nowMs);
			}

			if (latestActivityText !== undefined && latestUpdatedAt !== undefined) {
				activityRecordObj = { text: latestActivityText, updatedAt: latestUpdatedAt };
			}
		}

		const nested: NestedChild[] = [];
		for (const spawnRecord of spawns) {
			for (const spawnChild of spawnRecord.children) {
				const leaseChildId = `${spawnRecord.groupId}-${spawnChild.nestedIndex}`;
				const matchLease = depth2Leases.find((l) => l.childId === leaseChildId);
				const nestedStatusText = spawnChild.status === undefined ? undefined : semanticStatusText(spawnChild.status);
				const nestedStatusIsFresh = spawnChild.status !== undefined && isFreshActivity(spawnChild.status.updatedAt, nowMs);
				const lastNestedJournalEntry = spawnChild.journal?.at(-1);
				let nestedActivityText = spawnChild.activity;
				let nestedUpdatedAt = spawnChild.updatedAt;
				if (nestedStatusText !== undefined && (nestedStatusIsFresh || lastNestedJournalEntry === undefined)) {
					nestedActivityText = nestedStatusText;
					nestedUpdatedAt = spawnChild.status?.updatedAt ?? spawnChild.updatedAt;
				} else if (lastNestedJournalEntry !== undefined) {
					nestedActivityText = formatJournalEntry(lastNestedJournalEntry);
					nestedUpdatedAt = lastNestedJournalEntry.timestamp;
				}

				const childUpdatedMs = Date.parse(nestedUpdatedAt);
				const isStale = spawnChild.state === "running" && nestedActivityText !== undefined && (
					!Number.isNaN(childUpdatedMs) && nowMs - childUpdatedMs > STALE_ACTIVITY_THRESHOLD_MS
				);
				const model = spawnChild.model ?? (
					parentResultRaw !== undefined
						? recoverNestedModelFromParentResult(parentResultRaw, spawnChild.nestedIndex, spawnChild.agent)
						: undefined
				);
				nested.push({
					groupId: spawnRecord.groupId,
					nestedIndex: spawnChild.nestedIndex,
					agent: spawnChild.agent,
					role: spawnChild.role,
					assignment: spawnChild.assignment,
					taskPreview: spawnChild.taskPreview,
					state: spawnChild.state,
					activity: nestedActivityText,
					status: spawnChild.status,
					journal: spawnChild.journal ? recentJournal(spawnChild.journal) : undefined,
					startedAt: spawnChild.startedAt,
					endedAt: spawnChild.endedAt,
					updatedAt: nestedUpdatedAt,
					live: matchLease !== undefined,
					lease: matchLease,
					stale: isStale || undefined,
					taskFull: spawnChild.taskFull,
					workflow: spawnChild.workflow,
					model,
					cwd: spawnChild.cwd,
					tools: spawnChild.tools,
					finalResponse: spawnChild.finalResponse,
					errorMessage: spawnChild.errorMessage,
					stderr: spawnChild.stderr,
					stopReason: spawnChild.stopReason,
					exitCode: spawnChild.exitCode,
					usage: spawnChild.usage,
				});
			}
		}

		return {
			index,
			agent: progressChild?.agent ?? spec.agent,
			state,
			role,
			assignment,
			startedAt,
			endedAt,
			taskPreview: taskPreviewOf(spec.task),
			taskFull: spec.task,
			phase,
			activity: activityRecordObj,
			status: semanticStatus,
			journal,
			stale: stale || undefined,
			outcome: terminalChild?.outcome,
			workflow: spec.workflow,
			cwd: spec.cwd,
			model: spec.model,
			tools: spec.tools,
			nested,
		};
	});

	if (depth2Leases.length > 0) {
		const matchedLeaseChildIds = new Set<string>();
		for (const child of children) {
			for (const n of child.nested) {
				if (isLeaseSnapshot(n)) {
					matchedLeaseChildIds.add(n.childId);
				} else {
					if (n.lease !== undefined) matchedLeaseChildIds.add(n.lease.childId);
					matchedLeaseChildIds.add(`${n.groupId}-${n.nestedIndex}`);
				}
			}
		}
		const unmatchedLeases = depth2Leases.filter((l) => !matchedLeaseChildIds.has(l.childId));
		if (unmatchedLeases.length > 0) {
			const ownerIndex = children.findIndex((child) => child.assignment === "owner");
			const targetIndex = ownerIndex >= 0 ? ownerIndex : 0;
			const targetChild = children[targetIndex];
			if (targetChild !== undefined) {
				const legacyNested: NestedChild[] = unmatchedLeases.map((lease) => {
					const { groupId, nestedIndex } = parseLeaseChildId(lease.childId);
					return {
						groupId,
						nestedIndex,
						agent: "nested",
						taskPreview: "",
						state: "running",
						startedAt: lease.acquiredAt,
						updatedAt: lease.acquiredAt,
						live: true,
						lease,
					};
				});
				children[targetIndex] = {
					...targetChild,
					nested: [...targetChild.nested, ...legacyNested],
				};
			}
		}
	}

	const counts = progress.children.length === manifest.specs.length
		? {
				queued: children.filter((child) => child.state === "queued").length,
				running: children.filter((child) => child.state === "running").length,
				complete: children.filter((child) => child.state !== "queued" && child.state !== "running").length,
				total: children.length,
			}
		: {
				queued: progress.queued,
				running: progress.running,
				complete: progress.complete,
				total: progress.total,
			};

	return {
		taskId: input.taskId,
		workflowId: manifest.workflowId,
		mode: manifest.mode,
		playbook: input.playbook ?? manifest.specs[0]?.playbook,
		createdAt: manifest.createdAt,
		committed,
		counts,
		slots: {
			active: allLeases.length,
			capacity: MAX_ACTIVE_CHILDREN,
		},
		children,
		todos: todoState.items,
		todoOwner: todoState.items.length > 0 ? "session root" : undefined,
		todoCounts: {
			total: todoState.items.length,
			completed: completedTodos,
			inProgress: inProgressTodos,
		},
		capturedAt: now.toISOString(),
	};
}

function plainTheme(): TreeTheme {
	return {
		fg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
	};
}

function glyphForState(state: TreeChildState, theme: TreeTheme): string {
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

function roleLabel(child: TreeChild): string {
	if (child.assignment === "owner") {
		if (child.phase !== undefined && child.phase.length > 0) {
			return `owner ${child.agent} · phase ${child.phase}`;
		}
		return `owner ${child.agent}`;
	}
	if (child.assignment !== undefined) {
		return `${child.assignment} ${child.agent}`;
	}
	if (child.role !== undefined) {
		return `${child.role} ${child.agent}`;
	}
	return child.agent;
}

function childDurationText(child: TreeChild, createdAt: string, nowMs: number): string {
	const createdMs = Date.parse(createdAt);
	if (child.state === "queued") {
		const elapsed = Number.isNaN(createdMs) ? 0 : Math.max(0, nowMs - createdMs);
		return `queued ${formatElapsed(elapsed)}`;
	}
	if (child.state === "running") {
		const startMs = child.startedAt !== undefined ? Date.parse(child.startedAt) : createdMs;
		const elapsed = Number.isNaN(startMs) ? 0 : Math.max(0, nowMs - startMs);
		return formatElapsed(elapsed);
	}
	if (child.state === "skipped") {
		return "skipped";
	}
	const startMs = child.startedAt !== undefined ? Date.parse(child.startedAt) : createdMs;
	const endMs = child.endedAt !== undefined ? Date.parse(child.endedAt) : nowMs;
	const duration = Number.isNaN(startMs) || Number.isNaN(endMs) ? 0 : Math.max(0, endMs - startMs);
	const durationFormatted = `(${formatElapsed(duration)})`;
	if (child.state === "failed") return `${durationFormatted} failed`;
	if (child.state === "cancelled") return `${durationFormatted} cancelled`;
	return durationFormatted;
}

type PreparedTreeRow = Readonly<{
	kind: "child" | "nested";
	priority: number;
	order: number;
	render: (isLast: boolean, theme: TreeTheme, width: number) => string;
}>;

export function isLeaseSnapshot(child: NestedChild): child is LeaseSnapshot {
	return "childId" in child && typeof child.childId === "string" && !("agent" in child);
}

export function renderTreeLines(snapshot: TreeSnapshot, opts: RenderTreeOptions): string[] {
	const width = Math.max(20, opts.width);
	const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;
	const now = opts.now ?? (snapshot.capturedAt ? new Date(snapshot.capturedAt) : new Date());
	const nowMs = now.getTime();
	const theme = opts.theme ?? plainTheme();

	const label = snapshot.playbook ?? snapshot.mode;
	const totalElapsedMs = Math.max(0, nowMs - Date.parse(snapshot.createdAt));
	const totalElapsed = formatElapsed(totalElapsedMs);

	let header = `dstack · ${label}`;
	if (!snapshot.committed) {
		header += ` · slots ${snapshot.slots.active}/${snapshot.slots.capacity}`;
	}
	header += ` · ${snapshot.counts.complete}/${snapshot.counts.total} done · ${totalElapsed}`;
	if (snapshot.todos.length > 0) {
		header += ` · todos ${snapshot.todoCounts.completed}/${snapshot.todoCounts.total}`;
	}

	const lines: string[] = [truncateToWidth(header, width)];

	const rows: PreparedTreeRow[] = [];
	let orderIndex = 0;

	for (const child of snapshot.children) {
		const childOrder = orderIndex++;
		let priority = 4;
		if (child.state === "failed") priority = 1;
		else if (child.state === "running") priority = 2;
		else if (child.state === "queued") priority = 3;

		const currentChild = child;
		rows.push({
			kind: "child",
			priority,
			order: childOrder,
			render: (isLast, rowTheme, renderWidth) => {
				const guide = rowTheme.fg("dim", isLast ? "└─ " : "├─ ");
				const glyph = glyphForState(currentChild.state, rowTheme);
				const role = roleLabel(currentChild);
				const duration = childDurationText(currentChild, snapshot.createdAt, nowMs);

				let detail = "";
				if (currentChild.state === "queued") {
					if (snapshot.slots.active >= snapshot.slots.capacity) {
						detail = " — waiting on slot";
					} else if (currentChild.taskPreview.length > 0) {
						detail = ` ${currentChild.taskPreview}`;
					}
				} else if (currentChild.state === "running") {
					let staleTag = "";
					if (currentChild.stale) {
						const staleBase = currentChild.activity?.updatedAt;
						const staleMs = staleBase !== undefined ? Date.parse(staleBase) : Number.NaN;
						const staleElapsed = !Number.isNaN(staleMs) ? Math.max(0, nowMs - staleMs) : 0;
						staleTag = ` ${rowTheme.fg("dim", `stale ${formatElapsed(staleElapsed)}`)}`;
					}
					const act = currentChild.activity?.text;
					const actSuffix = act !== undefined && act.length > 0
						? ` — ${act}`
						: currentChild.taskPreview.length > 0
							? ` ${currentChild.taskPreview}`
							: "";
					detail = `${staleTag}${actSuffix}`;
				} else {
					if (currentChild.outcome !== undefined && currentChild.outcome.length > 0) {
						detail = ` — ${currentChild.outcome}`;
					} else if (currentChild.taskPreview.length > 0) {
						detail = ` ${currentChild.taskPreview}`;
					}
				}

				const rawLine = `${guide}${glyph} ${role} ${duration}${detail}`;
				return truncateToWidth(rawLine, renderWidth);
			},
		});

		for (let nIdx = 0; nIdx < child.nested.length; nIdx++) {
			const nestedChild = child.nested[nIdx];
			if (nestedChild === undefined) continue;
			const nestedOrder = orderIndex++;
			let nestedPriority = 4;
			if (isLeaseSnapshot(nestedChild)) {
				nestedPriority = 2;
			} else if (nestedChild.state === "failed") {
				nestedPriority = 1;
			} else if (nestedChild.state === "running" || nestedChild.state === "queued") {
				nestedPriority = 2;
			}

			const isLastNested = nIdx === child.nested.length - 1;
			rows.push({
				kind: "nested",
				priority: nestedPriority,
				order: nestedOrder,
				render: (_isLast, rowTheme, renderWidth) => {
					const guide = rowTheme.fg("dim", isLastNested ? "   └─ " : "   ├─ ");
					if (isLeaseSnapshot(nestedChild)) {
						const leaseAcquiredMs = Date.parse(nestedChild.acquiredAt);
						const leaseElapsed = Number.isNaN(leaseAcquiredMs) ? 0 : Math.max(0, nowMs - leaseAcquiredMs);
						const glyph = rowTheme.fg("accent", "◐");
						const rawLine = `${guide}${glyph} nested (${formatElapsed(leaseElapsed)})`;
						return truncateToWidth(rawLine, renderWidth);
					}

					const glyph = glyphForState(nestedChild.state, rowTheme);
					let role = nestedChild.agent;
					if (nestedChild.assignment !== undefined) {
						role = `${nestedChild.assignment} ${nestedChild.agent}`;
					} else if (nestedChild.role !== undefined) {
						role = `${nestedChild.role} ${nestedChild.agent}`;
					}

					const taskPreview = typeof nestedChild.taskPreview === "string" ? nestedChild.taskPreview : "";
					let durationStr = "";
					let detail = "";
					if (nestedChild.state === "queued") {
						const createdMs = Date.parse(nestedChild.updatedAt);
						const elapsed = !Number.isNaN(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
						durationStr = `queued ${formatElapsed(elapsed)}`;
						if (taskPreview.length > 0) {
							detail = ` ${taskPreview}`;
						}
					} else if (nestedChild.state === "running") {
						const startedMs = nestedChild.startedAt !== undefined ? Date.parse(nestedChild.startedAt) : Date.parse(nestedChild.updatedAt);
						const elapsed = !Number.isNaN(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
						durationStr = formatElapsed(elapsed);
						let staleTag = "";
						if (nestedChild.stale) {
							const staleMs = Date.parse(nestedChild.updatedAt);
							const staleElapsed = !Number.isNaN(staleMs) ? Math.max(0, nowMs - staleMs) : 0;
							staleTag = ` ${rowTheme.fg("dim", `stale ${formatElapsed(staleElapsed)}`)}`;
						}
						const act = nestedChild.activity ?? (taskPreview.length > 0 ? taskPreview : undefined);
						detail = `${staleTag}${act !== undefined ? ` — ${act}` : ""}`;
					} else if (nestedChild.state === "skipped") {
						durationStr = "skipped";
						if (taskPreview.length > 0) {
							detail = ` ${taskPreview}`;
						}
					} else {
						const startedMs = nestedChild.startedAt !== undefined ? Date.parse(nestedChild.startedAt) : Date.parse(nestedChild.updatedAt);
						const endedMs = Date.parse(nestedChild.endedAt ?? nestedChild.updatedAt);
						const duration = Number.isNaN(startedMs) || Number.isNaN(endedMs) ? 0 : Math.max(0, endedMs - startedMs);
						const durationFormatted = `(${formatElapsed(duration)})`;
						durationStr = nestedChild.state === "failed"
							? `${durationFormatted} failed`
							: nestedChild.state === "cancelled"
								? `${durationFormatted} cancelled`
								: durationFormatted;
						const act = nestedChild.activity ?? (taskPreview.length > 0 ? taskPreview : undefined);
						detail = act !== undefined ? ` — ${act}` : "";
					}

					const rawLine = `${guide}${glyph} ${role} ${durationStr}${detail}`;
					return truncateToWidth(rawLine, renderWidth);
				},
			});
		}
	}

	const budget = Number.isFinite(maxLines) ? Math.max(1, maxLines - 1) : rows.length;

	if (rows.length <= budget) {
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row === undefined) continue;
			const isLast = i === rows.length - 1;
			lines.push(row.render(isLast, theme, width));
		}
	} else {
		const rowBudget = Math.max(1, budget - 1);
		const sortedByPriority = [...rows].sort((a, b) => a.priority - b.priority || a.order - b.order);
		const selected = sortedByPriority.slice(0, rowBudget).sort((a, b) => a.order - b.order);
		const hiddenCount = rows.length - selected.length;

		for (let i = 0; i < selected.length; i++) {
			const row = selected[i];
			if (row === undefined) continue;
			lines.push(row.render(false, theme, width));
		}
		lines.push(truncateToWidth(theme.fg("dim", `… ${hiddenCount} more (use /dtree)`), width));
	}

	if (opts.includeTodos && snapshot.todos.length > 0) {
		lines.push("");
		const ownerSuffix = snapshot.todoOwner !== undefined ? `, owner: ${snapshot.todoOwner}` : "";
		lines.push(truncateToWidth(`todos (${snapshot.todoCounts.completed}/${snapshot.todoCounts.total} done${ownerSuffix}):`, width));
		for (const item of snapshot.todos) {
			let mark = "☐";
			if (item.status === "completed") {
				mark = theme.fg("success", "☑");
			} else if (item.status === "in_progress") {
				mark = theme.fg("accent", "◐");
			} else {
				mark = theme.fg("dim", "☐");
			}
			const text = item.status === "completed" && theme.strikethrough !== undefined
				? theme.fg("dim", theme.strikethrough(item.content))
				: item.content;
			lines.push(truncateToWidth(`  ${mark} ${text}`, width));
		}
	}

	if (opts.expanded) {
		for (const child of snapshot.children) {
			if (child.taskFull !== undefined && child.taskFull !== child.taskPreview) {
				lines.push(truncateToWidth(`    task [${child.agent}]: ${child.taskFull}`, width));
			}
			if (child.state === "running" && child.journal && child.journal.length > 0) {
				const recent = formatRecentActivity(child.journal);
				for (const act of recent) {
					lines.push(truncateToWidth(`    ${theme.fg("dim", "•")} ${act}`, width));
				}
			}
			for (const n of child.nested) {
				if (!isLeaseSnapshot(n) && n.state === "running" && n.journal && n.journal.length > 0) {
					const recent = formatRecentActivity(n.journal);
					for (const act of recent) {
						lines.push(truncateToWidth(`      ${theme.fg("dim", "•")} ${act}`, width));
					}
				}
			}
		}
	}

	return lines;
}
