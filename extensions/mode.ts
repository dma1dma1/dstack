import { MODE_ENTRY, type ModeState, type NestingDepth } from "./types.ts";

export type SessionEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

export function parseModeData(data: unknown): ModeState | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const on = (data as { on?: unknown }).on;
	if (typeof on !== "boolean") return undefined;
	return { on };
}

export function restoreMode(entries: readonly SessionEntryLike[]): ModeState {
	let state: ModeState = { on: false };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
		const next = parseModeData(entry.data);
		if (next) state = next;
	}
	return state;
}

export function toggleMode(current: ModeState, args: string): ModeState {
	const token = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (token === "off") return { on: false };
	if (token === "on") return { on: true };
	return { on: true };
}

export function modeStatusText(state: ModeState): string | undefined {
	return state.on ? "dmode" : undefined;
}

export function dmodeNestingGuidance(depth: NestingDepth): string {
	if (depth === 0) {
		return "You are at root depth 0. Preserve context by delegating repository-context-intensive work instead of implementing it directly. Work locally only for trivial, low-context mechanical actions. Parallelize independent tasks early. Give each concurrent writer a distinct checkout. Depth-1 children may spawn terminal depth-2 workers.";
	}
	if (depth === 1) {
		return "You are at depth 1. Use your final fan-out level for independent tasks. Give each concurrent writer a distinct checkout. Depth-2 workers are terminal.";
	}
	return "You are a terminal depth-2 worker. Do not call dstack_task. Complete the assigned scope directly.";
}

export function dmodeReminder(skillPath: string, depth: NestingDepth = 0): string {
	return `dmode is on. Read ${skillPath}. Casual turns stay short. Do not dump the playbook into the system prompt. ${dmodeNestingGuidance(depth)}`;
}

export function sameModeCommands(): readonly string[] {
	return ["dmode", "poteto-mode"];
}
