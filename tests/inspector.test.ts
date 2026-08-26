import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	AgentInspector,
	boundedTailRead,
	buildAgentInspection,
	listSessionWorkflows,
	parseChildResultDetails,
	readChildActivityDetails,
	readChildResultDetails,
	renderAmbientWidgetLine,
	wrapText,
	type AmbientStatus,
	type BoundedReadResult,
	type InspectorTheme,
	type WorkflowSummary,
} from "../extensions/background/inspector.ts";
import {
	parseChildUsage,
	parseSpawnRecordV1,
	type SpawnNestedChild,
	type TreeSnapshot,
	type TreeTheme,
} from "../extensions/background/tree.ts";
import type { TodoItem } from "../extensions/types.ts";

function plainTheme(): InspectorTheme & TreeTheme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-inspector-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("boundedTailRead reads bounded bytes from end of file without throwing", async (t) => {
	const dir = await temporaryDirectory(t);
	const file = join(dir, "output.txt");

	const line100 = "Line of output content\n".repeat(100);
	await writeFile(file, line100, "utf8");

	const readFull = await boundedTailRead(file, 100_000);
	assert.equal(readFull.truncated, false);
	assert.equal(readFull.bytesRead, readFull.totalBytes);
	assert.equal(readFull.content, line100);

	const readTail = await boundedTailRead(file, 50);
	assert.equal(readTail.truncated, true);
	assert.equal(readTail.bytesRead, 50);
	assert.ok(readTail.totalBytes > 50);
	assert.equal(readTail.content, line100.slice(line100.length - 50));
});

test("listSessionWorkflows enumerates session workflows, maps bindings, and sorts newest first", async (t) => {
	const home = await temporaryDirectory(t);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		process.env.HOME = previousHome;
	});

	const sessionId = "test-session-123";
	const sRoot = join(home, ".pi", "agent", "dstack", "background", encodeURIComponent(sessionId));
	await mkdir(join(sRoot, "bindings"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-older"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-newer"), { recursive: true });
	await mkdir(join(sRoot, "workflows", "wf-corrupt"), { recursive: true });

	await writeFile(
		join(sRoot, "bindings", "task-older.json"),
		JSON.stringify({ taskId: "task-older", workflowId: "wf-older" }),
		"utf8",
	);
	await writeFile(
		join(sRoot, "bindings", "task-newer.json"),
		JSON.stringify({ taskId: "task-newer", workflowId: "wf-newer" }),
		"utf8",
	);

	const nowMs = Date.now();
	const timeNewer = new Date(nowMs + 100_000).toISOString();
	const timeOlder = new Date(nowMs + 50_000).toISOString();

	await writeFile(
		join(sRoot, "workflows", "wf-older", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-older",
			mode: "single",
			createdAt: timeOlder,
			specs: [{ agent: "poteto-agent", task: "older task", workflow: { assignment: "owner", playbook: "feature" } }],
		}),
		"utf8",
	);
	await writeFile(join(sRoot, "workflows", "wf-older", "COMMITTED"), "", "utf8");

	await writeFile(
		join(sRoot, "workflows", "wf-newer", "manifest.json"),
		JSON.stringify({
			workflowId: "wf-newer",
			mode: "parallel",
			createdAt: timeNewer,
			specs: [{ agent: "poteto-agent", task: "newer task", workflow: { assignment: "owner", playbook: "explore" } }],
		}),
		"utf8",
	);

	await writeFile(join(sRoot, "workflows", "wf-corrupt", "manifest.json"), "invalid json", "utf8");

	const list = await listSessionWorkflows(sessionId);
	assert.equal(list.length, 3);
	assert.equal(list[0]?.workflowId, "wf-newer");
	assert.equal(list[0]?.taskId, "task-newer");
	assert.equal(list[0]?.committed, false);
	assert.equal(list[0]?.playbook, "explore");
	assert.equal(list[0]?.unreadable, false);

	assert.equal(list[1]?.workflowId, "wf-older");
	assert.equal(list[1]?.taskId, "task-older");
	assert.equal(list[1]?.committed, true);
	assert.equal(list[1]?.playbook, "feature");
	assert.equal(list[1]?.unreadable, false);

	assert.equal(list[2]?.workflowId, "wf-corrupt");
	assert.equal(list[2]?.unreadable, true);
});

test("readChildResultDetails and readChildActivityDetails parse usage telemetry", async (t) => {
	const dir = await temporaryDirectory(t);
	const childDir = join(dir, "children", "0");
	await mkdir(childDir, { recursive: true });

	await writeFile(
		join(childDir, "activity.json"),
		JSON.stringify({
			schemaVersion: "dstack.child-activity.v1",
			workflowId: "wf-act",
			index: 0,
			activity: "working on step",
			updatedAt: "2025-01-01T12:00:00.000Z",
			turns: 4,
			contextTokens: 12500,
		}),
		"utf8",
	);

	const act = await readChildActivityDetails(dir, 0, "wf-act");
	assert.ok(act !== undefined);
	assert.equal(act.turns, 4);
	assert.equal(act.contextTokens, 12500);

	await writeFile(
		join(childDir, "result.json"),
		JSON.stringify({
			schemaVersion: "dstack.child-result.v1",
			workflowId: "wf-act",
			index: 0,
			state: "succeeded",
			output: {
				path: "/path/to/output.txt",
				sha256: "abc123sha256hash",
				bytes: 4096,
			},
			result: {
				text: "done output summary",
				exitCode: 0,
				model: "anthropic/claude-3-5-sonnet",
				stopReason: "stop",
				usage: {
					turns: 6,
					contextTokens: 18000,
					input: 2500,
					output: 800,
					cost: 0.045,
					cacheRead: 0,
					cacheWrite: 0,
				},
			},
		}),
		"utf8",
	);

	const res = await readChildResultDetails(dir, 0);
	assert.ok(res !== undefined);
	assert.equal(res.model, "anthropic/claude-3-5-sonnet");
	assert.equal(res.turns, 6);
	assert.equal(res.contextTokens, 18000);
	assert.equal(res.cost, 0.045);
	assert.equal(res.summaryText, "done output summary");
	assert.equal(res.stopReason, "stop");
	assert.equal(res.exitCode, 0);
	assert.equal(res.outputSeal?.bytes, 4096);
	assert.equal(res.outputSeal?.sha256, "abc123sha256hash");
});

