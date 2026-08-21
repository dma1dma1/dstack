import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TodoItem, TodoState, TodoStatus } from "./types.ts";

export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

export function emptyTodos(): TodoState {
	return { items: [] };
}

export function parseTodoState(raw: unknown): TodoState {
	if (raw === null || typeof raw !== "object") return emptyTodos();
	const itemsIn = (raw as { items?: unknown }).items;
	if (!Array.isArray(itemsIn)) return emptyTodos();
	const items: TodoItem[] = [];
	for (const item of itemsIn) {
		if (item === null || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.id !== "string" || typeof rec.content !== "string") continue;
		if (rec.status !== "pending" && rec.status !== "in_progress" && rec.status !== "completed") continue;
		items.push({ id: rec.id, content: rec.content, status: rec.status });
	}
	return { items };
}

export function applyTodoOp(
	state: TodoState,
	op:
		| { action: "list" }
		| { action: "create"; content: string }
		| { action: "update"; id: string; content?: string; status?: TodoStatus }
		| { action: "complete"; id: string },
	idFactory: () => string = () => crypto.randomUUID(),
): { state: TodoState; text: string } {
	if (op.action === "list") {
		return { state, text: formatTodos(state) };
	}
	if (op.action === "create") {
		const item: TodoItem = { id: idFactory(), content: op.content, status: "pending" };
		const next = { items: [...state.items, item] };
		return { state: next, text: `created ${item.id}\n${formatTodos(next)}` };
	}
	const idx = state.items.findIndex((t) => t.id === op.id);
	if (idx === -1) return { state, text: `unknown todo ${op.id}` };
	const current = state.items[idx] as TodoItem;
	if (op.action === "complete") {
		const nextItems = state.items.slice();
		nextItems[idx] = { ...current, status: "completed" };
		const next = { items: nextItems };
		return { state: next, text: formatTodos(next) };
	}
	const nextItems = state.items.slice();
	nextItems[idx] = {
		...current,
		content: op.content ?? current.content,
		status: op.status ?? current.status,
	};
	const next = { items: nextItems };
	return { state: next, text: formatTodos(next) };
}

export function formatTodos(state: TodoState): string {
	if (state.items.length === 0) return "(no todos)";
	return state.items.map((t) => `[${t.status}] ${t.id} ${t.content}`).join("\n");
}

export function todoFilePath(sessionId: string, home = homedir()): string {
	return join(home, ".pi/agent/dstack/todos", `${sessionId}.json`);
}

export async function loadTodos(path: string): Promise<TodoState> {
	try {
		return parseTodoState(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch {
		return emptyTodos();
	}
}

export async function saveTodos(path: string, state: TodoState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function richerTodoPresent(toolNames: readonly string[]): boolean {
	return toolNames.some((name) => name === "todo" || name === "rpiv_todo" || name === "rpiv-todo");
}
