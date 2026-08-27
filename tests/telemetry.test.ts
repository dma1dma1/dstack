import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	aggregateTelemetry,
	calculateQuantileDistribution,
	collectTelemetryData,
	mergeTimeIntervals,
	totalMergedDurationMs,
	type RawTelemetryData,
	type TelemetryReportV1,
} from "../extensions/telemetry.ts";
import { formatReportHumanReadable, runTelemetryCli } from "../scripts/telemetry.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-telemetry-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("calculateQuantileDistribution calculates correct quantiles for empty and populated data", () => {
	const empty = calculateQuantileDistribution([]);
	assert.equal(empty.count, 0);
	assert.equal(empty.minMs, 0);
	assert.equal(empty.maxMs, 0);
	assert.equal(empty.medianMs, 0);

	const single = calculateQuantileDistribution([1000]);
	assert.equal(single.count, 1);
	assert.equal(single.minMs, 1000);
	assert.equal(single.maxMs, 1000);
	assert.equal(single.medianMs, 1000);
	assert.equal(single.meanMs, 1000);

	const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
	const populated = calculateQuantileDistribution(values);
	assert.equal(populated.count, 10);
	assert.equal(populated.minMs, 100);
	assert.equal(populated.maxMs, 1000);
	assert.equal(populated.meanMs, 550);
	assert.equal(populated.totalMs, 5500);
	assert.equal(populated.medianMs, 550);
	assert.ok(populated.p75Ms >= 750);
	assert.ok(populated.p90Ms >= 900);
	assert.ok(populated.p99Ms >= 990);
});

test("mergeTimeIntervals coalesces overlapping intervals and prevents double counting", () => {
	const intervals = [
		{ startMs: 1000, endMs: 2000 },
		{ startMs: 1500, endMs: 2500 }, // overlaps with first -> [1000, 2500]
		{ startMs: 3000, endMs: 4000 }, // separate -> [3000, 4000]
	];
	const merged = mergeTimeIntervals(intervals);
	assert.equal(merged.length, 2);
	assert.deepEqual(merged[0], { startMs: 1000, endMs: 2500 });
	assert.deepEqual(merged[1], { startMs: 3000, endMs: 4000 });

	const totalMs = totalMergedDurationMs(intervals);
	assert.equal(totalMs, 1500 + 1000); // 2500ms
});