test("renderAmbientWidgetLine renders concise one-line indicators for running and finished states", () => {
	const theme = plainTheme();
	const runningSnapshot: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "parallel",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 1, running: 2, complete: 1, total: 4 },
		slots: { active: 2, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", taskPreview: "plan", nested: [] },
			{ index: 1, agent: "general-purpose", state: "running", taskPreview: "code", nested: [] },
			{ index: 2, agent: "general-purpose", state: "queued", taskPreview: "test", nested: [] },
			{ index: 3, agent: "general-purpose", state: "succeeded", taskPreview: "init", nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const runningLines = renderAmbientWidgetLine(runningSnapshot, 100, theme);
	assert.equal(runningLines.length, 1);
	assert.ok(runningLines[0]?.includes("2 running"));
	assert.ok(runningLines[0]?.includes("1 queued"));
	assert.ok(runningLines[0]?.includes("slots 2/4"));
	assert.ok(runningLines[0]?.includes("shift+up to inspect"));

	const finishedSnapshot: TreeSnapshot = {
		...runningSnapshot,
		committed: true,
		counts: { queued: 0, running: 0, complete: 4, total: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "succeeded", taskPreview: "plan", nested: [] },
			{ index: 1, agent: "general-purpose", state: "succeeded", taskPreview: "code", nested: [] },
			{ index: 2, agent: "general-purpose", state: "succeeded", taskPreview: "test", nested: [] },
			{ index: 3, agent: "general-purpose", state: "succeeded", taskPreview: "init", nested: [] },
		],
	};

	const finishedLines = renderAmbientWidgetLine(finishedSnapshot, 100, theme);
	assert.equal(finishedLines.length, 1);
	assert.ok(finishedLines[0]?.includes("feature complete"));
	assert.ok(finishedLines[0]?.includes("shift+up to inspect"));
});

test("renderAmbientWidgetLine reports session-wide active workflow count when multiple workflows are active", () => {
	const theme = plainTheme();
	const snapshot: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "single",
		playbook: "bug-fix",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 3, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", taskPreview: "fix bug", nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const multiWorkflowStatus: AmbientStatus = {
		snapshot,
		activeWorkflowCount: 2,
	};

	const multiLines = renderAmbientWidgetLine(multiWorkflowStatus, 100, theme);
	assert.equal(multiLines.length, 1);
	assert.ok(multiLines[0]?.includes("bug-fix"));
	assert.ok(multiLines[0]?.includes("2 active workflows"));
	assert.ok(multiLines[0]?.includes("slots 3/4"));
	assert.ok(!multiLines[0]?.includes("1 running"));
	assert.ok(multiLines[0]?.includes("shift+up to inspect"));

	const singleWorkflowStatus: AmbientStatus = {
		snapshot,
		activeWorkflowCount: 1,
	};
	const singleLines = renderAmbientWidgetLine(singleWorkflowStatus, 100, theme);
	assert.equal(singleLines.length, 1);
	assert.ok(singleLines[0]?.includes("1 running"));
	assert.ok(!singleLines[0]?.includes("1 active workflows"));
});

