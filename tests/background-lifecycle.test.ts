import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { test, type TestContext } from "node:test";
import { readOutputArtifact, toAbsolutePath, toSha256, writeSealedArtifact } from "../extensions/background/artifacts.ts";
import { createEventBusV1Port } from "../extensions/background/eventbus-v1.ts";
import { createTaskResultFiles } from "../extensions/background/launch.ts";
import { commitWorkflowResult } from "../extensions/background/runner.ts";
import {
	readDstackResult,
	type CommittedResult,
	type TaskBinding,
} from "../extensions/background/result.ts";
import {
	TERMINAL_CHANNEL,
	installImmediateCompanion,
	outputFixtureSeal,
	runningTask,
	taskId,
} from "./fixtures/background-lifecycle.ts";

const execFileAsync = promisify(execFile);
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function temporaryDirectory(t: TestContext) {
	const path = await mkdtemp(join(tmpdir(), "dstack-background-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("EventBus v1 launch emits only the documented closed run schema", async () => {
	const events = createEventBus();
	const requests: unknown[] = [];
	const uninstall = installImmediateCompanion(events, requests);
	const port = createEventBusV1Port({ events, makeRequestId: () => "request-0001" });

	await port.launch({
		request: {
			name: String(runningTask.name),
			command: String(runningTask.command),
			timeoutSeconds: 90,
		},
		onAccepted() {},
	});

	assert.deepEqual(requests, [{
		schema_version: "pi-background-tasks.extension-request.v1",
		request_id: "request-0001",
		operation: "run",
		payload: {
			name: runningTask.name,
			command: runningTask.command,
			isAgent: true,
			notifyOnCompletion: true,
			triggerOnCompletion: true,
			timeoutSeconds: 90,
		},
	}]);

	port.close();
	uninstall();
});

test("EventBus v1 kill emits kill request schema and parses response", async () => {
	const events = createEventBus();
	const requests: unknown[] = [];
	const stop = events.on("pi-background-tasks:request:v1", (raw: unknown) => {
		requests.push(raw);
		const req = raw as { request_id: string; operation: string; payload: { taskId: string } };
		if (req.operation === "kill") {
			events.emit("pi-background-tasks:response:v1", {
				schema_version: "pi-background-tasks.extension-response.v1",
				request_id: req.request_id,
				operation: "kill",
				ok: true,
				result: {
					message: "Task was killed",
					task: {
						id: req.payload.taskId,
						command: "runner",
						status: "killed",
						outputPath: "/tmp/out.txt",
					},
				},
			});
		}
	});
	const port = createEventBusV1Port({ events, makeRequestId: () => "request-kill-001" });
	const killed = await port.kill("task-kill-123");
	assert.equal(killed.id, "task-kill-123");
	assert.equal(killed.status, "killed");
	assert.deepEqual(requests, [{
		schema_version: "pi-background-tasks.extension-request.v1",
		request_id: "request-kill-001",
		operation: "kill",
		payload: { taskId: "task-kill-123" },
	}]);
	port.close();
	stop();
});

test("launch correlates acceptance before an immediate terminal frame", async () => {
	const events = createEventBus();
	const order: string[] = [];
	const uninstall = installImmediateCompanion(events, []);
	const stopTerminal = events.on(TERMINAL_CHANNEL, () => order.push("terminal"));
	const port = createEventBusV1Port({ events, makeRequestId: () => "request-0002" });

	const accepted = await port.launch({
		request: { name: String(runningTask.name), command: String(runningTask.command) },
		onAccepted(task: Readonly<{ id: string }>) {
			assert.equal(task.id, taskId);
			order.push("accepted");
		},
	});

	assert.equal(accepted.id, taskId);
	assert.deepEqual(order, ["accepted", "terminal"]);
	port.close();
	stopTerminal();
	uninstall();
});

test("the shipped runner uses Node TypeScript stripping from an unrelated cwd", async (t) => {
	const cwd = await temporaryDirectory(t);
	const runnerPath = fileURLToPath(new URL("../extensions/background/runner.ts", import.meta.url));
	const { stdout, stderr } = await execFileAsync(process.execPath, [
		"--experimental-strip-types",
		runnerPath,
		"--runtime-preflight",
	], { cwd });

	assert.equal(stderr, "");
	assert.equal(stdout, "dstack.runner-preflight.v1\n");
});

test("dstack_result lookup reads one point-in-time snapshot and never sleeps", async (t) => {
	let statusReads = 0;
	t.mock.method(globalThis, "setTimeout", function forbiddenSleep(): never {
		throw new Error("dstack_result must not sleep");
	});

	const result = await readDstackResult({
		taskId,
		statusExact: async (requestedTaskId: string) => {
			statusReads += 1;
			assert.equal(requestedTaskId, taskId);
			return runningTask;
		},
		readBinding: async () => ({ taskId, workflowId: "wf-0123456789abcdef" }),
		readProgress: async () => ({ queued: 1, running: 0, complete: 0, total: 1 }),
		readCommittedResult: async () => undefined,
	});

	assert.equal(statusReads, 1);
	assert.deepEqual(result, {
		kind: "running",
		taskId,
		progress: { queued: 1, running: 0, complete: 0, total: 1 },
	});
});

test("shared response traffic ignores frames that cannot be attributed to a pending request", async () => {
	const events = createEventBus();
	const requestIds: string[] = [];
	const stopRequests = events.on("pi-background-tasks:request:v1", (raw: unknown) => {
		if (typeof raw === "object" && raw !== null && "request_id" in raw && typeof raw.request_id === "string") {
			requestIds.push(raw.request_id);
		}
	});
	let sequence = 0;
	const port = createEventBusV1Port({ events, makeRequestId: () => `request-${++sequence}` });
	const first = port.capabilities();
	const second = port.capabilities();

	events.emit("pi-background-tasks:response:v1", null);
	events.emit("pi-background-tasks:response:v1", { request_id: 42, malformed: true });
	events.emit("pi-background-tasks:response:v1", { request_id: "somebody-else", malformed: true });
	for (const requestId of requestIds) {
		events.emit("pi-background-tasks:response:v1", {
			schema_version: "pi-background-tasks.extension-response.v1",
			request_id: requestId,
			operation: "capabilities",
			ok: true,
			result: {
				api_version: 1,
				run: true,
				run_is_agent: true,
				run_completion_trigger: true,
				status: true,
				logs: true,
				logs_bounded: true,
				kill: true,
				future_capability: "ignored",
			},
			future_frame_field: "ignored",
		});
	}

	assert.equal((await first).api_version, 1);
	assert.equal((await second).api_version, 1);
	port.close();
	stopRequests();
});

test("response parsers accept unknown companion fields while validating required fields", async () => {
	const events = createEventBus();
	const stopRequests = events.on("pi-background-tasks:request:v1", (raw: unknown) => {
		if (typeof raw !== "object" || raw === null || !("request_id" in raw)) return;
		events.emit("pi-background-tasks:response:v1", {
			schema_version: "pi-background-tasks.extension-response.v1",
			request_id: raw.request_id,
			operation: "run",
			ok: true,
			result: { ...runningTask, future_task_field: { version: 2 } },
			future_frame_field: true,
		});
	});
	const port = createEventBusV1Port({ events, makeRequestId: () => "request-evolution" });
	const task = await port.launch({
		request: { name: String(runningTask.name), command: String(runningTask.command) },
		onAccepted() {},
	});

	assert.equal(task.id, taskId);
	port.close();
	stopRequests();
});

test("dstack_result projects every companion and committed-result state", async () => {
	const binding: TaskBinding = { taskId, workflowId: "wf-0123456789abcdef" };
	const complete: CommittedResult = {
		kind: "complete",
		package: { mode: "single", results: [] },
	};
	const artifact: CommittedResult = {
		kind: "artifact",
		outcome: "succeeded",
		path: toAbsolutePath("/tmp/result-index.json"),
		sha256: toSha256("a".repeat(64)),
		bytes: 1024,
		summary: { total: 1, succeeded: 1, failed: 0, cancelled: 0 },
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.025 },
		},
	};
	const cancelled: CommittedResult = { kind: "cancelled", message: "Stopped after child 1." };
	const read = (status: "completed" | "failed" | "killed", committed?: CommittedResult) => readDstackResult({
		taskId,
		statusExact: async () => ({ ...runningTask, status }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => committed,
	});

	assert.deepEqual(await readDstackResult({
		taskId,
		detail: "full",
		statusExact: async () => ({ ...runningTask, status: "completed" }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => complete,
	}), { kind: "complete", taskId, detail: "full", package: complete.package });
	assert.deepEqual(await read("completed", artifact), {
		kind: "artifact",
		taskId,
		outcome: artifact.outcome,
		path: artifact.path,
		sha256: artifact.sha256,
		bytes: artifact.bytes,
		summary: artifact.summary,
		usage: artifact.usage,
	});
	assert.deepEqual(await read("failed"), {
		kind: "runner_failed",
		taskId,
		message: "The background task runner failed.",
		companionOutputPath: runningTask.outputPath,
	});
	assert.deepEqual(await read("killed", cancelled), { kind: "cancelled", taskId, message: cancelled.message });
	assert.deepEqual(await read("killed"), { kind: "cancelled", taskId, message: "The background task was cancelled." });
	const killedWithUnreadableCommit = await readDstackResult({
		taskId,
		statusExact: async () => ({ ...runningTask, status: "killed" }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 0, total: 1 }),
		readCommittedResult: async () => { throw new Error("commit is incomplete"); },
	});
	assert.deepEqual(killedWithUnreadableCommit, { kind: "cancelled", taskId, message: "The background task was cancelled." });
});

