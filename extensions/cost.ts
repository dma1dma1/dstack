import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommittedResult, TaskBinding } from "./background/result.ts";
import { buildTreeSnapshot, type NestedChild, type TreeChild } from "./background/tree.ts";
import { sessionRoot } from "./background/launch.ts";

export type CostLabel = "claimed" | "claimed/pending" | "pending" | "approximate";

export type CostRow = Readonly<{
	taskId?: string;
	agent: string;
	model?: string;
	cost: number;
	label: CostLabel;
}>;

export type CostSnapshot = Readonly<{
	persisted: number;
	live: number;
	total: number;
	persistedRows: readonly CostRow[];
	liveRows: readonly CostRow[];
}>;

type TaskResultFiles = Readonly<{
	listBindings: () => Promise<readonly TaskBinding[]>;
	readCommittedResult: (binding: TaskBinding) => Promise<CommittedResult | undefined>;
	isUsageClaimed: (binding: TaskBinding) => Promise<boolean>;
}>;

type EntryRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EntryRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteCost(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageCost(value: unknown): number | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	return finiteCost(value.cost.total);
}

function childUsageCost(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	return finiteCost(value.cost);
}

function messageEntry(entry: unknown): EntryRecord | undefined {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
	return entry.message;
}

function taskIdFromToolResult(message: EntryRecord): string | undefined {
	if (message.role !== "toolResult" || message.toolName !== "dstack_result" || !isRecord(message.details)) return undefined;
	return typeof message.details.taskId === "string" ? message.details.taskId : undefined;
}

function addRow(rows: CostRow[], row: CostRow): void {
	if (row.cost <= 0) return;
	const existingIndex = rows.findIndex(
		(existing) => existing.taskId === row.taskId && existing.agent === row.agent && existing.model === row.model && existing.label === row.label,
	);
	if (existingIndex === -1) {
		rows.push(row);
		return;
	}
	const existing = rows[existingIndex];
	if (existing !== undefined) rows[existingIndex] = { ...existing, cost: existing.cost + row.cost };
}

function persistedSnapshot(entries: readonly unknown[]): Readonly<{
	cost: number;
	rows: readonly CostRow[];
	claimedTaskIds: ReadonlySet<string>;
}> {
	let cost = 0;
	const rows: CostRow[] = [];
	const claimedTaskIds = new Set<string>();
	for (const entry of entries) {
		const message = messageEntry(entry);
		if (message !== undefined) {
			const entryCost = message.role === "assistant" ? usageCost(message.usage) : message.role === "toolResult" ? usageCost(message.usage) : undefined;
			if (entryCost === undefined) continue;
			cost += entryCost;
			const taskId = taskIdFromToolResult(message);
			if (taskId !== undefined) claimedTaskIds.add(taskId);
			addRow(rows, {
				...(taskId !== undefined ? { taskId } : {}),
				agent: taskId !== undefined ? "dstack" : message.role === "assistant" ? "root" : `tool:${String(message.toolName ?? "unknown")}`,
				...(message.role === "assistant" && typeof message.model === "string" ? { model: message.model } : {}),
				cost: entryCost,
				label: "claimed",
			});
			continue;
		}
		if (!isRecord(entry) || (entry.type !== "branch_summary" && entry.type !== "compaction")) continue;
		const entryCost = usageCost(entry.usage);
		if (entryCost === undefined) continue;
		cost += entryCost;
		addRow(rows, { agent: String(entry.type), cost: entryCost, label: "claimed" });
	}
	return { cost, rows, claimedTaskIds };
}

function committedRows(taskId: string, committed: CommittedResult, label: CostLabel): CostRow[] {
	if (committed.kind === "artifact") {
		const cost = usageCost(committed.usage);
		return cost === undefined ? [] : [{ taskId, agent: "dstack", cost, label }];
	}
	if (committed.kind !== "complete") return [];
	const rows: CostRow[] = [];
	for (const result of committed.package.results) {
		addRow(rows, {
			taskId,
			agent: result.agent,
			...(result.model !== undefined ? { model: result.model } : {}),
			cost: result.usage.cost,
			label,
		});
	}
	return rows;
}

function nestedUsageCost(nested: NestedChild): number | undefined {
	if (!("usage" in nested)) return undefined;
	return childUsageCost(nested.usage);
}

function claimedNestedTaskIds(records: readonly unknown[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const record of records) {
		const message = messageEntry(record);
		if (message === undefined || usageCost(message.usage) === undefined) continue;
		const taskId = taskIdFromToolResult(message);
		if (taskId !== undefined) ids.add(taskId);
	}
	return ids;
}

