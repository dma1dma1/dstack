import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { test, type TestContext } from "node:test";
import { readOutputArtifact, toAbsolutePath, toSha256 } from "../extensions/background/artifacts.ts";
import { createEventBusV1Port } from "../extensions/background/eventbus-v1.ts";
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
	};
	const cancelled: CommittedResult = { kind: "cancelled", message: "Stopped after child 1." };
	const read = (status: "completed" | "failed" | "killed", committed?: CommittedResult) => readDstackResult({
		taskId,
		statusExact: async () => ({ ...runningTask, status }),
		readBinding: async () => binding,
		readProgress: async () => ({ queued: 0, running: 0, complete: 1, total: 1 }),
		readCommittedResult: async () => committed,
	});

	assert.deepEqual(await read("completed", complete), { kind: "complete", taskId, package: complete.package });
	assert.deepEqual(await read("completed", artifact), {
		kind: "artifact",
		taskId,
		outcome: artifact.outcome,
		path: artifact.path,
		sha256: artifact.sha256,
		bytes: artifact.bytes,
		summary: artifact.summary,
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