test("dstack_result recovers committed result from durable bindings across prior sessions when live status is absent", async (t) => {
	const home = await temporaryDirectory(t);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = previousHome;
	});

	const priorSessionId = "prior-session-999";
	const currentSessionId = "current-session-001";
	const crossTaskId = "task-cross-session-123";
	const crossWorkflowId = "wf-cross-session-456";

	const bgRoot = join(home, ".pi", "agent", "dstack", "background");
	const priorSessRoot = join(bgRoot, encodeURIComponent(priorSessionId));
	const priorBindingsDir = join(priorSessRoot, "bindings");
	const priorWorkflowDir = join(priorSessRoot, "workflows", crossWorkflowId);
	const priorChildDir = join(priorWorkflowDir, "children", "0");

	await mkdir(priorBindingsDir, { recursive: true });
	await mkdir(priorChildDir, { recursive: true });

	const binding = { taskId: crossTaskId, workflowId: crossWorkflowId };
	await writeFile(join(priorBindingsDir, `${encodeURIComponent(crossTaskId)}.json`), JSON.stringify(binding), "utf8");

	const manifest = {
		schemaVersion: "dstack.workflow.v1" as const,
		workflowId: crossWorkflowId,
		sessionId: priorSessionId,
		mode: "single" as const,
		createdAt: "2025-01-01T00:00:00.000Z",
		artifactDir: toAbsolutePath(priorWorkflowDir),
		schedulerRoot: toAbsolutePath(join(priorSessRoot, "scheduler")),
		extensionPath: "/tmp/ext.ts",
		piChildLaunch: { executable: "node", argvPrefix: [] },
		childDepth: 1 as const,
		specs: [{ index: 0, agent: "poteto-agent", task: "cross session task", cwd: "/workspace", requestedRole: "feature" }] as const,
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	await writeFile(join(priorWorkflowDir, "manifest.json"), manifestBytes);

	const output = await writeSealedArtifact(join(priorChildDir, "output.txt"), "");
	const childMetadata = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: crossWorkflowId,
		index: 0,
		state: "succeeded",
		startedAt: "2025-01-01T00:00:01.000Z",
		endedAt: "2025-01-01T00:01:00.000Z",
		result: {
			agent: "poteto-agent",
			cwd: "/workspace",
			task: "cross session task",
			text: "Cross session result text completed successfully.",
			exitCode: 0,
			stderr: "",
			messages: [],
			usage: { turns: 2, input: 100, output: 50, cost: 0.01, contextTokens: 1000, cacheRead: 0, cacheWrite: 0 },
		},
		output,
	};
	const childResultSeal = await writeSealedArtifact(join(priorChildDir, "result.json"), `${JSON.stringify(childMetadata)}\n`);

	const index = {
		schemaVersion: "dstack.result-index.v1" as const,
		workflowId: crossWorkflowId,
		manifestSha256,
		mode: "single" as const,
		outcome: "succeeded" as const,
		summary: { total: 1, succeeded: 1, failed: 0, cancelled: 0 },
		package: {
			mode: "single" as const,
			results: [childMetadata.result],
		},
		children: [{ index: 0, state: "succeeded" as const, output, result: childResultSeal }],
	};
	await commitWorkflowResult(manifest, index);

	const currentFiles = createTaskResultFiles(currentSessionId);
	const result = await readDstackResult({
		taskId: crossTaskId,
		statusExact: async () => undefined,
		readBinding: currentFiles.readBinding,
		readProgress: currentFiles.readProgress,
		readCommittedResult: currentFiles.readCommittedResult,
	});

	assert.equal(result.kind, "complete");
	if (result.kind === "complete" && result.detail === "summary") {
		assert.equal(result.taskId, crossTaskId);
		assert.equal(result.package.results[0]?.summary, "Cross session result text completed successfully.");
	}
});

