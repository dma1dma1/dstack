import type { Usage } from "@earendil-works/pi-ai";
import type { TaskDetails, TaskResult } from "../dstack.ts";
import type { AbsolutePath, OutputArtifactSeal, Sha256 } from "./artifacts.ts";
import type { CompanionTaskState } from "./eventbus-v1.ts";
import type { JournalEntry, SemanticStatus } from "./journal.ts";

export type ChildStateView = Readonly<{
	index: number;
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
	agent: string;
	task?: string;
	cwd?: string;
	model?: string;
	latestStatus?: SemanticStatus;
	latestActivity?: string;
	recentActivity?: readonly string[];
	lastActiveAt?: string;
	startedAt?: string;
	endedAt?: string;
	elapsedMs?: number;
	journal?: readonly JournalEntry[];
	journalCount?: number;
	usage?: TaskResult["usage"];
	exitCode?: number;
}>;

export type WorkflowProgress = Readonly<{
	queued: number;
	running: number;
	complete: number;
	total: number;
	children?: readonly ChildStateView[];
}>;

export type GroupOutcome = "succeeded" | "failed" | "cancelled";

export type TaskSummary = Readonly<{
	total: number;
	succeeded: number;
	failed: number;
	cancelled: number;
}>;

export type CommittedResult =
	| Readonly<{ kind: "complete"; package: TaskDetails; outputs?: readonly OutputArtifactSeal[] }>
	| Readonly<{
		kind: "artifact";
		outcome: GroupOutcome;
		path: AbsolutePath;
		sha256: Sha256;
		bytes: number;
		summary: TaskSummary;
		usage?: Usage;
	}>
	| Readonly<{ kind: "cancelled"; message: string }>;

export type DstackResultView =
	| Readonly<{
		kind: "running";
		taskId: string;
		progress: WorkflowProgress;
		children?: readonly ChildStateView[];
		latestStatus?: SemanticStatus;
	}>
	| Readonly<{ kind: "complete"; taskId: string; detail: "summary"; package: TaskSummaryDetails }>
	| Readonly<{ kind: "complete"; taskId: string; detail: "full"; package: TaskDetails }>
	| Readonly<{
		kind: "artifact";
		taskId: string;
		outcome: GroupOutcome;
		path: AbsolutePath;
		sha256: Sha256;
		bytes: number;
		summary: TaskSummary;
		usage?: Usage;
	}>
	| Readonly<{ kind: "runner_failed"; taskId: string; message: string; companionOutputPath: string }>
	| Readonly<{ kind: "cancelled"; taskId: string; message: string }>
	| Readonly<{ kind: "unknown_task"; taskId: string; message: string }>
	| Readonly<{ kind: "infrastructure_failure"; taskId: string; message: string; companionOutputPath: string | null }>;

export type TaskBinding = Readonly<{
	taskId: string;
	workflowId: string;
	root?: string;
}>;

