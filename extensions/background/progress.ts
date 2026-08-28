import {
	formatDuration,
	formatToolActivityItem,
	groupToolActivity,
	sanitizeString,
	type JournalEntry,
	type SemanticStatus,
	type ToolActivityGroup,
	type ToolActivityItem,
	type ToolJournalResult,
} from "./journal.ts";
import { isLeaseSnapshot, type SpawnNestedChild, type TreeChild, type TreeSnapshot } from "./tree.ts";

export const PROGRESS_ENTRY = "dstack-progress";
export const PROGRESS_SCHEMA_VERSION = "dstack.progress.v1";
export const ROUTINE_PROGRESS_INTERVAL_MS = 4_000;

const MAX_PROGRESS_TEXT_CHARS = 240;
const MAX_PROGRESS_TASK_CHARS = 120;
const MAX_TOOL_KINDS = 6;
const MAX_ACTIVITY_ITEMS = 32;
const MAX_DEDUPE_KEYS = 128;

type ChildActor = Readonly<{
	kind: "child";
	childIndex: number;
	agent: string;
	role?: string;
	assignment?: "owner" | "worker" | "reviewer";
}>;

type NestedActor = Readonly<{
	kind: "nested";
	parentIndex: number;
	groupId: string;
	nestedIndex: number;
	agent: string;
	role?: string;
	assignment?: "owner" | "worker" | "reviewer";
}>;

export type ProgressActor = ChildActor | NestedActor;

type ProgressCommon = Readonly<{
	schemaVersion: typeof PROGRESS_SCHEMA_VERSION;
	taskId: string;
	workflowId: string;
	at: string;
	actor: ProgressActor;
}>;

type ProgressDetails =
	| Readonly<{ kind: "phase"; phase: string; note?: string }>
	| Readonly<{ kind: "narration"; text: string }>
	| Readonly<{ kind: "activity_group"; phase?: string; note?: string; items: readonly ToolActivityItem[] }>
	| Readonly<{ kind: "tool_burst"; tools: readonly Readonly<{ name: string; count: number }>[]; total: number }>
	| Readonly<{ kind: "nested_launch"; task: string }>
	| Readonly<{ kind: "nested_return"; state: "succeeded" | "failed" | "cancelled" | "skipped"; summary?: string }>
	| Readonly<{ kind: "blocker"; blocked: boolean; text: string }>
	| Readonly<{ kind: "failure"; text: string }>;

export type TranscriptProgressEvent = ProgressCommon & ProgressDetails;

type ProgressTheme = Readonly<{
	fg(color: string, text: string): string;
	bold?(text: string): string;
}>;

type PendingNarration = Readonly<{
	actor: ProgressActor;
	text: string;
}>;

type ToolBucket = {
	actor: ProgressActor;
	phase?: string;
	note?: string;
	items: ToolActivityItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssignment(value: unknown): value is "owner" | "worker" | "reviewer" {
	return value === "owner" || value === "worker" || value === "reviewer";
}

function parseActor(value: unknown): ProgressActor | undefined {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.agent !== "string") return undefined;
	const assignment = isAssignment(value.assignment) ? value.assignment : undefined;
	const role = typeof value.role === "string" && value.role.length > 0 ? sanitizeString(value.role, 60) : undefined;
	if (value.kind === "child" && typeof value.childIndex === "number" && Number.isSafeInteger(value.childIndex) && value.childIndex >= 0) {
		return { kind: "child", childIndex: value.childIndex, agent: sanitizeString(value.agent, 40), role, assignment };
	}
	if (
		value.kind === "nested" &&
		typeof value.parentIndex === "number" && Number.isSafeInteger(value.parentIndex) && value.parentIndex >= 0 &&
		typeof value.groupId === "string" && value.groupId.length > 0 &&
		typeof value.nestedIndex === "number" && Number.isSafeInteger(value.nestedIndex) && value.nestedIndex >= 0
	) {
		return {
			kind: "nested",
			parentIndex: value.parentIndex,
			groupId: sanitizeString(value.groupId, 80),
			nestedIndex: value.nestedIndex,
			agent: sanitizeString(value.agent, 40),
			role,
			assignment,
		};
	}
	return undefined;
}