test("aggregateTelemetry produces TelemetryReportV1 with top-level owner selection filtering, delegation cohorts, and join reliability", () => {
	const rawData: RawTelemetryData = {
		sessions: [
			{
				sessionId: "sess-1",
				startedAt: "2026-08-25T10:00:00.000Z",
				endedAt: "2026-08-25T10:30:00.000Z",
				interval: {
					startMs: Date.parse("2026-08-25T10:00:00.000Z"),
					endMs: Date.parse("2026-08-25T10:30:00.000Z"),
				},
			},
		],
		workflows: [
			// Workflow 1: Top-level owner workflow with nested worker spawns
			{
				workflowId: "wf-1",
				sessionId: "sess-1",
				mode: "single",
				playbook: "feature",
				createdAt: "2026-08-25T10:05:00.000Z",
				isTopLevelOwnerWorkflow: true,
				outcome: "succeeded",
				hasManifest: true,
				committed: true,
				hasResultIndex: true,
				childCount: 1,
				succeededChildCount: 1,
				failedChildCount: 0,
				cancelledChildCount: 0,
				children: [
					{
						childKey: "wf-1:0",
						workflowId: "wf-1",
						index: 0,
						agent: "poteto-agent",
						role: "feature",
						model: "openai-codex/gpt-5.6-sol",
						playbook: "feature",
						assignment: "owner",
						phase: "planning",
						state: "succeeded",
						exitCode: 0,
						runtimeMs: 50000,
						interval: {
							startMs: Date.parse("2026-08-25T10:05:00.000Z"),
							endMs: Date.parse("2026-08-25T10:10:00.000Z"),
						},
						usage: { input: 1000, output: 200, cost: 0.058, turns: 3 },
						hasChildResult: true,
						spawnGroupCount: 2,
						spawns: [
							{
								spawnKey: "group-1:0",
								groupId: "group-1",
								nestedIndex: 0,
								agent: "general-purpose",
								role: "slice-worker",
								model: "anthropic/claude-3-5-haiku",
								assignment: "worker",
								phase: "slice-0",
								state: "succeeded",
								exitCode: 0,
								runtimeMs: 15000,
								interval: {
									startMs: Date.parse("2026-08-25T10:06:00.000Z"),
									endMs: Date.parse("2026-08-25T10:07:00.000Z"),
								},
								usage: { input: 500, output: 100, cost: 0.005, turns: 2 },
							},
							{
								spawnKey: "group-2:0",
								groupId: "group-2",
								nestedIndex: 0,
								agent: "general-purpose",
								role: "slice-worker",
								model: "anthropic/claude-3-5-haiku",
								assignment: "worker",
								phase: "slice-0-repair",
								state: "succeeded",
								exitCode: 0,
								runtimeMs: 10000,
								interval: {
									startMs: Date.parse("2026-08-25T10:08:00.000Z"),
									endMs: Date.parse("2026-08-25T10:09:00.000Z"),
								},
								usage: { input: 300, output: 80, cost: 0.003, turns: 1 },
							},
						],
					},
				],
			},
			// Workflow 2: Top-level non-delegated owner workflow
			{
				workflowId: "wf-2",
				sessionId: "sess-1",
				mode: "single",
				playbook: "bug-fix",
				createdAt: "2026-08-25T10:15:00.000Z",
				isTopLevelOwnerWorkflow: true,
				outcome: "succeeded",
				hasManifest: true,
				committed: true,
				hasResultIndex: true,
				childCount: 1,
				succeededChildCount: 1,
				failedChildCount: 0,
				cancelledChildCount: 0,
				children: [
					{
						childKey: "wf-2:0",
						workflowId: "wf-2",
						index: 0,
						agent: "poteto-agent",
						role: "bug-fix",
						model: "anthropic/claude-3-5-sonnet",
						playbook: "bug-fix",
						assignment: "owner",
						phase: "fix",
						state: "succeeded",
						exitCode: 0,
						runtimeMs: 25000,
						interval: {
							startMs: Date.parse("2026-08-25T10:15:00.000Z"),
							endMs: Date.parse("2026-08-25T10:20:00.000Z"),
						},
						usage: { input: 800, output: 150, cost: 0.03, turns: 2 },
						hasChildResult: true,
						spawnGroupCount: 0,
						spawns: [],
					},
				],
			},
			// Workflow 3: Nested worker workflow (must NOT inflate workflow selections)
			{
				workflowId: "wf-3-worker",
				sessionId: "sess-1",
				mode: "single",
				playbook: "feature",
				createdAt: "2026-08-25T10:22:00.000Z",
				isTopLevelOwnerWorkflow: false,
				outcome: "failed",
				hasManifest: true,
				committed: true,
				hasResultIndex: true,
				childCount: 1,
				succeededChildCount: 0,
				failedChildCount: 1,
				cancelledChildCount: 0,
				children: [
					{
						childKey: "wf-3-worker:0",
						workflowId: "wf-3-worker",
						index: 0,
						agent: "general-purpose",
						role: "test-runner",
						model: "anthropic/claude-3-5-haiku",
						playbook: "feature",
						assignment: "worker",
						phase: "test",
						state: "failed",
						exitCode: 1,
						runtimeMs: 8000,
						interval: {
							startMs: Date.parse("2026-08-25T10:22:00.000Z"),
							endMs: Date.parse("2026-08-25T10:23:00.000Z"),
						},
						usage: { input: 200, output: 40, cost: 0.002, turns: 1 },
						hasChildResult: true,
						spawnGroupCount: 0,
						spawns: [],
					},
				],
			},
		],
		bindings: [
			{ bindingId: "task-1", workflowId: "wf-1" },
			{ bindingId: "task-2", workflowId: "wf-2" },
			{ bindingId: "task-dangling", workflowId: "wf-nonexistent" },
		],
		duplicateQueueEventIds: 2,
		queueEvents: [
			{
				eventId: "dstack.scheduler-queue-event.v1:ticket_created:nonce-1",
				kind: "ticket_created",
				ticketId: "dstack.scheduler-ticket.v2:nonce-1",
				workflowId: "wf-1",
				childId: "0",
				seq: 1,
				depth: 1,
				capacityClass: "reserved",
				occurredAt: "2026-08-25T10:05:00.000Z",
			},
			{
				eventId: "dstack.scheduler-queue-event.v1:slot_acquired:nonce-1",
				kind: "slot_acquired",
				ticketId: "dstack.scheduler-ticket.v2:nonce-1",
				slotAcquisitionId: "dstack.scheduler-slot-acquisition.v1:nonce-1",
				workflowId: "wf-1",
				childId: "0",
				seq: 1,
				depth: 1,
				capacityClass: "reserved",
				occurredAt: "2026-08-25T10:05:01.250Z",
			},
		],
		corruptCounts: {
			sessionFiles: 0,
			manifestFiles: 0,
			resultIndexFiles: 0,
			childResultFiles: 0,
			spawnRecordFiles: 0,
			bindingFiles: 0,
			queueEventFiles: 0,
		},
	};

	const report = aggregateTelemetry(rawData);

	// 1. Schema version
	assert.equal(report.schemaVersion, "dstack.telemetry-report.v1");

	// 2. Workflow selection counts ONLY from top-level owner workflows (wf-1 and wf-2, NOT wf-3-worker)
	assert.equal(report.workflowSelections.totalWorkflows, 2);
	assert.equal(report.workflowSelections.byPlaybook["feature"], 1);
	assert.equal(report.workflowSelections.byPlaybook["bug-fix"], 1);
	assert.equal(report.workflowSelections.byMode["single"], 2);
	assert.equal(report.workflowSelections.byOutcome["succeeded"], 2);

	// 3. Roles and resolved models includes nested spawns
	assert.equal(report.rolesAndModels.byPlaybook["feature"]?.["feature"]?.["openai-codex/gpt-5.6-sol"], 1);
	assert.equal(report.rolesAndModels.byPlaybook["feature"]?.["slice-worker"]?.["anthropic/claude-3-5-haiku"], 2);
	assert.equal(report.rolesAndModels.byPlaybook["bug-fix"]?.["bug-fix"]?.["anthropic/claude-3-5-sonnet"], 1);

	// 4. Runtime distributions
	assert.equal(report.runtimeDistributions.owner.count, 2);
	assert.equal(report.runtimeDistributions.worker.count, 3); // 2 spawns + 1 wf-3-worker child
	assert.equal(report.runtimeDistributions.all.count, 5);

	// 5. Observational Owner Delegation Cohorts
	assert.equal(report.ownerDelegationCohorts.delegatedOwners.count, 1);
	assert.equal(report.ownerDelegationCohorts.delegatedOwners.runtime.medianMs, 50000);
	assert.equal(report.ownerDelegationCohorts.nonDelegatedOwners.count, 1);
	assert.equal(report.ownerDelegationCohorts.nonDelegatedOwners.runtime.medianMs, 25000);
	assert.ok(report.ownerDelegationCohorts.causalityLimitation.includes("cannot establish delegation causality"));

	// 6. Role & model reliability: observable repeated delegation counted conservatively, no parallel steps as retries
	const sliceWorkerStats = report.roleModelReliability.find((r) => r.role === "slice-worker");
	assert.ok(sliceWorkerStats);
	assert.equal(sliceWorkerStats.totalInvocations, 2);
	assert.equal(sliceWorkerStats.succeededCount, 2);
	assert.equal(sliceWorkerStats.failedCount, 0);
	assert.equal(sliceWorkerStats.observableRepeatedDelegationCount, 2);

	assert.equal(report.workerEconomics.lightweightWorkerRuns, 3);
	assert.equal(report.workerEconomics.lightweightWorkerDirectCost, 0.005 + 0.003 + 0.002);
	assert.equal(report.workerEconomics.ownerRuns, 2);
	assert.equal(report.workerEconomics.ownerDirectCost, 0.05 + 0.03);
	assert.equal(report.workerEconomics.directCostIsLower, true);
	assert.equal(report.workerEconomics.afterReworkEconomicsSupported, false);
	assert.ok(report.workerEconomics.evaluationNote.includes("after-rework economics are unsupported"));

	// 8. Durable queue events
	assert.equal(report.queueEvents.ticketCreated, 1);
	assert.equal(report.queueEvents.slotAcquired, 1);
	assert.equal(report.queueEvents.matchedAcquisitions, 1);
	assert.equal(report.queueEvents.missingAcquisitions, 0);
	assert.equal(report.queueEvents.duplicateEventIds, 2);
	assert.equal(report.queueEvents.waitTime.medianMs, 1250);
	assert.equal(report.queueEvents.byDepth["1"], 1);

	// 9. Data Join Reliability
	// Manifest -> Session: 3 manifests with sessionId, 3 joined -> 3/3
	assert.equal(report.dataJoinReliability.manifestToSession.total, 3);
	assert.equal(report.dataJoinReliability.manifestToSession.joined, 3);
	assert.equal(report.dataJoinReliability.manifestToSession.joinRate, 1.0);

	// Committed -> Result Index: 3 committed, 3 have result-index -> 3/3
	assert.equal(report.dataJoinReliability.committedToResultIndex.totalCommitted, 3);
	assert.equal(report.dataJoinReliability.committedToResultIndex.joined, 3);

	// Manifest -> Child Results: 3 children, 3 have child results -> 3/3
	assert.equal(report.dataJoinReliability.manifestToChildResults.totalExpectedChildren, 3);
	assert.equal(report.dataJoinReliability.manifestToChildResults.joinedChildResults, 3);

	// Bindings -> Workflows: 3 bindings, 2 matched wf-1 and wf-2, 1 dangling -> 2/3
	assert.equal(report.dataJoinReliability.bindingsToWorkflows.totalBindings, 3);
	assert.equal(report.dataJoinReliability.bindingsToWorkflows.joined, 2);
	assert.equal(report.dataJoinReliability.bindingsToWorkflows.danglingBindings, 1);
	assert.equal(report.dataJoinReliability.bindingsToWorkflows.joinRate, 2 / 3);

	assert.equal(report.dataJoinReliability.queueEventsToWorkflows.totalEvents, 2);
	assert.equal(report.dataJoinReliability.queueEventsToWorkflows.joined, 2);

	// Total Joins: 3 + 3 + 3 + 3 + 2 = 14 attempted, 3 + 3 + 3 + 2 + 2 = 13 successful
	assert.equal(report.dataJoinReliability.totalJoinsAttempted, 14);
	assert.equal(report.dataJoinReliability.totalJoinsSuccessful, 13);
	assert.equal(report.dataJoinReliability.overallJoinRate, 13 / 14);

	// 10. Recoverable and missing limitations
	assert.equal(report.recoverableAndMissingMetrics.scannedSessions, 1);
	assert.equal(report.recoverableAndMissingMetrics.scannedWorkflows, 3);
	assert.equal(report.recoverableAndMissingMetrics.scannedChildren, 5); // 3 workflow children + 2 nested spawns
	assert.ok(report.recoverableAndMissingMetrics.missingOrUnsupportedMetrics.some((m) => m.metric === "delegation_causality"));
	assert.ok(report.recoverableAndMissingMetrics.missingOrUnsupportedMetrics.some((m) => m.metric === "after_rework_worker_economics"));
	assert.ok(report.recoverableAndMissingMetrics.missingOrUnsupportedMetrics.some((m) => m.metric === "retries_and_abandonment_intent"));
});

