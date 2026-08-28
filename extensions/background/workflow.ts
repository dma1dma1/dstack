import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDetails, TaskResult } from "../dstack.ts";
import { buildChildArgv, capOutput, childEnv, runChildProcess, type ChildInvocation, type ChildResult } from "../spawn.ts";
import type { WorkflowContext, WorktreeFrom } from "../types.ts";
import { DEFAULT_TOTAL_SLOTS, MAX_CONCURRENCY, NESTING_ENV, SESSION_REF_ENV, STATUS_FILE_ENV } from "../types.ts";
import { createWorktree } from "../worktree.ts";
import { atomicWriteFile, readOutputArtifact, toAbsolutePath, writeSealedArtifact, type OutputArtifactSeal } from "./artifacts.ts";
import { allowStatusTool, ChildJournalRecorder } from "./journal.ts";
import { readChildSessionRef, type ChildSessionRefV1 } from "./session.ts";
import { acquireChildSlot } from "./scheduler.ts";
import { latestActivity, type ChildActivityV1, type ProgressChildV1, type WorkflowProgressV2 } from "./tree.ts";

export const ROOT_WORKFLOW_ENV = "DSTACK_ROOT_WORKFLOW";
export const SCHEDULER_ROOT_ENV = "DSTACK_SCHEDULER_ROOT";
export const DSTACK_CHILD_INDEX_ENV = "DSTACK_CHILD_INDEX";
export const DSTACK_ARTIFACT_DIR_ENV = "DSTACK_ARTIFACT_DIR";

export type WorkflowMode = "single" | "parallel" | "chain";

export type ResolvedChildSpec = Readonly<{
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	omitModel?: boolean;
	requestedRole?: string;
	roleIndex?: number;
	overrideReason?: string;
	tools?: string;
	workflow?: WorkflowContext;
	systemPrompt?: string;
	worktree?: Readonly<{ repoRoot: string; base: string; from: WorktreeFrom }>;
}>;

export type WorkflowManifestV1 = Readonly<{
	schemaVersion: "dstack.workflow.v1";
	workflowId: string;
	sessionId: string;
	schedulerRoot: string;
	schedulerTotalSlots?: number;
	artifactDir: string;
	extensionPath: string;
	companionExtensionPaths?: readonly string[];
	piChildLaunch: Readonly<{ executable: string; argvPrefix: readonly string[] }>;
	mode: WorkflowMode;
	childDepth: 1;
	specs: readonly [ResolvedChildSpec, ...ResolvedChildSpec[]];
	createdAt: string;
}>;

export interface SlotLease {
	bindChild(pid: number): void | Promise<void>;
	release(): void | Promise<void>;
}

/** Test seam. Production execution always uses the shared file scheduler. */
export interface SlotAcquirer {
	acquire(input: Readonly<{ workflowId: string; childIndex: number; signal: AbortSignal }>): Promise<SlotLease>;
}

/** In-memory test seam. Never used by runner execution. */
export function createLocalSlotAcquirer(capacity = MAX_CONCURRENCY): SlotAcquirer {
	if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("slot capacity must be a positive integer");
	let active = 0;
	const queue: Array<Readonly<{ signal: AbortSignal; admit: (lease: SlotLease) => void; reject: (error: unknown) => void }>> = [];
	const admitNext = () => {
		while (active < capacity && queue.length > 0) {
			const waiter = queue.shift();
			if (waiter === undefined || waiter.signal.aborted) continue;
			active += 1;
			let released = false;
			waiter.admit({
				bindChild() {},
				release() {
					if (released) return;
					released = true;
					active -= 1;
					admitNext();
				},
			});
		}
	};
	return {
		acquire({ signal }) {
			if (signal.aborted) return Promise.reject(abortError(signal));
			return new Promise<SlotLease>((admit, reject) => {
				const waiter = { signal, admit, reject };
				const cancel = () => {
					const index = queue.indexOf(waiter);
					if (index >= 0) queue.splice(index, 1);
					reject(abortError(signal));
				};
				signal.addEventListener("abort", cancel, { once: true });
				queue.push({
					signal,
					reject,
					admit: (lease) => {
						signal.removeEventListener("abort", cancel);
						admit(lease);
					},
				});
				admitNext();
			});
		},
	};
}