test("AgentInspector subtitle uses shared scheduler slot count when multiple active workflows have differing scheduler activity", async () => {
	const tui = { requestRender: () => {} };
	const done = () => {};

	const workflows: WorkflowSummary[] = [
		{
			workflowId: "wf-2",
			taskId: "task-2",
			artifactDir: "/tmp/wf-2",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:01:00.000Z",
			playbook: "bug-fix",
			unreadable: false,
		},
		{
			workflowId: "wf-1",
			taskId: "task-1",
			artifactDir: "/tmp/wf-1",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			unreadable: false,
		},
	];

	const snapshot1: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 3, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", role: "feature", assignment: "owner", taskPreview: "owner 1", nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const snapshot2: TreeSnapshot = {
		taskId: "task-2",
		workflowId: "wf-2",
		mode: "single",
		playbook: "bug-fix",
		createdAt: "2025-01-01T00:01:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 3, capacity: 4 },
		children: [
			{ index: 0, agent: "poteto-agent", state: "running", role: "bug-fix", assignment: "owner", taskPreview: "owner 2", nested: [] },
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const snapshotsById = new Map<string, TreeSnapshot>([
		["wf-1", snapshot1],
		["wf-2", snapshot2],
	]);

	const inspector = new AgentInspector(tui, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => workflows,
		getSnapshot: async (w) => snapshotsById.get(w.workflowId),
		readOutputTail: async () => ({ content: "", truncated: false, bytesRead: 0, totalBytes: 0 }),
		now: () => new Date("2025-01-01T00:02:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const listLines = inspector.render(100);
	assert.ok(listLines.some((l) => l.includes("2 active workflows · slots 3")));
	assert.ok(!listLines.some((l) => l.includes("slots 2")));

	inspector.dispose();
});

test("AgentInspector component navigation: list -> drill-down -> nested drill-down -> pop navigation -> close", async () => {
	let renderRequested = 0;
	const tui = {
		requestRender: () => {
			renderRequested++;
		},
	};
	let closedResult: string | undefined;
	const done = (res: string) => {
		closedResult = res;
	};

	const workflows: WorkflowSummary[] = [
		{
			workflowId: "wf-1",
			taskId: "task-1",
			artifactDir: "/tmp/wf-1",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			unreadable: false,
		},
	];

	const snapshot: TreeSnapshot = {
		taskId: "task-1",
		workflowId: "wf-1",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				phase: "implementation",
				taskPreview: "build inspector",
				taskFull: "build inspector with clean frames",
				startedAt: "2025-01-01T00:00:10.000Z",
				activity: { text: "writing component", updatedAt: "2025-01-01T00:01:00.000Z" },
				nested: [
					{
						groupId: "nested-grp-1",
						nestedIndex: 0,
						agent: "general-purpose",
						role: "worker",
						assignment: "worker",
						taskPreview: "nested worker job",
						state: "running",
						activity: "compiling",
						startedAt: "2025-01-01T00:00:20.000Z",
						updatedAt: "2025-01-01T00:01:00.000Z",
						live: true,
					},
				],
			},
		],
		todos: [
			{ id: "todo-1", content: "ground investigation", status: "completed" },
			{ id: "todo-2", content: "implement component", status: "in_progress" },
		],
		todoCounts: { total: 2, completed: 1, inProgress: 1 },
		capturedAt: "2025-01-01T00:01:30.000Z",
	};

	const readOutputTail = async () => ({
		content: "line 1\nline 2\nline 3\nline 4\n",
		truncated: false,
		bytesRead: 28,
		totalBytes: 28,
	});

	const inspector = new AgentInspector(tui, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => workflows,
		getSnapshot: async () => snapshot,
		readOutputTail,
		now: () => new Date("2025-01-01T00:02:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const listLines = inspector.render(100);
	assert.ok(listLines.length > 5);
	assert.ok(listLines.some((l) => l.includes("dstack agent inspector")));
	assert.ok(listLines.some((l) => l.includes("owner poteto-agent")));
	assert.ok(listLines.some((l) => l.includes("worker general-purpose")));

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\r");
	await new Promise((r) => setTimeout(r, 20));

	const detailLines = inspector.render(100);
	assert.ok(detailLines.some((l) => l.includes("Agent: poteto-agent")));
	assert.ok(detailLines.some((l) => l.includes("Workflow: feature")));
	assert.ok(detailLines.some((l) => l.includes("Phase: implementation")));
	assert.ok(detailLines.some((l) => l.includes("Input Envelope:")));

	inspector.handleInput("\x1b[6~");
	const scrolledDetailLines = inspector.render(100);
	assert.ok(scrolledDetailLines.some((l) => l.includes("Todos:")));
	assert.ok(scrolledDetailLines.some((l) => l.includes("Nested agents")));
	assert.ok(scrolledDetailLines.some((l) => l.includes("Output Envelope:")));

	inspector.handleInput("\r");
	await new Promise((r) => setTimeout(r, 20));

	const nestedDetailLines = inspector.render(100);
	assert.ok(nestedDetailLines.some((l) => l.includes("nested agent: general-purpose") || l.includes("Agent: general-purpose")));
	assert.ok(nestedDetailLines.some((l) => l.includes("Parent: poteto-agent")));

	inspector.handleInput("\x1b[D");
	const backParentLines = inspector.render(100);
	assert.ok(backParentLines.some((l) => l.includes("Agent: poteto-agent")));

	inspector.handleInput("\x1b");
	const backListLines = inspector.render(100);
	assert.ok(backListLines.some((l) => l.includes("dstack agent inspector")));

	inspector.handleInput("\x1b");
	assert.equal(closedResult, "closed");

	inspector.dispose();
});

test("AgentInspector history toggle and empty states", async () => {
	let closed = false;
	const done = () => {
		closed = true;
	};

	const committedWorkflows: WorkflowSummary[] = [
		{
			workflowId: "wf-done",
			taskId: "task-done",
			artifactDir: "/tmp/wf-done",
			schedulerRoot: "/tmp/scheduler",
			committed: true,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			unreadable: false,
		},
	];

	const doneSnapshot: TreeSnapshot = {
		taskId: "task-done",
		workflowId: "wf-done",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				taskPreview: "done task",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:04:00.000Z",
				outcome: "all steps finished",
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:04:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => committedWorkflows,
		getSnapshot: async () => doneSnapshot,
		now: () => new Date("2025-01-01T00:05:00.000Z"),
	});

	await new Promise((r) => setTimeout(r, 20));

	const initial = inspector.render(100);
	assert.ok(initial.some((l) => l.includes("all steps finished")));

	inspector.handleInput("h");
	const hidden = inspector.render(100);
	assert.ok(hidden.some((l) => l.includes("No active dstack workflows")));

	inspector.handleInput("h");
	const visibleAgain = inspector.render(100);
	assert.ok(visibleAgain.some((l) => l.includes("all steps finished")));

	inspector.dispose();
});

test("AgentInspector stale state and explicit raw output tail scrolling behavior", async () => {
	const done = () => {};
	const staleWorkflow: WorkflowSummary[] = [
		{
			workflowId: "wf-stale",
			taskId: "task-stale",
			artifactDir: "/tmp/wf-stale",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			unreadable: false,
		},
	];

	const staleSnapshot: TreeSnapshot = {
		taskId: "task-stale",
		workflowId: "wf-stale",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				taskPreview: "stuck job",
				stale: true,
				startedAt: "2025-01-01T00:00:00.000Z",
				activity: { text: "last saw progress 10m ago", updatedAt: "2025-01-01T00:01:00.000Z" },
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:10:00.000Z",
	};

	let tailReads = 0;
	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), done, {
		sessionId: "test-sess",
		initialTaskId: "task-stale",
		listWorkflows: async () => staleWorkflow,
		getSnapshot: async () => staleSnapshot,
		readOutputTail: async () => {
			tailReads++;
			return {
				content: Array.from({ length: 30 }, (_, i) => `Output log line #${i + 1}`).join("\n"),
				truncated: true,
				bytesRead: 600,
				totalBytes: 2400,
			};
		},
	});

	await new Promise((r) => setTimeout(r, 20));

	const detailLines = inspector.render(100);
	assert.ok(detailLines.some((l) => l.includes("⚠ Stale")));
	assert.ok(detailLines.some((l) => l.includes("Input Envelope:")));

	inspector.handleInput("o");
	const rawLines = inspector.render(100);
	assert.ok(rawLines.some((l) => l.includes("following tail 600 bytes of 2400 bytes")));

	inspector.handleInput("\x1b[A");
	const scrolledLines = inspector.render(100);
	assert.ok(scrolledLines.some((l) => l.includes("lines ") && l.includes("of 30")));

	inspector.handleInput("r");
	await new Promise((r) => setTimeout(r, 20));
	const resumedLines = inspector.render(100);
	assert.ok(resumedLines.some((l) => l.includes("following tail")));

	inspector.dispose();
});