test("privacy guarantee: telemetry parser strictly ignores private files and fields", async (t) => {
	const dir = await temporaryDirectory(t);
	const bgRoot = join(dir, "background");
	const sessRoot = join(dir, "sessions");
	const sessDir = join(bgRoot, "test-session");
	const wfDir = join(sessDir, "workflows", "wf-priv");
	const child0Dir = join(wfDir, "children", "0");
	const spawnsDir = join(child0Dir, "spawns");
	const queueEventsDir = join(sessDir, "scheduler", "events");

	await mkdir(spawnsDir, { recursive: true });
	await mkdir(queueEventsDir, { recursive: true });
	await mkdir(join(sessRoot, "proj"), { recursive: true });

	// Session file with private user messages
	const sessionFile = join(sessRoot, "proj", "test-session.jsonl");
	await writeFile(
		sessionFile,
		JSON.stringify({ type: "session", id: "test-session", timestamp: "2026-08-25T12:00:00.000Z" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				role: "user",
				content: "SECRET USER PROMPT CONTENT DO NOT LEAK",
				timestamp: "2026-08-25T12:01:00.000Z",
			}) +
			"\n" +
			JSON.stringify({ type: "session_end", timestamp: "2026-08-25T12:05:00.000Z" }) +
			"\n",
	);

	// Manifest with private task, cwd, systemPrompt
	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-priv",
		sessionId: "test-session",
		mode: "single",
		specs: [
			{
				agent: "poteto-agent",
				task: "SECRET TASK INSTRUCTION DO NOT LEAK",
				cwd: "/secret/private/path",
				model: "provider/test-model",
				requestedRole: "judgment",
				workflow: { playbook: "feature", assignment: "owner", phase: "run" },
				systemPrompt: "SECRET SYSTEM PROMPT DO NOT LEAK",
			},
		],
		createdAt: "2026-08-25T12:00:00.000Z",
	};
	await writeFile(join(wfDir, "manifest.json"), JSON.stringify(manifest));
	await writeFile(join(wfDir, "COMMITTED"), JSON.stringify({ schemaVersion: "dstack.commit.v1" }));
	await writeFile(
		join(wfDir, "result-index.json"),
		JSON.stringify({ schemaVersion: "dstack.result-index.v1", workflowId: "wf-priv", outcome: "succeeded", children: [] }),
	);

	// Child result.json matching real nested result schema with private text, messages, cwd, stderr
	const childResult = {
		schemaVersion: "dstack.child-result.v1",
		workflowId: "wf-priv",
		index: 0,
		state: "succeeded",
		startedAt: "2026-08-25T12:00:00.000Z",
		endedAt: "2026-08-25T12:04:00.000Z",
		result: {
			text: "SECRET ASSISTANT PROSE DO NOT LEAK",
			exitCode: 0,
			stderr: "SECRET STDERR DO NOT LEAK",
			messages: [{ role: "assistant", content: "SECRET MESSAGE" }],
			model: "provider/test-model",
			usage: { input: 10, output: 5, cost: 0.01, turns: 1 },
			task: "SECRET TASK AGAIN",
			cwd: "/secret/path/again",
		},
	};
	await writeFile(join(child0Dir, "result.json"), JSON.stringify(childResult));

	// Forbidden files that must NOT be read or leak
	await writeFile(join(child0Dir, "journal.json"), JSON.stringify({ entries: [{ secret: "FORBIDDEN JOURNAL" }] }));
	await writeFile(join(child0Dir, "status.json"), JSON.stringify({ note: "FORBIDDEN STATUS NOTE" }));
	await writeFile(join(child0Dir, "activity.json"), JSON.stringify({ text: "FORBIDDEN ACTIVITY PROSE" }));
	await writeFile(join(child0Dir, "output.txt"), "FORBIDDEN FULL OUTPUT TEXT");

	// Spawn record with private taskPreview, taskFull, activity, cwd, finalResponse
	const spawnRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-priv",
		parentIndex: 0,
		groupId: "spawn-grp-1",
		mode: "single",
		createdAt: "2026-08-25T12:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				role: "worker-role",
				model: "provider/worker-model",
				state: "succeeded",
				taskPreview: "SECRET SPAWN TASK PREVIEW",
				taskFull: "SECRET SPAWN TASK FULL",
				cwd: "/secret/spawn/cwd",
				activity: "SECRET SPAWN ACTIVITY",
				finalResponse: "SECRET SPAWN FINAL RESPONSE",
				exitCode: 0,
				startedAt: "2026-08-25T12:01:00.000Z",
				endedAt: "2026-08-25T12:02:00.000Z",
				usage: { cost: 0.002 },
			},
		],
	};
	await writeFile(join(spawnsDir, "spawn-grp-1.json"), JSON.stringify(spawnRecord));

	const queueEventBase = {
		schemaVersion: "dstack.scheduler.queue-event.v1",
		ticketId: "dstack.scheduler-ticket.v2:privacy-nonce",
		workflowId: "wf-priv",
		childId: "0",
		seq: 1,
		depth: 1,
		capacityClass: "reserved",
		privateTask: "SECRET QUEUE TASK",
	};
	await writeFile(join(queueEventsDir, "privacy-ticket.json"), JSON.stringify({
		...queueEventBase,
		eventId: "dstack.scheduler-queue-event.v1:ticket_created:privacy-nonce",
		kind: "ticket_created",
		occurredAt: "2026-08-25T12:00:00.000Z",
	}));
	await writeFile(join(queueEventsDir, "privacy-slot.json"), JSON.stringify({
		...queueEventBase,
		eventId: "dstack.scheduler-queue-event.v1:slot_acquired:privacy-nonce",
		kind: "slot_acquired",
		slotAcquisitionId: "dstack.scheduler-slot-acquisition.v1:privacy-nonce",
		occurredAt: "2026-08-25T12:00:02.000Z",
	}));

	const report = await collectTelemetryData({
		backgroundRoot: bgRoot,
		sessionsDir: sessRoot,
	});

	const serialized = JSON.stringify(report);
	assert.ok(!serialized.includes("SECRET USER PROMPT CONTENT"));
	assert.ok(!serialized.includes("SECRET TASK INSTRUCTION"));
	assert.ok(!serialized.includes("SECRET SYSTEM PROMPT"));
	assert.ok(!serialized.includes("SECRET ASSISTANT PROSE"));
	assert.ok(!serialized.includes("SECRET STDERR"));
	assert.ok(!serialized.includes("/secret/"));
	assert.ok(!serialized.includes("FORBIDDEN JOURNAL"));
	assert.ok(!serialized.includes("FORBIDDEN STATUS NOTE"));
	assert.ok(!serialized.includes("FORBIDDEN ACTIVITY PROSE"));
	assert.ok(!serialized.includes("FORBIDDEN FULL OUTPUT TEXT"));
	assert.ok(!serialized.includes("SECRET SPAWN TASK PREVIEW"));
	assert.ok(!serialized.includes("SECRET SPAWN TASK FULL"));
	assert.ok(!serialized.includes("SECRET SPAWN ACTIVITY"));
	assert.ok(!serialized.includes("SECRET SPAWN FINAL RESPONSE"));
	assert.ok(!serialized.includes("SECRET QUEUE TASK"));
	assert.equal(report.queueEvents.matchedAcquisitions, 1);
	assert.equal(report.queueEvents.waitTime.medianMs, 2000);

	// Check runtime used top-level startedAt/endedAt (12:00 to 12:04 = 240,000ms)
	assert.equal(report.runtimeDistributions.owner.medianMs, 240000);
});

