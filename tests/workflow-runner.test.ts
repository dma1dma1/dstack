import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
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
	createLocalSlotAcquirer,
	executeWorkflow,
	DSTACK_ARTIFACT_DIR_ENV,
	DSTACK_CHILD_INDEX_ENV,
	type ResolvedChildSpec,
	type SlotAcquirer,
	type WorkflowManifestV1,
} from "../extensions/background/workflow.ts";
import { buildTreeSnapshot } from "../extensions/background/tree.ts";

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
	assert.throws(() => parseWorkflowManifest({ ...good, specs: [spec(cwd, "bad", { tools: "read,,grep" })] }), /empty tool/);
	assert.throws(() => parseWorkflowManifest({ ...good, specs: [spec(cwd, "bad", { tools: "read,read" })] }), /duplicate/);
	assert.equal(parseWorkflowManifest({ ...good, specs: [spec(cwd, "ok", { tools: "read, grep" })] }).specs[0].tools, "read,grep");
});

test("parallel results retain manifest order when children finish in reverse order", async (t) => {
	const cwd = await temporaryDirectory(t);
	const specs: [ResolvedChildSpec, ...ResolvedChildSpec[]] = [spec(cwd, "0"), spec(cwd, "1"), spec(cwd, "2")];
	const calls: number[] = [];
	let started = 0;
	let releaseStarts: (() => void) | undefined;
	const allStarted = new Promise<void>((resolve) => { releaseStarts = resolve; });
	const index = await executeWorkflow(
		manifest({ artifactDir: join(cwd, "artifacts"), cwd, mode: "parallel", specs }),
		"a".repeat(64),
		new AbortController().signal,
		{
			slots: createLocalSlotAcquirer(4),
			spawnChild: async ({ args }) => {
				const id = Number(args.at(-1)?.replace("Task: ", ""));
				started += 1;
				if (started === specs.length) releaseStarts?.();
				await allStarted;
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

	await commitWorkflowResult(workflow, index);
	const progressRaw = await readFile(join(workflow.artifactDir, "progress.json"), "utf8");
	const progress = JSON.parse(progressRaw) as {
		children: Array<{ index: number; state: string; startedAt?: string; endedAt?: string }>;
	};
	assert.equal(progress.children[0]?.state, "succeeded");
	assert.ok(typeof progress.children[0]?.startedAt === "string");
	assert.ok(typeof progress.children[0]?.endedAt === "string");
	assert.equal(progress.children[2]?.state, "skipped");
	assert.equal(progress.children[2]?.startedAt, undefined);
	assert.ok(typeof progress.children[2]?.endedAt === "string");
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

test("leases release once on child success, failure, spawn error, and binding error", async (t) => {
	const cwd = await temporaryDirectory(t);
	for (const scenario of ["success", "failure", "spawn-error", "binding-error"] as const) {
		let releases = 0;
		let binds = 0;
		const slots: SlotAcquirer = {
			async acquire() {
				return {
					bindChild() {
						binds += 1;
						if (scenario === "binding-error") throw new Error("binding failed");
					},
					release() { releases += 1; },
				};
			},
		};
		const running = executeWorkflow(
			manifest({ artifactDir: join(cwd, scenario), cwd, specs: [spec(cwd, scenario)] }),
			"9".repeat(64),
			new AbortController().signal,
			{
				slots,
				spawnChild: async (input) => {
					if (scenario === "spawn-error") throw new Error("spawn failed");
					await input.onSpawn?.(process.pid);
					return child(scenario, scenario === "failure" ? 1 : 0);
				},
			},
		);
		if (scenario === "spawn-error") await assert.rejects(running, /spawn failed/);
		else if (scenario === "binding-error") await assert.rejects(running, /binding failed/);
		else await running;
		assert.equal(binds, scenario === "spawn-error" ? 0 : 1);
		assert.equal(releases, 1);
	}
});

test("cancellation aborts active work, rejects queued slots, and commits cancellation", async (t) => {
	const cwd = await temporaryDirectory(t);
	const controller = new AbortController();
	let active = 0;
	let releases = 0;
	let markAcquired = (): void => {
		throw new Error("acquisition resolver was not initialized");
	};
	const acquired = new Promise<void>((resolve) => {
		markAcquired = resolve;
	});
	const slots: SlotAcquirer = {
		acquire: ({ signal }) => new Promise((resolve, reject) => {
			if (active === 0) {
				active += 1;
				resolve({ bindChild() {}, release() { active -= 1; releases += 1; } });
				markAcquired();
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
	await acquired;
	controller.abort(new Error("test cancellation"));
	const index = await running;
	assert.equal(index.outcome, "cancelled");
	assert.deepEqual(index.children.map((entry) => entry.state), ["cancelled", "cancelled"]);
	assert.equal(releases, 1);
	assert.equal(active, 0);
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

test("concurrent runner processes share one four-child scheduler", async (t) => {
	const root = await temporaryDirectory(t);
	const schedulerRoot = join(root, "scheduler");
	const activeDir = join(root, "active");
	await mkdir(activeDir, { recursive: true });
	const fake = join(root, "fake-pi.mjs");
	await writeFile(
		fake,
		[
			`import { writeFileSync, unlinkSync } from "node:fs";`,
			`import { join } from "node:path";`,
			`const marker = join(process.env.DSTACK_TEST_ACTIVE_DIR, String(process.pid));`,
			`writeFileSync(marker, "active");`,
			`await new Promise((resolve) => setTimeout(resolve, 500));`,
			`const task = process.argv.at(-1).slice(6);`,
			`process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:task}]}}) + "\\n");`,
			`unlinkSync(marker);`,
		].join("\n"),
		{ mode: 0o700 },
	);
	const extension = join(root, "extension.ts");
	await writeFile(extension, "", { mode: 0o600 });
	const node = await realpath(process.execPath);
	const fakeReal = await realpath(fake);
	const extensionReal = await realpath(extension);
	const runnerCommands = await Promise.all(Array.from({ length: 2 }, async (_, runnerIndex) => {
		const artifactDir = join(root, `artifacts-${runnerIndex}`);
		await mkdir(artifactDir, { recursive: true, mode: 0o700 });
		const tools = { tools: "read,grep" };
		const specs: [ResolvedChildSpec, ...ResolvedChildSpec[]] = [
			spec(root, `${runnerIndex}-0`, tools),
			spec(root, `${runnerIndex}-1`, tools),
			spec(root, `${runnerIndex}-2`, tools),
		];
		const workflow: WorkflowManifestV1 = {
			...manifest({ artifactDir, cwd: root, mode: "parallel", executable: node, argvPrefix: [fakeReal], specs }),
			workflowId: `wf-runner-${runnerIndex}-0123456789`,
			schedulerRoot,
			extensionPath: extensionReal,
		};
		const bytes = Buffer.from(`${JSON.stringify(workflow)}\n`);
		const manifestPath = join(artifactDir, "manifest.json");
		await writeFile(manifestPath, bytes, { mode: 0o600 });
		return {
			args: ["--experimental-strip-types", runnerPath, "--manifest", manifestPath, "--manifest-sha256", sha(bytes)],
		};
	}));
	const running = runnerCommands.map(({ args }) =>
		execFileAsync(node, args, { env: { ...process.env, DSTACK_TEST_ACTIVE_DIR: activeDir } }),
	);
	let complete = false;
	let peak = 0;
	const monitor = (async () => {
		while (!complete) {
			peak = Math.max(peak, (await readdir(activeDir)).length);
			await sleep(2);
		}
	})();
	let outputs: Awaited<(typeof running)[number]>[];
	try {
		outputs = await Promise.all(running);
	} finally {
		complete = true;
		await monitor;
	}
	assert.equal(peak, 4);
	for (const output of outputs) assert.equal(output.stderr, "");
	assert.deepEqual(await readdir(activeDir), []);
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

test("parallel execution writes durable per-child progress v2 and startedAt/endedAt timestamps", async (t) => {
	const cwd = await temporaryDirectory(t);
	const workflow = manifest({
		artifactDir: join(cwd, "artifacts"),
		cwd,
		mode: "parallel",
		specs: [
			spec(cwd, "task-0", { requestedRole: "feature", workflow: { assignment: "owner", playbook: "feature", phase: "design", completedPhases: [], artifacts: [] } }),
			spec(cwd, "task-1", { requestedRole: "implementation-worker", workflow: { assignment: "worker", playbook: "feature", phase: "implement", completedPhases: ["design"], artifacts: [] } }),
		],
	});
	const digest = "a".repeat(64);
	const index = await executeWorkflow(workflow, digest, new AbortController().signal, {
		slots: createLocalSlotAcquirer(2),
		spawnChild: async () => {
			await sleep(5);
			return child("done");
		},
	});
	await commitWorkflowResult(workflow, index);

	const progressRaw = await readFile(join(workflow.artifactDir, "progress.json"), "utf8");
	const progress = JSON.parse(progressRaw) as {
		queued: number;
		running: number;
		complete: number;
		total: number;
		children: Array<{ index: number; state: string; startedAt?: string; endedAt?: string; assignment?: string; role?: string }>;
	};
	assert.equal(progress.queued, 0);
	assert.equal(progress.running, 0);
	assert.equal(progress.complete, 2);
	assert.equal(progress.total, 2);
	assert.equal(progress.children.length, 2);

	for (const childRecord of progress.children) {
		assert.equal(childRecord.state, "succeeded");
		assert.ok(typeof childRecord.startedAt === "string" && childRecord.startedAt.length > 0);
		assert.ok(typeof childRecord.endedAt === "string" && childRecord.endedAt.length > 0);
		const startMs = Date.parse(childRecord.startedAt!);
		const endMs = Date.parse(childRecord.endedAt!);
		assert.ok(!Number.isNaN(startMs));
		assert.ok(!Number.isNaN(endMs));
		assert.ok(startMs <= endMs);
	}

	const childResultRaw = await readFile(join(workflow.artifactDir, "children", "0", "result.json"), "utf8");
	const childResult = JSON.parse(childResultRaw) as { schemaVersion: string; startedAt?: string; endedAt?: string; state: string };
	assert.equal(childResult.schemaVersion, "dstack.child-result.v1");
	assert.equal(childResult.state, "succeeded");
	assert.ok(typeof childResult.startedAt === "string");
	assert.ok(typeof childResult.endedAt === "string");
});

test("child execution exports index and artifact dir env vars and writes activity.json onUpdate", async (t) => {
	const cwd = await temporaryDirectory(t);
	const workflow = manifest({
		artifactDir: join(cwd, "artifacts"),
		cwd,
		mode: "single",
		specs: [spec(cwd, "test-task")],
	});

	let capturedChildIndex: string | undefined;
	let capturedArtifactDir: string | undefined;

	const index = await executeWorkflow(workflow, "c".repeat(64), new AbortController().signal, {
		slots: createLocalSlotAcquirer(1),
		spawnChild: async ({ env, onUpdate }) => {
			capturedChildIndex = env[DSTACK_CHILD_INDEX_ENV];
			capturedArtifactDir = env[DSTACK_ARTIFACT_DIR_ENV];

			onUpdate?.({
				exitCode: -1,
				text: "working on step 1",
				stderr: "",
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }],
					},
				],
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 500, turns: 1 },
			});

			await sleep(50);

			onUpdate?.({
				exitCode: -1,
				text: "working on step 2",
				stderr: "",
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
					},
				],
				usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.002, contextTokens: 1000, turns: 2 },
			});

			await sleep(50);
			return child("all done", 0);
		},
	});
	await commitWorkflowResult(workflow, index);

	assert.equal(capturedChildIndex, "0");
	assert.equal(capturedArtifactDir, workflow.artifactDir);

	const activityRaw = await readFile(join(workflow.artifactDir, "children", "0", "activity.json"), "utf8");
	const activity = JSON.parse(activityRaw) as {
		schemaVersion: string;
		workflowId: string;
		index: number;
		activity: string;
		turns: number;
		contextTokens: number;
		cost?: number;
		updatedAt: string;
	};

	assert.equal(activity.schemaVersion, "dstack.child-activity.v1");
	assert.equal(activity.workflowId, workflow.workflowId);
	assert.equal(activity.index, 0);
	assert.ok(activity.activity.includes("npm test") || activity.activity.includes("read"));
	assert.ok(activity.turns >= 1);
	assert.ok(typeof activity.updatedAt === "string");
	assert.equal(activity.cost, 0.002);

	await writeFile(join(workflow.artifactDir, "manifest.json"), JSON.stringify(workflow), "utf8");
	const snapshot = await buildTreeSnapshot({
		taskId: "task-test",
		workflowId: workflow.workflowId,
		artifactDir: workflow.artifactDir,
		schedulerRoot: workflow.schedulerRoot,
	});

	assert.ok(snapshot !== undefined);
	assert.equal(snapshot.children[0]?.state, "succeeded");
	assert.equal(snapshot.children[0]?.outcome, "all done");
});
