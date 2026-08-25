import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { freezePiChildLaunch, type ChildResult } from "../extensions/spawn.ts";
import { readOutputArtifact } from "../extensions/background/artifacts.ts";
import {
	commitWorkflowResult,
	parseWorkflowManifest,
	readCommittedWorkflowResult,
} from "../extensions/background/runner.ts";
import {
	executeWorkflow,
	type ResolvedChildSpec,
	type SlotAcquirer,
	type WorkflowManifestV1,
} from "../extensions/background/workflow.ts";

const execFileAsync = promisify(execFile);
const runnerPath = fileURLToPath(new URL("../extensions/background/runner.ts", import.meta.url));
const extensionPath = fileURLToPath(new URL("../extensions/dstack.ts", import.meta.url));

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-runner-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

function spec(cwd: string, task: string, extra: Partial<ResolvedChildSpec> = {}): ResolvedChildSpec {
	return { agent: "general-purpose", task, cwd, ...extra };
}

function manifest(input: Readonly<{
	artifactDir: string;
	cwd: string;
	specs: readonly [ResolvedChildSpec, ...ResolvedChildSpec[]];
	mode?: "single" | "parallel" | "chain";
	executable?: string;
	argvPrefix?: readonly string[];
}>): WorkflowManifestV1 {
	return {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-runner-0123456789",
		sessionId: "session-test",
		schedulerRoot: join(input.artifactDir, "scheduler"),
		artifactDir: input.artifactDir,
		extensionPath,
		piChildLaunch: { executable: input.executable ?? process.execPath, argvPrefix: input.argvPrefix ?? [] },
		mode: input.mode ?? "single",
		childDepth: 1,
		specs: input.specs,
		createdAt: "2025-01-01T00:00:00.000Z",
	};
}