test("corrupt file counters increment ONLY on malformed present files, not on missing optional files", async (t) => {
	const dir = await temporaryDirectory(t);
	const bgRoot = join(dir, "background");
	const sessRoot = join(dir, "sessions");
	const sessDir = join(bgRoot, "session-corrupt");
	const wfDir = join(sessDir, "workflows", "wf-corrupt");
	const child0Dir = join(wfDir, "children", "0");
	const spawnsDir = join(child0Dir, "spawns");
	const bindingsDir = join(sessDir, "bindings");
	const queueEventsDir = join(sessDir, "scheduler", "events");

	await mkdir(spawnsDir, { recursive: true });
	await mkdir(bindingsDir, { recursive: true });
	await mkdir(queueEventsDir, { recursive: true });
	await mkdir(join(sessRoot, "proj"), { recursive: true });

	// 1. Session file with a malformed JSON line -> sessionFiles corrupt = 1
	const sessionFile = join(sessRoot, "proj", "sess-corrupt.jsonl");
	await writeFile(sessionFile, "NOT VALID JSON\n");

	// 2. Manifest file with malformed JSON -> manifestFiles corrupt = 1
	await writeFile(join(wfDir, "manifest.json"), "{ invalid manifest json");

	// 3. Result index with malformed JSON -> resultIndexFiles corrupt = 1
	await writeFile(join(wfDir, "result-index.json"), "{ invalid result index json");

	// 4. Child result.json with malformed JSON -> childResultFiles corrupt = 1
	await writeFile(join(child0Dir, "result.json"), "{ invalid child result json");

	// 5. Spawn record with malformed JSON -> spawnRecordFiles corrupt = 1
	await writeFile(join(spawnsDir, "bad-spawn.json"), "{ invalid spawn json");

	// 6. Binding with malformed JSON -> bindingFiles corrupt = 1
	await writeFile(join(bindingsDir, "bad-binding.json"), "{ invalid binding json");

	// 7. Queue event with malformed JSON -> queueEventFiles corrupt = 1
	await writeFile(join(queueEventsDir, "bad-event.json"), "{ invalid queue event json");

	const report = await collectTelemetryData({
		backgroundRoot: bgRoot,
		sessionsDir: sessRoot,
	});

	const corrupt = report.recoverableAndMissingMetrics.corruptOrUnparseableRecords;
	assert.equal(corrupt.sessionFiles, 1);
	assert.equal(corrupt.manifestFiles, 1);
	assert.equal(corrupt.resultIndexFiles, 1);
	assert.equal(corrupt.childResultFiles, 1);
	assert.equal(corrupt.spawnRecordFiles, 1);
	assert.equal(corrupt.bindingFiles, 1);
	assert.equal(corrupt.queueEventFiles, 1);
});

