import type { SessionEntryLike } from "../mode.ts";
import type { TaskRequest, TaskSpec } from "../types.ts";
import type { DstackResultView } from "./result.ts";

export const MAX_OWNER_ATTEMPTS = 3; // total launches: 1 original + up to 2 recoveries

export const RECOVERY_ENTRY = "dstack-recovery";

export type RecoveryAttempt = Readonly<{ taskId: string; endedAt: string; reason: string }>;

export type RecoveryLineageStatus = "active" | "resolved" | "exhausted" | "unrecoverable";

export type RecoveryLineage = Readonly<{
	lineageId: string;
	request: TaskRequest;
	playbook?: string;
	currentTaskId: string;
	attempts: readonly RecoveryAttempt[];
	status: RecoveryLineageStatus;
}>;

export type FailureClassification = "retryable" | "unrecoverable" | "success";

export type RecoveryAction =
	| Readonly<{ kind: "relaunch"; attemptNumber: number }>
	| Readonly<{ kind: "stop"; status: RecoveryLineageStatus; reason: string }>
	| Readonly<{ kind: "ignore" }>;

export function classifyFailure(view: DstackResultView): FailureClassification {
	switch (view.kind) {
		case "complete":
			return view.package.results.some((result) => result.exitCode !== 0) ? "retryable" : "success";
		case "runner_failed":
		case "infrastructure_failure":
			return "retryable";
		default:
			return "unrecoverable";
	}
}

export function nextRecoveryAction(
	lineage: RecoveryLineage,
	taskId: string,
	classification: FailureClassification,
): RecoveryAction {
	if (
		taskId !== lineage.currentTaskId ||
		lineage.status !== "active" ||
		lineage.attempts.some((attempt) => attempt.taskId === taskId)
	) {
		return { kind: "ignore" };
	}
	if (classification === "success") {
		return { kind: "stop", status: "resolved", reason: "The owner attempt completed successfully." };
	}
	if (classification === "unrecoverable") {
		return { kind: "stop", status: "unrecoverable", reason: "The failure is not retryable." };
	}
	if (lineage.attempts.length + 1 >= MAX_OWNER_ATTEMPTS) {
		return {
			kind: "stop",
			status: "exhausted",
			reason: `All ${MAX_OWNER_ATTEMPTS} owner attempts have been consumed.`,
		};
	}
	return { kind: "relaunch", attemptNumber: lineage.attempts.length + 2 };
}

export type RetryAugmentation = Readonly<{
	attemptNumber: number;
	maxAttempts: number;
	priorTaskId: string;
	reason: string;
	evidenceDir?: string;
}>;

function recoveryPreamble(input: RetryAugmentation): string {
	const evidence = input.evidenceDir
		? `Preserved evidence from the failed attempt is at ${input.evidenceDir} (children/*/output.txt, result.json, and session files).`
		: "Evidence from the failed attempt was preserved in the workflow artifact dir (children/*/output.txt, result.json, and session files).";
	return [
		"",
		"---",
		`RECOVERY ATTEMPT ${input.attemptNumber} of ${input.maxAttempts}.`,
		`The prior owner attempt (task ${input.priorTaskId}) failed: ${input.reason}`,
		evidence,
		"Resume from that evidence. Do not repeat work already verified complete. Do not claim success without verification. If the outcome cannot be completed, report a concrete unrecoverable blocker.",
	].join("\n");
}

export function augmentRequestForRetry(request: TaskRequest, input: RetryAugmentation): TaskRequest {
	const copy = structuredClone(request) as { kind: TaskRequest["kind"]; spec?: TaskSpec; specs?: TaskSpec[] };
	const preamble = recoveryPreamble(input);
	const augment = (spec: TaskSpec) => {
		spec.task = `${spec.task}${preamble}`;
	};
	if (copy.kind === "single" && copy.spec !== undefined) {
		augment(copy.spec);
	} else if (copy.specs !== undefined) {
		for (const spec of copy.specs) {
			if (spec.workflow?.assignment === "owner") augment(spec);
		}
	}
	return copy as TaskRequest;
}

const REASON_CAP = 600;

