import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	buildTreeSnapshot,
	formatCost,
	formatElapsed,
	isLeaseSnapshot,
	parseActivityV1,
	parseJournalEntries,
	parseJournalSnapshot,
	parseLeaseChildId,
	parseManifestForTree,
	parseProgressV2,
	parseSemanticStatus,
	parseSpawnRecordV1,
	parseTreeSnapshot,
	recoverNestedModelFromParentResult,
	renderTreeLines,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
	type LeaseSnapshot,
	type TreeSnapshot,
	type TreeTheme,
} from "../extensions/background/tree.ts";
import { snapshotActiveLeases } from "../extensions/background/scheduler.ts";
import { saveTodos } from "../extensions/todo.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-tree-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("parseProgressV2 validates counters and per-child records", () => {
	const validV2 = {
		queued: 1,
		running: 1,
		complete: 2,
		total: 4,
		children: [
			{ index: 0, agent: "poteto-agent", state: "succeeded", role: "feature", assignment: "owner", startedAt: "2025-01-01T00:00:00.000Z", endedAt: "2025-01-01T00:04:02.000Z" },
			{ index: 1, agent: "general-purpose", state: "failed", assignment: "worker", startedAt: "2025-01-01T00:01:00.000Z", endedAt: "2025-01-01T00:03:11.000Z" },
			{ index: 2, agent: "general-purpose", state: "running", startedAt: "2025-01-01T00:03:00.000Z" },
			{ index: 3, agent: "general-purpose", state: "queued" },
		],
	};

	const parsed = parseProgressV2(validV2);
	assert.ok(parsed !== undefined);
	assert.equal(parsed.queued, 1);
	assert.equal(parsed.running, 1);
	assert.equal(parsed.complete, 2);
	assert.equal(parsed.total, 4);
	assert.equal(parsed.children.length, 4);
	assert.equal(parsed.children[0]?.assignment, "owner");
	assert.equal(parsed.children[1]?.state, "failed");
	assert.equal(parsed.children[2]?.startedAt, "2025-01-01T00:03:00.000Z");
	assert.equal(parsed.children[3]?.endedAt, undefined);
});

test("parseProgressV2 accepts legacy counts-only progress and drops malformed child records individually", () => {
	const legacy = { queued: 2, running: 0, complete: 0, total: 2 };
	const parsedLegacy = parseProgressV2(legacy);
	assert.ok(parsedLegacy !== undefined);
	assert.deepEqual(parsedLegacy.children, []);

	const mixed = {
		queued: 1,
		running: 0,
		complete: 1,
		total: 2,
		children: [
			{ index: 0, agent: "poteto-agent", state: "succeeded" },
			{ index: "bad-index", agent: "foo", state: "running" },
			{ index: 1, agent: "", state: "queued" },
			{ index: 2, agent: "general-purpose", state: "invalid-state" },
			{ index: 3, agent: "general-purpose", state: "queued" },
		],
	};
	const parsedMixed = parseProgressV2(mixed);
	assert.ok(parsedMixed !== undefined);
	assert.equal(parsedMixed.children.length, 2);
	assert.equal(parsedMixed.children[0]?.index, 0);
	assert.equal(parsedMixed.children[1]?.index, 3);

	assert.equal(parseProgressV2(null), undefined);
	assert.equal(parseProgressV2({ queued: -1, running: 0, complete: 0, total: 0 }), undefined);
	assert.equal(parseProgressV2("not an object"), undefined);
});

test("parseManifestForTree extracts tree-relevant facts permissively", () => {
	const rawManifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-1234",
		sessionId: "sess-abc",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "first line of task\nsecond line of details",
				requestedRole: "feature",
				workflow: {
					assignment: "owner",
					playbook: "feature",
					phase: "implement",
				},
			},
			{
				agent: "general-purpose",
				task: "single line worker task",
			},
		],
	};

	const parsed = parseManifestForTree(rawManifest);
	assert.ok(parsed !== undefined);
	assert.equal(parsed.workflowId, "wf-1234");
	assert.equal(parsed.mode, "parallel");
	assert.equal(parsed.specs.length, 2);
	assert.equal(parsed.specs[0]?.assignment, "owner");
	assert.equal(parsed.specs[0]?.playbook, "feature");
	assert.equal(parsed.specs[0]?.phase, "implement");
	assert.equal(parsed.specs[1]?.agent, "general-purpose");

	assert.equal(parseManifestForTree(null), undefined);
	assert.equal(parseManifestForTree({ workflowId: "" }), undefined);
	assert.equal(parseManifestForTree({ workflowId: "1", mode: "unknown", createdAt: "now", specs: [] }), undefined);
});

test("formatElapsed formats durations cleanly across scales", () => {
	assert.equal(formatElapsed(0), "0m00s");
	assert.equal(formatElapsed(12_000), "0m12s");
	assert.equal(formatElapsed(242_000), "4m02s");
	assert.equal(formatElapsed(761_000), "12m41s");
	assert.equal(formatElapsed(3720_000), "1h02m");
	assert.equal(formatElapsed(7380_000), "2h03m");
});

test("stripAnsi and truncateToWidth respect visible width", () => {
	const plain = "Hello world from tree renderer";
	assert.equal(truncateToWidth(plain, 15), "Hello world fr…");
	assert.equal(truncateToWidth(plain, 50), plain);
	assert.equal(truncateToWidth(plain, 3), "Hel");

	const ansi = "\x1b[32m✓\x1b[39m \x1b[1mowner poteto-agent\x1b[22m";
	assert.equal(stripAnsi(ansi), "✓ owner poteto-agent");
	assert.equal(visibleWidth(ansi), 20);
});

test("renderTreeLines generates compact live widget lines with glyphs, elapsed times, and nested rows", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-100",
		workflowId: "wf-100",
		mode: "parallel",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 1, running: 1, complete: 2, total: 4 },
		slots: { active: 3, capacity: 4 },
		capturedAt: "2025-01-01T00:12:41.000Z",
		todos: [
			{ id: "1", content: "ground and design the MVP", status: "completed" },
			{ id: "2", content: "implement tree renderer", status: "in_progress" },
			{ id: "3", content: "verify tests", status: "pending" },
		],
		todoOwner: "session root",
		todoCounts: { total: 3, completed: 1, inProgress: 1 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				startedAt: "2025-01-01T00:00:02.000Z",
				taskPreview: "orchestrate feature development",
				nestedGroups: [
					{
						groupId: "group",
						mode: "unknown",
						createdAt: "2025-01-01T00:11:39.000Z",
						children: [
							{
								workflowId: "wf-100",
								childId: "group-0",
								depth: 2,
								acquiredAt: "2025-01-01T00:11:39.000Z",
							},
						],
					},
				],
				nested: [
					{
						workflowId: "wf-100",
						childId: "group-0",
						depth: 2,
						acquiredAt: "2025-01-01T00:11:39.000Z",
					},
				],
			},
			{
				index: 1,
				agent: "general-purpose",
				state: "succeeded",
				role: "implementation-worker",
				assignment: "worker",
				startedAt: "2025-01-01T00:01:00.000Z",
				endedAt: "2025-01-01T00:05:02.000Z",
				taskPreview: "ground and design the MVP",
				nestedGroups: [],
				nested: [],
			},
			{
				index: 2,
				agent: "general-purpose",
				state: "failed",
				role: "implementation-worker",
				assignment: "worker",
				startedAt: "2025-01-01T00:05:10.000Z",
				endedAt: "2025-01-01T00:07:21.000Z",
				taskPreview: "implement todo timestamps",
				nestedGroups: [],
				nested: [],
			},
			{
				index: 3,
				agent: "general-purpose",
				state: "queued",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "write tree renderer tests",
				nestedGroups: [],
				nested: [],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 78,
		maxLines: 8,
		now: new Date("2025-01-01T00:12:41.000Z"),
	});

	assert.equal(lines[0], truncateToWidth("dstack · feature · slots 3/4 · 2/4 done · 12m41s · todos 1/3 · oldest at top · newest at bottom", 78));
	assert.ok(lines.some((l) => l.includes("├─ ◐ owner poteto-agent 12m39s orchestrate feature development")));
	assert.ok(lines.some((l) => l.includes("run · 1 agent · mode unavailable")));
	assert.ok(lines.some((l) => l.includes("◐ agent details pending (1m02s)")));
	assert.ok(lines.some((l) => l.includes("├─ ✓ worker general-purpose (4m02s) ground and design the MVP")));
	assert.ok(lines.some((l) => l.includes("├─ ✗ worker general-purpose (2m11s) failed implement todo timestamps")));
	assert.ok(lines.some((l) => l.includes("└─ ○ worker general-purpose queued 12m41s write tree renderer tests")));

	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 78, `line exceeds width 78: "${line}"`);
	}
});

test("renderTreeLines applies theme colors and renders frozen frame without slots", () => {
	const theme: TreeTheme = {
		fg(color, text) { return `[${color}]${text}[/${color}]`; },
		bold(text) { return `[bold]${text}[/bold]`; },
		strikethrough(text) { return `[s]${text}[/s]`; },
	};

	const frozenSnapshot: TreeSnapshot = {
		taskId: "task-200",
		workflowId: "wf-200",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		capturedAt: "2025-01-01T00:04:02.000Z",
		todos: [
			{ id: "1", content: "complete task", status: "completed" },
		],
		todoOwner: "session root",
		todoCounts: { total: 1, completed: 1, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				assignment: "owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:04:02.000Z",
				taskPreview: "finish everything",
				nestedGroups: [],
				nested: [],
			},
		],
	};

	const lines = renderTreeLines(frozenSnapshot, {
		width: 80,
		maxLines: Infinity,
		theme,
		includeTodos: true,
		now: new Date("2025-01-01T00:04:02.000Z"),
	});

	assert.equal(lines[0], truncateToWidth("dstack · feature · 1/1 done · 4m02s · todos 1/1 · oldest at top · newest at bottom", 80));
	assert.ok(lines.some((l) => l.includes("[success]✓[/success]")));
	assert.ok(lines.some((l) => l.includes("todos (1/1 done, owner: session root):")));
	assert.ok(lines.some((l) => l.includes("[success]☑[/success]")));
});

