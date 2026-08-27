import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { atomicWriteFile, sealBytes } from "../extensions/background/artifacts.ts";
import { commitWorkflowResult, readCommittedWorkflowResult } from "../extensions/background/runner.ts";
import {
	cleanupStaleChildSessions,
	DEFAULT_SESSION_RETENTION_MS,
	parseChildSessionRef,
	readChildSessionRef,
	sessionRetentionMs,
	type ChildSessionRefV1,
} from "../extensions/background/session.ts";
import { buildTreeSnapshot, parseSpawnRecordV1, type SessionRefCache, type SpawnRecordV1 } from "../extensions/background/tree.ts";
import {
	createLocalSlotAcquirer,
	executeWorkflow,
	INDEX_SUMMARY_TEXT_CAP,
	type ResolvedChildSpec,
	type WorkflowExecutionResult,
	type WorkflowManifestV1,
} from "../extensions/background/workflow.ts";
import { SESSION_REF_ENV } from "../extensions/types.ts";
import type { ChildResult } from "../extensions/spawn.ts";

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-session-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

async function writeSessionJsonl(sessionDir: string, sessionId: string): Promise<string> {
	await mkdir(sessionDir, { recursive: true, mode: 0o700 });
	const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
	const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: sessionDir };
	await writeFile(sessionFile, `${JSON.stringify(header)}\n{"type":"model_change","id":"x"}\n`, { mode: 0o600 });
	return sessionFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refRecord(input: Readonly<{ sessionId: string; sessionFile: string; sessionDir: string }>): ChildSessionRefV1 {
	return {
		schemaVersion: "dstack.child-session.v1",
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
		sessionDir: input.sessionDir,
		createdAt: new Date().toISOString(),
	};
}

test("readChildSessionRef accepts a child-written reference to a contained session", async (t) => {
	const root = await temporaryDirectory(t);
	const sessionDir = join(root, "session");
	const sessionFile = await writeSessionJsonl(sessionDir, "sess-1");
	const refPath = join(root, "session-ref.json");
	await writeFile(refPath, JSON.stringify(refRecord({ sessionId: "sess-1", sessionFile, sessionDir })), { mode: 0o600 });
	const ref = await readChildSessionRef({ refPath, sessionDir });
	assert.ok(ref !== undefined);
	assert.equal(ref.sessionId, "sess-1");
	assert.equal(ref.sessionFile, sessionFile);
	assert.equal(ref.sessionDir, sessionDir);
});

test("readChildSessionRef rejects escapes, symlinks, and identity mismatches", async (t) => {
	const root = await temporaryDirectory(t);
	const sessionDir = join(root, "session");
	const sessionFile = await writeSessionJsonl(sessionDir, "sess-1");
	const refPath = join(root, "session-ref.json");
	const good = refRecord({ sessionId: "sess-1", sessionFile, sessionDir });

	await writeFile(refPath, JSON.stringify({ ...good, sessionId: "other-session" }), { mode: 0o600 });
	assert.equal(await readChildSessionRef({ refPath, sessionDir }), undefined);

	const outsideFile = await writeSessionJsonl(join(root, "elsewhere"), "sess-1");
	await writeFile(refPath, JSON.stringify({ ...good, sessionFile: outsideFile }), { mode: 0o600 });
	assert.equal(await readChildSessionRef({ refPath, sessionDir }), undefined);

	await writeFile(refPath, JSON.stringify({ ...good, sessionDir: join(root, "elsewhere") }), { mode: 0o600 });
	assert.equal(await readChildSessionRef({ refPath, sessionDir }), undefined);

	await writeFile(refPath, JSON.stringify(good), { mode: 0o600 });
	const linkPath = join(root, "session-ref-link.json");
	await symlink(refPath, linkPath);
	assert.equal(await readChildSessionRef({ refPath: linkPath, sessionDir }), undefined);

	const escaped = await writeSessionJsonl(join(root, "outside-session"), "sess-1");
	const linkedFile = join(sessionDir, "linked.jsonl");
	await symlink(escaped, linkedFile);
	await writeFile(refPath, JSON.stringify({ ...good, sessionFile: linkedFile }), { mode: 0o600 });
	assert.equal(await readChildSessionRef({ refPath, sessionDir }), undefined);

	await writeFile(refPath, "not json", { mode: 0o600 });
	assert.equal(await readChildSessionRef({ refPath, sessionDir }), undefined);
	assert.equal(parseChildSessionRef({ ...good, sessionFile: "relative/path.jsonl" }), undefined);
	assert.equal(parseChildSessionRef({ ...good, schemaVersion: "dstack.child-session.v2" }), undefined);
});

