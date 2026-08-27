import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseTranscriptProgressEvent,
	PROGRESS_SCHEMA_VERSION,
	renderTranscriptProgress,
	TranscriptProgressTracker,
	type TranscriptProgressEvent,
} from "../extensions/background/progress.ts";
import type { TreeChild, TreeSnapshot } from "../extensions/background/tree.ts";

const BASE_TIME = Date.parse("2025-01-01T00:00:00.000Z");

function child(overrides: Partial<TreeChild> = {}): TreeChild {
	return {
		index: 0,
		agent: "poteto-agent",
		state: "running",
		assignment: "owner",
		startedAt: "2025-01-01T00:00:00.000Z",
		taskPreview: "implement transcript progress",
		nestedGroups: [],
		nested: [],
		...overrides,
	};
}

function snapshot(children: readonly TreeChild[], overrides: Partial<TreeSnapshot> = {}): TreeSnapshot {
	return {
		taskId: "task-progress",
		workflowId: "workflow-progress",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children,
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

function kinds(events: readonly TranscriptProgressEvent[]): string[] {
	return events.map((event) => event.kind);
}

test("progress tracker emits phase and narration changes while deduplicating repeated status", () => {
	const tracker = new TranscriptProgressTracker();
	const initial = snapshot([child({ phase: "grounding" })]);
	assert.deepEqual(tracker.ingest(initial, BASE_TIME), []);

	const changed = snapshot([child({
		phase: "implementation",
		status: {
			phase: "implementation",
			note: "editing api_key=super-secret in the progress reducer",
			updatedAt: "2025-01-01T00:00:01.000Z",
		},
	})]);
	const immediate = tracker.ingest(changed, BASE_TIME + 1_000);
	assert.deepEqual(kinds(immediate), ["phase"]);
	assert.equal(immediate[0]?.kind === "phase" ? immediate[0].note : undefined, "editing api_key=[redacted] in the progress reducer");

	assert.deepEqual(tracker.ingest(changed, BASE_TIME + 4_000), []);
	const narrated = snapshot([child({
		phase: "implementation",
		status: {
			phase: "implementation",
			note: "adding focused tests",
			updatedAt: "2025-01-01T00:00:05.000Z",
		},
	})]);
	const routine = tracker.ingest(narrated, BASE_TIME + 5_000);
	assert.deepEqual(kinds(routine), ["narration"]);
	assert.equal(routine[0]?.kind === "narration" ? routine[0].text : undefined, "adding focused tests");
	assert.deepEqual(tracker.ingest(narrated, BASE_TIME + 10_000), []);

	const blocked = snapshot([child({
		phase: "implementation",
		status: {
			phase: "implementation",
			note: "waiting for the test fixture",
			blocking: true,
			updatedAt: "2025-01-01T00:00:11.000Z",
		},
	})]);
	const blocker = tracker.ingest(blocked, BASE_TIME + 11_000);
	assert.deepEqual(kinds(blocker), ["blocker"]);
	assert.equal(blocker[0]?.kind === "blocker" ? blocker[0].text : undefined, "waiting for the test fixture");
	assert.equal(blocker[0]?.kind === "blocker" ? blocker[0].blocked : undefined, true);

	const unblocked = snapshot([child({
		phase: "implementation",
		status: {
			phase: "implementation",
			note: "test fixture is ready",
			blocking: false,
			updatedAt: "2025-01-01T00:00:12.000Z",
		},
	})]);
	const cleared = tracker.ingest(unblocked, BASE_TIME + 12_000);
	assert.deepEqual(kinds(cleared), ["blocker"]);
	assert.equal(cleared[0]?.kind === "blocker" ? cleared[0].blocked : undefined, false);
});

test("progress tracker coalesces tool bursts and rate limits routine entries", () => {
	const tracker = new TranscriptProgressTracker();
	tracker.ingest(snapshot([child()]), BASE_TIME);
	const withTools = snapshot([child({
		journal: [
			{ seq: 1, timestamp: "2025-01-01T00:00:01.000Z", kind: "tool", name: "read", gist: "a.ts" },
			{ seq: 2, timestamp: "2025-01-01T00:00:02.000Z", kind: "tool", name: "read", gist: "b.ts" },
			{ seq: 3, timestamp: "2025-01-01T00:00:03.000Z", kind: "tool", name: "bash", gist: "npm test" },
		],
	})]);
	assert.deepEqual(tracker.ingest(withTools, BASE_TIME + 3_000), []);
	const emitted = tracker.ingest(withTools, BASE_TIME + 4_000);
	assert.deepEqual(kinds(emitted), ["tool_burst"]);
	assert.deepEqual(emitted[0]?.kind === "tool_burst" ? emitted[0].tools : undefined, [
		{ name: "read", count: 2 },
		{ name: "bash", count: 1 },
	]);
	assert.equal(emitted[0]?.kind === "tool_burst" ? emitted[0].total : undefined, 3);
	assert.deepEqual(tracker.ingest(withTools, BASE_TIME + 8_000), []);
});

test("progress tracker attributes nested launches and returns and reports failures immediately", () => {
	const tracker = new TranscriptProgressTracker();
	tracker.ingest(snapshot([child()]), BASE_TIME);
	const runningNested = child({
		nested: [{
			groupId: "group-a",
			nestedIndex: 2,
			agent: "general-purpose",
			assignment: "worker",
			taskPreview: "write progress tests",
			state: "running",
			startedAt: "2025-01-01T00:00:01.000Z",
			updatedAt: "2025-01-01T00:00:01.000Z",
			live: true,
		}],
	});
	const launched = tracker.ingest(snapshot([runningNested]), BASE_TIME + 1_000);
	assert.deepEqual(kinds(launched), ["nested_launch"]);
	const launch = launched[0];
	assert.ok(launch?.actor.kind === "nested");
	assert.equal(launch.actor.parentIndex, 0);
	assert.equal(launch.actor.groupId, "group-a");
	assert.equal(launch.actor.nestedIndex, 2);

	const failedNested = child({
		state: "failed",
		outcome: "owner process failed",
		nested: [{
			...runningNested.nested[0],
			groupId: "group-a",
			nestedIndex: 2,
			agent: "general-purpose",
			taskPreview: "write progress tests",
			state: "failed",
			updatedAt: "2025-01-01T00:00:02.000Z",
			endedAt: "2025-01-01T00:00:02.000Z",
			live: false,
			errorMessage: "token=private test failure",
		}],
	});
	const failed = tracker.ingest(snapshot([failedNested]), BASE_TIME + 2_000);
	assert.deepEqual(kinds(failed), ["failure", "nested_return"]);
	const nestedReturn = failed.find((event) => event.kind === "nested_return");
	assert.equal(nestedReturn?.kind === "nested_return" ? nestedReturn.summary : undefined, "token=[redacted] test failure");
});

test("progress tracker initializes on reload and branch changes without replaying history", () => {
	const historical = snapshot([child({
		phase: "verification",
		journal: [
			{ seq: 10, timestamp: "2025-01-01T00:00:01.000Z", kind: "turn", turn: 2, summary: "historical narration" },
			{ seq: 11, timestamp: "2025-01-01T00:00:02.000Z", kind: "failure", error: "historical failure" },
		],
	})]);
	const tracker = new TranscriptProgressTracker();
	assert.deepEqual(tracker.ingest(historical, BASE_TIME), []);
	tracker.reset();
	assert.deepEqual(tracker.ingest(historical, BASE_TIME + 20_000), []);
	assert.deepEqual(tracker.ingest({ ...historical, taskId: "branched-task" }, BASE_TIME + 30_000), []);
});

test("progress schema parser and renderer bound data and expose nested failure attribution", () => {
	const parsed = parseTranscriptProgressEvent({
		schemaVersion: PROGRESS_SCHEMA_VERSION,
		taskId: "task-progress",
		workflowId: "workflow-progress",
		at: "2025-01-01T00:00:02.000Z",
		kind: "nested_return",
		actor: {
			kind: "nested",
			parentIndex: 0,
			groupId: "group-a",
			nestedIndex: 2,
			agent: "general-purpose",
			assignment: "worker",
		},
		state: "failed",
		summary: "password=hunter2 assertion failed",
	});
	assert.ok(parsed !== undefined);
	assert.equal(parsed.kind === "nested_return" ? parsed.summary : undefined, "password=[redacted] assertion failed");
	const rendered = renderTranscriptProgress(parsed, true);
	assert.match(rendered, /✗ worker general-purpose · returned failed/);
	assert.match(rendered, /child 0 · nested group-a\/2/);
	assert.match(rendered, /2025-01-01T00:00:02.000Z/);
	assert.equal(parseTranscriptProgressEvent({ ...parsed, schemaVersion: "dstack.progress.v2" }), undefined);
	assert.equal(parseTranscriptProgressEvent({ ...parsed, actor: { kind: "nested", parentIndex: -1 } }), undefined);
});
