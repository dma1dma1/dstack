import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConfig } from "../agents.ts";
import { executionProvenance, type DstackConfig } from "../types.ts";
import type { TaskRequest } from "../types.ts";
import { dmodeReminder } from "../mode.ts";
import { freezePiChildLaunch, resolveAgent } from "../spawn.ts";
import { formatConfigError, resolveModel } from "../models.ts";
import { expandHome } from "../worktree.ts";
import { workflowSystemPrompt } from "../workflow-context.ts";
import { atomicWriteFile, writeSealedArtifact } from "./artifacts.ts";
import type { BackgroundTaskPort } from "./eventbus-v1.ts";
import { readCommittedWorkflowResult } from "./runner.ts";
import { cleanupStaleChildSessions } from "./session.ts";
import { formatJournalActivity, readJournalFile, readSemanticStatusFile, recentJournal, recentJournalActivity } from "./journal.ts";
import type { ChildStateView, CommittedResult, TaskBinding, WorkflowProgress } from "./result.ts";
import type { ResolvedChildSpec, WorkflowManifestV1 } from "./workflow.ts";

type ManifestSpecSummary = Readonly<{
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifestSpecs(raw: unknown): readonly ManifestSpecSummary[] | undefined {
	if (!isRecord(raw) || !Array.isArray(raw["specs"])) return undefined;
	const specs: ManifestSpecSummary[] = [];
	for (const item of raw["specs"]) {
		if (!isRecord(item)) return undefined;
		if (typeof item["agent"] !== "string" || typeof item["task"] !== "string") return undefined;
		specs.push({
			agent: item["agent"],
			task: item["task"],
			cwd: typeof item["cwd"] === "string" ? item["cwd"] : undefined,
			model: typeof item["model"] === "string" ? item["model"] : undefined,
		});
	}
	return specs;
}

export type BackgroundReceipt = Readonly<{
	taskId: string;
	workflowId: string;
	mode: TaskRequest["kind"];
	childCount: number;
	resultTool: "dstack_result";
}>;

export function backgroundRoot(): string {
	return join(homedir(), ".pi", "agent", "dstack", "background");
}

export function sessionRoot(sessionId: string): string {
	return join(backgroundRoot(), encodeURIComponent(sessionId));
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
	companionExtensionPaths: readonly string[];
	skillPath: string;
	runnerPath: string;
	port: BackgroundTaskPort;
	signal?: AbortSignal;
}>): Promise<BackgroundReceipt> {
	const workflowId = randomUUID();
	const root = sessionRoot(input.sessionId);
	// Best-effort retention sweep. Failures must never affect the launch.
	void cleanupStaleChildSessions({ root }).catch(() => undefined);
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
		if (spec.workflow !== undefined) promptParts.push(workflowSystemPrompt(input.skillPath, 1, spec.workflow));
		else if (resolvedAgent.dmode) promptParts.push(dmodeReminder(input.skillPath, 1));
		const cwd = resolve(input.ctxCwd, spec.cwd ?? input.ctxCwd);
		return {
			agent: resolvedAgent.agent,
			task: spec.task,
			cwd,
			model: model.value.model,
			omitModel: model.value.omitModel,
			thinking: model.value.thinking,
			requestedRole: model.value.requestedRole,
			roleIndex: model.value.roleIndex,
			overrideReason: spec.overrideReason,
			tools: resolvedAgent.tools ?? agent.tools?.join(","),
			workflow: spec.workflow,
			budget: spec.budget,
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
		schedulerTotalSlots: input.config.scheduler.totalSlots,
		artifactDir,
		extensionPath: await realpath(input.extensionPath),
		companionExtensionPaths: await Promise.all(input.companionExtensionPaths.map((path) => realpath(path))),
		piChildLaunch: { executable: childLaunch.command, argvPrefix: childLaunch.argsPrefix },
		mode: input.request.kind,
		childDepth: 1,
		provenance: executionProvenance(),
		specs: [first, ...resolvedSpecs.slice(1)],
		createdAt: new Date().toISOString(),
	};
	const manifestSeal = await writeSealedArtifact(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
	const initialChildren = resolvedSpecs.map((spec, index) => ({
		index,
		agent: spec.agent,
		state: "queued",
		role: spec.requestedRole,
		assignment: spec.workflow?.assignment,
	}));
	await atomicWriteFile(join(artifactDir, "progress.json"), `${JSON.stringify({ queued: specs.length, running: 0, complete: 0, total: specs.length, children: initialChildren })}\n`);
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

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export function createTaskResultFiles(sessionId: string): Readonly<{
	readBinding: (taskId: string) => Promise<TaskBinding | undefined>;
	listBindings: () => Promise<readonly TaskBinding[]>;
	readProgress: (binding: TaskBinding) => Promise<WorkflowProgress>;
	readCommittedResult: (binding: TaskBinding) => Promise<CommittedResult | undefined>;
	isUsageClaimed: (binding: TaskBinding) => Promise<boolean>;
	claimUsage: (binding: TaskBinding) => Promise<boolean>;
}> {
	const currentRoot = sessionRoot(sessionId);
	const bgRoot = backgroundRoot();
	const workflowDir = (binding: TaskBinding) => join(binding.root ?? currentRoot, "workflows", binding.workflowId);
	return {
		async readBinding(taskId) {
			const encodedFileName = `${encodeURIComponent(taskId)}.json`;

			try {
				const content = await readFile(join(currentRoot, "bindings", encodedFileName), "utf8");
				const value: unknown = JSON.parse(content);
				if (typeof value === "object" && value !== null && "taskId" in value && "workflowId" in value) {
					if (typeof value.taskId === "string" && typeof value.workflowId === "string" && value.taskId === taskId) {
						return { taskId: value.taskId, workflowId: value.workflowId, root: currentRoot };
					}
				}
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) throw error;
			}

			try {
				const entries = await readdir(bgRoot, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const sessDir = join(bgRoot, entry.name);
					if (sessDir === currentRoot) continue;
					try {
						const content = await readFile(join(sessDir, "bindings", encodedFileName), "utf8");
						const value: unknown = JSON.parse(content);
						if (typeof value === "object" && value !== null && "taskId" in value && "workflowId" in value) {
							if (typeof value.taskId === "string" && typeof value.workflowId === "string" && value.taskId === taskId) {
								return { taskId: value.taskId, workflowId: value.workflowId, root: sessDir };
							}
						}
					} catch (error) {
						if (!hasErrorCode(error, "ENOENT")) throw error;
					}
				}
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) throw error;
			}

			return undefined;
		},
		async listBindings() {
			let entries;
			try {
				entries = await readdir(join(currentRoot, "bindings"), { withFileTypes: true });
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) return [];
				throw error;
			}
			const bindings: TaskBinding[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				try {
					const value: unknown = JSON.parse(await readFile(join(currentRoot, "bindings", entry.name), "utf8"));
					if (typeof value !== "object" || value === null || !("taskId" in value) || !("workflowId" in value)) continue;
					if (typeof value.taskId !== "string" || typeof value.workflowId !== "string") continue;
					bindings.push({ taskId: value.taskId, workflowId: value.workflowId, root: currentRoot });
				} catch {}
			}
			return bindings;
		},
		async readProgress(binding) {
			const dir = workflowDir(binding);
			const value: unknown = JSON.parse(await readFile(join(dir, "progress.json"), "utf8"));
			if (typeof value !== "object" || value === null) throw new Error("progress must be an object");
			const progress = Object.fromEntries(Object.entries(value));
			for (const key of ["queued", "running", "complete", "total"] as const) {
				if (!Number.isSafeInteger(progress[key]) || Number(progress[key]) < 0) throw new Error(`progress.${key} is invalid`);
			}
			const base = {
				queued: Number(progress.queued),
				running: Number(progress.running),
				complete: Number(progress.complete),
				total: Number(progress.total),
			};
			let children: ChildStateView[] | undefined;
			try {
				const manifestBytes = await readFile(join(dir, "manifest.json"), "utf8");
				const specs = parseManifestSpecs(JSON.parse(manifestBytes));
				if (specs !== undefined) {
					const childViews: ChildStateView[] = [];
					for (const [index, spec] of specs.entries()) {
						const childDir = join(dir, "children", String(index));
						const journalSnapshot = await readJournalFile(join(childDir, "journal.json"));
						const semanticStatus = await readSemanticStatusFile(join(childDir, "status.json"));
						const allJournal = journalSnapshot?.entries;
						const journal = allJournal === undefined ? undefined : recentJournal(allJournal);
						const spawnEntry = allJournal?.find((entry) => entry.kind === "spawn");
						const latestTurn = allJournal?.findLast((entry) => entry.kind === "turn");
						const startedAt = spawnEntry?.timestamp;
						const elapsedMs = startedAt === undefined ? undefined : Math.max(0, Date.now() - Date.parse(startedAt));
						const recentActivity = allJournal === undefined ? undefined : recentJournalActivity(allJournal);
						let latestActivity: string | undefined;
						let lastActiveAt: string | undefined = journalSnapshot?.updatedAt ?? semanticStatus?.updatedAt;
						let exitCode: number | undefined;
						let state: ChildStateView["state"] = "queued";
						if (journal && journal.length > 0) {
							const last = journal[journal.length - 1]!;
							lastActiveAt = last.timestamp;
							if (last.kind === "exit") {
								exitCode = last.exitCode;
								state = exitCode === 0 ? "succeeded" : "failed";
							} else if (last.kind === "failure") {
								state = "failed";
							} else {
								state = "running";
							}
							if (semanticStatus && (semanticStatus.phase || semanticStatus.note)) {
								const parts = [semanticStatus.phase, semanticStatus.note].filter((part): part is string => part !== undefined && part !== "");
								if (semanticStatus.blocking) parts.push("[blocking]");
								latestActivity = parts.join(": ");
							} else {
								latestActivity = formatJournalActivity(last);
							}
						}
						lastActiveAt = [lastActiveAt, journalSnapshot?.updatedAt, semanticStatus?.updatedAt]
							.flatMap((value) => value ?? [])
							.filter((value) => Number.isFinite(Date.parse(value)))
							.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
						if (journalSnapshot || semanticStatus) {
							childViews.push({
								index,
								state,
								agent: spec.agent,
								task: spec.task,
								cwd: spec.cwd,
								model: spec.model,
								latestStatus: semanticStatus,
								latestActivity,
								lastActiveAt,
								startedAt,
								elapsedMs,
								recentActivity,
								journal,
								journalCount: allJournal?.length,
								usage: latestTurn?.usage,
								exitCode,
							});
						}
					}
					if (childViews.length > 0) {
						children = childViews;
					}
				}
			} catch {}
			return {
				...base,
				...(children && children.length > 0 ? { children } : {}),
			};
		},
		async isUsageClaimed(binding) {
			try {
				const marker = await stat(join(workflowDir(binding), "USAGE_REPORTED"));
				return marker.isDirectory();
			} catch (error) {
				if (hasErrorCode(error, "ENOENT")) return false;
				throw error;
			}
		},
		async claimUsage(binding) {
			try {
				await mkdir(join(workflowDir(binding), "USAGE_REPORTED"));
				return true;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
				throw error;
			}
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
				return { kind: "complete", package: result.package, outputs: result.children.map((child) => child.output) };
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
	};
}