test("missing optional files (ENOENT) do NOT increment corrupt counters", async (t) => {
	const dir = await temporaryDirectory(t);
	const bgRoot = join(dir, "background");
	const sessRoot = join(dir, "sessions");
	const sessDir = join(bgRoot, "session-clean");
	const wfDir = join(sessDir, "workflows", "wf-clean");
	const child0Dir = join(wfDir, "children", "0");

	await mkdir(child0Dir, { recursive: true });
	await mkdir(join(sessRoot, "proj"), { recursive: true });

	// Clean session file
	await writeFile(
		join(sessRoot, "proj", "sess-clean.jsonl"),
		JSON.stringify({ type: "session", id: "session-clean", timestamp: "2026-08-25T12:00:00.000Z" }) + "\n",
	);

	// Clean manifest
	await writeFile(
		join(wfDir, "manifest.json"),
		JSON.stringify({
			schemaVersion: "dstack.workflow.v1",
			workflowId: "wf-clean",
			sessionId: "session-clean",
			mode: "single",
			specs: [{ agent: "poteto-agent", model: "model-1", workflow: { playbook: "feature", assignment: "owner" } }],
		}),
	);

	// Child result.json, result-index.json, COMMITTED, spawns, bindings are all MISSING
	// None of these missing optional files should count as corrupt!
	const report = await collectTelemetryData({
		backgroundRoot: bgRoot,
		sessionsDir: sessRoot,
	});

	const corrupt = report.recoverableAndMissingMetrics.corruptOrUnparseableRecords;
	assert.equal(corrupt.sessionFiles, 0);
	assert.equal(corrupt.manifestFiles, 0);
	assert.equal(corrupt.resultIndexFiles, 0);
	assert.equal(corrupt.childResultFiles, 0);
	assert.equal(corrupt.spawnRecordFiles, 0);
	assert.equal(corrupt.bindingFiles, 0);
});