type ChildState = "succeeded" | "failed" | "cancelled" | "skipped";

export type ChildIndexEntry = Readonly<{
	index: number;
	state: ChildState;
	output: OutputArtifactSeal;
	result: OutputArtifactSeal;
	session?: ChildSessionRefV1;
}>;

export type GroupOutcome = "succeeded" | "failed" | "cancelled";

export type GroupSummary = Readonly<{ total: number; succeeded: number; failed: number; cancelled: number }>;

export type WorkflowExecutionResult = Readonly<{
	workflowId: string;
	manifestSha256: string;
	mode: WorkflowMode;
	outcome: GroupOutcome;
	summary: GroupSummary;
	package: TaskDetails;
	children: readonly ChildIndexEntry[];
}>;

export type WorkflowResultIndexV1 = Readonly<{
	schemaVersion: "dstack.result-index.v1";
	workflowId: string;
	manifestSha256: string;
	mode: WorkflowMode;
	outcome: GroupOutcome;
	summary: GroupSummary;
	package: TaskDetails;
	children: readonly ChildIndexEntry[];
}>;

export type ResultIndexChildSummary = Readonly<{
	agent: string;
	task: string;
	exitCode: number;
	text: string;
}>;

export type ResultIndexChildV2 = Readonly<{
	index: number;
	state: ChildState;
	summary: ResultIndexChildSummary;
	result: OutputArtifactSeal;
}>;

export type WorkflowResultIndexV2 = Readonly<{
	schemaVersion: "dstack.result-index.v2";
	workflowId: string;
	manifestSha256: string;
	mode: WorkflowMode;
	outcome: GroupOutcome;
	summary: GroupSummary;
	children: readonly ResultIndexChildV2[];
}>;

export const INDEX_SUMMARY_TASK_CAP = 2 * 1024;
export const INDEX_SUMMARY_TEXT_CAP = 8 * 1024;

export function boundedSummaryText(value: string, cap: number): string {
	if (Buffer.byteLength(value, "utf8") <= cap) return value;
	let text = value.slice(0, cap);
	while (Buffer.byteLength(text, "utf8") > cap) text = text.slice(0, -1);
	return `${text}\n\n[truncated; read the sealed result.json for the remainder]`;
}

export function compactResultIndex(execution: WorkflowExecutionResult): WorkflowResultIndexV2 {
	return {
		schemaVersion: "dstack.result-index.v2",
		workflowId: execution.workflowId,
		manifestSha256: execution.manifestSha256,
		mode: execution.mode,
		outcome: execution.outcome,
		summary: execution.summary,
		children: execution.children.map((child) => {
			const result = execution.package.results[child.index];
			if (result === undefined) throw new Error("result index package is missing a child result");
			return {
				index: child.index,
				state: child.state,
				summary: {
					agent: result.agent,
					task: boundedSummaryText(result.task, INDEX_SUMMARY_TASK_CAP),
					exitCode: result.exitCode,
					text: boundedSummaryText(result.text, INDEX_SUMMARY_TEXT_CAP),
				},
				result: { ...child.result },
			};
		}),
	};
}

type WorkflowDependencies = Readonly<{
	slots?: SlotAcquirer;
	spawnChild?: typeof runChildProcess;
	createWorktree?: typeof createWorktree;
	env?: NodeJS.Dict<string>;
}>;

