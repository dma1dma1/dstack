export type TodoSnapshot = {
	id: number | string;
	subject: string;
	status: "pending" | "in_progress";
	activeForm?: string;
};

export type TodoBranchEntry = {
	type: string;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	};
};

type TodoRecord = {
	id?: unknown;
	subject?: unknown;
	status?: unknown;
	activeForm?: unknown;
};

function parseActiveTasks(details: unknown): TodoSnapshot[] | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const tasks = (details as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return undefined;

	const active: TodoSnapshot[] = [];
	for (const value of tasks) {
		if (value === null || typeof value !== "object") continue;
		const task = value as TodoRecord;
		if (task.status !== "pending" && task.status !== "in_progress") continue;
		if ((typeof task.id !== "number" && typeof task.id !== "string") || typeof task.subject !== "string") continue;
		active.push({
			id: task.id,
			subject: task.subject,
			status: task.status,
			...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
		});
	}
	return active;
}

export function shouldArmContinuation(
	tasks: readonly TodoSnapshot[],
	state: { isIdle: boolean; hasPendingMessages: boolean },
): boolean {
	return tasks.length > 0 && state.isIdle && !state.hasPendingMessages;
}

/** Read the latest durable snapshot emitted by the richer `todo` tool. */
export function latestActiveTodoTasks(entries: readonly TodoBranchEntry[]): TodoSnapshot[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const message = entries[index]?.message;
		if (entries[index]?.type !== "message" || message?.role !== "toolResult" || message.toolName !== "todo") continue;
		if (message.isError) continue;
		const tasks = parseActiveTasks(message.details);
		if (tasks !== undefined) return tasks;
	}
	return [];
}

export function continuationPrompt(tasks: readonly TodoSnapshot[]): string {
	const lines = tasks.map((task) => {
		const activity = task.activeForm ? ` — ${task.activeForm}` : "";
		return `- #${task.id} [${task.status}] ${task.subject}${activity}`;
	});
	return [
		"Automatic compaction completed while the user's task still had unfinished work.",
		"Resume the work now; do not merely acknowledge this message or repeat the previous status report.",
		"Continue the in-progress task first, then remaining pending tasks. End only when the work is complete or genuinely requires user input.",
		"",
		"Unfinished tasks:",
		...lines,
	].join("\n");
}