test("time filtering bounds session and workflow telemetry", async (t) => {
	const dir = await temporaryDirectory(t);
	const bgRoot = join(dir, "background");
	const sessRoot = join(dir, "sessions");
	const sessDir = join(bgRoot, "session-filter");
	const wfDir1 = join(sessDir, "workflows", "wf-early");
	const wfDir2 = join(sessDir, "workflows", "wf-late");

	await mkdir(join(wfDir1, "children", "0"), { recursive: true });
	await mkdir(join(wfDir2, "children", "0"), { recursive: true });
	await mkdir(join(sessRoot, "proj"), { recursive: true });

	await writeFile(
		join(sessRoot, "proj", "session.jsonl"),
		JSON.stringify({ type: "session", id: "session-filter", timestamp: "2026-08-25T08:00:00.000Z" }) +
			"\n" +
			JSON.stringify({ type: "session_end", timestamp: "2026-08-25T08:30:00.000Z" }) +
			"\n",
	);

	await writeFile(
		join(wfDir1, "manifest.json"),
		JSON.stringify({
			schemaVersion: "dstack.workflow.v1",
			workflowId: "wf-early",
			createdAt: "2026-08-25T08:05:00.000Z",
			specs: [{ agent: "poteto-agent", workflow: { playbook: "investigation", assignment: "owner" } }],
		}),
	);

	await writeFile(
		join(wfDir2, "manifest.json"),
		JSON.stringify({
			schemaVersion: "dstack.workflow.v1",
			workflowId: "wf-late",
			createdAt: "2026-08-25T20:00:00.000Z",
			specs: [{ agent: "poteto-agent", workflow: { playbook: "feature", assignment: "owner" } }],
		}),
	);

	const reportFiltered = await collectTelemetryData({
		backgroundRoot: bgRoot,
		sessionsDir: sessRoot,
		timeWindow: {
			from: "2026-08-25T07:00:00.000Z",
			to: "2026-08-25T10:00:00.000Z",
		},
	});

	assert.equal(reportFiltered.workflowSelections.totalWorkflows, 1);
	assert.equal(reportFiltered.workflowSelections.byPlaybook["investigation"], 1);
	assert.equal(reportFiltered.workflowSelections.byPlaybook["feature"], undefined);
});

