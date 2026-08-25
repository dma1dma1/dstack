import type { TaskDetails } from "../dstack.ts";
import type { AbsolutePath, Sha256 } from "./artifacts.ts";
import type { CompanionTaskState } from "./eventbus-v1.ts";

export type WorkflowProgress = Readonly<{
	queued: number;
	running: number;
	complete: number;
	total: number;
}>;

export type GroupOutcome = "succeeded" | "failed" | "cancelled";

export type TaskSummary = Readonly<{
	total: number;
	succeeded: number;
	failed: number;
	cancelled: number;
}>;

export type CommittedResult =
	| Readonly<{ kind: "complete"; package: TaskDetails }>
	| Readonly<{
		kind: "artifact";
		outcome: GroupOutcome;
		path: AbsolutePath;
		sha256: Sha256;
		bytes: number;
		summary: TaskSummary;
	}>
	| Readonly<{ kind: "cancelled"; message: string }>;

export type DstackResultView =
	| Readonly<{ kind: "running"; taskId: string; progress: WorkflowProgress }>
	| Readonly<{ kind: "complete"; taskId: string; package: TaskDetails }>
	| Readonly<{
		kind: "artifact";
		taskId: string;
		outcome: GroupOutcome;
		path: AbsolutePath;
		sha256: Sha256;
		bytes: number;
		summary: TaskSummary;
	}>
	| Readonly<{ kind: "runner_failed"; taskId: string; message: string; companionOutputPath: string }>
	| Readonly<{ kind: "cancelled"; taskId: string; message: string }>
	| Readonly<{ kind: "unknown_task"; taskId: string; message: string }>
	| Readonly<{ kind: "infrastructure_failure"; taskId: string; message: string; companionOutputPath: string | null }>;

export type TaskBinding = Readonly<{
	taskId: string;
	workflowId: string;
}>;

type ResultReader = Readonly<{
	taskId: string;
	statusExact: (taskId: string) => Promise<CompanionTaskState | undefined>;
	readBinding: (taskId: string) => Promise<TaskBinding | undefined>;
	readProgress: (binding: TaskBinding) => Promise<WorkflowProgress>;
	readCommittedResult: (binding: TaskBinding) => Promise<CommittedResult | undefined>;
}>;

export async function readDstackResult(input: ResultReader): Promise<DstackResultView> {
	let task: CompanionTaskState | undefined;
	try {
		task = await input.statusExact(input.taskId);
	} catch (error) {
		return infrastructureFailure(input.taskId, undefined, `background task status failed: ${errorMessage(error)}`);
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

	switch (task.status) {
		case "running":
			try {
				return { kind: "running", taskId: input.taskId, progress: await input.readProgress(binding) };
			} catch (error) {
				return infrastructureFailure(input.taskId, task, `dstack progress read failed: ${errorMessage(error)}`);
			}
		case "completed": {
			const committed = await readCommitted(input, binding, task);
			if (committed.kind === "read_failure") return committed.result;
			if (committed.result === undefined) {
				return infrastructureFailure(input.taskId, task, "The background task completed without a valid committed result.");
			}
			return projectCommitted(input.taskId, committed.result);
		}
		case "failed":
			return {
				kind: "runner_failed",
				taskId: input.taskId,
				message: "The background task runner failed.",
				companionOutputPath: task.outputPath,
			};
		case "killed": {
			const committed = await readCommitted(input, binding, task);
			if (committed.kind === "read" && committed.result?.kind === "cancelled") {
				return { kind: "cancelled", taskId: input.taskId, message: committed.result.message };
			}
			return { kind: "cancelled", taskId: input.taskId, message: "The background task was cancelled." };
		}
		default: {
			const exhaustive: never = task.status;
			return exhaustive;
		}
	}
}

type InfrastructureFailure = Extract<DstackResultView, Readonly<{ kind: "infrastructure_failure" }>>;

type CommittedRead =
	| Readonly<{ kind: "read"; result: CommittedResult | undefined }>
	| Readonly<{ kind: "read_failure"; result: InfrastructureFailure }>;

async function readCommitted(input: ResultReader, binding: TaskBinding, task: CompanionTaskState): Promise<CommittedRead> {
	try {
		return { kind: "read", result: await input.readCommittedResult(binding) };
	} catch (error) {
		return {
			kind: "read_failure",
			result: infrastructureFailure(input.taskId, task, `dstack committed result read failed: ${errorMessage(error)}`),
		};
	}
}

function projectCommitted(taskId: string, committed: CommittedResult): DstackResultView {
	switch (committed.kind) {
		case "complete":
			return { kind: "complete", taskId, package: committed.package };
		case "artifact":
			return { kind: "artifact", taskId, outcome: committed.outcome, path: committed.path, sha256: committed.sha256, bytes: committed.bytes, summary: committed.summary };
		case "cancelled":
			return { kind: "cancelled", taskId, message: committed.message };
		default: {
			const exhaustive: never = committed;
			return exhaustive;
		}
	}
}

function infrastructureFailure(taskId: string, task: CompanionTaskState | undefined, message: string): InfrastructureFailure {
	return { kind: "infrastructure_failure", taskId, message, companionOutputPath: task?.outputPath ?? null };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
