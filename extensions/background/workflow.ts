import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDetails, TaskResult } from "../dstack.ts";
import { buildChildArgv, capOutput, childEnv, runChildProcess, type ChildInvocation, type ChildResult } from "../spawn.ts";
import type { WorktreeFrom } from "../types.ts";
import { MAX_CONCURRENCY, NESTING_ENV } from "../types.ts";
import { createWorktree } from "../worktree.ts";
import { atomicWriteFile, readOutputArtifact, toAbsolutePath, writeSealedArtifact, type OutputArtifactSeal } from "./artifacts.ts";

export const ROOT_WORKFLOW_ENV = "DSTACK_ROOT_WORKFLOW";
export const SCHEDULER_ROOT_ENV = "DSTACK_SCHEDULER_ROOT";

export type WorkflowMode = "single" | "parallel" | "chain";

export type ResolvedChildSpec = Readonly<{
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	omitModel?: boolean;
	tools?: string;
	systemPrompt?: string;
	worktree?: Readonly<{ repoRoot: string; base: string; from: WorktreeFrom }>;
}>;

export type WorkflowManifestV1 = Readonly<{
	schemaVersion: "dstack.workflow.v1";
	workflowId: string;
	sessionId: string;
	schedulerRoot: string;
	artifactDir: string;
	extensionPath: string;
	piChildLaunch: Readonly<{ executable: string; argvPrefix: readonly string[] }>;
	mode: WorkflowMode;
	childDepth: 1;
	specs: readonly [ResolvedChildSpec, ...ResolvedChildSpec[]];
	createdAt: string;
}>;

export interface SlotLease {
	release(): void | Promise<void>;
}

export interface SlotAcquirer {
	acquire(input: Readonly<{ workflowId: string; childIndex: number; signal: AbortSignal }>): Promise<SlotLease>;
}

export const immediateSlotAcquirer: SlotAcquirer = {
	async acquire() {
		return { release() {} };
	},
};

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

type ChildIndexEntry = Readonly<{
	index: number;
	state: ChildState;
	output: OutputArtifactSeal;
	result: OutputArtifactSeal;
}>;

export type WorkflowResultIndexV1 = Readonly<{
	schemaVersion: "dstack.result-index.v1";
	workflowId: string;
	manifestSha256: string;
	mode: WorkflowMode;
	outcome: "succeeded" | "failed" | "cancelled";
	summary: Readonly<{ total: number; succeeded: number; failed: number; cancelled: number }>;
	package: TaskDetails;
	children: readonly ChildIndexEntry[];
}>;

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

async function writeProgress(manifest: WorkflowManifestV1, states: readonly (ChildState | "queued" | "running")[]): Promise<void> {
	const progress = {
		queued: states.filter((state) => state === "queued").length,
		running: states.filter((state) => state === "running").length,
		complete: states.filter((state) => state !== "queued" && state !== "running").length,
		total: states.length,
	};
	await atomicWriteFile(join(manifest.artifactDir, "progress.json"), `${JSON.stringify(progress)}\n`);
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
		result: input.result,
		output,
	};
	const result = await writeSealedArtifact(resultPath, `${JSON.stringify(metadata)}\n`);
	return { index: input.index, state: input.state, output, result };
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Workflow cancelled");
}

