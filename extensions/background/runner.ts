import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { atomicWriteFile, readOutputArtifact, sealBytes, toSha256, type OutputArtifactSeal } from "./artifacts.ts";
import { executeWorkflow, verifyChildOutputs, type WorkflowManifestV1, type WorkflowResultIndexV1 } from "./workflow.ts";

export const RUNNER_PREFLIGHT_PROTOCOL = "dstack.runner-preflight.v1";
const MANIFEST_SCHEMA = "dstack.workflow.v1";
const COMMIT_SCHEMA = "dstack.commit.v1";

type JsonRecord = Record<string, unknown>;

type CommitMarker = Readonly<{
	schemaVersion: "dstack.commit.v1";
	workflowId: string;
	manifestSha256: string;
	resultIndex: OutputArtifactSeal;
}>;

function record(value: unknown, label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function absolutePath(value: unknown, label: string): string {
	const path = string(value, label);
	if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`${label} must be absolute and normalized`);
	return path;
}

function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : string(value, label);
}

function optionalToolsAllowlist(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	const tools = string(value, label).split(",").map((tool) => tool.trim());
	if (tools.some((tool) => tool === "")) throw new Error(`${label} contains an empty tool name`);
	if (new Set(tools).size !== tools.length) throw new Error(`${label} contains a duplicate tool name`);
	return tools.join(",");
}

function parseSpec(value: unknown, index: number) {
	const spec = record(value, `manifest.specs[${index}]`);
	const worktreeValue = spec["worktree"];
	let worktree;
	if (worktreeValue !== undefined) {
		const raw = record(worktreeValue, `manifest.specs[${index}].worktree`);
		const fromValue = raw["from"];
		if (fromValue !== "HEAD" && fromValue !== "origin/main") throw new Error(`manifest.specs[${index}].worktree.from is invalid`);
		const from: "HEAD" | "origin/main" = fromValue;
		worktree = {
			repoRoot: absolutePath(raw["repoRoot"], `manifest.specs[${index}].worktree.repoRoot`),
			base: absolutePath(raw["base"], `manifest.specs[${index}].worktree.base`),
			from,
		};
	}
	const omitModel = spec["omitModel"];
	if (omitModel !== undefined && typeof omitModel !== "boolean") throw new Error(`manifest.specs[${index}].omitModel must be boolean`);
	return {
		agent: string(spec["agent"], `manifest.specs[${index}].agent`),
		task: string(spec["task"], `manifest.specs[${index}].task`),
		cwd: absolutePath(spec["cwd"], `manifest.specs[${index}].cwd`),
		model: optionalString(spec["model"], `manifest.specs[${index}].model`),
		omitModel,
		tools: optionalToolsAllowlist(spec["tools"], `manifest.specs[${index}].tools`),
		systemPrompt: optionalString(spec["systemPrompt"], `manifest.specs[${index}].systemPrompt`),
		worktree,
	};
}

