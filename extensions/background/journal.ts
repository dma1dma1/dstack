import { readFile } from "node:fs/promises";
import type { ChildMessage, ChildResult } from "../spawn.ts";
import { atomicWriteFile } from "./artifacts.ts";

export const MAX_JOURNAL_ENTRIES = 256;
export const MAX_JOURNAL_BYTES = 64 * 1024;
export const MAX_STATUS_PHASE_CHARS = 100;
export const MAX_STATUS_NOTE_CHARS = 500;
export const MAX_TOOL_GIST_CHARS = 120;
export const MAX_TURN_SUMMARY_CHARS = 160;
export const RECENT_JOURNAL_ENTRIES = 20;

export type SemanticStatusBlockedOn = "human" | "approval" | "dependency" | "external";

export type SemanticStatus = Readonly<{
	phase?: string;
	note?: string;
	blocking?: boolean;
	blockedOn?: SemanticStatusBlockedOn;
	updatedAt: string;
}>;

export type SpawnJournalEntry = Readonly<{
	seq: number;
	timestamp: string;
	kind: "spawn";
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	role?: string;
	step?: number;
}>;

export type ToolJournalResult = Readonly<{
	status: "succeeded" | "failed";
	summary?: string;
}>;

export type ToolJournalEntry = Readonly<{
	seq: number;
	timestamp: string;
	kind: "tool";
	name: string;
	gist: string;
	durationMs?: number;
	result?: ToolJournalResult;
}>;

export type ToolActivityItem = Readonly<{
	seq: number;
	timestamp: string;
	name: string;
	intent: string;
	gist: string;
	durationMs?: number;
	result?: ToolJournalResult;
}>;

export type ToolActivityGroup = Readonly<{
	phase?: string;
	note?: string;
	items: readonly ToolActivityItem[];
}>;

export type TurnJournalEntry = Readonly<{
	seq: number;
	timestamp: string;
	kind: "turn";
	turn: number;
	summary?: string;
	usage?: ChildResult["usage"];
}>;

export type PhaseJournalEntry = Readonly<{
	seq: number;
	timestamp: string;
	kind: "phase";
	phase?: string;
	note?: string;
	blocking?: boolean;
	blockedOn?: SemanticStatusBlockedOn;
}>;

export type ExitJournalEntry = Readonly<{
	seq: number;
	timestamp: string;
	kind: "exit";
	exitCode: number;
	text?: string;
	durationMs?: number;
}>;

export type FailureJournalEntry = Readonly<{
	seq: number;
	timestamp: string;
	kind: "failure";
	error: string;
}>;

export type JournalEntry =
	| SpawnJournalEntry
	| ToolJournalEntry
	| TurnJournalEntry
	| PhaseJournalEntry
	| ExitJournalEntry
	| FailureJournalEntry;

export type ChildJournalSnapshot = Readonly<{
	schemaVersion: "dstack.journal.v1";
	seq: number;
	entries: readonly JournalEntry[];
	updatedAt: string;
}>;

export function sanitizeString(value: string, maxLen: number): string {
	const cleaned = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[=:]\s*(?:bearer\s+)?\S+/gi, "$1=[redacted]")
		.replace(/--(?:api[_-]?key|token|password|secret|authorization)(?:=|\s+)(?:bearer\s+)?\S+/gi, "--credential=[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLen) return cleaned;
	if (maxLen <= 3) return cleaned.slice(0, maxLen);
	return `${cleaned.slice(0, maxLen - 3)}...`;
}

function isSensitiveKey(key: string): boolean {
	return /(?:authorization|content|edits|password|prompt|secret|systemprompt|token)/i.test(key);
}

function truncateValue(value: unknown, maxLen = 40): string {
	if (typeof value === "string") return sanitizeString(value, maxLen);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	return sanitizeString(JSON.stringify(value), maxLen);
}

