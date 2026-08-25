import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Readable, Writable } from "node:stream";
import { toAbsolutePath } from "../extensions/background/artifacts.ts";
import {
	acquireChildSlot,
	MAX_ACTIVE_CHILDREN,
	type ChildDepth,
} from "../extensions/background/scheduler.ts";

const workerPath = fileURLToPath(new URL("./fixtures/background-scheduler-worker.ts", import.meta.url));

async function temporaryRoot(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "dstack-scheduler-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

type Worker = Readonly<{
	childId: string;
	send: (command: string) => void;
	/** Consumes and awaits the next unconsumed occurrence of the line. */
	waitForLine: (line: string) => Promise<void>;
	exited: Promise<number | null>;
	kill: () => void;
}>;

type SpawnOptions = Readonly<{
	root: string;
	childId: string;
	depth: ChildDepth;
	canNest?: boolean;
}>;

function spawnWorker(t: TestContext, options: SpawnOptions): Worker {
	const args = [
		"--experimental-strip-types",
		"--disable-warning=ExperimentalWarning",
		workerPath,
		"--root",
		options.root,
		"--child",
		options.childId,
		"--depth",
		String(options.depth),
	];
	if (options.canNest === true) args.push("--can-nest");
	const child: ChildProcessByStdio<Writable, Readable, null> = spawn(process.execPath, args, {
		stdio: ["pipe", "pipe", "inherit"],
	});
	const unconsumed: string[] = [];
	const waiters: Array<{ line: string; resolve: () => void; reject: (error: Error) => void }> = [];
	let buffer = "";
	let exitCode: number | null | undefined;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const waiterIndex = waiters.findIndex((waiter) => waiter.line === line);
			if (waiterIndex >= 0) {
				const [waiter] = waiters.splice(waiterIndex, 1);
				waiter?.resolve();
			} else {
				unconsumed.push(line);
			}
		}
	});
	const exited = new Promise<number | null>((resolve) => {
		child.on("exit", (code) => {
			exitCode = code;
			resolve(code);
			for (const waiter of waiters.splice(0)) {
				waiter.reject(new Error(`worker ${options.childId} exited (code ${code}) before printing "${waiter.line}"`));
			}
		});
	});
	t.after(() => {
		if (exitCode === undefined) child.kill("SIGKILL");
	});
	return {
		childId: options.childId,
		send: (command) => {
			child.stdin.write(`${command}\n`);
		},
		waitForLine: (line) => {
			const index = unconsumed.indexOf(line);
			if (index >= 0) {
				unconsumed.splice(index, 1);
				return Promise.resolve();
			}
			if (exitCode !== undefined) {
				return Promise.reject(
					new Error(`worker ${options.childId} exited (code ${exitCode}) before printing "${line}"`),
				);
			}
			return new Promise((resolve, reject) => {
				waiters.push({ line, resolve, reject });
			});
		},
		exited,
		kill: () => child.kill("SIGKILL"),
	};
}

/** Poll for a state to appear. Deterministic: waits for events, never asserts on elapsed time. */
async function waitForState<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

async function listJsonFiles(dir: string): Promise<readonly string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

async function leaseFiles(root: string): Promise<readonly string[]> {
	return listJsonFiles(join(root, "leases"));
}

async function ticketFiles(root: string): Promise<readonly string[]> {
	return listJsonFiles(join(root, "tickets"));
}

async function leaseChildIds(root: string): Promise<readonly string[]> {
	const dir = join(root, "leases");
	const ids: string[] = [];
	for (const name of await leaseFiles(root)) {
		try {
			const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
			if (typeof parsed === "object" && parsed !== null && "childId" in parsed && typeof parsed.childId === "string") {
				ids.push(parsed.childId);
			}
		} catch {
			// A file removed between listing and reading is not a lease anymore.
		}
	}
	return ids.sort();
}

async function acquireWorkers(t: TestContext, root: string, specs: readonly SpawnOptions[]): Promise<Worker[]> {
	const workers = specs.map((spec) => spawnWorker(t, spec));
	for (const worker of workers) await worker.waitForLine("acquired");
	return workers;
}

test("four slots cap admission; releasing one admits the fifth waiter", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "w1", depth: 1, canNest: true },
		{ root, childId: "w2", depth: 1, canNest: true },
		{ root, childId: "w3", depth: 1, canNest: true },
		{ root, childId: "w4", depth: 1 },
	]);
	assert.equal((await leaseFiles(root)).length, MAX_ACTIVE_CHILDREN);

	const fifth = spawnWorker(t, { root, childId: "w5", depth: 1 });
	await waitForState("the fifth waiter to enqueue a ticket", async () =>
		(await ticketFiles(root)).length === 1 ? true : undefined,
	);
	assert.equal((await leaseFiles(root)).length, MAX_ACTIVE_CHILDREN);
	assert.deepEqual(await leaseChildIds(root), ["w1", "w2", "w3", "w4"]);

	const [first, ...rest] = holders;
	assert.ok(first !== undefined);
	first.send("release");
	await first.waitForLine("released");
	await fifth.waitForLine("acquired");
	assert.deepEqual(await leaseChildIds(root), ["w2", "w3", "w4", "w5"]);
	assert.deepEqual(await ticketFiles(root), []);

	for (const worker of [...rest, fifth]) {
		worker.send("release");
		await worker.waitForLine("released");
	}
	assert.deepEqual(await leaseFiles(root), []);
});