export function parseWorkflowManifest(value: unknown): WorkflowManifestV1 {
	const raw = record(value, "manifest");
	if (raw["schemaVersion"] !== MANIFEST_SCHEMA) throw new Error("manifest.schemaVersion is unsupported");
	if (raw["childDepth"] !== 1) throw new Error("manifest.childDepth must be 1");
	const mode = raw["mode"];
	if (mode !== "single" && mode !== "parallel" && mode !== "chain") throw new Error("manifest.mode is invalid");
	const rawSpecs = raw["specs"];
	if (!Array.isArray(rawSpecs) || rawSpecs.length === 0) throw new Error("manifest.specs must be non-empty");
	if (mode === "single" && rawSpecs.length !== 1) throw new Error("single manifests must contain one spec");
	const specs = rawSpecs.map(parseSpec);
	const first = specs[0];
	if (first === undefined) throw new Error("manifest.specs must be non-empty");
	const launch = record(raw["piChildLaunch"], "manifest.piChildLaunch");
	const argvPrefixValue = launch["argvPrefix"];
	if (!Array.isArray(argvPrefixValue) || !argvPrefixValue.every((arg) => typeof arg === "string")) {
		throw new Error("manifest.piChildLaunch.argvPrefix must be a string array");
	}
	const createdAt = string(raw["createdAt"], "manifest.createdAt");
	if (!Number.isFinite(Date.parse(createdAt))) throw new Error("manifest.createdAt must be an ISO date");
	return {
		schemaVersion: MANIFEST_SCHEMA,
		workflowId: string(raw["workflowId"], "manifest.workflowId"),
		sessionId: string(raw["sessionId"], "manifest.sessionId"),
		schedulerRoot: absolutePath(raw["schedulerRoot"], "manifest.schedulerRoot"),
		artifactDir: absolutePath(raw["artifactDir"], "manifest.artifactDir"),
		extensionPath: absolutePath(raw["extensionPath"], "manifest.extensionPath"),
		piChildLaunch: {
			executable: absolutePath(launch["executable"], "manifest.piChildLaunch.executable"),
			argvPrefix: [...argvPrefixValue],
		},
		mode,
		childDepth: 1,
		specs: [first, ...specs.slice(1)],
		createdAt,
	};
}

async function requireRegularFile(path: string, label: string, executable = false): Promise<string> {
	const resolved = await realpath(path);
	if (resolved !== path) throw new Error(`${label} must already be resolved to its real path`);
	const stats = await lstat(path);
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
	if (executable && process.platform !== "win32" && (stats.mode & 0o111) === 0) throw new Error(`${label} must be executable`);
	return path;
}

export async function validateManifestFiles(manifest: WorkflowManifestV1): Promise<void> {
	await requireRegularFile(manifest.piChildLaunch.executable, "manifest.piChildLaunch.executable", true);
	const entryPoint = manifest.piChildLaunch.argvPrefix[0];
	if (entryPoint !== undefined && isAbsolute(entryPoint)) await requireRegularFile(entryPoint, "manifest.piChildLaunch.argvPrefix[0]");
	await requireRegularFile(manifest.extensionPath, "manifest.extensionPath");
	for (const [index, spec] of manifest.specs.entries()) {
		const stats = await lstat(spec.cwd);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`manifest.specs[${index}].cwd must be a directory`);
	}
}

async function readFileNoFollow(path: string): Promise<Buffer> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const opened = await handle.stat();
		const linked = await lstat(path);
		if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()) throw new Error("sealed file must be regular");
		if (opened.dev !== linked.dev || opened.ino !== linked.ino) throw new Error("sealed file identity changed while reading");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function commitWorkflowResult(manifest: WorkflowManifestV1, index: WorkflowResultIndexV1): Promise<void> {
	const indexPath = join(manifest.artifactDir, "result-index.json");
	const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
	await atomicWriteFile(indexPath, indexBytes);
	const marker: CommitMarker = {
		schemaVersion: COMMIT_SCHEMA,
		workflowId: manifest.workflowId,
		manifestSha256: index.manifestSha256,
		resultIndex: sealBytes(indexPath, indexBytes),
	};
	await atomicWriteFile(join(manifest.artifactDir, "COMMITTED"), `${JSON.stringify(marker)}\n`);
	await readCommittedWorkflowResult(manifest.artifactDir, index.manifestSha256, manifest.workflowId);
}

function parseSeal(value: unknown, expectedPath: string): OutputArtifactSeal {
	const raw = record(value, "artifact seal");
	const path = absolutePath(raw["path"], "artifact seal.path");
	if (path !== expectedPath) throw new Error("artifact seal path does not match the workflow layout");
	const bytes = raw["bytes"];
	if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) throw new Error("artifact seal.bytes is invalid");
	return { path, bytes: Number(bytes), sha256: String(toSha256(string(raw["sha256"], "artifact seal.sha256"))) };
}