export function sanitizeToolGist(name: string, rawArgs: Record<string, unknown>): string {
	const toolName = sanitizeString(name, 30);
	if (toolName === "read" && typeof rawArgs["path"] === "string") {
		const path = sanitizeString(rawArgs["path"], 80);
		const offset = typeof rawArgs["offset"] === "number" ? ` offset=${rawArgs["offset"]}` : "";
		const limit = typeof rawArgs["limit"] === "number" ? ` limit=${rawArgs["limit"]}` : "";
		return sanitizeString(`${path}${offset}${limit}`, MAX_TOOL_GIST_CHARS);
	}
	if (toolName === "edit" && typeof rawArgs["path"] === "string") {
		return sanitizeString(rawArgs["path"], MAX_TOOL_GIST_CHARS);
	}
	if (toolName === "write" && typeof rawArgs["path"] === "string") {
		return sanitizeString(rawArgs["path"], MAX_TOOL_GIST_CHARS);
	}
	if (toolName === "bash" && typeof rawArgs["command"] === "string") {
		return sanitizeString(rawArgs["command"], MAX_TOOL_GIST_CHARS);
	}
	if (toolName === "dstack_task") {
		const parts: string[] = [];
		if (typeof rawArgs["agent"] === "string") parts.push(`agent=${rawArgs["agent"]}`);
		if (typeof rawArgs["task"] === "string") parts.push(sanitizeString(rawArgs["task"], 60));
		if (Array.isArray(rawArgs["tasks"])) parts.push(`${rawArgs["tasks"].length} tasks`);
		if (Array.isArray(rawArgs["chain"])) parts.push(`${rawArgs["chain"].length} chain steps`);
		return sanitizeString(parts.join(" ") || "task", MAX_TOOL_GIST_CHARS);
	}
	if (toolName === "dstack_status") {
		const parts: string[] = [];
		if (typeof rawArgs["phase"] === "string") parts.push(`phase=${rawArgs["phase"]}`);
		if (typeof rawArgs["note"] === "string") parts.push(`note=${rawArgs["note"]}`);
		if (typeof rawArgs["blocking"] === "boolean") parts.push(`blocking=${rawArgs["blocking"]}`);
		if (typeof rawArgs["blockedOn"] === "string") parts.push(`blockedOn=${rawArgs["blockedOn"]}`);
		return sanitizeString(parts.join(" ") || "update", MAX_TOOL_GIST_CHARS);
	}
	const pairs: string[] = [];
	for (const [key, val] of Object.entries(rawArgs)) {
		if (isSensitiveKey(key)) continue;
		pairs.push(`${sanitizeString(key, 24)}=${truncateValue(val, 30)}`);
	}
	return sanitizeString(pairs.join(" ") || "called", MAX_TOOL_GIST_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseChildUsage(raw: unknown): ChildResult["usage"] | undefined {
	if (!isRecord(raw)) return undefined;
	const { input, output, cacheRead, cacheWrite, cost, contextTokens, turns } = raw;
	if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
	if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
	if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead) || cacheRead < 0) return undefined;
	if (typeof cacheWrite !== "number" || !Number.isFinite(cacheWrite) || cacheWrite < 0) return undefined;
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
	if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens < 0) return undefined;
	if (typeof turns !== "number" || !Number.isFinite(turns) || turns < 0) return undefined;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		contextTokens,
		turns,
	};
}

function isSemanticStatusBlockedOn(value: unknown): value is SemanticStatusBlockedOn {
	return value === "human" || value === "approval" || value === "dependency" || value === "external";
}

export function parseSemanticStatus(raw: unknown): SemanticStatus | undefined {
	if (!isRecord(raw)) return undefined;
	if (!isValidTimestamp(raw["updatedAt"])) return undefined;
	const phase = typeof raw["phase"] === "string" ? sanitizeString(raw["phase"], MAX_STATUS_PHASE_CHARS) : undefined;
	const note = typeof raw["note"] === "string" ? sanitizeString(raw["note"], MAX_STATUS_NOTE_CHARS) : undefined;
	const blocking = typeof raw["blocking"] === "boolean" ? raw["blocking"] : undefined;
	const blockedOn = isSemanticStatusBlockedOn(raw["blockedOn"]) ? raw["blockedOn"] : undefined;
	return {
		...(phase !== undefined ? { phase } : {}),
		...(note !== undefined ? { note } : {}),
		...(blocking !== undefined ? { blocking } : {}),
		...(blockedOn !== undefined ? { blockedOn } : {}),
		updatedAt: raw["updatedAt"],
	};
}

