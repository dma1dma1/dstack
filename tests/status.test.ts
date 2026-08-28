import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TreeSnapshot } from "../extensions/background/tree.ts";
import {
	classifyDstackStatus,
	DstackStatusWriter,
	encodedSessionId,
	reduceDstackStatus,
} from "../extensions/status.ts";

const tree = {
	taskId: "task-1",
	workflowId: "workflow-1",
	mode: "single",
	playbook: "feature",
	createdAt: "2026-03-01T00:00:00.000Z",
	committed: false,
	counts: { queued: 0, running: 1, complete: 0, total: 1 },
	slots: { active: 2, capacity: 4 },
	children: [{
		index: 0,
		agent: "poteto-agent",
		state: "running",
		taskPreview: "Implement status",
		nestedGroups: [{
			groupId: "group-1",
			mode: "single",
			createdAt: "2026-03-01T00:00:01.000Z",
			children: [{
				groupId: "group-1",
				nestedIndex: 0,
				agent: "poteto-agent",
				taskPreview: "Write module",
				state: "running",
				updatedAt: "2026-03-01T00:00:02.000Z",
				live: true,
				status: { blockedOn: "approval", updatedAt: "2026-03-01T00:00:02.000Z" },
			}],
		}],
		nested: [],
	}],
	todos: [],
	todoCounts: { total: 0, completed: 0, inProgress: 0 },
	capturedAt: "2026-03-01T00:00:03.000Z",
} satisfies TreeSnapshot;

const processIdentity = {
	pid: 123,
	startedAt: "2026-03-01T00:00:00.000Z",
	hostname: "host",
	cwd: "/tmp",
	execPath: "/usr/bin/node",
};

test("status snapshot preserves the public rollup, tree, classifier, and atomic file contract", async (t) => {
	const waiting = reduceDstackStatus({
		sessionId: "session/one",
		process: processIdentity,
		heartbeatAt: "2026-03-01T00:00:10.000Z",
		heartbeatIntervalMs: 5_000,
		rootState: "working",
		rootStatus: { blockedOn: "human", updatedAt: "2026-03-01T00:00:10.000Z" },
		tree,
	});
	assert.equal(waiting.schemaVersion, "dstack.status.v1");
	assert.equal(waiting.rollup, "waiting_on_input");
	assert.equal(waiting.task?.children[0]?.children[0]?.summary, "Write module");
	assert.equal(waiting.task?.children[0]?.children[0]?.status?.blockedOn, "approval");
	const childApproval = reduceDstackStatus({
		sessionId: "session/one",
		process: processIdentity,
		heartbeatAt: "2026-03-01T00:00:10.000Z",
		heartbeatIntervalMs: 5_000,
		rootState: "idle",
		tree,
	});
	assert.equal(childApproval.rollup, "waiting_on_approval");
	assert.equal(classifyDstackStatus(waiting, { nowMs: Date.parse("2026-03-01T00:00:21.001Z"), processAlive: false }), "crashed");
	assert.equal(classifyDstackStatus(waiting, { nowMs: Date.parse("2026-03-01T00:00:20.000Z"), processAlive: false }), "live");
	assert.equal(encodedSessionId("session/one"), "c2Vzc2lvbi9vbmU");

	const dir = await mkdtemp(join(tmpdir(), "dstack-status-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "snapshot.json");
	const writer = new DstackStatusWriter("session/one", path, 5_000, undefined);
	const written = await writer.write({ heartbeatAt: "2026-03-01T00:00:10.000Z", rootState: "idle" });
	const bytes = await readFile(path, "utf8");
	assert.deepEqual(JSON.parse(bytes), written);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});