function childState(value: unknown): "succeeded" | "failed" | "cancelled" | "skipped" {
	if (value === "succeeded" || value === "failed" || value === "cancelled" || value === "skipped") return value;
	throw new Error("result index child state is invalid");
}

function validateTaskResult(value: unknown, index: number): void {
	const result = record(value, `result index package result ${index}`);
	for (const key of ["agent", "cwd", "task"] as const) string(result[key], `result index package result ${index}.${key}`);
	for (const key of ["text", "stderr"] as const) {
		if (typeof result[key] !== "string") throw new Error(`result index package result ${index}.${key} must be a string`);
	}
	if (!Number.isFinite(result["exitCode"])) throw new Error("result index package exitCode is invalid");
	if (!Array.isArray(result["messages"])) throw new Error("result index package messages are invalid");
	const usage = record(result["usage"], "result index package usage");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"] as const) {
		if (!Number.isFinite(usage[key])) throw new Error("result index package usage is invalid");
	}
}

function parseResultIndex(value: unknown, artifactDir: string, workflowId: string, manifestSha256: string): WorkflowResultIndexV1 {
	const raw = record(value, "result index");
	if (raw["schemaVersion"] !== "dstack.result-index.v1") throw new Error("result index schema is invalid");
	if (raw["workflowId"] !== workflowId || raw["manifestSha256"] !== manifestSha256) throw new Error("result index identity mismatch");
	const mode = raw["mode"];
	if (mode !== "single" && mode !== "parallel" && mode !== "chain") throw new Error("result index mode is invalid");
	const outcome = raw["outcome"];
	if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") throw new Error("result index outcome is invalid");
	const rawChildren = raw["children"];
	if (!Array.isArray(rawChildren)) throw new Error("result index children must be an array");
	const children = rawChildren.map((value, index) => {
		const child = record(value, `result index child ${index}`);
		if (child["index"] !== index) throw new Error("result index child order is invalid");
		const state = childState(child["state"]);
		const directory = join(artifactDir, "children", String(index));
		return {
			index,
			state,
			result: parseSeal(child["result"], join(directory, "result.json")),
			output: parseSeal(child["output"], join(directory, "output.txt")),
		};
	});
	const packageValue = record(raw["package"], "result index package");
	if (packageValue["mode"] !== mode || !Array.isArray(packageValue["results"]) || packageValue["results"].length !== children.length) {
		throw new Error("result index package is invalid");
	}
	packageValue["results"].forEach(validateTaskResult);
	if (children.length === 0 || (mode === "single" && children.length !== 1)) throw new Error("result index child count is invalid");
	const summaryValue = record(raw["summary"], "result index summary");
	const summaryKeys = ["total", "succeeded", "failed", "cancelled"] as const;
	for (const key of summaryKeys) if (!Number.isSafeInteger(summaryValue[key]) || Number(summaryValue[key]) < 0) throw new Error("result index summary is invalid");
	if (summaryValue["total"] !== children.length) throw new Error("result index summary total is invalid");
	const succeededCount = children.filter((child) => child.state === "succeeded").length;
	const cancelledCount = children.filter((child) => child.state === "cancelled").length;
	const failedCount = children.length - succeededCount - cancelledCount;
	if (summaryValue["succeeded"] !== succeededCount || summaryValue["failed"] !== failedCount || summaryValue["cancelled"] !== cancelledCount) {
		throw new Error("result index summary does not match child states");
	}
	const expectedOutcome = cancelledCount > 0 ? "cancelled" : failedCount > 0 ? "failed" : "succeeded";
	if (outcome !== expectedOutcome) throw new Error("result index outcome does not match child states");
	return {
		schemaVersion: "dstack.result-index.v1",
		workflowId,
		manifestSha256,
		mode,
		outcome,
		summary: {
			total: Number(summaryValue["total"]),
			succeeded: Number(summaryValue["succeeded"]),
			failed: Number(summaryValue["failed"]),
			cancelled: Number(summaryValue["cancelled"]),
		},
		package: { mode, results: packageValue["results"] },
		children,
	};
}