export function parseJournalEntry(raw: unknown): JournalEntry | undefined {
	if (!isRecord(raw)) return undefined;
	if (!isFiniteNonNegativeInteger(raw["seq"])) return undefined;
	if (!isValidTimestamp(raw["timestamp"])) return undefined;
	if (typeof raw["kind"] !== "string") return undefined;

	const seq = raw["seq"];
	const timestamp = raw["timestamp"];

	switch (raw["kind"]) {
		case "spawn": {
			if (typeof raw["agent"] !== "string" || typeof raw["task"] !== "string" || typeof raw["cwd"] !== "string") {
				return undefined;
			}
			const model = typeof raw["model"] === "string" ? raw["model"] : undefined;
			const role = typeof raw["role"] === "string" ? raw["role"] : undefined;
			const step = typeof raw["step"] === "number" && Number.isSafeInteger(raw["step"]) && raw["step"] >= 0 ? raw["step"] : undefined;
			return {
				seq,
				timestamp,
				kind: "spawn",
				agent: raw["agent"],
				task: raw["task"],
				cwd: raw["cwd"],
				...(model !== undefined ? { model } : {}),
				...(role !== undefined ? { role } : {}),
				...(step !== undefined ? { step } : {}),
			};
		}
		case "tool": {
			if (typeof raw["name"] !== "string" || typeof raw["gist"] !== "string") {
				return undefined;
			}
			const durationMs = typeof raw["durationMs"] === "number" && Number.isFinite(raw["durationMs"]) && raw["durationMs"] >= 0
				? raw["durationMs"]
				: undefined;
			const rawResult = isRecord(raw["result"]) ? raw["result"] : undefined;
			const result: ToolJournalResult | undefined = rawResult !== undefined && (rawResult["status"] === "succeeded" || rawResult["status"] === "failed")
				? {
						status: rawResult["status"],
						...(typeof rawResult["summary"] === "string"
							? { summary: sanitizeString(rawResult["summary"], 120) }
							: {}),
					}
				: undefined;
			return {
				seq,
				timestamp,
				kind: "tool",
				name: raw["name"],
				gist: raw["gist"],
				...(durationMs !== undefined ? { durationMs } : {}),
				...(result !== undefined ? { result } : {}),
			};
		}
		case "turn": {
			if (typeof raw["turn"] !== "number" || !Number.isSafeInteger(raw["turn"]) || raw["turn"] < 0) {
				return undefined;
			}
			const summary = typeof raw["summary"] === "string" ? raw["summary"] : undefined;
			const usage = parseChildUsage(raw["usage"]);
			return {
				seq,
				timestamp,
				kind: "turn",
				turn: raw["turn"],
				...(summary !== undefined ? { summary } : {}),
				...(usage !== undefined ? { usage } : {}),
			};
		}
		case "phase": {
			const phase = typeof raw["phase"] === "string" ? raw["phase"] : undefined;
			const note = typeof raw["note"] === "string" ? raw["note"] : undefined;
			const blocking = typeof raw["blocking"] === "boolean" ? raw["blocking"] : undefined;
			const blockedOn = isSemanticStatusBlockedOn(raw["blockedOn"]) ? raw["blockedOn"] : undefined;
			return {
				seq,
				timestamp,
				kind: "phase",
				...(phase !== undefined ? { phase } : {}),
				...(note !== undefined ? { note } : {}),
				...(blocking !== undefined ? { blocking } : {}),
				...(blockedOn !== undefined ? { blockedOn } : {}),
			};
		}
		case "exit": {
			if (typeof raw["exitCode"] !== "number" || !Number.isSafeInteger(raw["exitCode"])) {
				return undefined;
			}
			const text = typeof raw["text"] === "string" ? raw["text"] : undefined;
			const durationMs = typeof raw["durationMs"] === "number" && Number.isFinite(raw["durationMs"]) && raw["durationMs"] >= 0
				? raw["durationMs"]
				: undefined;
			return {
				seq,
				timestamp,
				kind: "exit",
				exitCode: raw["exitCode"],
				...(text !== undefined ? { text } : {}),
				...(durationMs !== undefined ? { durationMs } : {}),
			};
		}
		case "failure": {
			if (typeof raw["error"] !== "string") {
				return undefined;
			}
			return {
				seq,
				timestamp,
				kind: "failure",
				error: raw["error"],
			};
		}
		default:
			return undefined;
	}
}

export function parseJournalEntries(raw: unknown): readonly JournalEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const valid: JournalEntry[] = [];
	for (const item of raw) {
		const entry = parseJournalEntry(item);
		if (entry !== undefined) valid.push(entry);
	}
	return valid;
}

