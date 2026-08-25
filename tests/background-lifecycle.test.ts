import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { test, type TestContext } from "node:test";
import { readOutputArtifact } from "../extensions/background/artifacts.ts";
import { createEventBusV1Port } from "../extensions/background/eventbus-v1.ts";
import { readDstackResult } from "../extensions/background/result.ts";
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
	});

	assert.equal(statusReads, 1);
	assert.deepEqual(result, {
		kind: "not_ready",
		taskId,
		progress: { queued: 1, running: 0, complete: 0, total: 1 },
	});
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
