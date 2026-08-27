import { sanitizeString, type JournalEntry, type SemanticStatus } from "./journal.ts";
import { isLeaseSnapshot, type SpawnNestedChild, type TreeChild, type TreeSnapshot } from "./tree.ts";

export const PROGRESS_ENTRY = "dstack-progress";
export const PROGRESS_SCHEMA_VERSION = "dstack.progress.v1";
export const ROUTINE_PROGRESS_INTERVAL_MS = 4_000;

const MAX_PROGRESS_TEXT_CHARS = 240;
const MAX_PROGRESS_TASK_CHARS = 120;
const MAX_TOOL_KINDS = 6;
const MAX_DEDUPE_KEYS = 128;

type ChildActor = Readonly<{
	kind: "child";
	childIndex: number;
	agent: string;
	assignment?: "owner" | "worker" | "reviewer";
}>;

type NestedActor = Readonly<{
	kind: "nested";
	parentIndex: number;
	groupId: string;
	nestedIndex: number;
	agent: string;
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
	counts: Map<string, number>;
	total: number;
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
	if (value.kind === "child" && typeof value.childIndex === "number" && Number.isSafeInteger(value.childIndex) && value.childIndex >= 0) {
		return { kind: "child", childIndex: value.childIndex, agent: sanitizeString(value.agent, 40), assignment };
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
			assignment,
		};
	}
	return undefined;
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
	const role = actor.assignment ?? (actor.kind === "nested" ? "worker" : "agent");
	return `${role} ${actor.agent}`;
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
	return `${line}\n${color(theme, "dim", `${attribution} · ${event.at}`)}`;
}

function childActor(child: TreeChild): ChildActor {
	return { kind: "child", childIndex: child.index, agent: sanitizeString(child.agent, 40), assignment: child.assignment };
}

function nestedActor(parent: TreeChild, nested: SpawnNestedChild): NestedActor {
	return {
		kind: "nested",
		parentIndex: parent.index,
		groupId: sanitizeString(nested.groupId, 80),
		nestedIndex: nested.nestedIndex,
		agent: sanitizeString(nested.agent, 40),
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
	private readonly pendingNarration = new Map<string, PendingNarration>();
	private readonly pendingTools = new Map<string, ToolBucket>();
	private readonly emitted = new Set<string>();

	reset(): void {
		this.previous = undefined;
		this.lastRoutineAt = 0;
		this.journalSeq.clear();
		this.pendingNarration.clear();
		this.pendingTools.clear();
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
			this.captureJournal(snapshot, actor, child.journal, immediate, nowMs);
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
			this.journalSeq.set(actorKey(childActor(child)), journalMaxSeq(child.journal));
			for (const nested of child.nested) {
				if (isLeaseSnapshot(nested)) continue;
				this.journalSeq.set(actorKey(nestedActor(child, nested)), journalMaxSeq(nested.journal));
			}
		}
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
			this.captureJournal(snapshot, actor, nested.journal, output, nowMs);
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

	private captureJournal(snapshot: TreeSnapshot, actor: ProgressActor, journal: readonly JournalEntry[] | undefined, output: TranscriptProgressEvent[], nowMs: number): void {
		const key = actorKey(actor);
		const seen = this.journalSeq.get(key) ?? 0;
		let max = seen;
		for (const entry of journal ?? []) {
			max = Math.max(max, entry.seq);
			if (entry.seq <= seen) continue;
			if (entry.kind === "tool") this.queueTool(actor, entry.name);
			else if (entry.kind === "turn" && entry.summary) this.queueNarration(actor, entry.summary);
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

	private queueTool(actor: ProgressActor, name: string): void {
		const key = actorKey(actor);
		let bucket = this.pendingTools.get(key);
		if (!bucket) {
			bucket = { actor, counts: new Map(), total: 0 };
			this.pendingTools.set(key, bucket);
		}
		const clean = sanitizeString(name, 40);
		bucket.total += 1;
		bucket.counts.set(clean, (bucket.counts.get(clean) ?? 0) + 1);
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
		const tools = this.pendingTools.entries().next().value;
		if (!tools) return undefined;
		this.pendingTools.delete(tools[0]);
		const rows = [...tools[1].counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, MAX_TOOL_KINDS)
			.map(([name, count]) => ({ name, count }));
		const event = this.event(snapshot, tools[1].actor, nowMs, { kind: "tool_burst", tools: rows, total: tools[1].total });
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