export function parseJournalSnapshot(raw: unknown): ChildJournalSnapshot | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw["schemaVersion"] !== "dstack.journal.v1") return undefined;
	if (!isValidTimestamp(raw["updatedAt"])) return undefined;
	const entries = parseJournalEntries(raw["entries"]);
	if (entries === undefined) return undefined;
	const seq = isFiniteNonNegativeInteger(raw["seq"]) ? raw["seq"] : entries.length;
	return {
		schemaVersion: "dstack.journal.v1",
		seq,
		entries,
		updatedAt: raw["updatedAt"],
	};
}

export function compactJournal(
	entries: readonly JournalEntry[],
	maxEntries = MAX_JOURNAL_ENTRIES,
	maxBytes = MAX_JOURNAL_BYTES,
): JournalEntry[] {
	let current = [...entries];
	const isOver = (list: readonly JournalEntry[]) =>
		list.length > maxEntries || Buffer.byteLength(JSON.stringify(list), "utf8") > maxBytes;

	if (!isOver(current)) return current;

	while (isOver(current)) {
		const toolIdx = current.findIndex((entry) => entry.kind === "tool");
		if (toolIdx === -1) break;
		current.splice(toolIdx, 1);
	}

	while (isOver(current)) {
		const turnIndices = current
			.map((entry, idx) => (entry.kind === "turn" ? idx : -1))
			.filter((idx) => idx !== -1);
		if (turnIndices.length <= 1) break;
		const oldestTurnIdx = turnIndices[0]!;
		current.splice(oldestTurnIdx, 1);
	}

	while (isOver(current)) {
		const phaseIndices = current
			.map((entry, idx) => (entry.kind === "phase" ? idx : -1))
			.filter((idx) => idx !== -1);
		if (phaseIndices.length <= 2) break;
		current.splice(phaseIndices[1]!, 1);
	}

	if (isOver(current)) {
		current = current.map((entry) => {
			if (entry.kind === "exit" && entry.text && entry.text.length > 200) {
				return { ...entry, text: sanitizeString(entry.text, 200) };
			}
			if (entry.kind === "turn" && entry.summary && entry.summary.length > 80) {
				return { ...entry, summary: sanitizeString(entry.summary, 80) };
			}
			if (entry.kind === "tool" && entry.gist.length > 60) {
				return { ...entry, gist: sanitizeString(entry.gist, 60) };
			}
			if (entry.kind === "spawn" && entry.task.length > 100) {
				return { ...entry, task: sanitizeString(entry.task, 100) };
			}
			if (entry.kind === "failure" && entry.error.length > 100) {
				return { ...entry, error: sanitizeString(entry.error, 100) };
			}
			return entry;
		});
	}

	while (isOver(current) && current.length > 0) {
		const removable = current.findIndex((entry, index) => {
			const firstSpawn = index === 0 && entry.kind === "spawn";
			const finalExit = index === current.length - 1 && entry.kind === "exit";
			return !firstSpawn && !finalExit;
		});
		if (removable === -1) {
			if (current.length === 1) break;
			current.splice(current[0]?.kind === "spawn" ? 1 : 0, 1);
		} else {
			current.splice(removable, 1);
		}
	}

	return current;
}

export function sanitizeTurnSummary(text: string, maxLen = MAX_TURN_SUMMARY_CHARS): string {
	const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
	return sanitizeString(firstLine, maxLen);
}

export function toolIntent(name: string, gist: string): string {
	const normalized = name.toLowerCase();
	if (normalized === "read") return "Inspect";
	if (normalized === "grep" || normalized === "rg" || normalized === "find" || normalized === "ls") return "Search";
	if (normalized === "edit" || normalized === "write") return "Modify";
	if (normalized === "bash") {
		if (/\b(test|typecheck|lint|check|validate|build)\b/i.test(gist)) return "Verify";
		return "Run";
	}
	if (normalized === "dstack_task") return "Delegate";
	if (normalized === "dstack_result") return "Collect";
	if (normalized === "dstack_status") return "Update status";
	if (normalized === "mcp" || normalized === "mcpscript" || normalized.startsWith("mcp__")) return "Query service";
	if (normalized === "dstack_todo") return "Update plan";
	if (normalized === "dstack_ask") return "Request input";
	return "Use tool";
}