test("AgentInspector task view displays full multiline task with vertical scrolling and no truncation", async () => {
	const multilineTask = [
		"Step 1: Investigate current state of the code.",
		"Step 2: Define structured view model types.",
		"Step 3: Implement detail pane tabs (s, t, f, o).",
		"Step 4: Verify that long lines wrap cleanly and do not get clipped.",
		"Step 5: Add tests for backward compatibility and forward persistence.",
		"Step 6: Ensure depth-2 agents have full parity with depth-1.",
		"Step 7: Perform full typecheck and test suite verification.",
		"Step 8: Final review of changes.",
	].join("\n");

	const snapshot: TreeSnapshot = {
		taskId: "task-multiline",
		workflowId: "wf-multiline",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				taskPreview: "Step 1: Investigate...",
				taskFull: multilineTask,
				startedAt: "2025-01-01T00:00:00.000Z",
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-multiline",
		listWorkflows: async () => [
			{
				workflowId: "wf-multiline",
				taskId: "task-multiline",
				artifactDir: "/tmp/wf-multiline",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	const summaryLines = inspector.render(100);
	assert.ok(summaryLines.some((l) => l.includes("press 't' for full task")));

	inspector.handleInput("t");
	const taskLines = inspector.render(80);
	assert.ok(taskLines.some((l) => l.includes("Full Task Content:")));
	assert.ok(taskLines.some((l) => l.includes("Step 1: Investigate current state")));
	assert.ok(taskLines.some((l) => l.includes("Step 8: Final review of changes")));

	inspector.handleInput("\x1b[B");
	const scrolledTask = inspector.render(80);
	assert.ok(scrolledTask.some((l) => l.includes("Full Task Content:")));

	inspector.handleInput("s");
	const backSummary = inspector.render(80);
	assert.ok(backSummary.some((l) => l.includes("Input Envelope:")));

	inspector.dispose();
});

test("AgentInspector final response view renders free-form text with labeled envelope fields and scrolling", async () => {
	const snapshot: TreeSnapshot = {
		taskId: "task-final",
		workflowId: "wf-final",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				taskPreview: "run task",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:02:00.000Z",
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:02:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-final",
		listWorkflows: async () => [
			{
				workflowId: "wf-final",
				taskId: "task-final",
				artifactDir: "/tmp/wf-final",
				schedulerRoot: "/tmp/scheduler",
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
		getSnapshot: async () => snapshot,
		readChildResult: async () => ({
			state: "succeeded",
			model: "anthropic/claude-3-7-sonnet",
			summaryText: "Execution completed successfully.\nAll 144 unit tests pass.\nNo regressions detected.",
			exitCode: 0,
			stopReason: "tool_use",
			outputSeal: {
				path: "children/0/output.txt",
				sha256: "deadbeef12345678",
				bytes: 2048,
			},
			usage: {
				turns: 5,
				contextTokens: 12000,
				input: 1500,
				output: 600,
				cost: 0.03,
				cacheRead: 0,
				cacheWrite: 0,
			},
		}),
	});

	await new Promise((r) => setTimeout(r, 20));

	inspector.handleInput("f");
	const finalLines = inspector.render(100);
	assert.ok(finalLines.some((l) => l.includes("Envelope:") && l.includes("exitCode 0")));
	assert.ok(finalLines.some((l) => l.includes("Seal:") && l.includes("deadbeef12345678")));
	assert.ok(finalLines.some((l) => l.includes("Final Response (free-form text):")));
	assert.ok(finalLines.some((l) => l.includes("Execution completed successfully.")));
	assert.ok(finalLines.some((l) => l.includes("All 144 unit tests pass.")));

	inspector.dispose();
});

test("AgentInspector depth-2 agent parity in views, labeled fields, and unavailable raw output handling", async () => {
	const nestedChild: SpawnNestedChild = {
		groupId: "grp-nested-parity",
		nestedIndex: 0,
		agent: "general-purpose",
		role: "worker",
		assignment: "worker",
		taskPreview: "subtask 1",
		taskFull: "Detailed depth-2 subtask:\nRun implementation checks.\nVerify output format.",
		state: "succeeded",
		startedAt: "2025-01-01T00:00:10.000Z",
		endedAt: "2025-01-01T00:00:40.000Z",
		updatedAt: "2025-01-01T00:00:40.000Z",
		live: false,
		model: "anthropic/claude-3-5-haiku",
		cwd: "/tmp/worktree-parity",
		tools: "read,edit,write",
		finalResponse: "Depth-2 task finished cleanly without errors.",
		exitCode: 0,
		stopReason: "stop",
		usage: {
			turns: 3,
			contextTokens: 5000,
			input: 800,
			output: 200,
			cost: 0.005,
			cacheRead: 0,
			cacheWrite: 0,
		},
		workflow: {
			playbook: "feature",
			assignment: "worker",
			phase: "implementation",
			completedPhases: ["grounding"],
			artifacts: [{ name: "spec", path: "/tmp/spec.md" }],
		},
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-depth2",
		workflowId: "wf-depth2",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				taskPreview: "parent owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				nested: [nestedChild],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-depth2",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-nested-parity",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-depth2",
				taskId: "task-depth2",
				artifactDir: "/tmp/wf-depth2",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	const depth2Summary = inspector.render(100);
	assert.ok(depth2Summary.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(depth2Summary.some((l) => l.includes("Parent:") && l.includes("poteto-agent")));

	inspector.handleInput("\x1b[6~");
	const depth2SummaryScrolled = inspector.render(100);
	assert.ok(depth2SummaryScrolled.some((l) => l.includes("Output Envelope:")));
	assert.ok(depth2SummaryScrolled.some((l) => l.includes("provenance: spawn-record")));

	inspector.handleInput("t");
	const depth2Task = inspector.render(100);
	assert.ok(depth2Task.some((l) => l.includes("Detailed depth-2 subtask:")));
	assert.ok(depth2Task.some((l) => l.includes("Run implementation checks.")));

	inspector.handleInput("f");
	const depth2Final = inspector.render(100);
	assert.ok(depth2Final.some((l) => l.includes("Depth-2 task finished cleanly without errors.")));
	assert.ok(depth2Final.some((l) => l.includes("provenance: spawn-record")));

	inspector.handleInput("o");
	const depth2Raw = inspector.render(100);
	assert.ok(depth2Raw.some((l) => l.includes("Raw output.txt tail is not captured separately for depth-2 child agents")));

	inspector.dispose();
});

test("parseSpawnRecordV1 backward compatibility with old records and forward parsing with all optional fields", () => {
	const oldRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-legacy",
		parentIndex: 0,
		groupId: "grp-legacy",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "worker",
				assignment: "worker",
				taskPreview: "legacy task preview",
				state: "succeeded",
				activity: "done",
				updatedAt: "2025-01-01T00:01:00.000Z",
				startedAt: "2025-01-01T00:00:10.000Z",
				endedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};

	const parsedOld = parseSpawnRecordV1(oldRecord);
	assert.ok(parsedOld !== undefined);
	assert.equal(parsedOld.workflowId, "wf-legacy");
	assert.equal(parsedOld.children.length, 1);
	assert.equal(parsedOld.children[0]?.agent, "general-purpose");
	assert.equal(parsedOld.children[0]?.taskPreview, "legacy task preview");
	assert.equal(parsedOld.children[0]?.taskFull, undefined);
	assert.equal(parsedOld.children[0]?.model, undefined);
	assert.equal(parsedOld.children[0]?.usage, undefined);

	const newRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-new",
		parentIndex: 1,
		groupId: "grp-new",
		mode: "parallel",
		phase: "verification",
		createdAt: "2025-01-01T00:00:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "worker",
				assignment: "worker",
				taskPreview: "new task preview",
				taskFull: "new task full multiline content",
				state: "succeeded",
				activity: "completed step",
				updatedAt: "2025-01-01T00:02:00.000Z",
				startedAt: "2025-01-01T00:00:10.000Z",
				endedAt: "2025-01-01T00:02:00.000Z",
				model: "anthropic/claude-3-7-sonnet",
				cwd: "/tmp/cwd-new",
				tools: "read,write",
				finalResponse: "all tests pass",
				exitCode: 0,
				stopReason: "tool_use",
				usage: {
					turns: 4,
					contextTokens: 8000,
					input: 1200,
					output: 400,
					cost: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
				},
				workflow: {
					playbook: "feature",
					assignment: "worker",
					phase: "verification",
					completedPhases: ["grounding", "implementation"],
					artifacts: [{ name: "test-report", path: "/tmp/report.json", sha256: "sha123" }],
				},
			},
		],
	};

	const parsedNew = parseSpawnRecordV1(newRecord);
	assert.ok(parsedNew !== undefined);
	assert.equal(parsedNew.workflowId, "wf-new");
	assert.equal(parsedNew.phase, "verification");
	assert.equal(parsedNew.children.length, 1);
	const c = parsedNew.children[0]!;
	assert.equal(c.taskFull, "new task full multiline content");
	assert.equal(c.model, "anthropic/claude-3-7-sonnet");
	assert.equal(c.cwd, "/tmp/cwd-new");
	assert.equal(c.tools, "read,write");
	assert.equal(c.finalResponse, "all tests pass");
	assert.equal(c.exitCode, 0);
	assert.equal(c.stopReason, "tool_use");
	assert.equal(c.usage?.turns, 4);
	assert.equal(c.usage?.cost, 0.02);
	assert.equal(c.workflow?.playbook, "feature");
	assert.equal(c.workflow?.completedPhases.length, 2);
	assert.equal(c.workflow?.artifacts[0]?.sha256, "sha123");
});

test("wrapText wraps long lines cleanly at word boundaries and keeps newlines", () => {
	const input = "This is a short line.\nThis is a much longer line that should be wrapped neatly across multiple lines without losing any text.\nShort.";
	const wrapped = wrapText(input, 30);
	assert.ok(wrapped.length > 3);
	assert.equal(wrapped[0], "This is a short line.");
	assert.ok(wrapped.every((line) => line.length <= 30));
	assert.equal(wrapped[wrapped.length - 1], "Short.");
});

test("wrapText hard-wraps unbroken tokens with no inserted ellipsis or lost characters", () => {
	const rawToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-+/=!";
	const width = 16;
	const wrapped = wrapText(rawToken, width);
	assert.ok(wrapped.length >= 4);
	assert.ok(wrapped.every((chunk) => chunk.length <= width));
	assert.ok(wrapped.every((chunk) => !chunk.includes("…") && !chunk.includes("...")));
	assert.equal(wrapped.join(""), rawToken);
});

test("parseChildUsage validates complete records and rejects partial or non-finite records", () => {
	const complete = {
		input: 1000,
		output: 200,
		cacheRead: 50,
		cacheWrite: 25,
		cost: 0.015,
		contextTokens: 4000,
		turns: 3,
	};
	const parsed = parseChildUsage(complete);
	assert.deepEqual(parsed, complete);

	assert.equal(parseChildUsage(null), undefined);
	assert.equal(parseChildUsage(undefined), undefined);
	assert.equal(parseChildUsage("not-an-object"), undefined);

	assert.equal(parseChildUsage({ input: 100, output: 50 }), undefined);
	assert.equal(parseChildUsage({ ...complete, cost: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, cacheRead: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, cacheWrite: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, contextTokens: undefined }), undefined);
	assert.equal(parseChildUsage({ ...complete, turns: undefined }), undefined);

	assert.equal(parseChildUsage({ ...complete, input: Number.NaN }), undefined);
	assert.equal(parseChildUsage({ ...complete, cost: Number.POSITIVE_INFINITY }), undefined);
	assert.equal(parseChildUsage({ ...complete, turns: "5" as unknown as number }), undefined);
});

test("AgentInspector summary view bounds viewport, shows line-range indicator, and supports vertical scrolling", async () => {
	const manyTodos: TodoItem[] = Array.from({ length: 12 }, (_, i) => ({
		id: `todo-${i + 1}`,
		content: `Execute detailed inspection task step ${i + 1}`,
		status: i < 3 ? "completed" : i === 3 ? "in_progress" : "pending",
	}));

	const snapshot: TreeSnapshot = {
		taskId: "task-long-summary",
		workflowId: "wf-long-summary",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				role: "feature",
				assignment: "owner",
				state: "running",
				taskPreview: "Long summary test task",
				taskFull: "Long summary test task full description",
				startedAt: "2025-01-01T00:00:00.000Z",
				workflow: {
					playbook: "feature",
					assignment: "owner",
					phase: "implementation",
					completedPhases: ["grounding", "architecture"],
					artifacts: [
						{ name: "arch-doc", path: "/tmp/arch.md" },
						{ name: "plan-doc", path: "/tmp/plan.md" },
					],
				},
				nested: [],
			},
		],
		todos: manyTodos,
		todoCounts: { total: 12, completed: 3, inProgress: 1 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialTaskId: "task-long-summary",
		listWorkflows: async () => [
			{
				workflowId: "wf-long-summary",
				taskId: "task-long-summary",
				artifactDir: "/tmp/wf-long-summary",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));

	const initialSummary = inspector.render(100);
	assert.ok(initialSummary.some((l) => l.includes("Agent:") && l.includes("poteto-agent")));
	assert.ok(initialSummary.some((l) => l.includes("lines 1-14 of")));
	assert.ok(initialSummary.some((l) => l.includes("PgUp/PgDn scroll") && l.includes("Home/End")));

	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	const scrolledDownSummary = inspector.render(100);
	assert.ok(scrolledDownSummary.some((l) => l.includes("lines 3-16 of") || l.includes("lines 3-")));

	inspector.handleInput("\x1b[6~");
	inspector.handleInput("\x1b[6~");
	const pageDownSummary = inspector.render(100);
	assert.ok(pageDownSummary.some((l) => l.includes("step 10") || l.includes("step 11") || l.includes("step 12")));

	inspector.handleInput("\x1b[F");
	const bottomSummary = inspector.render(100);
	assert.ok(bottomSummary.some((l) => l.includes("step 12")));

	inspector.handleInput("\x1b[H");
	const topSummary = inspector.render(100);
	assert.ok(topSummary.some((l) => l.includes("lines 1-14 of")));
	assert.ok(topSummary.some((l) => l.includes("Agent:") && l.includes("poteto-agent")));

	inspector.dispose();
});

test("AgentInspector done resolves at most once", () => {
	let doneCalls = 0;
	const done = () => {
		doneCalls++;
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), done, {
		sessionId: "test-sess",
		listWorkflows: async () => [],
	});

	inspector.handleInput("q");
	inspector.handleInput("q");
	inspector.handleInput("\x1b");
	assert.equal(doneCalls, 1);

	inspector.dispose();
});

test("AgentInspector dispose halts refresh timer and prevents post-dispose render or state mutation", async () => {
	let renderCalls = 0;
	let resolveList: (value: WorkflowSummary[]) => void;
	const listPromise = new Promise<WorkflowSummary[]>((resolve) => {
		resolveList = resolve;
	});

	const inspector = new AgentInspector(
		{
			requestRender: () => {
				renderCalls++;
			},
		},
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			refreshIntervalMs: 5,
			listWorkflows: () => listPromise,
		},
	);

	inspector.dispose();
	const rendersAtDispose = renderCalls;

	resolveList!([
		{
			workflowId: "wf-late",
			taskId: "task-late",
			artifactDir: "/tmp/wf-late",
			schedulerRoot: "/tmp/scheduler",
			committed: false,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			unreadable: false,
		},
	]);

	await new Promise((r) => setTimeout(r, 20));
	assert.equal(renderCalls, rendersAtDispose);
});