function emptyUsage(): ChildResult["usage"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function syntheticResult(input: Readonly<{ spec: ResolvedChildSpec; cwd: string; step?: number; state: "skipped" | "cancelled"; message: string }>): TaskResult {
	return {
		agent: input.spec.agent,
		cwd: input.cwd,
		task: input.spec.task,
		text: "",
		exitCode: 1,
		stderr: "",
		messages: [],
		usage: emptyUsage(),
		stopReason: input.state,
		errorMessage: input.message,
		step: input.step,
	};
}

async function writeProgress(manifest: WorkflowManifestV1, children: readonly ProgressChildV1[]): Promise<void> {
	const queued = children.filter((child) => child.state === "queued").length;
	const running = children.filter((child) => child.state === "running").length;
	const complete = children.filter((child) => child.state !== "queued" && child.state !== "running").length;
	const total = children.length;
	const payload: WorkflowProgressV2 = {
		queued,
		running,
		complete,
		total,
		children,
	};
	await atomicWriteFile(join(manifest.artifactDir, "progress.json"), `${JSON.stringify(payload)}\n`);
}

function taskResult(child: ChildResult, spec: ResolvedChildSpec, cwd: string, task: string, step?: number): TaskResult {
	return { ...child, text: capOutput(child.text), agent: spec.agent, cwd, task, step };
}

async function sealChild(input: Readonly<{
	manifest: WorkflowManifestV1;
	index: number;
	state: ChildState;
	result: TaskResult;
	fullOutput: string;
	startedAt?: string;
	endedAt?: string;
	session?: ChildSessionRefV1;
}>): Promise<ChildIndexEntry> {
	const directory = join(input.manifest.artifactDir, "children", String(input.index));
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const output = await writeSealedArtifact(join(directory, "output.txt"), input.fullOutput);
	const resultPath = join(directory, "result.json");
	const metadata = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: input.manifest.workflowId,
		index: input.index,
		state: input.state,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		result: input.result,
		output,
		...(input.session !== undefined ? { session: input.session } : {}),
	};
	const result = await writeSealedArtifact(resultPath, `${JSON.stringify(metadata)}\n`);
	return { index: input.index, state: input.state, output, result, ...(input.session !== undefined ? { session: input.session } : {}) };
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Workflow cancelled");
}

function resolvedToolsAllowlist(tools: string | undefined): readonly string[] | undefined {
	if (tools === undefined) return undefined;
	return tools.split(",");
}

function createThrottledWriter<T>(filePath: string, minIntervalMs = 1000) {
	let lastWriteTime = 0;
	let pendingData: T | undefined;
	let timer: NodeJS.Timeout | undefined;
	let writePromise: Promise<void> | undefined;
	let disposed = false;

	const flush = async (): Promise<void> => {
		if (writePromise !== undefined) {
			await writePromise;
			if (pendingData !== undefined) await flush();
			return;
		}
		if (pendingData === undefined) return;
		const data = pendingData;
		pendingData = undefined;
		writePromise = (async () => {
			try {
				await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
				lastWriteTime = Date.now();
			} catch {}
		})();
		await writePromise;
		writePromise = undefined;
		if (pendingData !== undefined && !disposed) schedule();
	};

	const schedule = () => {
		if (timer !== undefined || disposed) return;
		const elapsed = Date.now() - lastWriteTime;
		const delay = Math.max(0, minIntervalMs - elapsed);
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, delay);
		timer.unref?.();
	};

	return {
		write(data: T) {
			if (disposed) return;
			pendingData = data;
			const elapsed = Date.now() - lastWriteTime;
			if (elapsed >= minIntervalMs && writePromise === undefined) {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				void flush();
			} else {
				schedule();
			}
		},
		async dispose() {
			disposed = true;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			await flush();
		},
	};
}