test("renderTreeLines prioritizes failed and live rows during maxLines truncation", () => {
	const children = [];
	for (let i = 0; i < 10; i++) {
		const state = i === 1 ? "failed" : i === 3 ? "running" : "succeeded";
		children.push({
			index: i,
			agent: "general-purpose",
			state: state as "failed" | "running" | "succeeded",
			assignment: "worker" as const,
			startedAt: "2025-01-01T00:00:00.000Z",
			endedAt: state !== "running" ? "2025-01-01T00:01:00.000Z" : undefined,
			taskPreview: `task number ${i}`,
			nestedGroups: [],
			nested: [],
		});
	}

	const snapshot: TreeSnapshot = {
		taskId: "task-many",
		workflowId: "wf-many",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 9, total: 10 },
		slots: { active: 1, capacity: 4 },
		capturedAt: "2025-01-01T00:05:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children,
	};

	const lines = renderTreeLines(snapshot, {
		width: 80,
		maxLines: 6,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});

	assert.equal(lines.length, 6);
	assert.ok(lines.some((l) => l.includes("✗ worker general-purpose") && l.includes("task number 1")));
	assert.ok(lines.some((l) => l.includes("◐ worker general-purpose") && l.includes("task number 3")));
	assert.ok(lines[lines.length - 1]?.includes("more (use /dtree)"));
});