const extensionSource = "extension.ts";

function spec(cwd: string, task: string): ResolvedChildSpec {
	return { agent: "general-purpose", task, cwd };
}

async function makeManifest(t: TestContext, specs: readonly [ResolvedChildSpec, ...ResolvedChildSpec[]], mode: "single" | "parallel" = "single"): Promise<WorkflowManifestV1> {
	const cwd = await temporaryDirectory(t);
	await writeFile(join(cwd, extensionSource), "", { mode: 0o600 });
	return {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-session-0123456789",
		sessionId: "session-test",
		schedulerRoot: join(cwd, "scheduler"),
		artifactDir: join(cwd, "artifacts"),
		extensionPath: join(cwd, extensionSource),
		piChildLaunch: { executable: process.execPath, argvPrefix: [] },
		mode,
		childDepth: 1,
		specs,
		createdAt: "2025-01-01T00:00:00.000Z",
	};
}

function childResult(text: string, exitCode = 0): ChildResult {
	return {
		text,
		exitCode,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

async function simulateChildSession(args: string[], env: Record<string, string>, sessionId: string): Promise<void> {
	const sessionDir = args[args.indexOf("--session-dir") + 1];
	const refPath = env[SESSION_REF_ENV];
	assert.ok(sessionDir !== undefined && refPath !== undefined);
	const sessionFile = await writeSessionJsonl(sessionDir, sessionId);
	await writeFile(refPath, `${JSON.stringify(refRecord({ sessionId, sessionFile, sessionDir }))}\n`, { mode: 0o600 });
}

test("depth-1 children run with contained native sessions recorded through the metadata env", async (t) => {
	const workflow = await makeManifest(t, [spec(tmpdir(), "task-a")]);
	const digest = "1".repeat(64);
	let sawNoSession = false;
	const execution = await executeWorkflow(workflow, digest, new AbortController().signal, {
		slots: createLocalSlotAcquirer(1),
		spawnChild: async ({ args, env }) => {
			sawNoSession = args.includes("--no-session");
			assert.equal(args[args.indexOf("--session-dir") + 1], join(workflow.artifactDir, "children", "0", "session"));
			assert.equal(env[SESSION_REF_ENV], join(workflow.artifactDir, "children", "0", "session-ref.json"));
			await simulateChildSession(args, env, "child-session-1");
			return childResult("done");
		},
	});
	assert.equal(sawNoSession, false);
	assert.equal(execution.children[0]?.session?.sessionId, "child-session-1");

	const rawMetadata: unknown = JSON.parse(await readFile(join(workflow.artifactDir, "children", "0", "result.json"), "utf8"));
	assert.ok(isRecord(rawMetadata));
	const sessionObj = isRecord(rawMetadata["session"]) ? rawMetadata["session"] : undefined;
	assert.equal(sessionObj?.["sessionId"], "child-session-1");

	await commitWorkflowResult(workflow, execution);
	const committed = await readCommittedWorkflowResult(workflow.artifactDir, digest, workflow.workflowId);
	assert.equal(committed.children[0]?.session?.sessionId, "child-session-1");
	assert.equal(committed.package.results[0]?.text, "done");

	await writeFile(join(workflow.artifactDir, "manifest.json"), JSON.stringify(workflow), "utf8");
	const snapshot = await buildTreeSnapshot({
		taskId: "task-session",
		workflowId: workflow.workflowId,
		artifactDir: workflow.artifactDir,
		schedulerRoot: workflow.schedulerRoot,
	});
	assert.equal(snapshot?.children[0]?.session?.sessionId, "child-session-1");
});

test("committed result-index is compact v2 with bounded summaries and sealed result refs only", async (t) => {
	const bigText = "x".repeat(INDEX_SUMMARY_TEXT_CAP + 4096);
	const workflow = await makeManifest(t, [spec(tmpdir(), "big-task")]);
	const digest = "2".repeat(64);
	const execution = await executeWorkflow(workflow, digest, new AbortController().signal, {
		spawnChild: async () => childResult(bigText),
	});
	await commitWorkflowResult(workflow, execution);

	const raw: unknown = JSON.parse(await readFile(join(workflow.artifactDir, "result-index.json"), "utf8"));
	assert.ok(isRecord(raw));
	assert.equal(raw["schemaVersion"], "dstack.result-index.v2");
	assert.equal("package" in raw, false);
	const rawChildren = Array.isArray(raw["children"]) ? raw["children"] : [];
	assert.equal(rawChildren.length, 1);
	const firstChild = isRecord(rawChildren[0]) ? rawChildren[0] : {};
	assert.equal(firstChild["output"], undefined);
	assert.ok(typeof firstChild["result"] === "object" && firstChild["result"] !== null);
	const summaryObj = isRecord(firstChild["summary"]) ? firstChild["summary"] : {};
	const summaryText = typeof summaryObj["text"] === "string" ? summaryObj["text"] : "";
	assert.ok(Buffer.byteLength(summaryText, "utf8") <= INDEX_SUMMARY_TEXT_CAP + 128);
	assert.ok(summaryText.includes("[truncated"));

	const committed = await readCommittedWorkflowResult(workflow.artifactDir, digest, workflow.workflowId);
	assert.equal(committed.package.results[0]?.text, bigText);
	assert.equal(committed.outcome, "succeeded");
	assert.equal(committed.summary.succeeded, 1);
});

test("committed reader rejects a re-sealed v2 index whose child state contradicts sealed metadata", async (t) => {
	const workflow = await makeManifest(t, [spec(tmpdir(), "flip-me")]);
	const digest = "3".repeat(64);
	const execution = await executeWorkflow(workflow, digest, new AbortController().signal, {
		spawnChild: async () => childResult("fine"),
	});
	await commitWorkflowResult(workflow, execution);

	const indexPath = join(workflow.artifactDir, "result-index.json");
	const rawTampered: unknown = JSON.parse(await readFile(indexPath, "utf8"));
	assert.ok(isRecord(rawTampered));
	const tamperedChildren = Array.isArray(rawTampered["children"]) ? rawTampered["children"] : [];
	const firstTampered = isRecord(tamperedChildren[0]) ? tamperedChildren[0] : {};
	const tampered = {
		...rawTampered,
		outcome: "failed",
		summary: { total: 1, succeeded: 0, failed: 1, cancelled: 0 },
		children: [{ ...firstTampered, state: "failed" }],
	};
	const bytes = Buffer.from(`${JSON.stringify(tampered)}\n`);
	await atomicWriteFile(indexPath, bytes);
	const marker = {
		schemaVersion: "dstack.commit.v1",
		workflowId: workflow.workflowId,
		manifestSha256: digest,
		resultIndex: sealBytes(indexPath, bytes),
	};
	await atomicWriteFile(join(workflow.artifactDir, "COMMITTED"), `${JSON.stringify(marker)}\n`);
	await assert.rejects(readCommittedWorkflowResult(workflow.artifactDir, digest, workflow.workflowId), /identity mismatch/);
});

test("strict v1 history remains readable and fully verified", async (t) => {
	const workflow = await makeManifest(t, [spec(tmpdir(), "legacy")]);
	const digest = "4".repeat(64);
	const execution: WorkflowExecutionResult = await executeWorkflow(workflow, digest, new AbortController().signal, {
		spawnChild: async () => childResult("legacy output"),
	});
	const v1 = {
		schemaVersion: "dstack.result-index.v1",
		workflowId: execution.workflowId,
		manifestSha256: execution.manifestSha256,
		mode: execution.mode,
		outcome: execution.outcome,
		summary: execution.summary,
		package: execution.package,
		children: execution.children.map(({ index, state, output, result }) => ({ index, state, output, result })),
	};
	const indexPath = join(workflow.artifactDir, "result-index.json");
	const bytes = Buffer.from(`${JSON.stringify(v1)}\n`);
	await atomicWriteFile(indexPath, bytes);
	const marker = {
		schemaVersion: "dstack.commit.v1",
		workflowId: workflow.workflowId,
		manifestSha256: digest,
		resultIndex: sealBytes(indexPath, bytes),
	};
	await atomicWriteFile(join(workflow.artifactDir, "COMMITTED"), `${JSON.stringify(marker)}\n`);
	const committed = await readCommittedWorkflowResult(workflow.artifactDir, digest, workflow.workflowId);
	assert.equal(committed.outcome, "succeeded");
	assert.equal(committed.package.results[0]?.text, "legacy output");
	assert.equal(committed.children[0]?.output.path, join(workflow.artifactDir, "children", "0", "output.txt"));

	const corrupt = { ...v1, workflowId: "other" };
	const corruptBytes = Buffer.from(`${JSON.stringify(corrupt)}\n`);
	await atomicWriteFile(indexPath, corruptBytes);
	await atomicWriteFile(join(workflow.artifactDir, "COMMITTED"), `${JSON.stringify({ ...marker, resultIndex: sealBytes(indexPath, corruptBytes) })}\n`);
	await assert.rejects(readCommittedWorkflowResult(workflow.artifactDir, digest, workflow.workflowId), /identity mismatch/);
});

test("spawn records carry validated depth-2 session references", () => {
	const record: SpawnRecordV1 = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-1",
		parentIndex: 0,
		groupId: "group-1",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				taskPreview: "nested task",
				state: "succeeded",
				updatedAt: "2025-01-01T00:01:00.000Z",
				session: refRecord({
					sessionId: "nested-session",
					sessionFile: "/abs/sessions/group-1-0/session/nested-session.jsonl",
					sessionDir: "/abs/sessions/group-1-0/session",
				}),
			},
		],
	};
	const parsed = parseSpawnRecordV1(JSON.parse(JSON.stringify(record)));
	assert.equal(parsed?.children[0]?.session?.sessionId, "nested-session");

	const rawInvalid: unknown = JSON.parse(JSON.stringify(record));
	assert.ok(isRecord(rawInvalid) && Array.isArray(rawInvalid["children"]));
	const invalidChild = isRecord(rawInvalid["children"][0]) ? { ...rawInvalid["children"][0] } : {};
	const invalidSession = isRecord(invalidChild["session"]) ? { ...invalidChild["session"], sessionFile: "relative.jsonl" } : undefined;
	const invalid = { ...rawInvalid, children: [{ ...invalidChild, session: invalidSession }] };
	assert.equal(parseSpawnRecordV1(invalid)?.children[0]?.session, undefined);
});

