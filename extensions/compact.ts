import { formatTodos } from "./todo.ts";
import { ACTIVE_WORKFLOW_ENTRY, type ActiveWorkflow, type TodoState } from "./types.ts";

export type CompactEntryLike = Readonly<{ type: string; customType?: string; data?: unknown }>;

export type CompactContext = {
	activeWorkflow?: ActiveWorkflow;
	todos?: TodoState;
};

export function parseActiveWorkflow(value: unknown): ActiveWorkflow | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.taskId !== "string" || typeof raw.playbook !== "string") return undefined;
	return { taskId: raw.taskId, playbook: raw.playbook };
}

export function restoreActiveWorkflow(entries: readonly CompactEntryLike[]): ActiveWorkflow | undefined {
	let active: ActiveWorkflow | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ACTIVE_WORKFLOW_ENTRY) continue;
		if (entry.data === null) active = undefined;
		else active = parseActiveWorkflow(entry.data) ?? active;
	}
	return active;
}

export function compactDetails(ctx: CompactContext): { activeWorkflow?: ActiveWorkflow; todos?: string } {
	const details: { activeWorkflow?: ActiveWorkflow; todos?: string } = {};
	if (ctx.activeWorkflow) details.activeWorkflow = ctx.activeWorkflow;
	if (ctx.todos && ctx.todos.items.length > 0) details.todos = formatTodos(ctx.todos);
	return details;
}

export function compactInstructions(ctx: CompactContext): string {
	const details = compactDetails(ctx);
	const parts: string[] = [];
	if (details.activeWorkflow) {
		parts.push(`Active dstack owner: task ${details.activeWorkflow.taskId}, playbook ${details.activeWorkflow.playbook}. Keep only this receipt until the owner completes.`);
	}
	if (details.todos) parts.push(`Current todos:\n${details.todos}`);
	return parts.join("\n");
}