test("AgentInspector suppresses overlapping poll execution", async () => {
	let activePolls = 0;
	let maxConcurrentPolls = 0;

	const inspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			refreshIntervalMs: 5,
			listWorkflows: async () => {
				activePolls++;
				maxConcurrentPolls = Math.max(maxConcurrentPolls, activePolls);
				await new Promise((r) => setTimeout(r, 25));
				activePolls--;
				return [];
			},
		},
	);

	await new Promise((r) => setTimeout(r, 60));
	inspector.dispose();

	assert.equal(maxConcurrentPolls, 1);
});

test("AgentInspector freezes committed workflow elapsed time using child end times and capturedAt", async () => {
	let simulatedNow = new Date("2025-01-01T00:10:00.000Z");

	const committedWorkflows: WorkflowSummary[] = [
		{
			workflowId: "wf-done",
			taskId: "task-done",
			artifactDir: "/tmp/wf-done",
			schedulerRoot: "/tmp/scheduler",
			committed: true,
			createdAt: "2025-01-01T00:00:00.000Z",
			playbook: "feature",
			unreadable: false,
		},
	];

	const doneSnapshot: TreeSnapshot = {
		taskId: "task-done",
		workflowId: "wf-done",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: true,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "succeeded",
				taskPreview: "done task",
				startedAt: "2025-01-01T00:00:00.000Z",
				endedAt: "2025-01-01T00:03:00.000Z",
				nested: [],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:05:00.000Z",
	};

	const inspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => committedWorkflows,
			getSnapshot: async () => doneSnapshot,
			now: () => simulatedNow,
		},
	);

	await new Promise((r) => setTimeout(r, 20));

	const initialLines = inspector.render(100);
	assert.ok(initialLines.some((l) => l.includes("1/1 done · 3m00s")));

	simulatedNow = new Date("2025-01-01T05:00:00.000Z");
	const laterLines = inspector.render(100);
	assert.ok(laterLines.some((l) => l.includes("1/1 done · 3m00s")));

	inspector.dispose();
});