async function ageRecursively(path: string, ageMs: number): Promise<void> {
	const stamp = new Date(Date.now() - ageMs);
	const walk = async (current: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const child = join(current, entry.name);
			if (entry.isDirectory()) await walk(child);
			await utimes(child, stamp, stamp).catch(() => undefined);
		}
		await utimes(current, stamp, stamp).catch(() => undefined);
	};
	await walk(path);
}

async function exists(path: string): Promise<boolean> {
	try {
		await readdir(path);
		return true;
	} catch {
		return false;
	}
}

test("retention deletes only stale uncommitted inactive child session dirs", async (t) => {
	const root = await temporaryDirectory(t);
	const dayMs = 24 * 60 * 60 * 1000;
	const mkSession = async (workflowId: string, childName: string, nested?: string) => {
		const childDir = join(root, "workflows", workflowId, "children", childName);
		const target = nested === undefined ? join(childDir, "session") : join(childDir, "sessions", nested);
		await writeSessionJsonl(nested === undefined ? target : join(target, "session"), `${workflowId}-${childName}`);
		return target;
	};

	const staleUncommitted = await mkSession("wf-stale", "0");
	const staleNested = await mkSession("wf-stale", "0", "group-1-0");
	const staleCommitted = await mkSession("wf-committed", "0");
	await writeFile(join(root, "workflows", "wf-committed", "COMMITTED"), "{}", { mode: 0o600 });
	const freshUncommitted = await mkSession("wf-fresh", "0");
	const staleActive = await mkSession("wf-active", "0");

	await ageRecursively(join(root, "workflows", "wf-stale"), 10 * dayMs);
	await ageRecursively(join(root, "workflows", "wf-committed", "children"), 10 * dayMs);
	await ageRecursively(join(root, "workflows", "wf-active"), 10 * dayMs);

	const leaseDir = join(root, "scheduler", "leases");
	await mkdir(leaseDir, { recursive: true, mode: 0o700 });
	await writeFile(join(leaseDir, "lease-1.json"), JSON.stringify({
		schemaVersion: "dstack.scheduler.lease.v2",
		seq: 1,
		nonce: "nonce-1",
		workflowId: "wf-active",
		childId: "0",
		depth: 1,
		capacityClass: "reserved",
		owner: { pid: process.pid, startToken: "unprovable" },
		acquiredAt: new Date().toISOString(),
	}), { mode: 0o600 });

	const removed = await cleanupStaleChildSessions({ root, maxAgeMs: 7 * dayMs });
	assert.equal(removed, 2);
	assert.equal(await exists(staleUncommitted), false);
	assert.equal(await exists(staleNested), false);
	assert.equal(await exists(staleCommitted), true);
	assert.equal(await exists(freshUncommitted), true);
	assert.equal(await exists(staleActive), true);
});