export function summarizeFailure(view: DstackResultView): string {
	let reason: string;
	switch (view.kind) {
		case "complete": {
			const failing = view.package.results
				.filter((result) => result.exitCode !== 0)
				.map((result) => {
					const error = "errorMessage" in result && typeof result.errorMessage === "string" ? `: ${result.errorMessage}` : "";
					return `${result.agent} exited ${result.exitCode}${error}`;
				});
			reason = failing.length > 0 ? failing.join("; ") : "all children succeeded";
			break;
		}
		case "runner_failed":
		case "cancelled":
		case "unknown_task":
		case "infrastructure_failure":
			reason = view.message;
			break;
		case "artifact":
			reason = `artifact outcome ${view.outcome} (${view.summary.failed} failed, ${view.summary.cancelled} cancelled)`;
			break;
		default:
			reason = "the task did not complete successfully";
	}
	return reason.length > REASON_CAP ? `${reason.slice(0, REASON_CAP)}…` : reason;
}

export function formatRecoveryRelaunchNotice(input: Readonly<{
	priorTaskId: string;
	newTaskId: string;
	attemptNumber: number;
	maxAttempts: number;
	reason: string;
}>): string {
	return [
		`Owner attempt ${input.attemptNumber - 1} (task ${input.priorTaskId}) failed: ${input.reason}`,
		`Recovery attempt ${input.attemptNumber} of ${input.maxAttempts} launched as task ${input.newTaskId}.`,
		`Wait for its completion and collect it with dstack_result taskId "${input.newTaskId}". Do not treat task ${input.priorTaskId} as pending.`,
	].join("\n");
}

export function formatRecoveryStoppedNotice(input: Readonly<{
	status: RecoveryLineageStatus;
	attempts: readonly RecoveryAttempt[];
	evidenceDir?: string;
}>): string {
	const attemptLines = input.attempts.map(
		(attempt, index) => `- attempt ${index + 1} (task ${attempt.taskId}): ${attempt.reason}`,
	);
	return [
		`The workflow outcome is INCOMPLETE (recovery ${input.status}). Attempts:`,
		...attemptLines,
		input.evidenceDir ? `Preserved evidence: ${input.evidenceDir}` : "",
		"Report the concrete blocker to the user. Never claim success for this workflow.",
	]
		.filter(Boolean)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseAttempt(value: unknown): RecoveryAttempt | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.taskId !== "string" || typeof value.endedAt !== "string" || typeof value.reason !== "string") {
		return undefined;
	}
	return { taskId: value.taskId, endedAt: value.endedAt, reason: value.reason };
}

function parseSpec(value: unknown): TaskSpec | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.agent !== "string" || typeof value.task !== "string") return undefined;
	return value as TaskSpec;
}

function parseRequest(value: unknown): TaskRequest | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "single") {
		const spec = parseSpec(value.spec);
		return spec === undefined ? undefined : { kind: "single", spec };
	}
	if (value.kind === "parallel" || value.kind === "chain") {
		if (!Array.isArray(value.specs)) return undefined;
		const specs: TaskSpec[] = [];
		for (const item of value.specs) {
			const spec = parseSpec(item);
			if (spec === undefined) return undefined;
			specs.push(spec);
		}
		if (specs.length === 0) return undefined;
		return { kind: value.kind, specs };
	}
	return undefined;
}

const LINEAGE_STATUSES: readonly RecoveryLineageStatus[] = ["active", "resolved", "exhausted", "unrecoverable"];

export function parseRecoveryLineage(value: unknown): RecoveryLineage | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.lineageId !== "string" || typeof value.currentTaskId !== "string") return undefined;
	if (typeof value.status !== "string" || !LINEAGE_STATUSES.includes(value.status as RecoveryLineageStatus)) {
		return undefined;
	}
	const request = parseRequest(value.request);
	if (request === undefined) return undefined;
	if (!Array.isArray(value.attempts)) return undefined;
	const attempts: RecoveryAttempt[] = [];
	for (const item of value.attempts) {
		const attempt = parseAttempt(item);
		if (attempt === undefined) return undefined;
		attempts.push(attempt);
	}
	return {
		lineageId: value.lineageId,
		request,
		playbook: typeof value.playbook === "string" ? value.playbook : undefined,
		currentTaskId: value.currentTaskId,
		attempts,
		status: value.status as RecoveryLineageStatus,
	};
}

export function restoreRecoveryLineages(entries: readonly SessionEntryLike[]): Map<string, RecoveryLineage> {
	const lineages = new Map<string, RecoveryLineage>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== RECOVERY_ENTRY) continue;
		const lineage = parseRecoveryLineage(entry.data);
		if (lineage !== undefined) lineages.set(lineage.lineageId, lineage);
	}
	return lineages;
}
