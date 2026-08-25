import type { CompanionTaskState } from "./eventbus-v1.ts";

export type WorkflowProgress = Readonly<{
	queued: number;
	running: number;
	complete: number;
	total: number;
}>;

export type DstackResultView =
	| Readonly<{ kind: "not_ready"; taskId: string; progress: WorkflowProgress }>
	| Readonly<{ kind: "cancelled"; taskId: string; message: string }>
	| Readonly<{ kind: "infrastructure_failure"; taskId: string; message: string; companionOutputPath?: string }>
	| Readonly<{ kind: "unknown_task"; taskId: string; message: string }>;

export type TaskBinding = Readonly<{
	taskId: string;
	workflowId: string;
}>;

export async function readDstackResult(input: Readonly<{
	taskId: string;
	statusExact: (taskId: string) => Promise<CompanionTaskState | undefined>;
	readBinding: (taskId: string) => Promise<TaskBinding | undefined>;
	readProgress: (binding: TaskBinding) => Promise<WorkflowProgress>;
}>): Promise<DstackResultView> {
	let task: CompanionTaskState | undefined;
	try {
		task = await input.statusExact(input.taskId);
	} catch (error) {
		return {
			kind: "infrastructure_failure",
			taskId: input.taskId,
			message: `background task status failed: ${errorMessage(error)}`,
		};
	}

	if (task === undefined) {
		return { kind: "unknown_task", taskId: input.taskId, message: `No background task exists with id ${input.taskId}.` };
	}

	let binding: TaskBinding | undefined;
	try {
		binding = await input.readBinding(input.taskId);
	} catch (error) {
		return infrastructureFailure(input.taskId, task, `dstack binding read failed: ${errorMessage(error)}`);
	}
	if (binding === undefined || binding.taskId !== input.taskId) {
		return infrastructureFailure(input.taskId, task, "The background task exists, but its dstack binding is missing or invalid.");
	}

	if (task.status === "running") {
		try {
			return { kind: "not_ready", taskId: input.taskId, progress: await input.readProgress(binding) };
		} catch (error) {
			return infrastructureFailure(input.taskId, task, `dstack progress read failed: ${errorMessage(error)}`);
		}
	}
	if (task.status === "killed") {
		return { kind: "cancelled", taskId: input.taskId, message: "The background task was cancelled." };
	}
	if (task.status === "completed") {
		return infrastructureFailure(input.taskId, task, "The background task completed without a committed result reader.");
	}
	if (task.status === "failed") {
		return infrastructureFailure(input.taskId, task, "The background task runner failed.");
	}
	const exhaustive: never = task.status;
	return exhaustive;
}

function infrastructureFailure(taskId: string, task: CompanionTaskState, message: string): DstackResultView {
	return { kind: "infrastructure_failure", taskId, message, companionOutputPath: task.outputPath };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