test("AgentInspector distinguishes top-level load failure from empty state", async () => {
	const failingInspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => {
				throw new Error("EACCES: permission denied");
			},
		},
	);

	await new Promise((r) => setTimeout(r, 20));
	const errorLines = failingInspector.render(100);
	assert.ok(errorLines.some((l) => l.includes("Failed to load dstack workflows: EACCES: permission denied")));
	failingInspector.dispose();

	const emptyInspector = new AgentInspector(
		{ requestRender: () => {} },
		plainTheme(),
		() => {},
		{
			sessionId: "test-sess",
			listWorkflows: async () => [],
		},
	);

	await new Promise((r) => setTimeout(r, 20));
	const emptyLines = emptyInspector.render(100);
	assert.ok(emptyLines.some((l) => l.includes("No dstack agents in this session yet")));
	emptyInspector.dispose();
});

test("AgentInspector renders inherited model for running depth-2 child", async () => {
	const runningNested: SpawnNestedChild = {
		groupId: "grp-running",
		nestedIndex: 0,
		agent: "general-purpose",
		role: "implementation-worker",
		assignment: "worker",
		taskPreview: "running worker task",
		state: "running",
		startedAt: "2025-01-01T00:00:10.000Z",
		updatedAt: "2025-01-01T00:00:10.000Z",
		live: true,
		model: "anthropic/claude-3-7-sonnet",
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-running-d2",
		workflowId: "wf-running-d2",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 1, complete: 0, total: 1 },
		slots: { active: 1, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				taskPreview: "parent owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				nested: [runningNested],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:00:30.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-running-d2",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-running",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-running-d2",
				taskId: "task-running-d2",
				artifactDir: "/tmp/wf-running-d2",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));
	const lines = inspector.render(100);

	assert.ok(lines.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(lines.some((l) => l.includes("Model:") && l.includes("anthropic/claude-3-7-sonnet")));
	assert.ok(!lines.some((l) => l.includes("Model:") && l.includes("implementation-worker")));
	inspector.dispose();
});