test("session retention window is configurable and fails safe", () => {
	assert.equal(sessionRetentionMs({}), DEFAULT_SESSION_RETENTION_MS);
	assert.equal(sessionRetentionMs({ DSTACK_SESSION_RETENTION_MS: "5000" }), 5000);
	assert.equal(sessionRetentionMs({ DSTACK_SESSION_RETENTION_MS: "-3" }), DEFAULT_SESSION_RETENTION_MS);
	assert.equal(sessionRetentionMs({ DSTACK_SESSION_RETENTION_MS: "soon" }), DEFAULT_SESSION_RETENTION_MS);
});

test("buildTreeSnapshot derives depth-2 session ref from layout and uses bounded ref cache", async (t) => {
	const root = await temporaryDirectory(t);
	const artifactDir = join(root, "workflows", "wf-nested-session");
	const schedulerRoot = join(root, "scheduler");
	await mkdir(join(artifactDir, "children", "0", "spawns"), { recursive: true });
	await mkdir(join(schedulerRoot, "leases"), { recursive: true });

	const manifest = {
		schemaVersion: "dstack.workflow.v1",
		workflowId: "wf-nested-session",
		sessionId: "sess-root",
		mode: "single",
		createdAt: "2025-01-01T00:00:00.000Z",
		specs: [{ agent: "poteto-agent", task: "orchestrator" }],
	};
	await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

	const nestedBase = join(artifactDir, "children", "0", "sessions", "group-nested-0");
	const nestedSessionDir = join(nestedBase, "session");
	const nestedSessionFile = await writeSessionJsonl(nestedSessionDir, "depth2-session-id");
	const nestedRefPath = join(nestedBase, "session-ref.json");
	await writeFile(
		nestedRefPath,
		JSON.stringify(refRecord({ sessionId: "depth2-session-id", sessionFile: nestedSessionFile, sessionDir: nestedSessionDir })),
		"utf8",
	);

	const spawnRecord = {
		schemaVersion: "dstack.spawn-record.v1",
		workflowId: "wf-nested-session",
		parentIndex: 0,
		groupId: "group-nested",
		mode: "single",
		createdAt: "2025-01-01T00:01:00.000Z",
		children: [
			{
				nestedIndex: 0,
				agent: "general-purpose",
				taskPreview: "nested worker",
				state: "succeeded",
				updatedAt: "2025-01-01T00:02:00.000Z",
				session: refRecord({
					sessionId: "depth2-session-id",
					sessionFile: "/untrusted/bogus/path.jsonl",
					sessionDir: "/untrusted/bogus",
				}),
			},
		],
	};
	await writeFile(join(artifactDir, "children", "0", "spawns", "group-nested.json"), JSON.stringify(spawnRecord), "utf8");

	const cache: SessionRefCache = new Map();
	const snapshot = await buildTreeSnapshot({
		taskId: "task-nested-session",
		workflowId: "wf-nested-session",
		artifactDir,
		schedulerRoot,
		sessionRefCache: cache,
	});

	assert.ok(snapshot !== undefined);
	const parent = snapshot.children[0];
	assert.ok(parent !== undefined);
	assert.equal(parent.nested.length, 1);
	const nested = parent.nested[0];
	assert.ok(nested !== undefined && "session" in nested);
	assert.equal(nested.session?.sessionId, "depth2-session-id");
	assert.equal(nested.session?.sessionFile, nestedSessionFile);
	assert.equal(nested.session?.sessionDir, nestedSessionDir);

	assert.equal(cache.get(nestedRefPath)?.ref.sessionId, "depth2-session-id");

	const snapshotCached = await buildTreeSnapshot({
		taskId: "task-nested-session",
		workflowId: "wf-nested-session",
		artifactDir,
		schedulerRoot,
		sessionRefCache: cache,
	});
	const parentCached = snapshotCached?.children[0];
	const nestedCached = parentCached?.nested[0];
	assert.ok(nestedCached !== undefined && "session" in nestedCached);
	assert.equal(nestedCached.session?.sessionId, "depth2-session-id");

	await writeFile(nestedRefPath, "corrupt", "utf8");
	const snapshotInvalidated = await buildTreeSnapshot({
		taskId: "task-nested-session",
		workflowId: "wf-nested-session",
		artifactDir,
		schedulerRoot,
		sessionRefCache: cache,
	});
	const parentInvalidated = snapshotInvalidated?.children[0];
	const nestedInvalidated = parentInvalidated?.nested[0];
	assert.ok(nestedInvalidated !== undefined && "session" in nestedInvalidated);
	assert.equal(nestedInvalidated.session, undefined);
});