type ResultReader = Readonly<{
	taskId: string;
	detail?: "summary" | "full";
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

	let binding: TaskBinding | undefined;
	try {
		binding = await input.readBinding(input.taskId);
	} catch (error) {
		return infrastructureFailure(input.taskId, task, `dstack binding read failed: ${errorMessage(error)}`);
	}

	if (task === undefined) {
		if (binding === undefined || binding.taskId !== input.taskId) {
			return { kind: "unknown_task", taskId: input.taskId, message: `No background task exists with id ${input.taskId}.` };
		}
		const committed = await readCommitted(input, binding, undefined);
		if (committed.kind === "read_failure") return committed.result;
		if (committed.result === undefined) {
			return infrastructureFailure(input.taskId, undefined, "The background task has a durable binding, but no committed result or live status exists.");
		}
		return projectCommitted(input.taskId, committed.result, input.detail ?? "summary");
	}

	if (binding === undefined || binding.taskId !== input.taskId) {
		return infrastructureFailure(input.taskId, task, "The background task exists, but its dstack binding is missing or invalid.");
	}

	switch (task.status) {
		case "running":
			try {
				const progress = await input.readProgress(binding);
				return projectRunning(input.taskId, progress, input.detail ?? "summary");
			} catch (error) {
				return infrastructureFailure(input.taskId, task, `dstack progress read failed: ${errorMessage(error)}`);
			}
		case "completed": {
			const committed = await readCommitted(input, binding, task);
			if (committed.kind === "read_failure") return committed.result;
			if (committed.result === undefined) {
				return infrastructureFailure(input.taskId, task, "The background task completed without a valid committed result.");
			}
			return projectCommitted(input.taskId, committed.result, input.detail ?? "summary");
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
			if (committed.kind === "read" && committed.result !== undefined) {
				return projectCommitted(input.taskId, committed.result, input.detail ?? "summary");
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

async function readCommitted(input: ResultReader, binding: TaskBinding, task?: CompanionTaskState): Promise<CommittedRead> {
	try {
		return { kind: "read", result: await input.readCommittedResult(binding) };
	} catch (error) {
		return {
			kind: "read_failure",
			result: infrastructureFailure(input.taskId, task, `dstack committed result read failed: ${errorMessage(error)}`),
		};
	}
}

export function projectRunning(
	taskId: string,
	progress: WorkflowProgress,
	detail: "summary" | "full" = "summary",
): Extract<DstackResultView, { kind: "running" }> {
	const sourceChildren = progress.children ?? [];
	const children = detail === "full"
		? sourceChildren
		: sourceChildren.map((child) => ({
			index: child.index,
			state: child.state,
			agent: child.agent,
			...(child.latestStatus !== undefined ? { latestStatus: child.latestStatus } : {}),
			...(child.latestActivity !== undefined ? { latestActivity: child.latestActivity } : {}),
			...(child.recentActivity !== undefined ? { recentActivity: child.recentActivity } : {}),
			...(child.lastActiveAt !== undefined ? { lastActiveAt: child.lastActiveAt } : {}),
			...(child.startedAt !== undefined ? { startedAt: child.startedAt } : {}),
			...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}),
			...(child.elapsedMs !== undefined ? { elapsedMs: child.elapsedMs } : {}),
			...(child.usage !== undefined ? { usage: child.usage } : {}),
			...((child.journalCount ?? child.journal?.length) !== undefined
				? { journalCount: child.journalCount ?? child.journal?.length }
				: {}),
			...(child.exitCode !== undefined ? { exitCode: child.exitCode } : {}),
		}));
	const latestStatus = sourceChildren
		.flatMap((child) => child.latestStatus ?? [])
		.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
	const { children: _children, ...counts } = progress;
	return {
		kind: "running",
		taskId,
		progress: detail === "full" ? progress : counts,
		...(children.length > 0 ? { children } : {}),
		...(latestStatus !== undefined ? { latestStatus } : {}),
	};
}

export type TaskSummaryResult = Readonly<{
	agent: string;
	summary: string;
	exitCode: number;
	step?: number;
	errorMessage?: string;
	unresolvedTaskIds?: readonly string[];
}>;

export type TaskSummaryDetails = Readonly<{
	mode: TaskDetails["mode"];
	results: readonly TaskSummaryResult[];
}>;

const SUMMARY_CAP = 8 * 1024;
const ERROR_CAP = 2 * 1024;

function bounded(value: string, cap: number): string {
	if (Buffer.byteLength(value, "utf8") <= cap) return value;
	let text = value.slice(0, cap);
	while (Buffer.byteLength(text, "utf8") > cap) text = text.slice(0, -1);
	return `${text}\n\n[truncated; call dstack_result with detail: "full" for the remainder]`;
}

export function summaryPackage(committed: Extract<CommittedResult, { kind: "complete" }>): TaskSummaryDetails {
	return {
		mode: committed.package.mode,
		results: committed.package.results.map((result) => ({
			agent: result.agent,
			summary: bounded(result.text, SUMMARY_CAP),
			exitCode: result.exitCode,
			...(result.step !== undefined ? { step: result.step } : {}),
			...(result.errorMessage ? { errorMessage: bounded(result.errorMessage, ERROR_CAP) } : {}),
			...(result.unresolvedTaskIds !== undefined ? { unresolvedTaskIds: result.unresolvedTaskIds } : {}),
		})),
	};
}

function projectCommitted(taskId: string, committed: CommittedResult, detail: "summary" | "full"): DstackResultView {
	switch (committed.kind) {
		case "complete":
			return detail === "full"
				? { kind: "complete", taskId, detail, package: committed.package }
				: { kind: "complete", taskId, detail, package: summaryPackage(committed) };
		case "artifact":
			return {
				kind: "artifact",
				taskId,
				outcome: committed.outcome,
				path: committed.path,
				sha256: committed.sha256,
				bytes: committed.bytes,
				summary: committed.summary,
				...(committed.usage !== undefined ? { usage: committed.usage } : {}),
			};
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