test("AgentInspector renders child-reported model for completed depth-2 child in summary and final views", async () => {
	const completedNested: SpawnNestedChild = {
		groupId: "grp-completed",
		nestedIndex: 0,
		agent: "general-purpose",
		role: "implementation-worker",
		assignment: "worker",
		taskPreview: "completed worker task",
		state: "succeeded",
		startedAt: "2025-01-01T00:00:10.000Z",
		endedAt: "2025-01-01T00:00:45.000Z",
		updatedAt: "2025-01-01T00:00:45.000Z",
		live: false,
		model: "google/gemini-2.5-pro",
		finalResponse: "implementation successfully completed",
		exitCode: 0,
	};

	const snapshot: TreeSnapshot = {
		taskId: "task-completed-d2",
		workflowId: "wf-completed-d2",
		mode: "single",
		playbook: "feature",
		createdAt: "2025-01-01T00:00:00.000Z",
		committed: false,
		counts: { queued: 0, running: 0, complete: 1, total: 1 },
		slots: { active: 0, capacity: 4 },
		children: [
			{
				index: 0,
				agent: "poteto-agent",
				state: "running",
				role: "feature",
				assignment: "owner",
				taskPreview: "parent owner",
				startedAt: "2025-01-01T00:00:00.000Z",
				nested: [completedNested],
			},
		],
		todos: [],
		todoCounts: { total: 0, completed: 0, inProgress: 0 },
		capturedAt: "2025-01-01T00:01:00.000Z",
	};

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-completed-d2",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-completed",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-completed-d2",
				taskId: "task-completed-d2",
				artifactDir: "/tmp/wf-completed-d2",
				schedulerRoot: "/tmp/scheduler",
				committed: false,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
		getSnapshot: async () => snapshot,
	});

	await new Promise((r) => setTimeout(r, 20));
	const summaryLines = inspector.render(100);
	assert.ok(summaryLines.some((l) => l.includes("Model:") && l.includes("google/gemini-2.5-pro")));

	inspector.handleInput("f");
	const finalLines = inspector.render(100);
	assert.ok(finalLines.some((l) => l.includes("model: google/gemini-2.5-pro")));
	assert.ok(finalLines.some((l) => l.includes("implementation successfully completed")));
	inspector.dispose();
});

