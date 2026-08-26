import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConfig } from "../agents.ts";
import type { DstackConfig } from "../types.ts";
import type { TaskRequest } from "../types.ts";
import { dmodeReminder } from "../mode.ts";
import { freezePiChildLaunch, resolveAgent } from "../spawn.ts";
import { formatConfigError, resolveModel } from "../models.ts";
import { expandHome } from "../worktree.ts";
import { atomicWriteFile, writeSealedArtifact } from "./artifacts.ts";
import type { BackgroundTaskPort } from "./eventbus-v1.ts";
import { readCommittedWorkflowResult } from "./runner.ts";
import type { CommittedResult, TaskBinding, WorkflowProgress } from "./result.ts";
import type { ResolvedChildSpec, WorkflowManifestV1 } from "./workflow.ts";

export type BackgroundReceipt = Readonly<{
	taskId: string;
	workflowId: string;
	mode: TaskRequest["kind"];
	childCount: number;
	resultTool: "dstack_result";
}>;

function sessionRoot(sessionId: string): string {
	return join(homedir(), ".pi", "agent", "dstack", "background", encodeURIComponent(sessionId));
}

function bindingPath(root: string, taskId: string): string {
	return join(root, "bindings", `${encodeURIComponent(taskId)}.json`);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requestSpecs(request: TaskRequest) {
	return request.kind === "single" ? [request.spec] : request.specs;
}

export async function launchTaskGroup(input: Readonly<{
	request: TaskRequest;
	ctxCwd: string;
	sessionId: string;
	config: DstackConfig;
	agents: readonly AgentConfig[];
	extensionPath: string;
	skillPath: string;
	runnerPath: string;
	port: BackgroundTaskPort;
	signal?: AbortSignal;
}>): Promise<BackgroundReceipt> {
	const workflowId = randomUUID();
	const root = sessionRoot(input.sessionId);
	const artifactDir = join(root, "workflows", workflowId);
	const specs = requestSpecs(input.request);
	const resolvedSpecs = specs.map((spec, index): ResolvedChildSpec => {
		const resolvedAgent = resolveAgent(spec);
		const agent = input.agents.find((candidate) => candidate.name === resolvedAgent.agent);
		if (agent === undefined) {
			const available = input.agents.map((candidate) => candidate.name).join(", ") || "none";
			throw new Error(`Unknown agent "${resolvedAgent.agent}". Available: ${available}.`);
		}
		const model = resolveModel({
			explicit: spec.model,
			role: spec.role,
			roles: input.config.roles,
			candidateIndex: input.request.kind === "parallel" ? index : 0,
			overrideReason: spec.overrideReason,
		});
		if (!model.ok) throw new Error(formatConfigError(model.error));
		const promptParts = [agent.systemPrompt.trim()];
		if (resolvedAgent.dmode) promptParts.push(dmodeReminder(input.skillPath, 1));
		const cwd = resolve(input.ctxCwd, spec.cwd ?? input.ctxCwd);
		return {
			agent: resolvedAgent.agent,
			task: spec.task,
			cwd,
			model: model.value.model,
			omitModel: model.value.omitModel,
			requestedRole: model.value.requestedRole,
			roleIndex: model.value.roleIndex,
			overrideReason: spec.overrideReason,
			tools: resolvedAgent.tools ?? agent.tools?.join(","),
			systemPrompt: promptParts.filter(Boolean).join("\n\n") || undefined,
			worktree: spec.worktree
				? {
					repoRoot: input.ctxCwd,
					base: resolve(expandHome(input.config.worktree.base)),
					from: input.config.worktree.from,
				}
				: undefined,
		};
	});
	const first = resolvedSpecs[0];
	if (first === undefined) throw new Error("A task group must contain at least one child.");
	const childLaunch = await freezePiChildLaunch();
	const manifest: WorkflowManifestV1 = {
		schemaVersion: "dstack.workflow.v1",
		workflowId,
		sessionId: input.sessionId,
		schedulerRoot: join(root, "scheduler"),
		artifactDir,
		extensionPath: await realpath(input.extensionPath),
		piChildLaunch: { executable: childLaunch.command, argvPrefix: childLaunch.argsPrefix },
		mode: input.request.kind,
		childDepth: 1,
		specs: [first, ...resolvedSpecs.slice(1)],
		createdAt: new Date().toISOString(),
	};
	const manifestSeal = await writeSealedArtifact(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
	await atomicWriteFile(join(artifactDir, "progress.json"), `${JSON.stringify({ queued: specs.length, running: 0, complete: 0, total: specs.length })}\n`);
	const runnerPath = await realpath(input.runnerPath);
	const command = [
		shellQuote(process.execPath),
		"--experimental-strip-types",
		shellQuote(runnerPath),
		"--manifest",
		shellQuote(manifestSeal.path),
		"--manifest-sha256",
		manifestSeal.sha256,
	].join(" ");
	const task = await input.port.launch({
		request: { name: `dstack-v1:${workflowId}`, command },
		onAccepted() {},
		signal: input.signal,
	});
	const binding: TaskBinding = { taskId: task.id, workflowId };
	await atomicWriteFile(bindingPath(root, task.id), `${JSON.stringify(binding)}\n`);
	return { taskId: task.id, workflowId, mode: input.request.kind, childCount: specs.length, resultTool: "dstack_result" };
}

export function createTaskResultFiles(sessionId: string): Readonly<{
	readBinding: (taskId: string) => Promise<TaskBinding | undefined>;
	readProgress: (binding: TaskBinding) => Promise<WorkflowProgress>;
	readCommittedResult: (binding: TaskBinding) => Promise<CommittedResult | undefined>;
}> {
	const root = sessionRoot(sessionId);
	const workflowDir = (binding: TaskBinding) => join(root, "workflows", binding.workflowId);
	return {
		async readBinding(taskId) {
			try {
				const value: unknown = JSON.parse(await readFile(bindingPath(root, taskId), "utf8"));
				if (typeof value !== "object" || value === null || !("taskId" in value) || !("workflowId" in value)) return undefined;
				return typeof value.taskId === "string" && typeof value.workflowId === "string"
					? { taskId: value.taskId, workflowId: value.workflowId }
					: undefined;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async readProgress(binding) {
			const value: unknown = JSON.parse(await readFile(join(workflowDir(binding), "progress.json"), "utf8"));
			if (typeof value !== "object" || value === null) throw new Error("progress must be an object");
			const progress = Object.fromEntries(Object.entries(value));
			for (const key of ["queued", "running", "complete", "total"] as const) {
				if (!Number.isSafeInteger(progress[key]) || Number(progress[key]) < 0) throw new Error(`progress.${key} is invalid`);
			}
			return { queued: Number(progress.queued), running: Number(progress.running), complete: Number(progress.complete), total: Number(progress.total) };
		},
		async readCommittedResult(binding) {
			const artifactDir = workflowDir(binding);
			let manifestBytes: Buffer;
			try {
				manifestBytes = await readFile(join(artifactDir, "manifest.json"));
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
			const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
			try {
				const result = await readCommittedWorkflowResult(artifactDir, manifestSha256, binding.workflowId);
				return { kind: "complete", package: result.package };
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
	};
}