test("dstack_result returns infrastructure failure when binding exists but no committed result or live status exists", async () => {
	const result = await readDstackResult({
		taskId: "task-abandoned-123",
		statusExact: async () => undefined,
		readBinding: async () => ({ taskId: "task-abandoned-123", workflowId: "wf-abandoned" }),
		readProgress: async () => ({ queued: 0, running: 1, complete: 0, total: 1 }),
		readCommittedResult: async () => undefined,
	});

	assert.equal(result.kind, "infrastructure_failure");
	if (result.kind === "infrastructure_failure") {
		assert.equal(result.taskId, "task-abandoned-123");
		assert.equal(result.companionOutputPath, null);
		assert.ok(result.message.includes("no committed result or live status exists"));
	}
});

test("dstack_result preserves true unknown behavior when no live status and no binding exists", async () => {
	const result = await readDstackResult({
		taskId: "task-never-existed",
		statusExact: async () => undefined,
		readBinding: async () => undefined,
		readProgress: async () => ({ queued: 0, running: 0, complete: 0, total: 0 }),
		readCommittedResult: async () => undefined,
	});

	assert.deepEqual(result, {
		kind: "unknown_task",
		taskId: "task-never-existed",
		message: "No background task exists with id task-never-existed.",
	});
});

test("dstack_result defaults to a bounded summary and detail full retains raw fields", async () => {
	const binding: TaskBinding = { taskId, workflowId: "wf-0123456789abcdef" };
	const fullOutput = { path: toAbsolutePath("/tmp/child-output.txt"), sha256: toSha256("b".repeat(64)), bytes: 12_000 };
	const errorMessage = `child failed: ${"e".repeat(4_000)}`;
	const committedComplete: CommittedResult = {
		kind: "complete",
		outputs: [fullOutput],
		package: {
			mode: "single",
			results: [{
				agent: "poteto-agent",
				cwd: "/workspace",
				task: "own it",
				model: "openai/gpt-5-mini",
				text: "x".repeat(12_000),
				exitCode: 7,
				stderr: "some stderr",
				errorMessage,
				messages: [{ role: "assistant", content: [{ type: "text", text: "large transcript" }] }],
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
			}],
		},
	};

	const result = await readDstackResult({
		taskId,
		statusExact: async () => ({ ...runningTask, status: "completed" }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => committedComplete,
	});
	assert.equal(result.kind, "complete");
	if (result.kind !== "complete" || result.detail !== "summary") return;
	const first = result.package.results[0];
	assert.equal(first?.agent, "poteto-agent");
	assert.equal(first?.exitCode, 7);
	const summaryError = first?.errorMessage ?? "";
	assert.match(summaryError, /^child failed:/);
	assert.match(summaryError, /truncated.*detail:\s*"full"/s);
	assert.ok(summaryError.length < errorMessage.length);
	assert.match(first?.summary ?? "", /truncated/);
	assert.match(first?.summary ?? "", /detail:\s*"full"/);
	assert.ok(!first?.summary.includes("artifact"));
	assert.equal("task" in (first ?? {}), false);
	assert.equal("journal" in (first ?? {}), false);
	assert.equal("usage" in (first ?? {}), false);
	assert.equal("model" in (first ?? {}), false);
	assert.equal("cwd" in (first ?? {}), false);
	assert.equal("messages" in (first ?? {}), false);
	assert.equal("fullOutput" in (first ?? {}), false);
	assert.equal("stderr" in (first ?? {}), false);
	assert.equal("stopReason" in (first ?? {}), false);
	assert.equal("status" in (first ?? {}), false);

	const defaultJson = JSON.stringify(result);
	assert.ok(!defaultJson.includes('"task"'));
	assert.ok(!defaultJson.includes('"journal"'));
	assert.ok(!defaultJson.includes('"usage"'));
	assert.ok(!defaultJson.includes('"model"'));
	assert.ok(!defaultJson.includes('"cwd"'));
	assert.ok(!defaultJson.includes('"messages"'));
	assert.ok(!defaultJson.includes('"fullOutput"'));

	const fullResult = await readDstackResult({
		taskId,
		detail: "full",
		statusExact: async () => ({ ...runningTask, status: "completed" }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => committedComplete,
	});
	assert.equal(fullResult.kind, "complete");
	if (fullResult.kind === "complete" && fullResult.detail === "full") {
		const fullFirst = fullResult.package.results[0];
		assert.equal(fullFirst?.agent, "poteto-agent");
		assert.equal(fullFirst?.cwd, "/workspace");
		assert.equal(fullFirst?.task, "own it");
		assert.equal(fullFirst?.model, "openai/gpt-5-mini");
		assert.equal(fullFirst?.text, "x".repeat(12_000));
		assert.equal(fullFirst?.exitCode, 7);
		assert.equal(fullFirst?.stderr, "some stderr");
		assert.equal(fullFirst?.errorMessage, errorMessage);
		assert.equal(fullFirst?.messages.length, 1);
		assert.deepEqual(fullFirst?.usage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 });
	}
});

test("output artifact hash and byte-length corruption fail closed", async (t) => {
	const dir = await temporaryDirectory(t);
	const fixture = await readFile(join(fixtureDir, "background-output.txt"));
	const path = join(dir, "output.txt");
	await writeFile(path, fixture, { mode: 0o600 });
	const seal = { path, ...outputFixtureSeal };
	assert.equal(fixture.byteLength, outputFixtureSeal.bytes);
	assert.deepEqual(await readOutputArtifact(seal), fixture);

	const hashCorruption = Buffer.from(fixture);
	hashCorruption[0] = hashCorruption[0] === 0x66 ? 0x46 : 0x66;
	await writeFile(path, hashCorruption);
	await assert.rejects(readOutputArtifact(seal), /hash|sha256|integrity/i);

	await writeFile(path, Buffer.concat([fixture, Buffer.from("!")]));
	await assert.rejects(readOutputArtifact(seal), /bytes|length|integrity/i);
});

test("output artifacts cannot be opened through symlinks", async (t) => {
	const dir = await temporaryDirectory(t);
	const fixture = await readFile(join(fixtureDir, "background-output.txt"));
	const target = join(dir, "target.txt");
	const path = join(dir, "output.txt");
	await writeFile(target, fixture, { mode: 0o600 });
	await symlink(target, path);

	await assert.rejects(readOutputArtifact({ path, ...outputFixtureSeal }), /path|symbolic|integrity|loop/i);
});