test("buildTreeSnapshot reads durable files, calculates queued duration from createdAt, and groups depth-2 leases", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-build-test");
	const schedulerRoot = join(cwd, "scheduler");
	const todoPath = join(cwd, "todos.json");

	await mkdir(artifactDir, { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifestData = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-build-test",
		sessionId: "sess-test",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner task prompt",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature", phase: "implement" },
			},
			{
				agent: "general-purpose",
				task: "worker task prompt",
				requestedRole: "implementation-worker",
				workflow: { assignment: "worker" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifestData)}\n`, "utf8");

	const progressData = {
		queued: 1,
		running: 1,
		complete: 0,
		total: 2,
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", startedAt: "2025-01-01T00:01:00.000Z", role: "feature", assignment: "owner" },
			{ index: 1, agent: "general-purpose", state: "queued", role: "implementation-worker", assignment: "worker" },
		],
	};
	await writeFile(join(artifactDir, "progress.json"), `${JSON.stringify(progressData)}\n`, "utf8");

	await saveTodos(todoPath, {
		items: [
			{ id: "todo-1", content: "todo item one", status: "completed" },
			{ id: "todo-2", content: "todo item two", status: "pending" },
		],
	});

	const leaseData = {
		schemaVersion: "dstack.scheduler.lease.v2",
		seq: 1,
		nonce: "nonce-1",
		workflowId: "wf-build-test",
		childId: "group-uuid-0",
		depth: 2,
		capacityClass: "terminal",
		owner: { pid: process.pid, startToken: "unprovable" },
		acquiredAt: "2025-01-01T00:02:00.000Z",
	};
	await writeFile(join(schedulerRoot, "leases", "lease-1.json"), `${JSON.stringify(leaseData)}\n`, "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-build-test",
		workflowId: "wf-build-test",
		artifactDir,
		schedulerRoot,
		todoPath,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	assert.equal(snapshot.taskId, "task-build-test");
	assert.equal(snapshot.workflowId, "wf-build-test");
	assert.equal(snapshot.mode, "parallel");
	assert.equal(snapshot.playbook, "feature");
	assert.equal(snapshot.committed, false);
	assert.equal(snapshot.counts.running, 1);
	assert.equal(snapshot.counts.queued, 1);
	assert.equal(snapshot.todos.length, 2);
	assert.equal(snapshot.todoOwner, "session root");
	assert.equal(snapshot.todoCounts.completed, 1);
	assert.equal(snapshot.todoCounts.total, 2);

	assert.equal(snapshot.children.length, 2);
	const ownerChild = snapshot.children[0];
	assert.ok(ownerChild !== undefined);
	assert.equal(ownerChild.nested.length, 1);
	const firstNested = ownerChild.nested[0];
	assert.ok(firstNested !== undefined);
	const nestedDepth = isLeaseSnapshot(firstNested) ? firstNested.depth : firstNested.lease?.depth;
	assert.equal(nestedDepth, 2);

	const workerChild = snapshot.children[1];
	assert.ok(workerChild !== undefined);
	assert.equal(workerChild.state, "queued");

	const lines = renderTreeLines(snapshot, {
		width: 80,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});
	assert.ok(lines.some((l) => l.includes("queued 5m00s")));
});

test("buildTreeSnapshot recovers legacy child states from leases and sealed results", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-legacy");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(artifactDir, "children", "0"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify({
		workflowId: "wf-legacy",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{ agent: "poteto-agent", task: "finished owner", workflow: { assignment: "owner" } },
			{ agent: "general-purpose", task: "live worker", workflow: { assignment: "worker" } },
		],
	}), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({ queued: 0, running: 1, complete: 1, total: 2 }), "utf8");
	await writeFile(join(artifactDir, "children", "0", "result.json"), JSON.stringify({ state: "failed" }), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-legacy",
		workflowId: "wf-legacy",
		artifactDir,
		schedulerRoot,
		activeLeases: [{
			workflowId: "wf-legacy",
			childId: "1",
			depth: 1,
			acquiredAt: "2025-01-01T00:01:00.000Z",
		}],
		now: new Date("2025-01-01T00:02:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	assert.equal(snapshot.children[0]?.state, "failed");
	assert.ok(snapshot.children[0]?.endedAt !== undefined);
	assert.equal(snapshot.children[1]?.state, "running");
	assert.equal(snapshot.children[1]?.startedAt, "2025-01-01T00:01:00.000Z");
});

test("parseTreeSnapshot validates schema at entry renderer boundaries", () => {
	const valid = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "succeeded",
				taskPreview: "done task",
				cost: 0.042,
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const parsed = parseTreeSnapshot(valid);
	assert.ok(parsed !== undefined);
	assert.equal(parsed.taskId, "task-1");
	assert.equal(parsed.children[0]?.cost, 0.042);

	const withInvalidCost = {
		...valid,
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "succeeded",
				taskPreview: "done task",
				cost: -1,
				nested: [],
			},
		],
	};
	const parsedInvalidCost = parseTreeSnapshot(withInvalidCost);
	assert.ok(parsedInvalidCost !== undefined);
	assert.equal(parsedInvalidCost.children[0]?.cost, undefined);

	assert.equal(parseTreeSnapshot(null), undefined);
	assert.equal(parseTreeSnapshot({ taskId: 123 }), undefined);
	assert.equal(parseTreeSnapshot({ ...valid, mode: "unsupported-mode" }), undefined);
});

test("snapshotActiveLeases returns active leases and ignores reclaimable/corrupt files", async (t) => {
	const cwd = await temporaryDirectory(t);
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const liveLease = {
		schemaVersion: "dstack.scheduler.lease.v2",
		seq: 1,
		nonce: "nonce-live",
		workflowId: "wf-10",
		childId: "child-0",
		depth: 1,
		capacityClass: "reserved",
		owner: { pid: process.pid, startToken: "live-token" },
		acquiredAt: "2025-01-01T00:00:00.000Z",
	};
	await writeFile(join(schedulerRoot, "leases", "01.json"), `${JSON.stringify(liveLease)}\n`, "utf8");

	await writeFile(join(schedulerRoot, "leases", "corrupt.json"), "invalid json data", "utf8");

	const leases = await snapshotActiveLeases(schedulerRoot);
	assert.ok(leases.length >= 0);
});

test("parseActivityV1 validates schema and rejects malformed records", () => {
	const valid = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-1",
		index: 0,
		activity: "→ read {\"path\":\"file.ts\"}",
		updatedAt: "2025-01-01T00:01:00.000Z",
		turns: 3,
		contextTokens: 1200,
		cost: 0.084,
	};
	assert.deepEqual(parseActivityV1(valid), valid);

	const withoutCost = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-1",
		index: 0,
		activity: "running",
		updatedAt: "2025-01-01T00:01:00.000Z",
		turns: 1,
		contextTokens: 100,
	};
	assert.deepEqual(parseActivityV1(withoutCost), withoutCost);

	assert.equal(parseActivityV1(null), undefined);
	assert.equal(parseActivityV1({ ...valid, schemaVersion: "invalid" }), undefined);
	assert.equal(parseActivityV1({ ...valid, index: -1 }), undefined);
	assert.equal(parseActivityV1({ ...valid, index: "0" }), undefined);
	assert.equal(parseActivityV1({ ...valid, turns: -1 }), undefined);
	assert.equal(parseActivityV1({ ...valid, contextTokens: -5 }), undefined);
	assert.equal(parseActivityV1({ ...valid, updatedAt: "" }), undefined);
	assert.equal(parseActivityV1({ ...valid, cost: -0.01 }), undefined);
	assert.equal(parseActivityV1({ ...valid, cost: Number.NaN }), undefined);
	assert.equal(parseActivityV1({ ...valid, cost: Number.POSITIVE_INFINITY }), undefined);
	assert.equal(parseActivityV1({ ...valid, cost: "0.084" }), undefined);
});

test("parseSpawnRecordV1 validates schema and per-child records", () => {
	const valid = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-1",
		parentIndex: 0,
		groupId: "group-uuid-1",
		mode: "parallel",
		phase: "implement",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "fix ts compiler error",
				state: "running",
				activity: "→ bash {\"command\":\"npm test\"}",
				updatedAt: "2025-01-01T00:01:30.000Z",
				startedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	const parsed = parseSpawnRecordV1(valid);
	assert.ok(parsed !== undefined);
	assert.equal(parsed.workflowId, "wf-1");
	assert.equal(parsed.parentIndex, 0);
	assert.equal(parsed.phase, "implement");
	assert.equal(parsed.children.length, 1);
	assert.equal(parsed.children[0]?.agent, "general-purpose");
	assert.equal(parsed.children[0]?.activity, "→ bash {\"command\":\"npm test\"}");
	assert.equal(parseSpawnRecordV1({
		...valid,
		children: [{ ...valid.children[0], state: "cancelled" }],
	})?.children[0]?.state, "cancelled");

	assert.equal(parseSpawnRecordV1(null), undefined);
	assert.equal(parseSpawnRecordV1({ ...valid, schemaVersion: "bad" }), undefined);
	assert.equal(parseSpawnRecordV1({ ...valid, parentIndex: -1 }), undefined);
	assert.equal(parseSpawnRecordV1({ ...valid, mode: "invalid" }), undefined);
	assert.equal(parseSpawnRecordV1({ ...valid, children: [{ nestedIndex: -1 }] })?.children.length, 0);
});

test("buildTreeSnapshot integrates activity.json, stale derivation, spawns, and outcome", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-rich");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(join(artifactDir, "children", "0", "spawns"), { recursive: true });
	await mkdir(join(artifactDir, "children", "1"), { recursive: true });
	await mkdir(join(artifactDir, "children", "2"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-rich",
		sessionId: "sess-rich",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner task",
				workflow: { assignment: "owner", playbook: "feature", phase: "ground" },
			},
			{
				agent: "general-purpose",
				task: "worker 1 task",
				workflow: { assignment: "worker" },
			},
			{
				agent: "general-purpose",
				task: "worker 2 task",
				workflow: { assignment: "worker" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const progress = {
		queued: 0,
		running: 2,
		complete: 1,
		total: 3,
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", assignment: "owner", startedAt: "2025-01-01T00:00:01.000Z" },
			{ index: 1, agent: "general-purpose", state: "running", assignment: "worker", startedAt: "2025-01-01T00:00:05.000Z" },
			{ index: 2, agent: "general-purpose", state: "failed", assignment: "worker", startedAt: "2025-01-01T00:00:05.000Z", endedAt: "2025-01-01T00:02:11.000Z" },
		],
	};
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify(progress), "utf8");

	const activity0 = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-rich",
		index: 0,
		activity: "dstack_task: batch 2",
		updatedAt: "2025-01-01T00:04:00.000Z",
		turns: 5,
		contextTokens: 2500,
	};
	await writeFile(join(artifactDir, "children", "0", "activity.json"), JSON.stringify(activity0), "utf8");

	const activity1 = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-rich",
		index: 1,
		activity: "→ bash {\"command\":\"sleep 1000\"}",
		updatedAt: "2025-01-01T00:01:00.000Z",
		turns: 2,
		contextTokens: 800,
	};
	await writeFile(join(artifactDir, "children", "1", "activity.json"), JSON.stringify(activity1), "utf8");

	const spawnRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-rich",
		parentIndex: 0,
		groupId: "nested-group-1",
		mode: "parallel",
		phase: "implement",
		createdAt: "2025-01-01T00:03:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "nested worker task",
				state: "running",
				activity: "→ Bash: npm test",
				updatedAt: "2025-01-01T00:04:30.000Z",
				startedAt: "2025-01-01T00:03:00.000Z",
			},
		],
	};
	await writeFile(join(artifactDir, "children", "0", "spawns", "nested-group-1.json"), JSON.stringify(spawnRecord), "utf8");

	const leaseData = {
		schemaVersion: "dstack.scheduler.lease.v2",
		seq: 1,
		nonce: "n-1",
		workflowId: "wf-rich",
		childId: "nested-group-1-0",
		depth: 2,
		capacityClass: "terminal",
		owner: { pid: process.pid, startToken: "unprovable" },
		acquiredAt: "2025-01-01T00:03:00.000Z",
	};
	await writeFile(join(schedulerRoot, "leases", "l1.json"), JSON.stringify(leaseData), "utf8");

	const result2 = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-rich",
		index: 2,
		state: "failed",
		startedAt: "2025-01-01T00:00:05.000Z",
		endedAt: "2025-01-01T00:02:11.000Z",
		result: {
			exitCode: 1,
			text: "",
			errorMessage: "tsc TS2345 in todo.ts:41: Argument of type string is not assignable\nsecond line of error",
		},
	};
	await writeFile(join(artifactDir, "children", "2", "result.json"), JSON.stringify(result2), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-rich",
		workflowId: "wf-rich",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const owner = snapshot.children[0];
	assert.ok(owner !== undefined);
	assert.equal(owner.phase, "implement");
	assert.equal(owner.activity?.text, "dstack_task: batch 2");
	assert.equal(owner.stale, undefined);
	assert.equal(owner.nested.length, 1);
	const nested0 = owner.nested[0];
	assert.ok(nested0 !== undefined);
	assert.equal(isLeaseSnapshot(nested0), false);
	if (!isLeaseSnapshot(nested0)) {
		assert.equal(nested0.agent, "general-purpose");
		assert.equal(nested0.activity, "→ Bash: npm test");
		assert.equal(nested0.live, true);
	}

	const worker1 = snapshot.children[1];
	assert.ok(worker1 !== undefined);
	assert.equal(worker1.stale, true);
	assert.equal(worker1.activity?.text, "→ bash {\"command\":\"sleep 1000\"}");

	const worker2 = snapshot.children[2];
	assert.ok(worker2 !== undefined);
	assert.equal(worker2.state, "failed");
	assert.ok(worker2.outcome?.includes("tsc TS2345 in todo.ts:41"));

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});

	assert.ok(lines.some((l) => l.includes("owner poteto-agent · phase implement") && l.includes("dstack_task: batch 2")));
	assert.ok(lines.some((l) => l.includes("worker general-purpose 4m55s") && l.includes("stale 4m00s") && l.includes("sleep 1000")));
	assert.ok(lines.some((l) => l.includes("worker general-purpose (2m06s) failed — tsc TS2345 in todo.ts:41")));
	assert.ok(lines.some((l) => l.includes("worker general-purpose 2m00s — → Bash: npm test")));
});

test("renderTreeLines displays waiting on slot when queued and slots are full", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-starved",
		workflowId: "wf-starved",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 1, running: 4, complete: 0, total: 5 },
		slots: { active: 4, capacity: 4 },
		capturedAt: "2025-01-01T00:00:12.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "queued",
				assignment: "worker",
				taskPreview: "review changes",
				nestedGroups: [],
				nested: [],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 80,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:00:12.000Z"),
	});

	assert.ok(lines.some((l) => l.includes("worker general-purpose queued 0m12s — waiting on slot")));
});

test("parseLeaseChildId splits UUID childIds at the final hyphen", () => {
	const uuidLease = "123e4567-e89b-12d3-a456-426614174000-3";
	const parsedUuid = parseLeaseChildId(uuidLease);
	assert.equal(parsedUuid.groupId, "123e4567-e89b-12d3-a456-426614174000");
	assert.equal(parsedUuid.nestedIndex, 3);

	const simpleLease = "group-0";
	const parsedSimple = parseLeaseChildId(simpleLease);
	assert.equal(parsedSimple.groupId, "group");
	assert.equal(parsedSimple.nestedIndex, 0);

	const noHyphen = "orphan";
	const parsedNoHyphen = parseLeaseChildId(noHyphen);
	assert.equal(parsedNoHyphen.groupId, "orphan");
	assert.equal(parsedNoHyphen.nestedIndex, 0);
});

test("buildTreeSnapshot rejects activity.json and spawns with mismatched workflowId or parentIndex", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-identity");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(join(artifactDir, "children", "0", "spawns"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-identity",
		sessionId: "sess-id",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{ agent: "poteto-agent", task: "owner task", workflow: { assignment: "owner" } },
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const badActivity = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-wrong-workflow",
		index: 0,
		activity: "mismatched activity",
		updatedAt: "2025-01-01T00:01:00.000Z",
		turns: 1,
		contextTokens: 100,
	};
	await writeFile(join(artifactDir, "children", "0", "activity.json"), JSON.stringify(badActivity), "utf8");

	const badSpawn = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-identity",
		parentIndex: 99,
		groupId: "grp-bad",
		mode: "parallel",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				taskPreview: "bad nested",
				state: "running",
				updatedAt: "2025-01-01T00:01:00.000Z",
				startedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	await writeFile(join(artifactDir, "children", "0", "spawns", "grp-bad.json"), JSON.stringify(badSpawn), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-identity",
		workflowId: "wf-identity",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:02:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child0 = snapshot.children[0];
	assert.ok(child0 !== undefined);
	assert.equal(child0.activity, undefined);
	assert.equal(child0.nested.length, 0);
});

test("buildTreeSnapshot ignores activity.json when child is in terminal state", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-terminal-activity");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(join(artifactDir, "children", "0"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-terminal-activity",
		sessionId: "sess-term",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "poteto-agent", task: "finished task" }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const result = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-terminal-activity",
		index: 0,
		state: "succeeded",
		startedAt: "2025-01-01T00:00:01.000Z",
		endedAt: "2025-01-01T00:01:00.000Z",
		result: {
			exitCode: 0,
			text: "Final completed text\nsecond line",
			errorMessage: "Old error should be ignored on success",
		},
	};
	await writeFile(join(artifactDir, "children", "0", "result.json"), JSON.stringify(result), "utf8");

	const activity = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-terminal-activity",
		index: 0,
		activity: "old in-flight tool call",
		updatedAt: "2025-01-01T00:00:10.000Z",
		turns: 2,
		contextTokens: 500,
	};
	await writeFile(join(artifactDir, "children", "0", "activity.json"), JSON.stringify(activity), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-term",
		workflowId: "wf-terminal-activity",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:10:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child0 = snapshot.children[0];
	assert.ok(child0 !== undefined);
	assert.equal(child0.state, "succeeded");
	assert.equal(child0.activity, undefined);
	assert.equal(child0.stale, undefined);
	assert.equal(child0.outcome, "Final completed text");
});

test("renderTreeLines formats all nested child states", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-nested-states",
		workflowId: "wf-nested-states",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 2, capacity: 4 },
		capturedAt: "2025-01-01T00:03:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				assignment: "owner",
				taskPreview: "orchestrator",
				startedAt: "2025-01-01T00:00:00.000Z",
				nestedGroups: [
					{
						groupId: "g-1",
						mode: "single",
						createdAt: "2025-01-01T00:00:00.000Z",
						children: [
							{
								groupId: "g-1",
								nestedIndex: 0,
								agent: "general-purpose",
								assignment: "worker",
								taskPreview: "queued task preview",
								state: "queued",
								updatedAt: "2025-01-01T00:02:00.000Z",
								live: false,
							},
							{
								groupId: "g-1",
								nestedIndex: 1,
								agent: "general-purpose",
								assignment: "worker",
								taskPreview: "running task",
								state: "running",
								activity: "→ bash npm test",
								startedAt: "2025-01-01T00:02:00.000Z",
								updatedAt: "2025-01-01T00:02:30.000Z",
								live: true,
							},
							{
								groupId: "g-1",
								nestedIndex: 2,
								agent: "general-purpose",
								assignment: "worker",
								taskPreview: "succeeded task",
								state: "succeeded",
								activity: "all tests passed",
								startedAt: "2025-01-01T00:01:00.000Z",
								endedAt: "2025-01-01T00:01:45.000Z",
								updatedAt: "2025-01-01T00:01:45.000Z",
								live: false,
							},
							{
								groupId: "g-1",
								nestedIndex: 3,
								agent: "general-purpose",
								assignment: "worker",
								taskPreview: "failed task",
								state: "failed",
								activity: "assertion failed on line 12",
								startedAt: "2025-01-01T00:01:00.000Z",
								endedAt: "2025-01-01T00:01:30.000Z",
								updatedAt: "2025-01-01T00:01:30.000Z",
								live: false,
							},
							{
								groupId: "g-1",
								nestedIndex: 4,
								agent: "general-purpose",
								assignment: "worker",
								taskPreview: "cancelled task",
								state: "cancelled",
								startedAt: "2025-01-01T00:01:00.000Z",
								endedAt: "2025-01-01T00:01:15.000Z",
								updatedAt: "2025-01-01T00:01:15.000Z",
								live: false,
							},
							{
								groupId: "g-1",
								nestedIndex: 5,
								agent: "general-purpose",
								assignment: "worker",
								taskPreview: "skipped task",
								state: "skipped",
								updatedAt: "2025-01-01T00:02:00.000Z",
								live: false,
							},
						],
					},
				],
				nested: [
					{
						groupId: "g-1",
						nestedIndex: 0,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "queued task preview",
						state: "queued",
						updatedAt: "2025-01-01T00:02:00.000Z",
						live: false,
					},
					{
						groupId: "g-1",
						nestedIndex: 1,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "running task",
						state: "running",
						activity: "→ bash npm test",
						startedAt: "2025-01-01T00:02:00.000Z",
						updatedAt: "2025-01-01T00:02:30.000Z",
						live: true,
					},
					{
						groupId: "g-1",
						nestedIndex: 2,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "succeeded task",
						state: "succeeded",
						activity: "all tests passed",
						startedAt: "2025-01-01T00:01:00.000Z",
						endedAt: "2025-01-01T00:01:45.000Z",
						updatedAt: "2025-01-01T00:01:45.000Z",
						live: false,
					},
					{
						groupId: "g-1",
						nestedIndex: 3,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "failed task",
						state: "failed",
						activity: "assertion failed on line 12",
						startedAt: "2025-01-01T00:01:00.000Z",
						endedAt: "2025-01-01T00:01:30.000Z",
						updatedAt: "2025-01-01T00:01:30.000Z",
						live: false,
					},
					{
						groupId: "g-1",
						nestedIndex: 4,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "cancelled task",
						state: "cancelled",
						startedAt: "2025-01-01T00:01:00.000Z",
						updatedAt: "2025-01-01T00:01:15.000Z",
						endedAt: "2025-01-01T00:01:15.000Z",
						live: false,
					},
					{
						groupId: "g-1",
						nestedIndex: 5,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "skipped task preview",
						state: "skipped",
						updatedAt: "2025-01-01T00:01:30.000Z",
						endedAt: "2025-01-01T00:01:30.000Z",
						live: false,
					},
				],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:03:00.000Z"),
	});

	assert.ok(lines.some((l) => l.includes("○ worker general-purpose queued 1m00s queued task preview")));
	assert.ok(lines.some((l) => l.includes("◐ worker general-purpose 1m00s — → bash npm test")));
	assert.ok(lines.some((l) => l.includes("✓ worker general-purpose (0m45s) — all tests passed")));
	assert.ok(lines.some((l) => l.includes("✗ worker general-purpose (0m30s) failed — assertion failed on line 12")));
	assert.ok(lines.some((l) => l.includes("⊘ worker general-purpose (0m15s) cancelled")));
	assert.ok(lines.some((l) => l.includes("⊘ worker general-purpose skipped skipped task")));
});

test("recoverNestedModelFromParentResult extracts model when unambiguous and rejects conflicting candidates", () => {
	const parentResultFromDetails = {
		result: {
			details: {
				results: [
					{ agent: "general-purpose", model: "anthropic/claude-3-5-sonnet" },
					{ agent: "general-purpose", model: "google/gemini-2.5-pro" },
				],
			},
		},
	};
	assert.equal(recoverNestedModelFromParentResult(parentResultFromDetails, 0, "general-purpose"), "anthropic/claude-3-5-sonnet");
	assert.equal(recoverNestedModelFromParentResult(parentResultFromDetails, 1, "general-purpose"), "google/gemini-2.5-pro");
	assert.equal(recoverNestedModelFromParentResult(parentResultFromDetails, 0, "mismatched-agent"), undefined);

	const parentResultFromMessages = {
		result: {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolResult",
							details: {
								results: [
									{ agent: "general-purpose", model: "openai/gpt-4o" },
								],
							},
						},
					],
				},
			],
		},
	};
	assert.equal(recoverNestedModelFromParentResult(parentResultFromMessages, 0, "general-purpose"), "openai/gpt-4o");

	const conflictingHistoricalResults = {
		result: {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolResult",
							details: {
								results: [
									{ agent: "general-purpose", model: "openai/gpt-4o" },
								],
							},
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolResult",
							details: {
								results: [
									{ agent: "general-purpose", model: "anthropic/claude-3-5-sonnet" },
								],
							},
						},
					],
				},
			],
		},
	};
	assert.equal(recoverNestedModelFromParentResult(conflictingHistoricalResults, 0, "general-purpose"), undefined);

	const agreeingHistoricalResults = {
		result: {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolResult",
							details: {
								results: [
									{ agent: "general-purpose", model: "openai/gpt-4o" },
								],
							},
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolResult",
							details: {
								results: [
									{ agent: "general-purpose", model: "openai/gpt-4o" },
								],
							},
						},
					],
				},
			],
		},
	};
	assert.equal(recoverNestedModelFromParentResult(agreeingHistoricalResults, 0, "general-purpose"), "openai/gpt-4o");
	assert.equal(recoverNestedModelFromParentResult({}, 0), undefined);
});

test("buildTreeSnapshot recovers nested model from parent result.json when historical spawn record omits model", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-recover-model");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(artifactDir, { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifestData = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-recover-model",
		sessionId: "sess-test",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner task",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature", phase: "implement" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifestData), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({ queued: 0, running: 0, complete: 1, total: 1 }), "utf8");

	const childDir = join(artifactDir, "children", "0");
	const spawnsDir = join(childDir, "spawns");
	await mkdir(spawnsDir, { recursive: true });

	const legacySpawn = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-recover-model",
		parentIndex: 0,
		groupId: "grp-hist",
		mode: "single",
		createdAt: "2025-01-01T00:00:10.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "worker job",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	await writeFile(join(spawnsDir, "grp-hist.json"), JSON.stringify(legacySpawn), "utf8");

	const parentResult = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-recover-model",
		index: 0,
		state: "succeeded",
		result: {
			agent: "poteto-agent",
			details: {
				mode: "single",
				results: [
					{
						agent: "general-purpose",
						model: "anthropic/claude-3-5-haiku",
						exitCode: 0,
					},
				],
			},
		},
	};
	await writeFile(join(childDir, "result.json"), JSON.stringify(parentResult), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-recover",
		workflowId: "wf-recover-model",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:02:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child = snapshot.children[0];
	assert.ok(child !== undefined);
	assert.equal(child.nested.length, 1);
	const nested = child.nested[0];
	assert.ok(nested !== undefined && !isLeaseSnapshot(nested));
	assert.equal(nested.model, "anthropic/claude-3-5-haiku");
});

test("formatCost distinguishes known zero cost from unavailable cost", () => {
	assert.equal(formatCost(0.084), "$0.0840");
	assert.equal(formatCost(1.25), "$1.2500");
	assert.equal(formatCost(0.0001), "$0.0001");
	assert.equal(formatCost(0), "$0.0000");
	assert.equal(formatCost(-0.5), undefined);
	assert.equal(formatCost(undefined), undefined);
	assert.equal(formatCost(Number.NaN), undefined);
});

test("buildTreeSnapshot calculates direct cost subtracting terminal nested children and preserving running nested costs", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-cost-calc");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(join(artifactDir, "children", "0", "spawns"), { recursive: true });
	await mkdir(join(artifactDir, "children", "1", "spawns"), { recursive: true });
	await mkdir(join(artifactDir, "children", "2", "spawns"), { recursive: true });
	await mkdir(join(artifactDir, "children", "3"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-cost-calc",
		sessionId: "sess-cost",
		mode: "parallel",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{ agent: "poteto-agent", task: "terminal parent" },
			{ agent: "poteto-agent", task: "live parent" },
			{ agent: "poteto-agent", task: "zero-cost clamp parent" },
			{ agent: "general-purpose", task: "legacy no-cost child" },
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const child0Spawns = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-cost-calc",
		parentIndex: 0,
		groupId: "grp-0",
		mode: "parallel",
		phase: "implement",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "worker 1",
				state: "succeeded",
				updatedAt: "2025-01-01T00:02:00.000Z",
				startedAt: "2025-01-01T00:01:00.000Z",
				endedAt: "2025-01-01T00:02:00.000Z",
				usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 700, turns: 2 },
			},
			{
				nestedIndex: 1,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "worker 2",
				state: "failed",
				updatedAt: "2025-01-01T00:02:00.000Z",
				startedAt: "2025-01-01T00:01:00.000Z",
				endedAt: "2025-01-01T00:02:00.000Z",
				usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.03, contextTokens: 400, turns: 1 },
			},
		],
	};
	await writeFile(join(artifactDir, "children", "0", "spawns", "grp-0.json"), JSON.stringify(child0Spawns), "utf8");
	await writeFile(join(artifactDir, "children", "0", "result.json"), JSON.stringify({
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-cost-calc",
		index: 0,
		state: "succeeded",
		result: {
			agent: "poteto-agent",
			text: "done",
			usage: { input: 1200, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.12, contextTokens: 1700, turns: 5 },
		},
	}), "utf8");

	const child1Spawns = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-cost-calc",
		parentIndex: 1,
		groupId: "grp-1",
		mode: "parallel",
		phase: "implement",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "running nested worker",
				state: "running",
				updatedAt: "2025-01-01T00:01:30.000Z",
				startedAt: "2025-01-01T00:01:00.000Z",
				usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 300, turns: 1 },
			},
			{
				nestedIndex: 1,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "completed nested worker",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:20.000Z",
				startedAt: "2025-01-01T00:01:00.000Z",
				endedAt: "2025-01-01T00:01:20.000Z",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 150, turns: 1 },
			},
		],
	};
	await writeFile(join(artifactDir, "children", "1", "spawns", "grp-1.json"), JSON.stringify(child1Spawns), "utf8");
	await writeFile(join(artifactDir, "children", "1", "activity.json"), JSON.stringify({
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-cost-calc",
		index: 1,
		activity: "waiting on nested worker",
		updatedAt: "2025-01-01T00:01:45.000Z",
		turns: 3,
		contextTokens: 1000,
		cost: 0.06,
	}), "utf8");

	const child2Spawns = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-cost-calc",
		parentIndex: 2,
		groupId: "grp-2",
		mode: "single",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				taskPreview: "worker",
				state: "succeeded",
				updatedAt: "2025-01-01T00:02:00.000Z",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150, turns: 1 },
			},
		],
	};
	await writeFile(join(artifactDir, "children", "2", "spawns", "grp-2.json"), JSON.stringify(child2Spawns), "utf8");
	await writeFile(join(artifactDir, "children", "2", "result.json"), JSON.stringify({
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-cost-calc",
		index: 2,
		state: "succeeded",
		result: {
			agent: "poteto-agent",
			text: "done",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 150, turns: 1 },
		},
	}), "utf8");

	await writeFile(join(artifactDir, "children", "3", "result.json"), JSON.stringify({
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-cost-calc",
		index: 3,
		state: "succeeded",
		result: {
			agent: "general-purpose",
			text: "legacy done",
		},
	}), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-cost-calc",
		workflowId: "wf-cost-calc",
		artifactDir,
		schedulerRoot,
		activeLeases: [
			{
				workflowId: "wf-cost-calc",
				childId: "1",
				depth: 1,
				acquiredAt: "2025-01-01T00:00:00.000Z",
			},
			{
				workflowId: "wf-cost-calc",
				childId: "grp-1-0",
				depth: 2,
				acquiredAt: "2025-01-01T00:01:00.000Z",
			},
		],
		now: new Date("2025-01-01T00:02:00.000Z"),
	});

	assert.ok(snapshot !== undefined);

	const child0 = snapshot.children[0];
	assert.ok(child0 !== undefined);
	assert.equal(child0.cost, 0.04);
	assert.equal(child0.nested.length, 2);
	const c0n0 = child0.nested[0];
	assert.ok(c0n0 !== undefined && !isLeaseSnapshot(c0n0));
	assert.equal(c0n0.usage?.cost, 0.05);
	const c0n1 = child0.nested[1];
	assert.ok(c0n1 !== undefined && !isLeaseSnapshot(c0n1));
	assert.equal(c0n1.usage?.cost, 0.03);

	const child1 = snapshot.children[1];
	assert.ok(child1 !== undefined);
	assert.equal(child1.state, "running");
	assert.equal(child1.cost, 0.06);
	const c1n0 = child1.nested[0];
	assert.ok(c1n0 !== undefined && !isLeaseSnapshot(c1n0));
	assert.equal(c1n0.state, "running");
	assert.equal(c1n0.usage?.cost, 0.02);
	const c1n1 = child1.nested[1];
	assert.ok(c1n1 !== undefined && !isLeaseSnapshot(c1n1));
	assert.equal(c1n1.state, "succeeded");
	assert.equal(c1n1.usage?.cost, 0.01);

	assert.equal(snapshot.children[2]?.cost, undefined);
	assert.equal(snapshot.children[3]?.cost, undefined);
});

test("renderTreeLines formats known costs and omits unavailable costs", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-render-cost",
		workflowId: "wf-render-cost",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		capturedAt: "2025-01-01T00:03:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				assignment: "owner",
				taskPreview: "orchestrator",
				startedAt: "2025-01-01T00:00:00.000Z",
				cost: 0.084,
				nestedGroups: [],
				nested: [
					{
						groupId: "g-1",
						nestedIndex: 0,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "worker with cost",
						state: "succeeded",
						activity: "completed work",
						startedAt: "2025-01-01T00:01:00.000Z",
						endedAt: "2025-01-01T00:01:45.000Z",
						updatedAt: "2025-01-01T00:01:45.000Z",
						live: false,
						usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.042, contextTokens: 700, turns: 2 },
					},
					{
						groupId: "g-1",
						nestedIndex: 1,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "worker with zero cost",
						state: "succeeded",
						activity: "free work",
						startedAt: "2025-01-01T00:02:00.000Z",
						endedAt: "2025-01-01T00:02:30.000Z",
						updatedAt: "2025-01-01T00:02:30.000Z",
						live: false,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					},
					{
						groupId: "g-1",
						nestedIndex: 2,
						agent: "general-purpose",
						assignment: "worker",
						taskPreview: "worker without usage",
						state: "succeeded",
						activity: "legacy work",
						startedAt: "2025-01-01T00:02:00.000Z",
						endedAt: "2025-01-01T00:02:30.000Z",
						updatedAt: "2025-01-01T00:02:30.000Z",
						live: false,
					},
					{
						workflowId: "wf-render-cost",
						childId: "g-1-3",
						depth: 2,
						acquiredAt: "2025-01-01T00:02:40.000Z",
					},
				],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:03:00.000Z"),
	});

	assert.ok(lines.some((l) => l.includes("owner poteto-agent 3m00s $0.0840 orchestrator")), `Expected top-level cost in: ${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("worker general-purpose (0m45s) $0.0420 — completed work")), `Expected nested cost in: ${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("worker general-purpose (0m30s) $0.0000 — free work")), `Expected known zero cost in: ${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("worker general-purpose (0m30s) — legacy work")), `Expected unavailable cost omission in: ${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("agent details pending (0m20s)")), `Expected lease row in: ${lines.join("\n")}`);
});

test("buildTreeSnapshot preserves invocation group identity and orders groups chronologically (oldest at top)", async (t) => {
	const artifactDir = await temporaryDirectory(t);
	const schedulerRoot = await temporaryDirectory(t);

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-grouped-ordering",
		sessionId: "sess-order",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner task",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature", phase: "grounding" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const spawnsDir = join(artifactDir, "children", "0", "spawns");
	await mkdir(spawnsDir, { recursive: true });

	const group1 = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-grouped-ordering",
		parentIndex: 0,
		groupId: "grp-1-parallel",
		mode: "parallel",
		phase: "grounding",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{ nestedIndex: 0, agent: "general-purpose", role: "worker", taskPreview: "parallel worker 1", state: "succeeded", updatedAt: "2025-01-01T00:02:00.000Z" },
			{ nestedIndex: 1, agent: "general-purpose", role: "worker", taskPreview: "parallel worker 2", state: "succeeded", updatedAt: "2025-01-01T00:02:30.000Z" },
		],
	};
	const group2 = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-grouped-ordering",
		parentIndex: 0,
		groupId: "grp-2-chain",
		mode: "chain",
		phase: "implementation",
		createdAt: "2025-01-01T00:03:00.000Z",
		children: [
			{ nestedIndex: 0, agent: "general-purpose", role: "worker", taskPreview: "step 1", state: "succeeded", updatedAt: "2025-01-01T00:04:00.000Z" },
			{ nestedIndex: 1, agent: "general-purpose", role: "worker", taskPreview: "step 2", state: "running", updatedAt: "2025-01-01T00:04:30.000Z" },
		],
	};
	const group3 = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-grouped-ordering",
		parentIndex: 0,
		groupId: "grp-3-single",
		mode: "single",
		phase: "review",
		createdAt: "2025-01-01T00:05:00.000Z",
		children: [
			{ nestedIndex: 0, agent: "general-purpose", role: "reviewer", taskPreview: "final review", state: "queued", updatedAt: "2025-01-01T00:05:00.000Z" },
		],
	};

	await writeFile(join(spawnsDir, "grp-3.json"), JSON.stringify(group3), "utf8");
	await writeFile(join(spawnsDir, "grp-1.json"), JSON.stringify(group1), "utf8");
	await writeFile(join(spawnsDir, "grp-2.json"), JSON.stringify(group2), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-grouped",
		workflowId: "wf-grouped-ordering",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:06:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const owner = snapshot.children[0];
	assert.ok(owner !== undefined);
	assert.equal(owner.nestedGroups.length, 3);

	assert.equal(owner.nestedGroups[0]?.groupId, "grp-1-parallel");
	assert.equal(owner.nestedGroups[0]?.mode, "parallel");
	assert.equal(owner.nestedGroups[0]?.children.length, 2);

	assert.equal(owner.nestedGroups[1]?.groupId, "grp-2-chain");
	assert.equal(owner.nestedGroups[1]?.mode, "chain");
	assert.equal(owner.nestedGroups[1]?.children.length, 2);

	assert.equal(owner.nestedGroups[2]?.groupId, "grp-3-single");
	assert.equal(owner.nestedGroups[2]?.mode, "single");
	assert.equal(owner.nestedGroups[2]?.children.length, 1);

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:06:00.000Z"),
	});

	assert.ok(lines[0]?.includes("oldest at top · newest at bottom"));

	const g1Idx = lines.findIndex((l) => l.includes("parallel · 2 agents · phase grounding"));
	assert.ok(g1Idx >= 0, "parallel group header rendered");
	assert.ok(lines[g1Idx]?.includes("├─ parallel · 2 agents"));
	assert.ok(lines[g1Idx + 1]?.includes("│  ├─ ✓ worker general-purpose"));
	assert.ok(lines[g1Idx + 2]?.includes("│  └─ ✓ worker general-purpose"));

	const g2Idx = lines.findIndex((l) => l.includes("sequence · 2 steps · phase implementation"));
	assert.ok(g2Idx > g1Idx, "sequence group appears after parallel group chronologically");
	assert.ok(lines[g2Idx]?.includes("├─ sequence · 2 steps"));
	assert.ok(lines[g2Idx + 1]?.includes("│  ├─ ✓ worker general-purpose"));
	assert.ok(lines[g2Idx + 2]?.includes("│  └─ ◐ worker general-purpose"));

	const g3Idx = lines.findIndex((l) => l.includes("single · phase review"));
	assert.ok(g3Idx > g2Idx, "single group appears last chronologically");
	assert.ok(lines[g3Idx]?.includes("└─ single · phase review"));
	assert.ok(lines[g3Idx + 1]?.includes("      └─ ○ reviewer general-purpose"));
});

test("renderTreeLines prefers errorMessage then stderr over activity/taskPreview on failed nested rows", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-failed-diag",
		workflowId: "wf-failed-diag",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		capturedAt: "2025-01-01T00:05:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				assignment: "owner",
				taskPreview: "orchestrate feature",
				nestedGroups: [
					{
						groupId: "grp-failures",
						mode: "parallel",
						createdAt: "2025-01-01T00:01:00.000Z",
						children: [
							{
								groupId: "grp-failures",
								nestedIndex: 0,
								agent: "missing-agent",
								state: "failed",
								taskPreview: "task preview should be ignored",
								activity: "activity should be ignored",
								errorMessage: "Unknown agent \"missing-agent\". Must be poteto-agent, general-purpose, or comment-sicko.",
								updatedAt: "2025-01-01T00:02:00.000Z",
								live: false,
							},
							{
								groupId: "grp-failures",
								nestedIndex: 1,
								agent: "general-purpose",
								state: "failed",
								taskPreview: "task preview should be ignored",
								stderr: "SyntaxError: Unexpected identifier in worker script",
								updatedAt: "2025-01-01T00:02:00.000Z",
								live: false,
							},
							{
								groupId: "grp-failures",
								nestedIndex: 2,
								agent: "general-purpose",
								state: "failed",
								taskPreview: "fallback task preview",
								activity: "fallback activity text",
								updatedAt: "2025-01-01T00:02:00.000Z",
								live: false,
							},
						],
					},
				],
				nested: [],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 140,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});

	assert.ok(lines.some((l) => l.includes("Unknown agent \"missing-agent\"")), "renders errorMessage on unknown agent failure");
	assert.ok(!lines.some((l) => l.includes("task preview should be ignored")), "does not show taskPreview when errorMessage exists");

	assert.ok(lines.some((l) => l.includes("SyntaxError: Unexpected identifier in worker script")), "renders stderr when errorMessage is absent");

	assert.ok(lines.some((l) => l.includes("fallback activity text")), "renders activity when errorMessage and stderr are absent");
});

test("buildTreeSnapshot derives stale state for running parent and nested children without activity records", async (t) => {
	const artifactDir = await temporaryDirectory(t);
	const schedulerRoot = await temporaryDirectory(t);

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-stale-no-act",
		sessionId: "sess-stale",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner running task",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature", phase: "implement" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const progress = {
		schemaVersion: "dstack.workflow-progress.v2",
		workflowId: "wf-stale-no-act",
		queued: 0,
		running: 1,
		complete: 0,
		total: 1,
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				startedAt: "2025-01-01T00:00:05.000Z",
			},
		],
	};
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify(progress), "utf8");

	const spawnsDir = join(artifactDir, "children", "0", "spawns");
	await mkdir(spawnsDir, { recursive: true });

	const spawnRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-stale-no-act",
		parentIndex: 0,
		groupId: "grp-stale-child",
		mode: "single",
		createdAt: "2025-01-01T00:00:10.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "worker",
				assignment: "worker",
				taskPreview: "nested worker running without activity updates",
				state: "running",
				startedAt: "2025-01-01T00:00:15.000Z",
				updatedAt: "2025-01-01T00:00:15.000Z",
			},
		],
	};
	await writeFile(join(spawnsDir, "grp-stale.json"), JSON.stringify(spawnRecord), "utf8");

	const nowMs = Date.parse("2025-01-01T00:10:00.000Z");
	const snapshot = await buildTreeSnapshot({
		taskId: "task-stale-test",
		workflowId: "wf-stale-no-act",
		artifactDir,
		schedulerRoot,
		now: new Date(nowMs),
	});

	assert.ok(snapshot !== undefined);
	const parent = snapshot.children[0];
	assert.ok(parent !== undefined);
	assert.equal(parent.state, "running");
	assert.equal(parent.stale, true);

	const nestedGroup = parent.nestedGroups[0];
	assert.ok(nestedGroup !== undefined);
	const nested = nestedGroup.children[0];
	assert.ok(nested !== undefined && !isLeaseSnapshot(nested));
	assert.equal(nested.state, "running");
	assert.equal(nested.stale, true);

	const lines = renderTreeLines(snapshot, {
		width: 120,
		maxLines: Infinity,
		now: new Date(nowMs),
	});
	assert.ok(lines.some((l) => l.includes("owner poteto-agent") && l.includes("stale 9m55s")));
	assert.ok(lines.some((l) => l.includes("worker general-purpose") && l.includes("stale 9m45s")));
});

test("buildTreeSnapshot groups unmatched depth-2 leases by parsed groupId into mode unknown with agent details pending", async (t) => {
	const artifactDir = await temporaryDirectory(t);
	const schedulerRoot = await temporaryDirectory(t);

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-unmatched-leases",
		sessionId: "sess-unmatched",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [
			{
				agent: "poteto-agent",
				task: "owner with multiple unmatched runs",
				requestedRole: "feature",
				workflow: { assignment: "owner", playbook: "feature" },
			},
		],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const leases: LeaseSnapshot[] = [
		{
			workflowId: "wf-unmatched-leases",
			childId: "grpA-0",
			depth: 2,
			acquiredAt: "2025-01-01T00:01:00.000Z",
		},
		{
			workflowId: "wf-unmatched-leases",
			childId: "grpB-0",
			depth: 2,
			acquiredAt: "2025-01-01T00:02:00.000Z",
		},
	];

	const snapshot = await buildTreeSnapshot({
		taskId: "task-unmatched",
		workflowId: "wf-unmatched-leases",
		artifactDir,
		schedulerRoot,
		activeLeases: leases,
		now: new Date("2025-01-01T00:03:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const owner = snapshot.children[0];
	assert.ok(owner !== undefined);
	assert.equal(owner.nestedGroups.length, 2);

	assert.equal(owner.nestedGroups[0]?.groupId, "grpA");
	assert.equal(owner.nestedGroups[0]?.mode, "unknown");
	assert.equal(owner.nestedGroups[0]?.children.length, 1);
	const childA = owner.nestedGroups[0]?.children[0];
	assert.ok(childA !== undefined && !isLeaseSnapshot(childA));
	assert.equal(childA.agent, "agent details pending");

	assert.equal(owner.nestedGroups[1]?.groupId, "grpB");
	assert.equal(owner.nestedGroups[1]?.mode, "unknown");
	assert.equal(owner.nestedGroups[1]?.children.length, 1);
	const childB = owner.nestedGroups[1]?.children[0];
	assert.ok(childB !== undefined && !isLeaseSnapshot(childB));
	assert.equal(childB.agent, "agent details pending");

	const lines = renderTreeLines(snapshot, {
		width: 120,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:03:00.000Z"),
	});

	const modeUnavailLines = lines.filter((l) => l.includes("run · 1 agent · mode unavailable"));
	assert.equal(modeUnavailLines.length, 2);
	const agentPendingLines = lines.filter((l) => l.includes("◐ agent details pending"));
	assert.equal(agentPendingLines.length, 2);
});

test("buildTreeSnapshot prefers fresh semantic status over low-level activity and renders it cleanly", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-status-pref");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(artifactDir, "children", "0"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-status-pref",
		sessionId: "sess-pref",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "poteto-agent", task: "implement feature", requestedRole: "feature", workflow: { assignment: "owner" } }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({
		queued: 0,
		running: 1,
		complete: 0,
		total: 1,
		children: [{ index: 0, agent: "poteto-agent", state: "running", startedAt: "2025-01-01T00:00:05.000Z" }],
	}), "utf8");

	const statusData = {
		phase: "integrate",
		note: "resolving merge conflicts",
		blocking: true,
		updatedAt: "2025-01-01T00:02:00.000Z",
	};
	await writeFile(join(artifactDir, "children", "0", "status.json"), JSON.stringify(statusData), "utf8");

	const activityData = {
		schemaVersion: "dstack.child-activity.v1",
		workflowId: "wf-status-pref",
		index: 0,
		activity: "→ read file.ts",
		updatedAt: "2025-01-01T00:01:30.000Z",
		turns: 3,
		contextTokens: 1500,
	};
	await writeFile(join(artifactDir, "children", "0", "activity.json"), JSON.stringify(activityData), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-status-pref",
		workflowId: "wf-status-pref",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:02:10.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child = snapshot.children[0];
	assert.ok(child !== undefined);
	assert.equal(child.phase, "integrate");
	assert.equal(child.status?.phase, "integrate");
	assert.equal(child.status?.note, "resolving merge conflicts");
	assert.equal(child.status?.blocking, true);
	assert.equal(child.activity?.text, "integrate: resolving merge conflicts: [blocking]");
	assert.equal(child.stale, undefined);

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:02:10.000Z"),
	});
	assert.ok(lines.some((l) => l.includes("owner poteto-agent · phase integrate") && l.includes("integrate: resolving merge conflicts: [blocking]")));
});

test("buildTreeSnapshot derives stale indicator when status and journal are older than threshold", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-stale-status");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(artifactDir, "children", "0"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-stale-status",
		sessionId: "sess-stale",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "general-purpose", task: "run long job", workflow: { assignment: "worker" } }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({
		queued: 0,
		running: 1,
		complete: 0,
		total: 1,
		children: [{ index: 0, agent: "general-purpose", state: "running", startedAt: "2025-01-01T00:00:00.000Z" }],
	}), "utf8");

	const statusData = {
		phase: "building",
		note: "compiling heavy binary",
		updatedAt: "2025-01-01T00:01:00.000Z",
	};
	await writeFile(join(artifactDir, "children", "0", "status.json"), JSON.stringify(statusData), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-stale-status",
		workflowId: "wf-stale-status",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child = snapshot.children[0];
	assert.ok(child !== undefined);
	assert.equal(child.stale, true);

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});
	assert.ok(lines.some((l) => l.includes("stale 4m00s") && l.includes("building: compiling heavy binary")));

	await writeFile(join(artifactDir, "children", "0", "journal.json"), JSON.stringify({
		schemaVersion: "dstack.journal.v1",
		seq: 1,
		entries: [{
			seq: 1,
			timestamp: "2025-01-01T00:04:50.000Z",
			kind: "tool",
			name: "bash",
			gist: "npm test",
		}],
		updatedAt: "2025-01-01T00:04:50.000Z",
	}), "utf8");

	const refreshed = await buildTreeSnapshot({
		taskId: "task-stale-status",
		workflowId: "wf-stale-status",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:05:00.000Z"),
	});
	assert.ok(refreshed !== undefined);
	assert.equal(refreshed.children[0]?.phase, undefined);
	assert.equal(refreshed.children[0]?.activity?.text, "→ bash npm test");
	assert.equal(refreshed.children[0]?.stale, undefined);
});

test("buildTreeSnapshot bounds journal history count and parses recent entries", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-history-bound");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(artifactDir, "children", "0"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-history-bound",
		sessionId: "sess-hist",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "poteto-agent", task: "long task", workflow: { assignment: "owner" } }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({
		queued: 0,
		running: 1,
		complete: 0,
		total: 1,
		children: [{ index: 0, agent: "poteto-agent", state: "running", startedAt: "2025-01-01T00:00:00.000Z" }],
	}), "utf8");

	const entries: Array<Record<string, unknown>> = [
		{ seq: 1, timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn", agent: "poteto-agent", task: "long task", cwd },
	];
	for (let i = 2; i <= 50; i++) {
		entries.push({
			seq: i,
			timestamp: new Date(Date.parse("2025-01-01T00:00:00.000Z") + i * 1000).toISOString(),
			kind: "tool",
			name: "read",
			gist: `file-${i}.ts`,
		});
	}
	const journalSnapshot = {
		schemaVersion: "dstack.journal.v1",
		seq: 50,
		entries,
		updatedAt: "2025-01-01T00:00:50.000Z",
	};
	await writeFile(join(artifactDir, "children", "0", "journal.json"), JSON.stringify(journalSnapshot), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-hist-bound",
		workflowId: "wf-history-bound",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:01:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child = snapshot.children[0];
	assert.ok(child !== undefined);
	assert.ok(child.journal !== undefined);
	assert.ok(child.journal.length <= 20);
	assert.equal(child.journal[0]?.kind, "spawn");
	assert.equal(child.journal.at(-1)?.kind, "tool");
});

test("buildTreeSnapshot propagates nested semantic status and recent history for depth-2 workers", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-nested-status");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(artifactDir, "children", "0", "spawns"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-nested-status",
		sessionId: "sess-nest",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "poteto-agent", task: "orchestrator", workflow: { assignment: "owner", playbook: "feature", phase: "implement" } }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({
		queued: 0,
		running: 1,
		complete: 0,
		total: 1,
		children: [{ index: 0, agent: "poteto-agent", state: "running", startedAt: "2025-01-01T00:00:00.000Z" }],
	}), "utf8");

	const spawnRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-nested-status",
		parentIndex: 0,
		groupId: "grp-nest-1",
		mode: "parallel",
		phase: "implement",
		createdAt: "2025-01-01T00:00:30.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "worker unit tests",
				state: "running",
				status: {
					phase: "unit-tests",
					note: "running suite 2 of 4",
					blocking: false,
					updatedAt: "2025-01-01T00:01:00.000Z",
				},
				journal: [
					{ seq: 1, timestamp: "2025-01-01T00:00:30.000Z", kind: "spawn", agent: "general-purpose", task: "worker unit tests", cwd },
					{ seq: 2, timestamp: "2025-01-01T00:01:00.000Z", kind: "tool", name: "bash", gist: "npm test" },
				],
				updatedAt: "2025-01-01T00:01:00.000Z",
				startedAt: "2025-01-01T00:00:30.000Z",
			},
		],
	};
	await writeFile(join(artifactDir, "children", "0", "spawns", "grp-nest-1.json"), JSON.stringify(spawnRecord), "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-nested-status",
		workflowId: "wf-nested-status",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:01:10.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child = snapshot.children[0];
	assert.ok(child !== undefined);
	assert.equal(child.nested.length, 1);
	const nested = child.nested[0];
	assert.ok(nested !== undefined && !isLeaseSnapshot(nested));
	assert.equal(nested.status?.phase, "unit-tests");
	assert.equal(nested.status?.note, "running suite 2 of 4");
	assert.equal(nested.activity, "unit-tests: running suite 2 of 4");
	assert.equal(nested.journal?.length, 2);

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:01:10.000Z"),
	});
	assert.ok(lines.some((l) => l.includes("worker general-purpose") && l.includes("unit-tests: running suite 2 of 4")));
});

test("buildTreeSnapshot and boundary parsers handle malformed status and journal safely", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-malformed");
	const schedulerRoot = join(cwd, "scheduler");
	await mkdir(join(artifactDir, "children", "0"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-malformed",
		sessionId: "sess-mal",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "poteto-agent", task: "task with corrupt files" }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await writeFile(join(artifactDir, "progress.json"), JSON.stringify({
		queued: 0,
		running: 1,
		complete: 0,
		total: 1,
		children: [{ index: 0, agent: "poteto-agent", state: "running" }],
	}), "utf8");

	await writeFile(join(artifactDir, "children", "0", "status.json"), "invalid json data {", "utf8");
	await writeFile(join(artifactDir, "children", "0", "journal.json"), "{ invalid journal", "utf8");

	const snapshot = await buildTreeSnapshot({
		taskId: "task-malformed",
		workflowId: "wf-malformed",
		artifactDir,
		schedulerRoot,
		now: new Date("2025-01-01T00:01:00.000Z"),
	});

	assert.ok(snapshot !== undefined);
	const child = snapshot.children[0];
	assert.ok(child !== undefined);
	assert.equal(child.status, undefined);
	assert.equal(child.journal, undefined);
	assert.equal(child.state, "running");

	const parsed = parseTreeSnapshot({
		taskId: "task-bad",
		workflowId: "wf-bad",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		capturedAt: "2025-01-01T00:01:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "general-purpose",
				state: "running",
				status: "not an object",
				journal: "not an array",
				nestedGroups: [],
				nested: [],
			},
		],
	});
	assert.ok(parsed !== undefined);
	assert.equal(parsed.children[0]?.status, undefined);
	assert.equal(parsed.children[0]?.journal, undefined);

	assert.equal(parseSemanticStatus({ phase: "integrate" }), undefined);
	assert.equal(parseSemanticStatus({ phase: "integrate", updatedAt: "invalid-date" }), undefined);
	assert.equal(parseSemanticStatus({ phase: "integrate", updatedAt: 12345 }), undefined);
	assert.deepEqual(parseSemanticStatus({ phase: "integrate", updatedAt: "2025-01-01T00:00:00.000Z" }), {
		phase: "integrate",
		updatedAt: "2025-01-01T00:00:00.000Z",
	});

	const validJournalItem = { seq: 1, timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn", agent: "poteto-agent", task: "task", cwd: "/tmp" };
	const invalidItems = [
		{ seq: "1", timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn" },
		{ seq: -1, timestamp: "2025-01-01T00:00:01.000Z", kind: "spawn" },
		{ seq: 2, timestamp: "not-a-date", kind: "tool", name: "read", gist: "a.ts" },
		{ seq: 3, timestamp: "2025-01-01T00:00:03.000Z", kind: "turn", turn: -1 },
		{ seq: 4, timestamp: "2025-01-01T00:00:04.000Z", kind: "exit", exitCode: "0" },
		{ seq: 5, timestamp: "2025-01-01T00:00:05.000Z", kind: "failure", error: 123 },
		null,
		"string-entry",
	];
	const filteredJournal = parseJournalEntries([...invalidItems, validJournalItem]);
	assert.deepEqual(filteredJournal, [validJournalItem]);
	assert.equal(parseJournalEntries("not-an-array"), undefined);
	assert.deepEqual(parseJournalEntries([]), []);

	assert.equal(parseJournalSnapshot({ schemaVersion: "dstack.journal.v2", seq: 1, entries: [], updatedAt: "2025-01-01T00:00:00.000Z" }), undefined);
	assert.equal(parseJournalSnapshot({ schemaVersion: "dstack.journal.v1", seq: 1, entries: [], updatedAt: "bad-date" }), undefined);
	assert.deepEqual(
		parseJournalSnapshot({ schemaVersion: "dstack.journal.v1", seq: 1, entries: [validJournalItem], updatedAt: "2025-01-01T00:00:00.000Z" }),
		{ schemaVersion: "dstack.journal.v1", seq: 1, entries: [validJournalItem], updatedAt: "2025-01-01T00:00:00.000Z" },
	);
});

test("terminal child rendering remains unchanged with outcome and duration", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-terminal-render",
		workflowId: "wf-term-render",
		mode: "parallel",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 2, total: 2 },
		slots: { active: 0, capacity: 4 },
		capturedAt: "2025-01-01T00:04:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				assignment: "owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:03:00.000Z",
				taskPreview: "orchestrate feature",
				outcome: "All changes integrated and verified",
				nestedGroups: [],
				nested: [],
			},
			{
				index: 1,
				agent: "general-purpose",
				state: "failed",
				assignment: "worker",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:01:30.000Z",
				taskPreview: "run tests",
				outcome: "AssertionError: 3 !== 4",
				nestedGroups: [],
				nested: [],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 100,
		maxLines: Infinity,
		now: new Date("2025-01-01T00:04:00.000Z"),
	});

	assert.equal(lines[0], "dstack · feature · 2/2 done · 4m00s · oldest at top · newest at bottom");
	assert.ok(lines.some((l) => l.includes("✓ owner poteto-agent (3m00s) — All changes integrated and verified")));
	assert.ok(lines.some((l) => l.includes("✗ worker general-purpose (1m30s) failed — AssertionError: 3 !== 4")));
});

test("renderTreeLines expanded view exposes compact recent activity history for running top-level and nested agents", () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-exp-journal",
		workflowId: "wf-exp-journal",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 1, total: 2 },
		slots: { active: 2, capacity: 4 },
		capturedAt: "2025-01-01T00:03:00.000Z",
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				assignment: "owner",
				phase: "implement",
				startedAt: "2025-01-01T00:00:00.000Z",
				taskPreview: "orchestrate feature implementation",
				taskFull: "orchestrate feature implementation in full details",
				activity: {
					text: "implement: editing tree renderer",
					updatedAt: "2025-01-01T00:02:30.000Z",
				},
				journal: [
					{ seq: 1, timestamp: "2025-01-01T00:00:00.000Z", kind: "spawn", agent: "poteto-agent", task: "orchestrate feature", cwd: "/tmp" },
					{ seq: 2, timestamp: "2025-01-01T00:01:00.000Z", kind: "tool", name: "read", gist: "src/tree.ts" },
					{ seq: 3, timestamp: "2025-01-01T00:01:45.000Z", kind: "tool", name: "edit", gist: "src/tree.ts" },
					{ seq: 4, timestamp: "2025-01-01T00:02:30.000Z", kind: "phase", phase: "implement", note: "editing tree renderer" },
				],
				nestedGroups: [
					{
						groupId: "grp-1",
						mode: "single",
						createdAt: "2025-01-01T00:01:00.000Z",
						children: [
							{
								groupId: "grp-1",
								nestedIndex: 0,
								agent: "general-purpose",
								role: "implementation-worker",
								assignment: "worker",
								taskPreview: "run test suite",
								state: "running",
								startedAt: "2025-01-01T00:01:00.000Z",
								updatedAt: "2025-01-01T00:02:30.000Z",
								live: true,
								journal: [
									{ seq: 1, timestamp: "2025-01-01T00:01:00.000Z", kind: "spawn", agent: "general-purpose", task: "run tests", cwd: "/tmp" },
									{ seq: 2, timestamp: "2025-01-01T00:01:30.000Z", kind: "tool", name: "bash", gist: "npm test" },
									{ seq: 3, timestamp: "2025-01-01T00:02:30.000Z", kind: "turn", turn: 1, summary: "tests running suite 1" },
								],
							},
						],
					},
				],
				nested: [],
			},
			{
				index: 1,
				agent: "general-purpose",
				state: "succeeded",
				assignment: "worker",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:01:00.000Z",
				taskPreview: "ground codebase",
				taskFull: "ground codebase full task description",
				outcome: "Codebase mapped cleanly",
				journal: [
					{ seq: 1, timestamp: "2025-01-01T00:00:00.000Z", kind: "spawn", agent: "general-purpose", task: "ground", cwd: "/tmp" },
					{ seq: 2, timestamp: "2025-01-01T00:00:30.000Z", kind: "tool", name: "read", gist: "README.md" },
					{ seq: 3, timestamp: "2025-01-01T00:01:00.000Z", kind: "exit", exitCode: 0 },
				],
				nestedGroups: [],
				nested: [],
			},
		],
	};

	const lines = renderTreeLines(snapshot, {
		width: 100,
		expanded: true,
		now: new Date("2025-01-01T00:03:00.000Z"),
	});

	assert.ok(lines.some((l) => l.includes("◐ owner poteto-agent") && l.includes("implement: editing tree renderer")));
	assert.ok(lines.some((l) => l.includes("◐ worker general-purpose")));

	assert.ok(lines.some((l) => l.includes("task [poteto-agent]: orchestrate feature implementation in full details")));
	assert.ok(lines.some((l) => l.includes("task [general-purpose]: ground codebase full task description")));

	assert.ok(!lines.some((l) => l.includes("• → read src/tree.ts")));
	assert.ok(!lines.some((l) => l.includes("• → edit src/tree.ts")));
	assert.ok(lines.some((l) => l.includes("• implement: editing tree renderer")));

	assert.ok(!lines.some((l) => l.includes("• → bash npm test")));
	assert.ok(!lines.some((l) => l.includes("• turn 1: tests running suite 1")));
	assert.ok(lines.some((l) => l.includes("• tests running suite 1")));

	assert.ok(lines.some((l) => l.includes("✓ worker general-purpose (1m00s) — Codebase mapped cleanly")));
	assert.ok(!lines.some((l) => l.includes("• → read README.md")));

	const narrowLines = renderTreeLines(snapshot, {
		width: 40,
		expanded: true,
		now: new Date("2025-01-01T00:03:00.000Z"),
	});
	for (const line of narrowLines) {
		assert.ok(visibleWidth(line) <= 40, `line exceeds width 40: "${line}"`);
	}
});