export function groupToolActivity(
	entries: readonly JournalEntry[],
	initial?: Readonly<{ phase?: string; note?: string }>,
): readonly ToolActivityGroup[] {
	let phase = initial?.phase;
	let note = initial?.note;
	let current: ToolActivityItem[] = [];
	let currentPhase = phase;
	let currentNote = note;
	const groups: ToolActivityGroup[] = [];
	const flush = () => {
		if (current.length === 0) return;
		groups.push({
			...(currentPhase !== undefined ? { phase: currentPhase } : {}),
			...(currentNote !== undefined ? { note: currentNote } : {}),
			items: current,
		});
		current = [];
	};

	for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
		if (entry.kind === "tool") {
			if (current.length === 0) {
				currentPhase = phase;
				currentNote = note;
			}
			current.push({
				seq: entry.seq,
				timestamp: entry.timestamp,
				name: entry.name,
				intent: toolIntent(entry.name, entry.gist),
				gist: entry.gist,
				...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
				...(entry.result !== undefined ? { result: entry.result } : {}),
			});
			continue;
		}
		flush();
		if (entry.kind === "phase") {
			if (entry.phase !== undefined) phase = entry.phase;
			if (entry.note !== undefined) note = entry.note;
		}
	}
	flush();
	return groups;
}

export function recentJournal(entries: readonly JournalEntry[], limit = RECENT_JOURNAL_ENTRIES): readonly JournalEntry[] {
	const boundedLimit = typeof limit === "number" && Number.isFinite(limit)
		? Math.min(MAX_JOURNAL_ENTRIES, Math.max(0, Math.floor(limit)))
		: 0;
	if (boundedLimit === 0 || entries.length === 0) return [];
	if (entries.length <= boundedLimit) return entries;
	const spawn = entries.find((entry) => entry.kind === "spawn");
	const tailCount = Math.max(1, boundedLimit - (spawn ? 1 : 0));
	const tail = entries.slice(entries.length - tailCount);
	return spawn && tail[0]?.seq !== spawn.seq ? [spawn, ...tail] : tail;
}

export function formatJournalEntry(entry: JournalEntry): string {
	switch (entry.kind) {
		case "phase": {
			const parts: string[] = [];
			if (entry.phase) parts.push(entry.phase);
			if (entry.note) parts.push(entry.note);
			if (entry.blocking) parts.push("[blocking]");
			return parts.join(": ") || "phase update";
		}
		case "tool": {
			return entry.gist ? `→ ${entry.name} ${entry.gist}` : `→ ${entry.name}`;
		}
		case "turn": {
			return entry.summary ? `turn ${entry.turn}: ${entry.summary}` : `turn ${entry.turn}`;
		}
		case "spawn": {
			return `spawned (${entry.agent})`;
		}
		case "exit": {
			return entry.exitCode === 0 ? "completed" : `failed (exit ${entry.exitCode})`;
		}
		case "failure": {
			return `failed: ${entry.error}`;
		}
		default: {
			const _exhaustive: never = entry;
			return String(_exhaustive);
		}
	}
}

export function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.floor((durationMs % 60_000) / 1_000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function formatToolActivityItem(item: ToolActivityItem): string {
	const details = [item.gist];
	if (item.result !== undefined) {
		details.push(item.result.status === "succeeded" ? "completed" : item.result.summary ?? "failed");
	}
	if (item.durationMs !== undefined) details.push(formatDuration(item.durationMs));
	return `${item.intent} · ${item.name}${details.filter(Boolean).map((detail) => ` · ${detail}`).join("")}`;
}

export function formatRecentActivity(
	journal: readonly JournalEntry[] | undefined,
): readonly string[] {
	if (!journal || journal.length === 0) return [];
	const results: string[] = [];
	for (const entry of [...journal].sort((a, b) => a.seq - b.seq)) {
		switch (entry.kind) {
			case "turn": {
				if (entry.summary && entry.summary.trim().length > 0) {
					results.push(entry.summary.trim());
				}
				break;
			}
			case "phase":
			case "exit":
			case "failure": {
				results.push(formatJournalEntry(entry));
				break;
			}
			case "spawn":
			case "tool": {
				break;
			}
			default: {
				const _exhaustive: never = entry;
				void _exhaustive;
				break;
			}
		}
	}
	return results;
}

export function allowStatusTool(tools: string | undefined): string | undefined {
	if (tools === undefined) return undefined;
	const parts = tools.split(",").map((t) => t.trim()).filter(Boolean);
	if (!parts.includes("dstack_status")) parts.push("dstack_status");
	return parts.join(",");
}

export async function readSemanticStatusFile(path: string): Promise<SemanticStatus | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return parseSemanticStatus(JSON.parse(content));
	} catch {
		return undefined;
	}
}