function child(text: string, exitCode = 0): ChildResult {
	return {
		text,
		exitCode,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function sha(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

test("Pi child launch facts are resolved before the runner starts", async (t) => {
	const cwd = await temporaryDirectory(t);
	const entry = join(cwd, "pi-entry.mjs");
	await writeFile(entry, "", { mode: 0o600 });
	const frozen = await freezePiChildLaunch({ execPath: process.execPath, entryScript: entry, pathValue: "/poisoned" });
	assert.equal(frozen.command, await realpath(process.execPath));
	assert.deepEqual(frozen.argsPrefix, [await realpath(entry)]);
});

test("manifest validation rejects malformed launch facts and mode shapes", async (t) => {
	const cwd = await temporaryDirectory(t);
	const good = manifest({ artifactDir: join(cwd, "artifacts"), cwd, specs: [spec(cwd, "ok")] });
	assert.equal(parseWorkflowManifest(good).piChildLaunch.executable, process.execPath);
	assert.throws(() => parseWorkflowManifest({ ...good, childDepth: 2 }), /childDepth/);
	assert.throws(() => parseWorkflowManifest({ ...good, piChildLaunch: { executable: "pi", argvPrefix: [] } }), /absolute/);
	assert.throws(() => parseWorkflowManifest({ ...good, mode: "single", specs: [spec(cwd, "a"), spec(cwd, "b")] }), /one spec/);
});

test("parallel results retain manifest order when children finish in reverse order", async (t) => {
	const cwd = await temporaryDirectory(t);
	const specs: [ResolvedChildSpec, ...ResolvedChildSpec[]] = [spec(cwd, "0"), spec(cwd, "1"), spec(cwd, "2")];
	const calls: number[] = [];
	const index = await executeWorkflow(
		manifest({ artifactDir: join(cwd, "artifacts"), cwd, mode: "parallel", specs }),
		"a".repeat(64),
		new AbortController().signal,
		{
			spawnChild: async ({ args }) => {
				const id = Number(args.at(-1)?.replace("Task: ", ""));
				await new Promise((resolve) => setTimeout(resolve, (2 - id) * 15));
				calls.push(id);
				return child(`output-${id}`);
			},
		},
	);
	assert.deepEqual(calls, [2, 1, 0]);
	assert.deepEqual(index.package.results.map((result) => result.text), ["output-0", "output-1", "output-2"]);
});

test("parallel mixed failure is a committed domain failure", async (t) => {
	const cwd = await temporaryDirectory(t);
	const workflow = manifest({
		artifactDir: join(cwd, "artifacts"),
		cwd,
		mode: "parallel",
		specs: [spec(cwd, "pass"), spec(cwd, "fail")],
	});
	const index = await executeWorkflow(workflow, "b".repeat(64), new AbortController().signal, {
		spawnChild: async ({ args }) => child(args.at(-1) ?? "", args.at(-1)?.includes("fail") ? 7 : 0),
	});
	assert.equal(index.outcome, "failed");
	assert.deepEqual(index.children.map((entry) => entry.state), ["succeeded", "failed"]);
	await commitWorkflowResult(workflow, index);
	assert.equal((await readCommittedWorkflowResult(workflow.artifactDir, "b".repeat(64), workflow.workflowId)).outcome, "failed");
});

test("chain substitutes every previous token with full output and seals later skips", async (t) => {
	const cwd = await temporaryDirectory(t);
	const full = "x".repeat(60 * 1024);
	const seen: string[] = [];
	const workflow = manifest({
		artifactDir: join(cwd, "artifacts"),
		cwd,
		mode: "chain",
		specs: [spec(cwd, "first"), spec(cwd, "left={previous};right={previous}"), spec(cwd, "never")],
	});
	const index = await executeWorkflow(workflow, "c".repeat(64), new AbortController().signal, {
		spawnChild: async ({ args }) => {
			const task = (args.at(-1) ?? "").slice(6);
			seen.push(task);
			if (task === "first") return child(full);
			return child("failed", 1);
		},
	});
	assert.equal(seen[1], `left=${full};right=${full}`);
	assert.equal(index.package.results[0]?.text.includes("Output truncated"), true);
	assert.deepEqual(index.children.map((entry) => entry.state), ["succeeded", "failed", "skipped"]);
	assert.equal((await readOutputArtifact(index.children[0]!.output)).toString(), full);
	assert.equal((await readOutputArtifact(index.children[2]!.output)).toString(), "");
});

test("chain creates worktrees only when their steps become runnable", async (t) => {
	const cwd = await temporaryDirectory(t);
	const made: string[] = [];
	const worktree = { repoRoot: cwd, base: join(cwd, "worktrees"), from: "HEAD" as const };
	await executeWorkflow(
		manifest({ artifactDir: join(cwd, "artifacts"), cwd, mode: "chain", specs: [spec(cwd, "fail", { worktree }), spec(cwd, "never", { worktree })] }),
		"d".repeat(64),
		new AbortController().signal,
		{
			createWorktree: async (input) => { made.push(input.task); return join(cwd, input.task); },
			spawnChild: async () => child("no", 1),
		},
	);
	assert.deepEqual(made, ["fail"]);
});

test("cancellation aborts active work, rejects queued slots, and commits cancellation", async (t) => {
	const cwd = await temporaryDirectory(t);
	const controller = new AbortController();
	let active = 0;
	const slots: SlotAcquirer = {
		acquire: ({ signal }) => new Promise((resolve, reject) => {
			if (active === 0) {
				active += 1;
				resolve({ release() { active -= 1; } });
				return;
			}
			signal.addEventListener("abort", () => reject(new Error("queue cancelled")), { once: true });
		}),
	};
	const workflow = manifest({ artifactDir: join(cwd, "artifacts"), cwd, mode: "parallel", specs: [spec(cwd, "active"), spec(cwd, "queued")] });
	const running = executeWorkflow(workflow, "e".repeat(64), controller.signal, {
		slots,
		spawnChild: ({ signal }) => new Promise((resolve) => {
			if (signal?.aborted) resolve(child("stopped", 1));
			else signal?.addEventListener("abort", () => resolve(child("stopped", 1)), { once: true });
		}),
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	controller.abort(new Error("test cancellation"));
	const index = await running;
	assert.equal(index.outcome, "cancelled");
	assert.deepEqual(index.children.map((entry) => entry.state), ["cancelled", "cancelled"]);
	await commitWorkflowResult(workflow, index);
	assert.equal((await readCommittedWorkflowResult(workflow.artifactDir, "e".repeat(64), workflow.workflowId)).outcome, "cancelled");
});

test("real runner launches from an unrelated cwd and exits zero after child failure", async (t) => {
	const root = await temporaryDirectory(t);
	const unrelated = await temporaryDirectory(t);
	const fake = join(root, "fake-pi.mjs");
	await writeFile(fake, `const task = process.argv.at(-1).slice(6);\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:task}]}}));\nif (task === "domain-failure") process.exitCode = 9;\n`, { mode: 0o700 });
	await chmod(fake, 0o700);
	const node = await realpath(process.execPath);
	const artifactDir = join(root, "artifacts");
	const workflow = manifest({ artifactDir, cwd: root, executable: node, argvPrefix: [await realpath(fake)], specs: [spec(root, "domain-failure")] });
	await writeFile(join(root, "extension.ts"), "", { mode: 0o600 });
	const sealed = { ...workflow, extensionPath: await realpath(join(root, "extension.ts")) };
	await writeFile(join(root, "manifest-source.json"), JSON.stringify(sealed));
	await writeFile(join(root, "noop"), "");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(artifactDir, { recursive: true, mode: 0o700 }));
	const bytes = Buffer.from(`${JSON.stringify(sealed)}\n`);
	const manifestPath = join(artifactDir, "manifest.json");
	await writeFile(manifestPath, bytes, { mode: 0o600 });
	const result = await execFileAsync(node, ["--experimental-strip-types", runnerPath, "--manifest", manifestPath, "--manifest-sha256", sha(bytes)], { cwd: unrelated });
	assert.equal(result.stderr, "");
	const committed = await readCommittedWorkflowResult(artifactDir, sha(bytes), workflow.workflowId);
	assert.equal(committed.outcome, "failed");
});

test("committed result reader rejects index corruption", async (t) => {
	const cwd = await temporaryDirectory(t);
	const workflow = manifest({ artifactDir: join(cwd, "artifacts"), cwd, specs: [spec(cwd, "ok")] });
	const digest = "f".repeat(64);
	const index = await executeWorkflow(workflow, digest, new AbortController().signal, { spawnChild: async () => child("complete") });
	await commitWorkflowResult(workflow, index);
	await writeFile(join(workflow.artifactDir, "result-index.json"), `${JSON.stringify({ ...index, workflowId: "other" })}\n`);
	await assert.rejects(readCommittedWorkflowResult(workflow.artifactDir, digest, workflow.workflowId), /hash|sha256|integrity/);
});