async function childSessionRecords(child: TreeChild): Promise<readonly unknown[] | undefined> {
	if (child.session === undefined) return undefined;
	try {
		const text = await readFile(child.session.sessionFile, "utf8");
		const records: unknown[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				records.push(JSON.parse(line));
			} catch {}
		}
		return records;
	} catch {
		return undefined;
	}
}

function sessionRecordsCost(records: readonly unknown[]): number {
	return persistedSnapshot(records).cost;
}

async function runningChildRow(taskId: string, child: TreeChild): Promise<CostRow | undefined> {
	const records = await childSessionRecords(child);
	if (records !== undefined) {
		const claimedNested = claimedNestedTaskIds(records);
		let cost = sessionRecordsCost(records);
		for (const group of child.nestedGroups) {
			if (claimedNested.has(group.groupId)) continue;
			for (const nested of group.children) cost += nestedUsageCost(nested) ?? 0;
		}
		return { taskId, agent: child.agent, model: child.model, cost, label: "pending" };
	}

	let cost = child.cost ?? 0;
	for (const nested of child.nested) cost += nestedUsageCost(nested) ?? 0;
	return cost > 0 ? { taskId, agent: child.agent, model: child.model, cost, label: "approximate" } : undefined;
}

function sumRows(rows: readonly CostRow[]): number {
	return rows.reduce((total, row) => total + row.cost, 0);
}

export async function buildCostSnapshot(input: Readonly<{
	entries: readonly unknown[];
	sessionId: string;
	files: TaskResultFiles;
	todoPath: string;
}>): Promise<CostSnapshot> {
	const persisted = persistedSnapshot(input.entries);
	const persistedRows = [...persisted.rows];
	const liveRows: CostRow[] = [];
	for (const binding of await input.files.listBindings()) {
		const committed = await input.files.readCommittedResult(binding);
		if (persisted.claimedTaskIds.has(binding.taskId)) {
			if (committed !== undefined) {
				const detailedRows = committedRows(binding.taskId, committed, "claimed");
				if (detailedRows.length > 0) {
					for (let index = persistedRows.length - 1; index >= 0; index -= 1) {
						if (persistedRows[index]?.taskId === binding.taskId) persistedRows.splice(index, 1);
					}
					for (const row of detailedRows) addRow(persistedRows, row);
				}
			}
			continue;
		}
		if (committed !== undefined) {
			const label: CostLabel = await input.files.isUsageClaimed(binding) ? "claimed/pending" : "pending";
			for (const row of committedRows(binding.taskId, committed, label)) addRow(liveRows, row);
			continue;
		}
		const root = binding.root ?? sessionRoot(input.sessionId);
		const snapshot = await buildTreeSnapshot({
			taskId: binding.taskId,
			workflowId: binding.workflowId,
			artifactDir: join(root, "workflows", binding.workflowId),
			schedulerRoot: join(root, "scheduler"),
			todoPath: input.todoPath,
		});
		if (snapshot === undefined) continue;
		for (const child of snapshot.children) {
			const row = await runningChildRow(binding.taskId, child);
			if (row !== undefined) addRow(liveRows, row);
		}
	}
	const live = sumRows(liveRows);
	return {
		persisted: persisted.cost,
		live,
		total: persisted.cost + live,
		persistedRows,
		liveRows,
	};
}

export function formatMergedCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

export function formatCostOverlay(snapshot: CostSnapshot): string[] {
	const lines = [
		`dstack cost  ${formatMergedCost(snapshot.total)}`,
		`Persisted    ${formatMergedCost(snapshot.persisted)}`,
	];
	for (const row of snapshot.persistedRows) {
		const task = row.taskId === undefined ? "" : ` ${row.taskId}`;
		const model = row.model === undefined ? "" : ` (${row.model})`;
		lines.push(`  ${row.agent}${model}${task}  ${formatMergedCost(row.cost)}  ${row.label}`);
	}
	lines.push(`Live         ${formatMergedCost(snapshot.live)}`);
	if (snapshot.liveRows.length === 0) lines.push("  no unclaimed dstack usage");
	for (const row of snapshot.liveRows) {
		const task = row.taskId === undefined ? "" : ` ${row.taskId}`;
		const model = row.model === undefined ? "" : ` (${row.model})`;
		lines.push(`  ${row.agent}${model}${task}  ${formatMergedCost(row.cost)}  ${row.label}`);
	}
	lines.push("", "Esc closes");
	return lines;
}