function parseToolActivityItem(value: unknown): ToolActivityItem | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) return undefined;
	if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return undefined;
	if (typeof value.name !== "string" || typeof value.intent !== "string" || typeof value.gist !== "string") return undefined;
	const durationMs = typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0
		? value.durationMs
		: undefined;
	const rawResult = isRecord(value.result) ? value.result : undefined;
	const result: ToolJournalResult | undefined = rawResult !== undefined && (rawResult.status === "succeeded" || rawResult.status === "failed")
		? {
				status: rawResult.status,
				...(typeof rawResult.summary === "string"
					? { summary: sanitizeString(rawResult.summary, 120) }
					: {}),
			}
		: undefined;
	return {
		seq: value.seq,
		timestamp: value.timestamp,
		name: sanitizeString(value.name, 40),
		intent: sanitizeString(value.intent, 40),
		gist: sanitizeString(value.gist, 120),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(result !== undefined ? { result } : {}),
	};
}

export function parseTranscriptProgressEvent(value: unknown): TranscriptProgressEvent | undefined {
	if (!isRecord(value) || value.schemaVersion !== PROGRESS_SCHEMA_VERSION) return undefined;
	if (typeof value.taskId !== "string" || value.taskId.length === 0 || typeof value.workflowId !== "string" || value.workflowId.length === 0) return undefined;
	if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.kind !== "string") return undefined;
	const actor = parseActor(value.actor);
	if (!actor) return undefined;
	const common: ProgressCommon = {
		schemaVersion: PROGRESS_SCHEMA_VERSION,
		taskId: sanitizeString(value.taskId, 100),
		workflowId: sanitizeString(value.workflowId, 100),
		at: value.at,
		actor,
	};
	if (value.kind === "phase" && typeof value.phase === "string" && value.phase.length > 0) {
		return { ...common, kind: "phase", phase: sanitizeString(value.phase, 100), note: typeof value.note === "string" ? sanitizeString(value.note, MAX_PROGRESS_TEXT_CHARS) : undefined };
	}
	if (value.kind === "narration" && typeof value.text === "string" && value.text.length > 0) {
		return { ...common, kind: "narration", text: sanitizeString(value.text, MAX_PROGRESS_TEXT_CHARS) };
	}
	if (value.kind === "activity_group" && Array.isArray(value.items)) {
		const items = value.items.slice(0, MAX_ACTIVITY_ITEMS).map(parseToolActivityItem).filter((item): item is ToolActivityItem => item !== undefined);
		if (items.length > 0) {
			return {
				...common,
				kind: "activity_group",
				phase: typeof value.phase === "string" ? sanitizeString(value.phase, 100) : undefined,
				note: typeof value.note === "string" ? sanitizeString(value.note, MAX_PROGRESS_TEXT_CHARS) : undefined,
				items,
			};
		}
	}
	if (value.kind === "tool_burst" && Array.isArray(value.tools) && typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total > 0) {
		const tools: Array<Readonly<{ name: string; count: number }>> = [];
		for (const rawTool of value.tools.slice(0, MAX_TOOL_KINDS)) {
			if (!isRecord(rawTool) || typeof rawTool.name !== "string" || typeof rawTool.count !== "number" || !Number.isSafeInteger(rawTool.count) || rawTool.count < 1) continue;
			tools.push({ name: sanitizeString(rawTool.name, 40), count: rawTool.count });
		}
		if (tools.length > 0) return { ...common, kind: "tool_burst", tools, total: value.total };
	}
	if (value.kind === "nested_launch" && actor.kind === "nested" && typeof value.task === "string") {
		return { ...common, kind: "nested_launch", task: sanitizeString(value.task, MAX_PROGRESS_TASK_CHARS) };
	}
	if (value.kind === "nested_return" && actor.kind === "nested" && (value.state === "succeeded" || value.state === "failed" || value.state === "cancelled" || value.state === "skipped")) {
		return { ...common, kind: "nested_return", state: value.state, summary: typeof value.summary === "string" ? sanitizeString(value.summary, MAX_PROGRESS_TEXT_CHARS) : undefined };
	}
	if (value.kind === "blocker" && typeof value.blocked === "boolean" && typeof value.text === "string" && value.text.length > 0) {
		return { ...common, kind: "blocker", blocked: value.blocked, text: sanitizeString(value.text, MAX_PROGRESS_TEXT_CHARS) };
	}
	if (value.kind === "failure" && typeof value.text === "string" && value.text.length > 0) {
		return { ...common, kind: "failure", text: sanitizeString(value.text, MAX_PROGRESS_TEXT_CHARS) };
	}
	return undefined;
}

