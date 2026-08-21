import { MODE_ENTRY, type ModeState } from "./types.ts";

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

export function dmodeReminder(skillPath: string): string {
	return `dmode is on. Read ${skillPath}. Casual turns stay short. Do not dump the playbook into the system prompt.`;
}

export function sameModeCommands(): readonly string[] {
	return ["dmode", "poteto-mode"];
}