export async function executeWorkflow(
	manifest: WorkflowManifestV1,
	manifestSha256: string,
	signal: AbortSignal,
	dependencies: WorkflowDependencies = {},
): Promise<WorkflowResultIndexV1> {
	const slots = dependencies.slots ?? createLocalSlotAcquirer();
	const spawnChild = dependencies.spawnChild ?? runChildProcess;
	const makeWorktree = dependencies.createWorktree ?? createWorktree;
	const states: (ChildState | "queued" | "running")[] = manifest.specs.map(() => "queued");
	const results: TaskResult[] = new Array(manifest.specs.length);
	const entries: ChildIndexEntry[] = new Array(manifest.specs.length);
	await writeProgress(manifest, states);

	const runOne = async (spec: ResolvedChildSpec, index: number, task: string): Promise<{ state: ChildState; output: string }> => {
		if (signal.aborted) throw abortError(signal);
		const lease = await slots.acquire({ workflowId: manifest.workflowId, childIndex: index, signal });
		try {
			if (signal.aborted) throw abortError(signal);
			states[index] = "running";
			await writeProgress(manifest, states);
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
			const systemPrompt = spec.systemPrompt;
			const systemPromptPath = systemPrompt === undefined ? undefined : join(childDirectory, "system-prompt.md");
			if (systemPromptPath !== undefined && systemPrompt !== undefined) await atomicWriteFile(systemPromptPath, systemPrompt);
			const args = buildChildArgv({
				task,
				extensionPath: manifest.extensionPath,
				model: spec.model,
				omitModel: spec.omitModel,
				tools: spec.tools,
				systemPromptPath,
			});
			const invocation: ChildInvocation = {
				command: manifest.piChildLaunch.executable,
				argsPrefix: manifest.piChildLaunch.argvPrefix,
			};
			const env = childEnv(1, dependencies.env ?? process.env);
			env[NESTING_ENV] = "1";
			env[ROOT_WORKFLOW_ENV] = manifest.workflowId;
			env[SCHEDULER_ROOT_ENV] = manifest.schedulerRoot;
			const child = await spawnChild({ args, cwd, env, invocation, signal });
			const state: ChildState = signal.aborted ? "cancelled" : child.exitCode === 0 ? "succeeded" : "failed";
			const completed = taskResult(child, spec, cwd, task, manifest.mode === "chain" ? index + 1 : undefined);
			results[index] = completed;
			entries[index] = await sealChild({ manifest, index, state, result: completed, fullOutput: child.text });
			states[index] = state;
			await writeProgress(manifest, states);
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
				results[index] = skipped;
				entries[index] = await sealChild({ manifest, index, state, result: skipped, fullOutput: "" });
				states[index] = state;
				await writeProgress(manifest, states);
				continue;
			}
			const task = spec.task.replaceAll("{previous}", previous);
			try {
				const outcome = await runOne(spec, index, task);
				previous = outcome.output;
				if (outcome.state !== "succeeded") stopped = true;
			} catch (error) {
				if (!signal.aborted) throw error;
				const cancelled = syntheticResult({ spec: { ...spec, task }, cwd: spec.cwd, step: index + 1, state: "cancelled", message: abortError(signal).message });
				results[index] = cancelled;
				entries[index] = await sealChild({ manifest, index, state: "cancelled", result: cancelled, fullOutput: "" });
				states[index] = "cancelled";
			}
		}
	} else {
		await Promise.all(manifest.specs.map(async (spec, index) => {
			try {
				await runOne(spec, index, spec.task);
			} catch (error) {
				if (!signal.aborted) throw error;
				const cancelled = syntheticResult({ spec, cwd: spec.cwd, state: "cancelled", message: abortError(signal).message });
				results[index] = cancelled;
				entries[index] = await sealChild({ manifest, index, state: "cancelled", result: cancelled, fullOutput: "" });
				states[index] = "cancelled";
				await writeProgress(manifest, states);
			}
		}));
	}

	const succeeded = states.filter((state) => state === "succeeded").length;
	const cancelled = states.filter((state) => state === "cancelled").length;
	const failed = states.length - succeeded - cancelled;
	const outcome = cancelled > 0 ? "cancelled" : failed > 0 ? "failed" : "succeeded";
	await writeProgress(manifest, states);
	return {
		schemaVersion: "dstack.result-index.v1",
		workflowId: manifest.workflowId,
		manifestSha256,
		mode: manifest.mode,
		outcome,
		summary: { total: states.length, succeeded, failed, cancelled },
		package: { mode: manifest.mode, results },
		children: entries,
	};
}

export async function verifyChildOutputs(index: WorkflowResultIndexV1): Promise<void> {
	for (const child of index.children) await readOutputArtifact(child.output);
}

export function artifactDirectory(path: string): string {
	return String(toAbsolutePath(path));
}