function actorKey(actor: ProgressActor): string {
	return actor.kind === "child"
		? `c:${actor.childIndex}`
		: `n:${actor.parentIndex}:${actor.groupId}:${actor.nestedIndex}`;
}

function actorLabel(actor: ProgressActor): string {
	const assignment = actor.assignment ?? (actor.kind === "nested" ? "worker" : "agent");
	const ordinal = actor.kind === "child" ? actor.childIndex + 1 : actor.nestedIndex + 1;
	const role = actor.role !== undefined && actor.role !== assignment ? ` · ${actor.role}` : "";
	return `${assignment} ${ordinal}${role} · ${actor.agent}`;
}

function summarizeActivity(items: readonly ToolActivityItem[]): string {
	const summaries = new Map<string, Readonly<{ intent: string; name: string; count: number; first: ToolActivityItem }>>();
	for (const item of items) {
		const key = `${item.intent}\u0000${item.name}`;
		const previous = summaries.get(key);
		summaries.set(key, previous === undefined
			? { intent: item.intent, name: item.name, count: 1, first: item }
			: { ...previous, count: previous.count + 1 });
	}
	const text = [...summaries.values()].map((summary) => {
		const count = summary.count > 1 ? ` ×${summary.count}` : "";
		const outcome = summary.count === 1 && summary.first.result !== undefined
			? summary.first.result.status === "succeeded" ? " · ✓" : " · ✗"
			: "";
		const duration = summary.count === 1 && summary.first.durationMs !== undefined
			? ` ${formatDuration(summary.first.durationMs)}`
			: "";
		return `${summary.intent} ${summary.name}${count} · ${summary.first.gist}${outcome}${duration}`;
	}).join("; ");
	return sanitizeString(text, MAX_PROGRESS_TEXT_CHARS);
}

function color(theme: ProgressTheme | undefined, name: string, text: string): string {
	return theme?.fg(name, text) ?? text;
}