test("CLI handles --help, human-readable formatting, and JSON output", async () => {
	const report: TelemetryReportV1 = {
		schemaVersion: "dstack.telemetry-report.v1",
		generatedAt: "2026-08-25T12:00:00.000Z",
		reportPeriod: {
			earliestTimestamp: "2026-08-25T10:00:00.000Z",
			latestTimestamp: "2026-08-25T12:00:00.000Z",
		},
		workflowSelections: {
			totalWorkflows: 1,
			byPlaybook: { feature: 1 },
			byMode: { single: 1 },
			byOutcome: { succeeded: 1 },
		},
		rolesAndModels: {
			byPlaybook: { feature: { "feature-owner": { "test/model": 1 } } },
			byRole: { "feature-owner": { "test/model": 1 } },
		},
		runtimeDistributions: {
			owner: calculateQuantileDistribution([10000]),
			worker: calculateQuantileDistribution([5000]),
			reviewer: calculateQuantileDistribution([]),
			unassigned: calculateQuantileDistribution([]),
			all: calculateQuantileDistribution([10000, 5000]),
		},
		ownerDelegationCohorts: {
			delegatedOwners: {
				count: 1,
				runtime: calculateQuantileDistribution([10000]),
			},
			nonDelegatedOwners: {
				count: 0,
				runtime: calculateQuantileDistribution([]),
			},
			causalityLimitation: "cannot establish delegation causality",
		},
		roleModelReliability: [
			{
				role: "feature-owner",
				resolvedModel: "test/model",
				totalInvocations: 1,
				succeededCount: 1,
				failedCount: 0,
				abandonedCount: 0,
				observableRepeatedDelegationCount: 0,
				failureRate: 0,
			},
		],
		workerEconomics: {
			lightweightWorkerRuns: 1,
			lightweightWorkerRunsWithCost: 1,
			lightweightWorkerDirectCost: 0.005,
			ownerRuns: 1,
			ownerRunsWithCost: 1,
			ownerDirectCost: 0.05,
			ownerAverageCostPerRun: 0.05,
			lightweightWorkerAverageCostPerRun: 0.005,
			directCostIsLower: true,
			costSavingsRatio: 0.9,
			afterReworkEconomicsSupported: false,
			evaluationNote: "Direct comparison note",
		},
		queueEvents: {
			ticketCreated: 1,
			slotAcquired: 1,
			matchedAcquisitions: 1,
			missingAcquisitions: 0,
			orphanAcquisitions: 0,
			duplicateEventIds: 0,
			byDepth: { "1": 1 },
			byCapacityClass: { reserved: 1 },
			waitTime: calculateQuantileDistribution([100]),
		},
		dataJoinReliability: {
			manifestToSession: { total: 1, joined: 1, missingSession: 0, joinRate: 1.0 },
			committedToResultIndex: { totalCommitted: 1, joined: 1, missingResultIndex: 0, joinRate: 1.0 },
			manifestToChildResults: { totalExpectedChildren: 1, joinedChildResults: 1, missingChildResults: 0, joinRate: 1.0 },
			bindingsToWorkflows: { totalBindings: 1, joined: 1, danglingBindings: 0, joinRate: 1.0 },
			queueEventsToWorkflows: { totalEvents: 2, joined: 2, danglingEvents: 0, joinRate: 1.0 },
			totalJoinsAttempted: 6,
			totalJoinsSuccessful: 6,
			overallJoinRate: 1.0,
		},
		workflowOutcomeReliability: {
			totalWorkflows: 1,
			succeeded: 1,
			failed: 0,
			cancelled: 0,
			uncommittedOrAbandoned: 0,
			successRate: 1.0,
			byMode: { single: { total: 1, succeeded: 1, failed: 0, cancelled: 0, uncommittedOrAbandoned: 0, successRate: 1.0 } },
		},
		recoverableAndMissingMetrics: {
			scannedSessions: 1,
			scannedWorkflows: 1,
			scannedChildren: 2,
			corruptOrUnparseableRecords: {
				sessionFiles: 0,
				manifestFiles: 0,
				resultIndexFiles: 0,
				childResultFiles: 0,
				spawnRecordFiles: 0,
				bindingFiles: 0,
				queueEventFiles: 0,
			},
			recoverableMetrics: ["metric 1"],
			missingOrUnsupportedMetrics: [{ metric: "m1", reason: "r1", explicitLimitation: "l1" }],
		},
	};

	const formatted = formatReportHumanReadable(report);
	assert.ok(formatted.includes("dstack Telemetry Report"));
	assert.ok(formatted.includes("1. Workflow Selections (Top-Level Owner Workflows):"));
	assert.ok(formatted.includes("4. Owner Delegation Cohorts (Observational):"));
	assert.ok(formatted.includes("6. Worker Economics (Direct Cost Comparison):"));
	assert.ok(formatted.includes("7. Durable Queue Events:"));
	assert.ok(formatted.includes("8. Data Join Reliability:"));

	const code = await runTelemetryCli(["--help"]);
	assert.equal(code, 0);
});