test("AgentInspector recovers nested model from historical sealed result on disk and renders it", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-historical-sealed");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(artifactDir, { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifestData = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-historical-sealed",
		sessionId: "test-sess",
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

	const historicalSpawn = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-historical-sealed",
		parentIndex: 0,
		groupId: "grp-hist-sealed",
		mode: "single",
		createdAt: "2025-01-01T00:00:10.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "historical worker task",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	await writeFile(join(spawnsDir, "grp-hist-sealed.json"), JSON.stringify(historicalSpawn), "utf8");

	const parentResult = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-historical-sealed",
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

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-historical-sealed",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-hist-sealed",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-historical-sealed",
				taskId: "task-hist-sealed",
				artifactDir,
				schedulerRoot,
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
	});

	await new Promise((r) => setTimeout(r, 40));
	const lines = inspector.render(100);

	assert.ok(lines.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(lines.some((l) => l.includes("Model:") && l.includes("anthropic/claude-3-5-haiku")));
	assert.ok(!lines.some((l) => l.includes("Model:") && l.includes("implementation-worker")));
	inspector.dispose();
});

test("AgentInspector renders Model: unavailable for historical records without sealed fallback", async (t) => {
	const cwd = await temporaryDirectory(t);
	const artifactDir = join(cwd, "workflows", "wf-historical-unavailable");
	const schedulerRoot = join(cwd, "scheduler");

	await mkdir(artifactDir, { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifestData = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-historical-unavailable",
		sessionId: "test-sess",
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

	const historicalSpawn = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-historical-unavailable",
		parentIndex: 0,
		groupId: "grp-hist-unavail",
		mode: "single",
		createdAt: "2025-01-01T00:00:10.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "implementation-worker",
				assignment: "worker",
				taskPreview: "historical unavail task",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:00.000Z",
			},
		],
	};
	await writeFile(join(spawnsDir, "grp-hist-unavail.json"), JSON.stringify(historicalSpawn), "utf8");

	const inspector = new AgentInspector({ requestRender: () => {} }, plainTheme(), () => {}, {
		sessionId: "test-sess",
		initialWorkflowId: "wf-historical-unavailable",
		initialChildIndex: 0,
		initialNestedGroupId: "grp-hist-unavail",
		initialNestedIndex: 0,
		listWorkflows: async () => [
			{
				workflowId: "wf-historical-unavailable",
				taskId: "task-hist-unavail",
				artifactDir,
				schedulerRoot,
				committed: true,
				createdAt: "2025-01-01T00:00:00.000Z",
				playbook: "feature",
				unreadable: false,
			},
		],
	});

	await new Promise((r) => setTimeout(r, 40));
	const lines = inspector.render(100);

	assert.ok(lines.some((l) => l.includes("Agent:") && l.includes("general-purpose") && l.includes("depth 2")));
	assert.ok(lines.some((l) => l.includes("Model:") && l.includes("unavailable")));
	assert.ok(!lines.some((l) => l.includes("Model:") && l.includes("implementation-worker")));
	inspector.dispose();
});
