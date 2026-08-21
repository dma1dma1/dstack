import { formatTodos } from "./todo.ts";
import type { TodoState } from "./types.ts";

export type CompactContext = {
	playbook?: string;
	todos?: TodoState;
};

export function compactDetails(ctx: CompactContext): { playbook?: string; todos?: string } {
	const details: { playbook?: string; todos?: string } = {};
	if (ctx.playbook) details.playbook = ctx.playbook;
	if (ctx.todos && ctx.todos.items.length > 0) details.todos = formatTodos(ctx.todos);
	return details;
}

export function compactInstructions(ctx: CompactContext): string {
	const details = compactDetails(ctx);
	const parts: string[] = [];
	if (details.playbook) parts.push(`Active playbook: ${details.playbook}.`);
	if (details.todos) parts.push(`Current todos:\n${details.todos}`);
	return parts.join("\n");
}