export async function readJournalFile(path: string): Promise<ChildJournalSnapshot | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return parseJournalSnapshot(JSON.parse(content));
	} catch {
		return undefined;
	}
}

export class ChildJournalRecorder {
	private seq = 0;
	private entries: JournalEntry[] = [];
	private latestStatus?: SemanticStatus;
	private lastStatusUpdatedAt?: string;
	private readonly journalPath?: string;
	private readonly statusPath?: string;
	private lastToolCallId?: string;
	private readonly pendingTools = new Map<string, Readonly<{ seq: number; startedAtMs: number }>>();
	private lastTurn = 0;
	private lastMessageIndex = 0;
	private lastTimestampMs = 0;

	constructor(input?: { journalPath?: string; statusPath?: string }) {
		this.journalPath = input?.journalPath;
		this.statusPath = input?.statusPath;
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	private timestamp(value?: string | number): string {
		const candidate = value === undefined ? Date.now() : typeof value === "number" ? value : Date.parse(value);
		const validCandidate = Number.isFinite(candidate) ? candidate : Date.now();
		this.lastTimestampMs = Math.max(this.lastTimestampMs, validCandidate);
		return new Date(this.lastTimestampMs).toISOString();
	}

	getEntries(): readonly JournalEntry[] {
		return this.entries;
	}

	getLatestStatus(): SemanticStatus | undefined {
		return this.latestStatus;
	}

	recordSpawn(input: {
		agent: string;
		task: string;
		cwd: string;
		model?: string;
		role?: string;
		step?: number;
		timestamp?: string;
	}): SpawnJournalEntry {
		const entry: SpawnJournalEntry = {
			seq: this.nextSeq(),
			timestamp: this.timestamp(input.timestamp),
			kind: "spawn",
			agent: sanitizeString(input.agent, 60),
			task: sanitizeString(input.task, 300),
			cwd: sanitizeString(input.cwd, 200),
			model: input.model ? sanitizeString(input.model, 100) : undefined,
			role: input.role ? sanitizeString(input.role, 100) : undefined,
			step: input.step,
		};
		this.entries.push(entry);
		this.entries = compactJournal(this.entries);
		return entry;
	}

	recordTool(input: {
		name: string;
		arguments: Record<string, unknown>;
		callId?: string;
		timestamp?: string | number;
		durationMs?: number;
	}): ToolJournalEntry | undefined {
		if (input.callId && input.callId === this.lastToolCallId) return undefined;
		if (input.callId) this.lastToolCallId = input.callId;
		const entry: ToolJournalEntry = {
			seq: this.nextSeq(),
			timestamp: this.timestamp(input.timestamp),
			kind: "tool",
			name: sanitizeString(input.name, 40),
			gist: sanitizeToolGist(input.name, input.arguments),
			durationMs: input.durationMs,
		};
		this.entries.push(entry);
		this.entries = compactJournal(this.entries);
		if (input.callId !== undefined) {
			this.pendingTools.set(input.callId, { seq: entry.seq, startedAtMs: Date.parse(entry.timestamp) });
		}
		return entry;
	}

	private recordToolResult(message: ChildMessage): void {
		if (message.toolCallId === undefined) return;
		const pending = this.pendingTools.get(message.toolCallId);
		if (pending === undefined) return;
		this.pendingTools.delete(message.toolCallId);
		const index = this.entries.findIndex((entry) => entry.seq === pending.seq && entry.kind === "tool");
		const existing = this.entries[index];
		if (existing?.kind !== "tool") return;
		const summaryText = message.content.find((part) => part.type === "text")?.text;
		const summary = message.isError === true && summaryText !== undefined
			? sanitizeTurnSummary(summaryText, 120)
			: undefined;
		const endedAtMs = message.timestamp ?? Number.NaN;
		const observedDuration = Number.isFinite(endedAtMs) ? Math.max(0, endedAtMs - pending.startedAtMs) : undefined;
		this.entries[index] = {
			...existing,
			durationMs: message.durationMs ?? observedDuration,
			result: {
				status: message.isError === true ? "failed" : "succeeded",
				...(summary !== undefined && summary.length > 0 ? { summary } : {}),
			},
		};
	}

	recordMessages(messages: readonly ChildMessage[]): void {
		if (messages.length > this.lastMessageIndex) {
			const newMessages = messages.slice(this.lastMessageIndex);
			this.lastMessageIndex = messages.length;
			for (const msg of newMessages) {
				if (msg.role === "assistant") {
					for (const part of msg.content) {
						if (part.type === "toolCall") {
							this.recordTool({
								name: part.name,
								arguments: part.arguments,
								callId: part.id,
								timestamp: msg.timestamp,
							});
						}
					}
				} else if (msg.role === "toolResult") {
					this.recordToolResult(msg);
				}
			}
		}
	}

	recordTurn(input: {
		turn: number;
		text: string;
		usage?: ChildResult["usage"];
		timestamp?: string;
	}): TurnJournalEntry | undefined {
		if (input.turn <= this.lastTurn && input.turn > 0) return undefined;
		this.lastTurn = input.turn;
		const entry: TurnJournalEntry = {
			seq: this.nextSeq(),
			timestamp: this.timestamp(input.timestamp),
			kind: "turn",
			turn: input.turn,
			summary: sanitizeTurnSummary(input.text),
			usage: input.usage ? { ...input.usage } : undefined,
		};
		this.entries.push(entry);
		this.entries = compactJournal(this.entries);
		return entry;
	}

	recordStatus(status: SemanticStatus, timestamp?: string): PhaseJournalEntry {
		const updatedAt = this.timestamp(status.updatedAt);
		const normalized: SemanticStatus = {
			...(status.phase !== undefined ? { phase: sanitizeString(status.phase, MAX_STATUS_PHASE_CHARS) } : {}),
			...(status.note !== undefined ? { note: sanitizeString(status.note, MAX_STATUS_NOTE_CHARS) } : {}),
			...(status.blocking !== undefined ? { blocking: status.blocking } : {}),
			...(status.blockedOn !== undefined ? { blockedOn: status.blockedOn } : {}),
			updatedAt,
		};
		this.latestStatus = normalized;
		this.lastStatusUpdatedAt = status.updatedAt;
		const entry: PhaseJournalEntry = {
			seq: this.nextSeq(),
			timestamp: this.timestamp(timestamp ?? updatedAt),
			kind: "phase",
			phase: normalized.phase,
			note: normalized.note,
			blocking: normalized.blocking,
			blockedOn: normalized.blockedOn,
		};
		this.entries.push(entry);
		this.entries = compactJournal(this.entries);
		return entry;
	}

	recordExit(input: {
		exitCode: number;
		text?: string;
		durationMs?: number;
		timestamp?: string;
	}): ExitJournalEntry {
		const entry: ExitJournalEntry = {
			seq: this.nextSeq(),
			timestamp: this.timestamp(input.timestamp),
			kind: "exit",
			exitCode: input.exitCode,
			text: input.text ? sanitizeTurnSummary(input.text, 250) : undefined,
			durationMs: input.durationMs,
		};
		this.entries.push(entry);
		this.entries = compactJournal(this.entries);
		return entry;
	}

	recordFailure(input: { error: string; timestamp?: string }): FailureJournalEntry {
		const entry: FailureJournalEntry = {
			seq: this.nextSeq(),
			timestamp: this.timestamp(input.timestamp),
			kind: "failure",
			error: sanitizeString(input.error, 300),
		};
		this.entries.push(entry);
		this.entries = compactJournal(this.entries);
		return entry;
	}

	async checkStatusFile(): Promise<SemanticStatus | undefined> {
		if (!this.statusPath) return undefined;
		const status = await readSemanticStatusFile(this.statusPath);
		if (!status) return undefined;
		if (this.lastStatusUpdatedAt === status.updatedAt) return status;
		this.recordStatus(status);
		return status;
	}

	async persist(): Promise<void> {
		if (!this.journalPath) return;
		const snapshot: ChildJournalSnapshot = {
			schemaVersion: "dstack.journal.v1",
			seq: this.seq,
			entries: this.entries,
			updatedAt: new Date().toISOString(),
		};
		await atomicWriteFile(this.journalPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	}
}