export function renderTranscriptProgress(event: TranscriptProgressEvent, expanded = false, theme?: ProgressTheme): string {
	const label = color(theme, "muted", actorLabel(event.actor));
	let line: string;
	switch (event.kind) {
		case "phase":
			line = `${color(theme, "accent", "◆")} ${label} · ${event.phase}${event.note ? ` · ${event.note}` : ""}`;
			break;
		case "narration":
			line = `${color(theme, "accent", "◐")} ${label} · ${event.text}`;
			break;
		case "activity_group": {
			const heading = event.phase ?? event.note;
			line = `${color(theme, "dim", "→")} ${label}${heading ? ` · ${heading}` : ""} · ${summarizeActivity(event.items)}`;
			break;
		}
		case "tool_burst": {
			const tools = event.tools.map((tool) => `${tool.name}${tool.count > 1 ? ` ×${tool.count}` : ""}`).join(", ");
			line = `${color(theme, "dim", "→")} ${label} · ${tools}`;
			break;
		}
		case "nested_launch":
			line = `${color(theme, "accent", "↳")} ${label} · launched · ${event.task}`;
			break;
		case "nested_return": {
			const failed = event.state === "failed" || event.state === "cancelled";
			const icon = failed ? color(theme, "error", "✗") : color(theme, "success", "✓");
			line = `${icon} ${label} · returned ${event.state}${event.summary ? ` · ${event.summary}` : ""}`;
			break;
		}
		case "blocker":
			line = event.blocked
				? `${color(theme, "warning", "⚠")} ${label} · blocked · ${event.text}`
				: `${color(theme, "success", "✓")} ${label} · unblocked · ${event.text}`;
			break;
		case "failure":
			line = `${color(theme, "error", "✗")} ${label} · failed · ${event.text}`;
			break;
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
	if (!expanded) return line;
	const attribution = event.actor.kind === "child"
		? `child ${event.actor.childIndex}`
		: `child ${event.actor.parentIndex} · nested ${event.actor.groupId}/${event.actor.nestedIndex}`;
	const details = event.kind === "activity_group"
		? event.items.map((item) => `  ${formatToolActivityItem(item)}`).join("\n")
		: "";
	return `${line}${details ? `\n${details}` : ""}\n${color(theme, "dim", `${attribution} · ${event.at}`)}`;
}

function childActor(child: TreeChild): ChildActor {
	return {
		kind: "child",
		childIndex: child.index,
		agent: sanitizeString(child.agent, 40),
		role: child.role,
		assignment: child.assignment,
	};
}

function nestedActor(parent: TreeChild, nested: SpawnNestedChild): NestedActor {
	return {
		kind: "nested",
		parentIndex: parent.index,
		groupId: sanitizeString(nested.groupId, 80),
		nestedIndex: nested.nestedIndex,
		agent: sanitizeString(nested.agent, 40),
		role: nested.role,
		assignment: nested.assignment,
	};
}

function statusFingerprint(status: SemanticStatus | undefined): string {
	if (!status) return "";
	return `${status.phase ?? ""}\u0000${status.note ?? ""}\u0000${status.blocking === true ? "1" : "0"}`;
}

function journalMaxSeq(journal: readonly JournalEntry[] | undefined): number {
	let max = 0;
	for (const entry of journal ?? []) max = Math.max(max, entry.seq);
	return max;
}

function isTerminalState(state: SpawnNestedChild["state"]): state is "succeeded" | "failed" | "cancelled" | "skipped" {
	return state === "succeeded" || state === "failed" || state === "cancelled" || state === "skipped";
}

export class TranscriptProgressTracker {
	private previous: TreeSnapshot | undefined;
	private lastRoutineAt = 0;
	private readonly journalSeq = new Map<string, number>();
	private readonly toolVersions = new Map<string, string>();
	private readonly pendingNarration = new Map<string, PendingNarration>();
	private readonly pendingTools = new Map<string, ToolBucket>();
	private readonly readyTools: ToolBucket[] = [];
	private readonly emitted = new Set<string>();

	reset(): void {
		this.previous = undefined;
		this.lastRoutineAt = 0;
		this.journalSeq.clear();
		this.toolVersions.clear();
		this.pendingNarration.clear();
		this.pendingTools.clear();
		this.readyTools.length = 0;
		this.emitted.clear();
	}

	ingest(snapshot: TreeSnapshot, nowMs = Date.now()): TranscriptProgressEvent[] {
		if (!this.previous || this.previous.workflowId !== snapshot.workflowId || this.previous.taskId !== snapshot.taskId) {
			this.initialize(snapshot, nowMs);
			return [];
		}

		const immediate: TranscriptProgressEvent[] = [];
		const previousChildren = new Map(this.previous.children.map((child) => [child.index, child]));
		for (const child of snapshot.children) {
			const prior = previousChildren.get(child.index);
			const actor = childActor(child);
			if (prior) {
				this.captureStatus(snapshot, actor, prior.phase, prior.status, child.phase, child.status, immediate, nowMs);
				if (prior.state !== "failed" && child.state === "failed") {
					this.pushImmediate(immediate, this.event(snapshot, actor, nowMs, { kind: "failure", text: sanitizeString(child.outcome ?? "child agent failed", MAX_PROGRESS_TEXT_CHARS) }));
				}
			}
			this.captureJournal(
				snapshot,
				actor,
				child.journal,
				prior?.status?.phase ?? prior?.phase,
				prior?.status?.note,
				immediate,
				nowMs,
			);
			this.captureNested(snapshot, prior, child, immediate, nowMs);
		}

		this.previous = snapshot;
		const routine = this.flushRoutine(snapshot, nowMs);
		return routine ? [...immediate, routine] : immediate;
	}

	private initialize(snapshot: TreeSnapshot, nowMs: number): void {
		this.reset();
		this.previous = snapshot;
		this.lastRoutineAt = nowMs;
		for (const child of snapshot.children) {
			const actor = childActor(child);
			this.initializeJournal(actor, child.journal);
			for (const nested of child.nested) {
				if (isLeaseSnapshot(nested)) continue;
				this.initializeJournal(nestedActor(child, nested), nested.journal);
			}
		}
	}

	private initializeJournal(actor: ProgressActor, journal: readonly JournalEntry[] | undefined): void {
		const key = actorKey(actor);
		this.journalSeq.set(key, journalMaxSeq(journal));
		for (const entry of journal ?? []) {
			if (entry.kind === "tool") this.toolVersions.set(`${key}:${entry.seq}`, this.toolVersion(entry));
		}
	}

	private toolVersion(entry: Extract<JournalEntry, { kind: "tool" }>): string {
		return `${entry.durationMs ?? ""}\u0000${entry.result?.status ?? ""}\u0000${entry.result?.summary ?? ""}`;
	}

	private captureNested(snapshot: TreeSnapshot, priorParent: TreeChild | undefined, parent: TreeChild, output: TranscriptProgressEvent[], nowMs: number): void {
		const priorNested = new Map<string, SpawnNestedChild>();
		for (const nested of priorParent?.nested ?? []) {
			if (!isLeaseSnapshot(nested)) priorNested.set(`${nested.groupId}:${nested.nestedIndex}`, nested);
		}
		for (const nested of parent.nested) {
			if (isLeaseSnapshot(nested)) continue;
			const actor = nestedActor(parent, nested);
			const key = `${nested.groupId}:${nested.nestedIndex}`;
			const prior = priorNested.get(key);
			if (!prior) {
				this.pushImmediate(output, this.event(snapshot, actor, nowMs, { kind: "nested_launch", task: sanitizeString(nested.taskPreview || "nested task", MAX_PROGRESS_TASK_CHARS) }));
			}
			if (prior) this.captureStatus(snapshot, actor, prior.workflow?.phase, prior.status, nested.workflow?.phase, nested.status, output, nowMs);
			this.captureJournal(
				snapshot,
				actor,
				nested.journal,
				prior?.status?.phase ?? prior?.workflow?.phase,
				prior?.status?.note,
				output,
				nowMs,
			);
			if (isTerminalState(nested.state) && (!prior || !isTerminalState(prior.state))) {
				const summary = nested.state === "failed"
					? nested.errorMessage ?? nested.activity
					: nested.finalResponse ?? nested.activity;
				this.pushImmediate(output, this.event(snapshot, actor, nowMs, {
					kind: "nested_return",
					state: nested.state,
					summary: summary ? sanitizeString(summary, MAX_PROGRESS_TEXT_CHARS) : undefined,
				}));
			}
		}
	}

	private captureStatus(
		snapshot: TreeSnapshot,
		actor: ProgressActor,
		previousPhase: string | undefined,
		previousStatus: SemanticStatus | undefined,
		phase: string | undefined,
		status: SemanticStatus | undefined,
		output: TranscriptProgressEvent[],
		nowMs: number,
	): void {
		const priorEffectivePhase = previousStatus?.phase ?? previousPhase;
		const effectivePhase = status?.phase ?? phase;
		if (effectivePhase && effectivePhase !== priorEffectivePhase) {
			this.pushImmediate(output, this.event(snapshot, actor, nowMs, {
				kind: "phase",
				phase: sanitizeString(effectivePhase, 100),
				note: status?.note ? sanitizeString(status.note, MAX_PROGRESS_TEXT_CHARS) : undefined,
			}));
		}
		if (statusFingerprint(status) === statusFingerprint(previousStatus)) return;
		if (status?.blocking === true) {
			this.pushImmediate(output, this.event(snapshot, actor, nowMs, {
				kind: "blocker",
				blocked: true,
				text: sanitizeString(status.note ?? status.phase ?? "blocked", MAX_PROGRESS_TEXT_CHARS),
			}));
			return;
		}
		if (previousStatus?.blocking === true) {
			this.pushImmediate(output, this.event(snapshot, actor, nowMs, {
				kind: "blocker",
				blocked: false,
				text: sanitizeString(status?.note ?? status?.phase ?? "blocker cleared", MAX_PROGRESS_TEXT_CHARS),
			}));
			return;
		}
		if (status?.note && status.note !== previousStatus?.note && effectivePhase === priorEffectivePhase) {
			this.queueNarration(actor, status.note);
		}
	}

	private captureJournal(
		snapshot: TreeSnapshot,
		actor: ProgressActor,
		journal: readonly JournalEntry[] | undefined,
		initialPhase: string | undefined,
		initialNote: string | undefined,
		output: TranscriptProgressEvent[],
		nowMs: number,
	): void {
		const key = actorKey(actor);
		const seen = this.journalSeq.get(key) ?? 0;
		let max = seen;
		const unseen = (journal ?? []).filter((entry) => entry.seq > seen);
		for (const group of groupToolActivity(unseen, { phase: initialPhase, note: initialNote })) {
			this.queueToolGroup(actor, group);
		}
		for (const entry of journal ?? []) {
			if (entry.kind !== "tool") continue;
			const versionKey = `${key}:${entry.seq}`;
			const version = this.toolVersion(entry);
			const previousVersion = this.toolVersions.get(versionKey);
			this.toolVersions.set(versionKey, version);
			if (previousVersion === undefined || previousVersion === version) continue;
			const updatedGroup = groupToolActivity([entry], { phase: initialPhase, note: initialNote })[0];
			if (updatedGroup === undefined || this.refreshPendingTool(key, updatedGroup.items[0]) === true) continue;
			this.queueToolGroup(actor, updatedGroup);
		}
		for (const entry of unseen) {
			max = Math.max(max, entry.seq);
			if (entry.kind === "turn" && entry.summary) this.queueNarration(actor, entry.summary);
			else if (entry.kind === "phase" && entry.blocking === true) {
				this.pushImmediate(output, this.event(snapshot, actor, nowMs, { kind: "blocker", blocked: true, text: sanitizeString(entry.note ?? entry.phase ?? "blocked", MAX_PROGRESS_TEXT_CHARS) }));
			} else if (entry.kind === "phase" && entry.phase) {
				this.pushImmediate(output, this.event(snapshot, actor, nowMs, { kind: "phase", phase: sanitizeString(entry.phase, 100), note: entry.note ? sanitizeString(entry.note, MAX_PROGRESS_TEXT_CHARS) : undefined }));
			} else if (
				entry.kind === "failure" &&
				actor.kind === "child" &&
				!output.some((event) => event.kind === "failure" && actorKey(event.actor) === key)
			) {
				this.pushImmediate(output, this.event(snapshot, actor, nowMs, { kind: "failure", text: sanitizeString(entry.error, MAX_PROGRESS_TEXT_CHARS) }));
			}
		}
		this.journalSeq.set(key, max);
	}

	private queueNarration(actor: ProgressActor, text: string): void {
		const clean = sanitizeString(text, MAX_PROGRESS_TEXT_CHARS);
		if (!clean) return;
		this.pendingNarration.set(actorKey(actor), { actor, text: clean });
	}

	private refreshPendingTool(key: string, item: ToolActivityItem | undefined): boolean {
		if (item === undefined) return false;
		const buckets = [this.pendingTools.get(key), ...this.readyTools];
		for (const bucket of buckets) {
			if (bucket === undefined || actorKey(bucket.actor) !== key) continue;
			const index = bucket.items.findIndex((candidate) => candidate.seq === item.seq);
			if (index === -1) continue;
			bucket.items[index] = item;
			return true;
		}
		return false;
	}

	private queueToolGroup(actor: ProgressActor, group: ToolActivityGroup): void {
		const key = actorKey(actor);
		const existing = this.pendingTools.get(key);
		const first = group.items[0];
		const lastExisting = existing?.items.at(-1);
		const consecutive = first !== undefined && lastExisting !== undefined && first.seq === lastExisting.seq + 1;
		if (
			existing !== undefined &&
			consecutive &&
			existing.phase === group.phase &&
			existing.note === group.note
		) {
			existing.items.push(...group.items);
			return;
		}
		if (existing !== undefined) this.readyTools.push(existing);
		this.pendingTools.set(key, {
			actor,
			...(group.phase !== undefined ? { phase: group.phase } : {}),
			...(group.note !== undefined ? { note: group.note } : {}),
			items: [...group.items],
		});
	}

	private flushRoutine(snapshot: TreeSnapshot, nowMs: number): TranscriptProgressEvent | undefined {
		if (nowMs - this.lastRoutineAt < ROUTINE_PROGRESS_INTERVAL_MS) return undefined;
		const narration = this.pendingNarration.entries().next().value;
		if (narration) {
			this.pendingNarration.delete(narration[0]);
			const event = this.event(snapshot, narration[1].actor, nowMs, { kind: "narration", text: narration[1].text });
			if (!this.remember(`narration:${actorKey(event.actor)}:${narration[1].text}`)) return this.flushRoutine(snapshot, nowMs);
			this.lastRoutineAt = nowMs;
			return event;
		}
		let tools = this.readyTools.shift();
		if (tools === undefined) {
			const active = this.pendingTools.entries().next().value;
			if (active === undefined) return undefined;
			this.pendingTools.delete(active[0]);
			tools = active[1];
		}
		const event = this.event(snapshot, tools.actor, nowMs, {
			kind: "activity_group",
			...(tools.phase !== undefined ? { phase: tools.phase } : {}),
			...(tools.note !== undefined ? { note: tools.note } : {}),
			items: tools.items.slice(0, MAX_ACTIVITY_ITEMS),
		});
		this.lastRoutineAt = nowMs;
		return event;
	}

	private event(
		snapshot: TreeSnapshot,
		actor: ProgressActor,
		nowMs: number,
		details: ProgressDetails,
	): TranscriptProgressEvent {
		const common: ProgressCommon = {
			schemaVersion: PROGRESS_SCHEMA_VERSION,
			taskId: sanitizeString(snapshot.taskId, 100),
			workflowId: sanitizeString(snapshot.workflowId, 100),
			at: new Date(nowMs).toISOString(),
			actor,
		};
		switch (details.kind) {
			case "phase": return { ...common, ...details };
			case "narration": return { ...common, ...details };
			case "activity_group": return { ...common, ...details };
			case "tool_burst": return { ...common, ...details };
			case "nested_launch": return { ...common, ...details };
			case "nested_return": return { ...common, ...details };
			case "blocker": return { ...common, ...details };
			case "failure": return { ...common, ...details };
			default: {
				const _exhaustive: never = details;
				return _exhaustive;
			}
		}
	}

	private pushImmediate(output: TranscriptProgressEvent[], event: TranscriptProgressEvent): void {
		const signature = JSON.stringify({ ...event, at: undefined });
		if (this.remember(signature)) output.push(event);
	}

	private remember(key: string): boolean {
		if (this.emitted.has(key)) return false;
		this.emitted.add(key);
		if (this.emitted.size > MAX_DEDUPE_KEYS) {
			const oldest = this.emitted.values().next().value;
			if (oldest !== undefined) this.emitted.delete(oldest);
		}
		return true;
	}
}