export async function executeWorkflow(
	manifest: WorkflowManifestV1,
	manifestSha256: string,
	signal: AbortSignal,
	dependencies: WorkflowDependencies = {},
): Promise<WorkflowExecutionResult> {
	const spawnChild = dependencies.spawnChild ?? runChildProcess;
	const makeWorktree = dependencies.createWorktree ?? createWorktree;
	const childMeta: ProgressChildV1[] = manifest.specs.map((spec, index) => ({
		index,
		agent: spec.agent,
		state: "queued",
		role: spec.requestedRole,
		assignment: spec.workflow?.assignment,
	}));
	const results: TaskResult[] = new Array(manifest.specs.length);
	const entries: ChildIndexEntry[] = new Array(manifest.specs.length);
	await writeProgress(manifest, childMeta);

	const runOne = async (spec: ResolvedChildSpec, index: number, task: string): Promise<{ state: ChildState; output: string }> => {
		if (signal.aborted) throw abortError(signal);
		const lease = dependencies.slots === undefined
			? await acquireChildSlot({
					schedulerRoot: toAbsolutePath(manifest.schedulerRoot),
					workflowId: manifest.workflowId,
					childId: String(index),
					work: { depth: manifest.childDepth, tools: resolvedToolsAllowlist(spec.tools) },
					requestedTotalSlots: manifest.schedulerTotalSlots ?? DEFAULT_TOTAL_SLOTS,
					signal,
				})
			: await dependencies.slots.acquire({ workflowId: manifest.workflowId, childIndex: index, signal });
		let startedAt: string | undefined;
		try {
			if (signal.aborted) throw abortError(signal);
			startedAt = new Date().toISOString();
			childMeta[index] = {
				...childMeta[index],
				state: "running",
				startedAt,
			};
			await writeProgress(manifest, childMeta);
			let cwd = spec.cwd;
			if (spec.worktree !== undefined) {
				cwd = await makeWorktree({
					repoRoot: spec.worktree.repoRoot,
					task,
					base: spec.worktree.base,
					from: spec.worktree.from,
				});
			}
			const childDirectory = join(manifest.artifactDir, "children", String(index));
			await mkdir(childDirectory, { recursive: true, mode: 0o700 });
			const sessionDir = join(childDirectory, "session");
			await mkdir(sessionDir, { recursive: true, mode: 0o700 });
			const sessionRefPath = join(childDirectory, "session-ref.json");
			const journalPath = join(childDirectory, "journal.json");
			const statusPath = join(childDirectory, "status.json");
			const recorder = new ChildJournalRecorder({ journalPath, statusPath });
			recorder.recordSpawn({
				agent: spec.agent,
				task,
				cwd,
				model: spec.model,
				role: spec.requestedRole,
				step: manifest.mode === "chain" ? index + 1 : undefined,
			});
			await recorder.persist();
			const systemPrompt = spec.systemPrompt;
			const systemPromptPath = systemPrompt === undefined ? undefined : join(childDirectory, "system-prompt.md");
			if (systemPromptPath !== undefined && systemPrompt !== undefined) await atomicWriteFile(systemPromptPath, systemPrompt);
			const args = buildChildArgv({
				task,
				extensionPath: manifest.extensionPath,
				companionExtensionPaths: manifest.companionExtensionPaths,
				model: spec.model,
				omitModel: spec.omitModel,
				tools: allowStatusTool(spec.tools),
				systemPromptPath,
				sessionDir,
			});
			const invocation: ChildInvocation = {
				command: manifest.piChildLaunch.executable,
				argsPrefix: manifest.piChildLaunch.argvPrefix,
			};
			const env = childEnv(1, dependencies.env ?? process.env, spec.workflow?.assignment);
			env[NESTING_ENV] = "1";
			env[ROOT_WORKFLOW_ENV] = manifest.workflowId;
			env[SCHEDULER_ROOT_ENV] = manifest.schedulerRoot;
			env[DSTACK_CHILD_INDEX_ENV] = String(index);
			env[DSTACK_ARTIFACT_DIR_ENV] = manifest.artifactDir;
			env[STATUS_FILE_ENV] = statusPath;
			env[SESSION_REF_ENV] = sessionRefPath;
			const activityPath = join(childDirectory, "activity.json");
			const throttledActivity = createThrottledWriter<ChildActivityV1>(activityPath, 1000);
			let journalUpdates = Promise.resolve();
			let child: ChildResult;
			try {
				child = await spawnChild({
					args,
					cwd,
					env,
					invocation,
					signal,
					onSpawn: (pid) => lease.bindChild(pid),
					onUpdate: (partial) => {
						throttledActivity.write({
							schemaVersion: "dstack.child-activity.v1",
							workflowId: manifest.workflowId,
							index,
							activity: latestActivity(partial),
							updatedAt: new Date().toISOString(),
							turns: partial.usage.turns,
							contextTokens: partial.usage.contextTokens,
							cost: partial.usage.cost,
						});
						journalUpdates = journalUpdates.then(async () => {
							recorder.recordMessages(partial.messages);
							if (partial.usage.turns > 0) {
								recorder.recordTurn({ turn: partial.usage.turns, text: partial.text, usage: partial.usage });
							}
							await recorder.checkStatusFile();
							await recorder.persist();
						}).catch(() => undefined);
					},
				});
				await journalUpdates;
			} catch (error) {
				await journalUpdates.catch(() => undefined);
				recorder.recordFailure({ error: error instanceof Error ? error.message : String(error) });
				await recorder.persist();
				throw error;
			} finally {
				await throttledActivity.dispose();
			}
			await recorder.checkStatusFile();
			const endedAt = new Date().toISOString();
			const state: ChildState = signal.aborted ? "cancelled" : child.exitCode === 0 ? "succeeded" : "failed";
			if (signal.aborted) recorder.recordFailure({ error: "Workflow cancelled" });
			else recorder.recordExit({ exitCode: child.exitCode, text: child.text });
			await recorder.persist();
			const completed = taskResult(child, spec, cwd, task, manifest.mode === "chain" ? index + 1 : undefined);
			completed.journal = recorder.getEntries();
			completed.status = recorder.getLatestStatus();
			results[index] = completed;
			const session = await readChildSessionRef({ refPath: sessionRefPath, sessionDir });
			entries[index] = await sealChild({ manifest, index, state, result: completed, fullOutput: child.text, startedAt, endedAt, session });
			childMeta[index] = {
				...childMeta[index],
				state,
				startedAt,
				endedAt,
			};
			await writeProgress(manifest, childMeta);
			return { state, output: child.text };
		} finally {
			await lease.release();
		}
	};

	if (manifest.mode === "chain") {
		let previous = "";
		let stopped = false;
		for (const [index, spec] of manifest.specs.entries()) {
			if (stopped || signal.aborted) {
				const state = signal.aborted ? "cancelled" : "skipped";
				const message = signal.aborted ? "Workflow cancelled before this step started." : "Skipped because an earlier chain step failed.";
				const skipped = syntheticResult({ spec, cwd: spec.cwd, step: index + 1, state, message });
				const endedAt = new Date().toISOString();
				results[index] = skipped;
				entries[index] = await sealChild({ manifest, index, state, result: skipped, fullOutput: "", endedAt });
				childMeta[index] = {
					...childMeta[index],
					state,
					endedAt,
				};
				await writeProgress(manifest, childMeta);
				continue;
			}
			const task = spec.task.replaceAll("{previous}", previous);
			try {
				const outcome = await runOne(spec, index, task);
				previous = outcome.output;
				if (outcome.state !== "succeeded") stopped = true;
			} catch (error) {
				if (!signal.aborted) throw error;
				const endedAt = new Date().toISOString();
				const cancelled = syntheticResult({ spec: { ...spec, task }, cwd: spec.cwd, step: index + 1, state: "cancelled", message: abortError(signal).message });
				results[index] = cancelled;
				entries[index] = await sealChild({ manifest, index, state: "cancelled", result: cancelled, fullOutput: "", endedAt });
				childMeta[index] = {
					...childMeta[index],
					state: "cancelled",
					endedAt,
				};
				await writeProgress(manifest, childMeta);
			}
		}
	} else {
		await Promise.all(manifest.specs.map(async (spec, index) => {
			try {
				await runOne(spec, index, spec.task);
			} catch (error) {
				if (!signal.aborted) throw error;
				const endedAt = new Date().toISOString();
				const cancelled = syntheticResult({ spec, cwd: spec.cwd, state: "cancelled", message: abortError(signal).message });
				results[index] = cancelled;
				entries[index] = await sealChild({ manifest, index, state: "cancelled", result: cancelled, fullOutput: "", endedAt });
				childMeta[index] = {
					...childMeta[index],
					state: "cancelled",
					endedAt,
				};
				await writeProgress(manifest, childMeta);
			}
		}));
	}

	const succeeded = childMeta.filter((child) => child.state === "succeeded").length;
	const cancelled = childMeta.filter((child) => child.state === "cancelled").length;
	const failed = childMeta.length - succeeded - cancelled;
	const outcome = cancelled > 0 ? "cancelled" : failed > 0 ? "failed" : "succeeded";
	await writeProgress(manifest, childMeta);
	return {
		workflowId: manifest.workflowId,
		manifestSha256,
		mode: manifest.mode,
		outcome,
		summary: { total: childMeta.length, succeeded, failed, cancelled },
		package: { mode: manifest.mode, results },
		children: entries,
	};
}

export async function verifyChildOutputs(index: Pick<WorkflowExecutionResult, "children">): Promise<void> {
	for (const child of index.children) await readOutputArtifact(child.output);
}

export function artifactDirectory(path: string): string {
	return String(toAbsolutePath(path));
}