test("a depth-2 ticket bypasses a blocked nesting-capable depth-1 ticket", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "n1", depth: 1, canNest: true },
		{ root, childId: "n2", depth: 1, canNest: true },
		{ root, childId: "n3", depth: 1, canNest: true },
	]);

	// The nesting reserve blocks a fourth nesting-capable depth-1 child even
	// though one slot is free.
	const blocked = spawnWorker(t, { root, childId: "n4", depth: 1, canNest: true });
	await waitForState("the blocked depth-1 ticket to enqueue", async () =>
		(await ticketFiles(root)).length === 1 ? true : undefined,
	);

	const terminal = spawnWorker(t, { root, childId: "d2", depth: 2 });
	await terminal.waitForLine("acquired");
	assert.deepEqual(await leaseChildIds(root), ["d2", "n1", "n2", "n3"]);
	assert.equal((await ticketFiles(root)).length, 1, "the bypassed depth-1 ticket must stay queued");

	const [first] = holders;
	assert.ok(first !== undefined);
	first.send("release");
	await first.waitForLine("released");
	await blocked.waitForLine("acquired");
	assert.deepEqual(await leaseChildIds(root), ["d2", "n2", "n3", "n4"]);
	assert.deepEqual(await ticketFiles(root), []);
});

test("aborting a queued waiter removes its ticket and leaves holders untouched", async (t) => {
	const root = await temporaryRoot(t);
	await acquireWorkers(t, root, [
		{ root, childId: "h1", depth: 1 },
		{ root, childId: "h2", depth: 1 },
		{ root, childId: "h3", depth: 1 },
		{ root, childId: "h4", depth: 1 },
	]);

	const waiter = spawnWorker(t, { root, childId: "h5", depth: 1 });
	await waitForState("the waiter ticket to enqueue", async () =>
		(await ticketFiles(root)).length === 1 ? true : undefined,
	);
	waiter.send("abort");
	await waiter.waitForLine("aborted");
	assert.equal(await waiter.exited, 0);
	await waitForState("the aborted ticket to be removed", async () =>
		(await ticketFiles(root)).length === 0 ? true : undefined,
	);
	assert.deepEqual(await leaseChildIds(root), ["h1", "h2", "h3", "h4"]);
});

test("a provably dead owner's stale lease is reclaimed", async (t) => {
	const root = await temporaryRoot(t);
	const [dead] = await acquireWorkers(t, root, [
		{ root, childId: "dead", depth: 1 },
		{ root, childId: "live1", depth: 1 },
		{ root, childId: "live2", depth: 1 },
		{ root, childId: "live3", depth: 1 },
	]);
	assert.ok(dead !== undefined);
	dead.send("exit-holding");
	assert.equal(await dead.exited, 0);
	// The dead worker's lease file survives its process.
	assert.deepEqual(await leaseChildIds(root), ["dead", "live1", "live2", "live3"]);

	const successor = spawnWorker(t, { root, childId: "successor", depth: 1 });
	await successor.waitForLine("acquired");
	assert.deepEqual(await leaseChildIds(root), ["live1", "live2", "live3", "successor"]);
});

test("live owners' leases survive a blocked waiter byte for byte", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "p1", depth: 1 },
		{ root, childId: "p2", depth: 1 },
		{ root, childId: "p3", depth: 1 },
		{ root, childId: "p4", depth: 1 },
	]);
	const leaseDir = join(root, "leases");
	const before = new Map<string, string>();
	for (const name of await leaseFiles(root)) {
		before.set(name, await readFile(join(leaseDir, name), "utf8"));
	}
	assert.equal(before.size, MAX_ACTIVE_CHILDREN);

	const waiter = spawnWorker(t, { root, childId: "p5", depth: 1 });
	const [first, ...rest] = holders;
	assert.ok(first !== undefined);
	first.send("release");
	await first.waitForLine("released");
	// The waiter acquiring proves it ran admission passes against live leases.
	await waiter.waitForLine("acquired");

	const after = await leaseFiles(root);
	assert.equal(after.length, MAX_ACTIVE_CHILDREN);
	const firstLease = [...before.keys()].find((name) => !after.includes(name));
	for (const name of after) {
		if (before.has(name)) {
			assert.equal(await readFile(join(leaseDir, name), "utf8"), before.get(name));
		}
	}
	// Exactly one lease (the released holder's) left; exactly one (the waiter's) arrived.
	assert.equal([...before.keys()].filter((name) => !after.includes(name)).length, 1);
	assert.equal(after.filter((name) => !before.has(name)).length, 1);
	assert.ok(firstLease !== undefined);
	void rest;
});

test("release is idempotent within and across calls", async (t) => {
	const root = await temporaryRoot(t);
	const lease = await acquireChildSlot({
		schedulerRoot: toAbsolutePath(root),
		workflowId: "wf-idempotent",
		childId: "solo",
		depth: 1,
		canNest: false,
		signal: new AbortController().signal,
	});
	assert.equal((await leaseFiles(root)).length, 1);

	const first = lease.release();
	const second = lease.release();
	assert.equal(first, second, "repeated release must return the same settled promise");
	await first;
	await lease.release();
	assert.deepEqual(await leaseFiles(root), []);

	// A worker double-release over the wire is also idempotent.
	const worker = spawnWorker(t, { root, childId: "again", depth: 1 });
	await worker.waitForLine("acquired");
	worker.send("release");
	await worker.waitForLine("released");
	worker.send("release");
	await worker.waitForLine("released");
	assert.deepEqual(await leaseFiles(root), []);
});

test("depth-2 tickets must be terminal", async () => {
	await assert.rejects(
		acquireChildSlot({
			schedulerRoot: toAbsolutePath(tmpdir()),
			workflowId: "wf-invalid",
			childId: "bad",
			depth: 2,
			canNest: true,
			signal: new AbortController().signal,
		}),
		/terminal/,
	);
});