export async function readCommittedWorkflowResult(artifactDir: string, manifestSha256: string, workflowId: string): Promise<WorkflowResultIndexV1> {
	const markerBytes = await readFileNoFollow(join(artifactDir, "COMMITTED"));
	const marker = record(JSON.parse(markerBytes.toString("utf8")) as unknown, "commit marker");
	if (marker["schemaVersion"] !== COMMIT_SCHEMA || marker["workflowId"] !== workflowId || marker["manifestSha256"] !== manifestSha256) {
		throw new Error("commit marker identity mismatch");
	}
	const indexSeal = parseSeal(marker["resultIndex"], join(artifactDir, "result-index.json"));
	const indexBytes = await readOutputArtifact(indexSeal);
	const index = parseResultIndex(JSON.parse(indexBytes.toString("utf8")) as unknown, artifactDir, workflowId, manifestSha256);
	await verifyChildOutputs(index);
	for (const child of index.children) {
		const metadataBytes = await readOutputArtifact(child.result);
		const metadata = record(JSON.parse(metadataBytes.toString("utf8")) as unknown, "child result metadata");
		if (metadata["schemaVersion"] !== "dstack.child-result.v1" || metadata["workflowId"] !== workflowId || metadata["index"] !== child.index || metadata["state"] !== child.state) {
			throw new Error("child result metadata identity mismatch");
		}
		if (JSON.stringify(metadata["output"]) !== JSON.stringify(child.output)) throw new Error("child result output seal mismatch");
		if (JSON.stringify(metadata["result"]) !== JSON.stringify(index.package.results[child.index])) throw new Error("child result package mismatch");
	}
	return index;
}

export function runRuntimePreflight(argv: readonly string[]): number {
	if (argv.length === 1 && argv[0] === "--runtime-preflight") {
		process.stdout.write(`${RUNNER_PREFLIGHT_PROTOCOL}\n`);
		return 0;
	}
	process.stderr.write("Usage: runner.ts --runtime-preflight\n");
	return 2;
}

function runnerArguments(argv: readonly string[]): { manifestPath: string; manifestSha256: string } {
	if (argv.length !== 4 || argv[0] !== "--manifest" || argv[2] !== "--manifest-sha256") {
		throw new Error("Usage: runner.ts --manifest <absolute-path> --manifest-sha256 <sha256>");
	}
	return { manifestPath: absolutePath(argv[1], "manifest path"), manifestSha256: String(toSha256(argv[3] ?? "")) };
}

export async function runWorkflowCli(argv: readonly string[]): Promise<number> {
	const args = runnerArguments(argv);
	const manifestBytes = await readFileNoFollow(args.manifestPath);
	if (digest(manifestBytes) !== args.manifestSha256) throw new Error("manifest sha256 mismatch");
	const manifest = parseWorkflowManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
	if (args.manifestPath !== join(manifest.artifactDir, "manifest.json")) throw new Error("manifest path does not match artifactDir");
	await validateManifestFiles(manifest);
	await mkdir(manifest.artifactDir, { recursive: true, mode: 0o700 });
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Root workflow cancelled"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const index = await executeWorkflow(manifest, args.manifestSha256, controller.signal);
		await commitWorkflowResult(manifest, index);
		return 0;
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}

async function main(argv: readonly string[]): Promise<number> {
	if (argv[0] === "--runtime-preflight") return runRuntimePreflight(argv);
	return runWorkflowCli(argv);
}

if (process.argv.slice(2).some((argument) => argument === "--runtime-preflight" || argument === "--manifest")) {
	main(process.argv.slice(2)).then(
		(code) => { process.exitCode = code; },
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
