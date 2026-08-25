import assert from "node:assert/strict";
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { Readable, Writable } from "node:stream";
import { toAbsolutePath } from "../extensions/background/artifacts.ts";
import {
	acquireChildSlot,
	proveStaticallyNonNesting,
	MAX_ACTIVE_CHILDREN,
	__schedulerInternalsForTesting as internals,
	type ChildDepth,
	type NonNestingProof,
} from "../extensions/background/scheduler.ts";

const workerPath = fileURLToPath(new URL("./fixtures/background-scheduler-worker.ts", import.meta.url));

const LOCK_SCHEMA = "dstack.scheduler.lock.v2";
const CLAIM_SCHEMA = "dstack.scheduler.lockclaim.v1";
const LEASE_SCHEMA = "dstack.scheduler.lease.v2";
const TICKET_SCHEMA = "dstack.scheduler.ticket.v2";
/** Well-formed but never matching any real process start token. */
const MISMATCHED_TOKEN = "posix-lstart:proven-dead-token-mismatch";

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
	nonNesting?: boolean;
	cycles?: number;
	holdMs?: number;
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
	if (options.nonNesting === true) args.push("--non-nesting");
	if (options.cycles !== undefined) args.push("--cycles", String(options.cycles));
	if (options.holdMs !== undefined) args.push("--hold-ms", String(options.holdMs));
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

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
	let resolve = (): void => {
		throw new Error("deferred promise initialized without a resolver");
	};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
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

type CraftedOwner = Readonly<{ pid: number; startToken: string }>;

async function craftLease(
	root: string,
	input: Readonly<{ childId: string; owner: CraftedOwner; child?: CraftedOwner; seq?: number }>,
): Promise<string> {
	const nonce = `crafted-${input.childId}`;
	const record: Record<string, unknown> = {
		schemaVersion: LEASE_SCHEMA,
		seq: input.seq ?? 1,
		nonce,
		workflowId: "wf-crafted",
		childId: input.childId,
		depth: 1,
		capacityClass: "terminal",
		owner: input.owner,
		acquiredAt: new Date().toISOString(),
	};
	if (input.child !== undefined) {
		record.child = input.child;
		record.childBoundAt = new Date().toISOString();
	}
	const path = join(root, "leases", `${nonce}.json`);
	await writeFile(path, JSON.stringify(record), { mode: 0o600 });
	// Crafted records need a consistent sequence file or the scheduler fails closed.
	await writeFile(join(root, "seq"), "10", { mode: 0o600 });
	return path;
}

async function initializedRoot(t: TestContext): Promise<string> {
	const root = await temporaryRoot(t);
	await internals.ensureSchedulerDirs(toAbsolutePath(root));
	return root;
}

async function selfOwner(): Promise<CraftedOwner> {
	return { pid: process.pid, startToken: await internals.currentStartToken() };
}

function acquireTerminal(root: string, childId: string, signal?: AbortSignal) {
	return acquireChildSlot({
		schedulerRoot: toAbsolutePath(root),
		workflowId: "wf-inproc",
		childId,
		work: { depth: 2 },
		signal: signal ?? new AbortController().signal,
	});
}

// --- Capacity, FIFO, and reserve -------------------------------------------

test("four slots cap admission; releasing one admits the fifth waiter", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "w1", depth: 1 },
		{ root, childId: "w2", depth: 1 },
		{ root, childId: "w3", depth: 1 },
		{ root, childId: "w4", depth: 1, nonNesting: true },
	]);
	assert.equal((await leaseFiles(root)).length, MAX_ACTIVE_CHILDREN);

	const fifth = spawnWorker(t, { root, childId: "w5", depth: 1, nonNesting: true });
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

test("the nesting reserve holds and terminal tickets bypass a blocked reserved ticket", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "n1", depth: 1 },
		{ root, childId: "n2", depth: 1 },
		{ root, childId: "n3", depth: 1 },
	]);

	// The nesting reserve blocks a fourth reserved depth-1 child even though
	// one slot is free.
	const blocked = spawnWorker(t, { root, childId: "n4", depth: 1 });
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

test("a proven non-nesting depth-1 child may take slot four past a blocked reserved ticket", async (t) => {
	const root = await temporaryRoot(t);
	await acquireWorkers(t, root, [
		{ root, childId: "r1", depth: 1 },
		{ root, childId: "r2", depth: 1 },
		{ root, childId: "r3", depth: 1 },
	]);
	const blocked = spawnWorker(t, { root, childId: "r4", depth: 1 });
	await waitForState("the blocked reserved ticket to enqueue", async () =>
		(await ticketFiles(root)).length === 1 ? true : undefined,
	);
	const proven = spawnWorker(t, { root, childId: "t1", depth: 1, nonNesting: true });
	await proven.waitForLine("acquired");
	assert.deepEqual(await leaseChildIds(root), ["r1", "r2", "r3", "t1"]);
	assert.equal((await ticketFiles(root)).length, 1);
	void blocked;
});

test("FIFO order holds under contention", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "f1", depth: 1, nonNesting: true },
		{ root, childId: "f2", depth: 1, nonNesting: true },
		{ root, childId: "f3", depth: 1, nonNesting: true },
		{ root, childId: "f4", depth: 1, nonNesting: true },
	]);
	const waiters: Worker[] = [];
	for (const [index, childId] of ["q1", "q2", "q3"].entries()) {
		waiters.push(spawnWorker(t, { root, childId, depth: 1, nonNesting: true }));
		await waitForState(`waiter ${childId} to enqueue`, async () =>
			(await ticketFiles(root)).length === index + 1 ? true : undefined,
		);
	}
	for (const [index, waiter] of waiters.entries()) {
		const holder = holders[index];
		assert.ok(holder !== undefined);
		holder.send("release");
		await holder.waitForLine("released");
		await waiter.waitForLine("acquired");
		const ids = await leaseChildIds(root);
		assert.ok(ids.includes(waiter.childId), `waiter ${waiter.childId} must be admitted in FIFO order`);
		for (const later of waiters.slice(index + 1)) {
			assert.ok(!ids.includes(later.childId), `waiter ${later.childId} must not jump the queue`);
		}
	}
});

test("stress: peak concurrency never exceeds four across many real worker processes", async (t) => {
	const root = await temporaryRoot(t);
	const specs: SpawnOptions[] = [
		{ root, childId: "s1", depth: 1, cycles: 3, holdMs: 25 },
		{ root, childId: "s2", depth: 1, cycles: 3, holdMs: 25 },
		{ root, childId: "s3", depth: 1, cycles: 3, holdMs: 25 },
		{ root, childId: "s4", depth: 1, nonNesting: true, cycles: 3, holdMs: 25 },
		{ root, childId: "s5", depth: 1, nonNesting: true, cycles: 3, holdMs: 25 },
		{ root, childId: "s6", depth: 1, nonNesting: true, cycles: 3, holdMs: 25 },
		{ root, childId: "s7", depth: 2, cycles: 3, holdMs: 25 },
		{ root, childId: "s8", depth: 2, cycles: 3, holdMs: 25 },
	];
	const workers = specs.map((spec) => spawnWorker(t, spec));
	let done = false;
	let peak = 0;
	const monitor = (async () => {
		while (!done) {
			peak = Math.max(peak, (await leaseFiles(root)).length);
			await sleep(5);
		}
	})();
	for (const worker of workers) {
		await worker.waitForLine("all-cycles-done");
		assert.equal(await worker.exited, 0);
	}
	done = true;
	await monitor;
	assert.ok(peak <= MAX_ACTIVE_CHILDREN, `observed ${peak} concurrent leases`);
	assert.ok(peak >= 1, "the monitor must observe at least one lease");
	assert.deepEqual(await leaseFiles(root), []);
	assert.deepEqual(await ticketFiles(root), []);
});

// --- Abort ------------------------------------------------------------------

test("aborting a queued waiter removes its ticket and leaves holders untouched", async (t) => {
	const root = await temporaryRoot(t);
	await acquireWorkers(t, root, [
		{ root, childId: "h1", depth: 1 },
		{ root, childId: "h2", depth: 1 },
		{ root, childId: "h3", depth: 1 },
		{ root, childId: "h4", depth: 1, nonNesting: true },
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

test("an abort that races admission releases the just-granted lease and rejects", async (t) => {
	const root = await temporaryRoot(t);
	const controller = new AbortController();
	await assert.rejects(
		acquireChildSlot({
			schedulerRoot: toAbsolutePath(root),
			workflowId: "wf-abort-race",
			childId: "raced",
			work: { depth: 2 },
			signal: controller.signal,
			__testHooks: {
				afterAdmission: () => {
					controller.abort(new Error("raced abort"));
				},
			},
		}),
		/raced abort/,
	);
	assert.deepEqual(await leaseFiles(root), []);
	assert.deepEqual(await ticketFiles(root), []);
});

// --- Lease reclamation and liveness -----------------------------------------

test("a provably dead owner's stale lease is reclaimed", async (t) => {
	const root = await temporaryRoot(t);
	const [dead] = await acquireWorkers(t, root, [
		{ root, childId: "dead", depth: 1, nonNesting: true },
		{ root, childId: "live1", depth: 1 },
		{ root, childId: "live2", depth: 1 },
		{ root, childId: "live3", depth: 1 },
	]);
	assert.ok(dead !== undefined);
	dead.send("exit-holding");
	assert.equal(await dead.exited, 0);
	// The dead worker's lease file survives its process.
	assert.deepEqual(await leaseChildIds(root), ["dead", "live1", "live2", "live3"]);

	const successor = spawnWorker(t, { root, childId: "successor", depth: 1, nonNesting: true });
	await successor.waitForLine("acquired");
	assert.deepEqual(await leaseChildIds(root), ["live1", "live2", "live3", "successor"]);
});

test("a dead runner's lease survives while its bound child is still alive", async (t) => {
	const root = await temporaryRoot(t);
	const sleeper: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {
		stdio: "ignore",
	});
	const sleeperExited = new Promise<void>((resolve) => sleeper.on("exit", () => resolve()));
	t.after(() => sleeper.kill("SIGKILL"));
	assert.ok(typeof sleeper.pid === "number");

	const [runner] = await acquireWorkers(t, root, [{ root, childId: "owner", depth: 1, nonNesting: true }]);
	assert.ok(runner !== undefined);
	runner.send(`bind ${sleeper.pid}`);
	await runner.waitForLine("bound");
	runner.send("exit-holding");
	assert.equal(await runner.exited, 0);

	// Fill the remaining three slots; the dead-runner lease must still count.
	await acquireWorkers(t, root, [
		{ root, childId: "l1", depth: 1 },
		{ root, childId: "l2", depth: 1 },
		{ root, childId: "l3", depth: 1 },
	]);
	const waiter = spawnWorker(t, { root, childId: "waiter", depth: 1, nonNesting: true });
	await waitForState("the waiter to enqueue", async () =>
		(await ticketFiles(root)).length === 1 ? true : undefined,
	);
	await sleep(400);
	assert.equal((await ticketFiles(root)).length, 1, "the waiter must stay queued while the child lives");
	assert.ok((await leaseChildIds(root)).includes("owner"), "the owner-dead child-live lease must survive");

	sleeper.kill("SIGKILL");
	await sleeperExited;
	await waiter.waitForLine("acquired");
	assert.ok(!(await leaseChildIds(root)).includes("owner"));
});

test("PID reuse: a live pid with a mismatched start token is proven dead and reclaimed", async (t) => {
	const root = await initializedRoot(t);
	const crafted = await craftLease(root, {
		childId: "reused-pid",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	const lease = await acquireTerminal(root, "claimant");
	assert.ok(!(await leaseChildIds(root)).includes("reused-pid"), "the token-mismatch lease must be reclaimed");
	await assert.rejects(readFile(crafted, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	await lease.release();
});

test("unknown owner liveness occupies the slot and blocks a fifth admission", async (t) => {
	const root = await initializedRoot(t);
	await craftLease(root, {
		childId: "unknown-owner",
		owner: { pid: process.pid, startToken: "unprovable" },
	});
	const held = await Promise.all([
		acquireTerminal(root, "k1"),
		acquireTerminal(root, "k2"),
		acquireTerminal(root, "k3"),
	]);
	await assert.rejects(
		acquireTerminal(root, "k4", AbortSignal.timeout(500)),
		(error: Error) => error.name === "TimeoutError" || error.name === "AbortError",
	);
	assert.ok((await leaseChildIds(root)).includes("unknown-owner"), "unknown liveness must keep occupying the slot");
	for (const lease of held) await lease.release();
});

test("a dead runner with an unknown-liveness bound child still occupies the slot", async (t) => {
	const root = await initializedRoot(t);
	await craftLease(root, {
		childId: "dead-runner-unknown-child",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
		child: { pid: process.pid, startToken: "unprovable" },
	});
	const held = await Promise.all([
		acquireTerminal(root, "u1"),
		acquireTerminal(root, "u2"),
		acquireTerminal(root, "u3"),
	]);
	await assert.rejects(
		acquireTerminal(root, "u4", AbortSignal.timeout(500)),
		(error: Error) => error.name === "TimeoutError" || error.name === "AbortError",
	);
	assert.ok((await leaseChildIds(root)).includes("dead-runner-unknown-child"));
	for (const lease of held) await lease.release();
});

test("live owners' leases survive a blocked waiter byte for byte", async (t) => {
	const root = await temporaryRoot(t);
	const holders = await acquireWorkers(t, root, [
		{ root, childId: "p1", depth: 1 },
		{ root, childId: "p2", depth: 1 },
		{ root, childId: "p3", depth: 1 },
		{ root, childId: "p4", depth: 1, nonNesting: true },
	]);
	const leaseDir = join(root, "leases");
	const before = new Map<string, string>();
	for (const name of await leaseFiles(root)) {
		before.set(name, await readFile(join(leaseDir, name), "utf8"));
	}
	assert.equal(before.size, MAX_ACTIVE_CHILDREN);

	const waiter = spawnWorker(t, { root, childId: "p5", depth: 1, nonNesting: true });
	const [first] = holders;
	assert.ok(first !== undefined);
	first.send("release");
	await first.waitForLine("released");
	// The waiter acquiring proves it ran admission passes against live leases.
	await waiter.waitForLine("acquired");

	const after = await leaseFiles(root);
	assert.equal(after.length, MAX_ACTIVE_CHILDREN);
	for (const name of after) {
		if (before.has(name)) {
			assert.equal(await readFile(join(leaseDir, name), "utf8"), before.get(name));
		}
	}
	// Exactly one lease (the released holder's) left; exactly one (the waiter's) arrived.
	assert.equal([...before.keys()].filter((name) => !after.includes(name)).length, 1);
	assert.equal(after.filter((name) => !before.has(name)).length, 1);
});

test("release is idempotent and binding after release fails", async (t) => {
	const root = await temporaryRoot(t);
	const lease = await acquireChildSlot({
		schedulerRoot: toAbsolutePath(root),
		workflowId: "wf-idempotent",
		childId: "solo",
		work: { depth: 1 },
		signal: new AbortController().signal,
	});
	assert.equal((await leaseFiles(root)).length, 1);

	const first = lease.release();
	const second = lease.release();
	assert.equal(first, second, "repeated release must return the same settled promise");
	await first;
	await lease.release();
	assert.deepEqual(await leaseFiles(root), []);
	await assert.rejects(lease.bindChild(process.pid), /released/);

	// A worker double-release over the wire is also idempotent.
	const worker = spawnWorker(t, { root, childId: "again", depth: 1 });
	await worker.waitForLine("acquired");
	worker.send("release");
	await worker.waitForLine("released");
	worker.send("release");
	await worker.waitForLine("released");
	assert.deepEqual(await leaseFiles(root), []);
});

// --- Lock hardening -----------------------------------------------------------

test("a corrupt scheduler lock fails closed: no wedge, no reset, no deletion", async (t) => {
	const root = await initializedRoot(t);
	const lockPath = join(root, "scheduler.lock");
	await writeFile(lockPath, "{ this is a torn or corrupt lock rec", { mode: 0o600 });
	await assert.rejects(acquireTerminal(root, "victim"), /corrupt/);
	assert.equal(await readFile(lockPath, "utf8"), "{ this is a torn or corrupt lock rec");
});

test("a stale lock held by a proven-dead owner is broken and acquisition proceeds", async (t) => {
	const root = await initializedRoot(t);
	const deadLock = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: "dead-lock-nonce",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	assert.ok(await internals.publishExclusive(join(root, "scheduler.lock"), deadLock));
	const lease = await acquireTerminal(root, "after-stale-lock");
	await lease.release();
	assert.deepEqual(await listJsonFiles(join(root, "lock-claims")), []);
});

test("a breaker never removes a live lock that replaced the proven-dead one", async (t) => {
	const root = await initializedRoot(t);
	const rootAbs = toAbsolutePath(root);
	const lockPath = join(root, "scheduler.lock");
	const deadLock = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: "lock-n1",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	const liveLock = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: "lock-n2",
		owner: await selfOwner(),
	});
	assert.ok(await internals.publishExclusive(lockPath, deadLock));
	await internals.tryBreakDeadLock(rootAbs, {
		afterDeadProof: async () => {
			// Another breaker wins in the window between proof and action.
			await rm(lockPath, { force: true });
			assert.ok(await internals.publishExclusive(lockPath, liveLock));
		},
	});
	assert.equal(await readFile(lockPath, "utf8"), liveLock, "the new live lock must survive");
	assert.deepEqual(await listJsonFiles(join(root, "lock-claims")), []);
});

test("a live recovery claim blocks every other breaker; only the claim holder may act", async (t) => {
	const root = await initializedRoot(t);
	const rootAbs = toAbsolutePath(root);
	const lockPath = join(root, "scheduler.lock");
	const claimPath = join(root, "lock-claims", "lock-n1.json");
	const deadLock = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: "lock-n1",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	assert.ok(await internals.publishExclusive(lockPath, deadLock));
	const liveClaim = JSON.stringify({
		schemaVersion: CLAIM_SCHEMA,
		lockNonce: "lock-n1",
		owner: await selfOwner(),
	});
	assert.ok(await internals.publishExclusive(claimPath, liveClaim));
	await internals.tryBreakDeadLock(rootAbs);
	assert.equal(await readFile(lockPath, "utf8"), deadLock, "a live claim must block other breakers");
	assert.equal(await readFile(claimPath, "utf8"), liveClaim, "a live claim must not be stolen");
	await rm(claimPath, { force: true });
	await internals.tryBreakDeadLock(rootAbs);
	await assert.rejects(readFile(lockPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("two stale claim observers cannot steal a replacement claim or admit a fifth lease", async (t) => {
	const root = await temporaryRoot(t);
	const held = await Promise.all([
		acquireTerminal(root, "held-1"),
		acquireTerminal(root, "held-2"),
		acquireTerminal(root, "held-3"),
		acquireTerminal(root, "held-4"),
	]);
	assert.equal(held.length, MAX_ACTIVE_CHILDREN);

	const rootAbs = toAbsolutePath(root);
	const lockPath = join(root, "scheduler.lock");
	const claimPath = join(root, "lock-claims", "lock-n1.json");
	const deadLock = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: "lock-n1",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	const staleClaim = JSON.stringify({
		schemaVersion: CLAIM_SCHEMA,
		lockNonce: "lock-n1",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	assert.ok(await internals.publishExclusive(lockPath, deadLock));
	assert.ok(await internals.publishExclusive(claimPath, staleClaim));

	const firstObserved = deferred();
	const releaseFirst = deferred();
	const secondObserved = deferred();
	const releaseSecond = deferred();
	const first = internals.tryBreakDeadLock(rootAbs, {
		afterClaimObserved: () => {
			firstObserved.resolve();
			return releaseFirst.promise;
		},
	});
	const second = internals.tryBreakDeadLock(rootAbs, {
		afterClaimObserved: () => {
			secondObserved.resolve();
			return releaseSecond.promise;
		},
	});
	await Promise.all([firstObserved.promise, secondObserved.promise]);

	// Both breakers observed the old claim. Let one return, then model the
	// accepted explicit cleanup and a new breaker claiming the same lock.
	releaseFirst.resolve();
	await first;
	await rm(claimPath);
	const liveClaim = JSON.stringify({
		schemaVersion: CLAIM_SCHEMA,
		lockNonce: "lock-n1",
		owner: await selfOwner(),
	});
	assert.ok(await internals.publishExclusive(claimPath, liveClaim));

	releaseSecond.resolve();
	await second;
	assert.equal(await readFile(claimPath, "utf8"), liveClaim, "the replacement claim must survive");
	assert.equal(await readFile(lockPath, "utf8"), deadLock, "the claimed lock must survive");
	await assert.rejects(
		acquireTerminal(root, "fifth", AbortSignal.timeout(300)),
		(error: Error) => error.name === "TimeoutError" || error.name === "AbortError",
	);
	assert.equal((await leaseFiles(root)).length, MAX_ACTIVE_CHILDREN);
	assert.deepEqual(await leaseChildIds(root), ["held-1", "held-2", "held-3", "held-4"]);
});

test("a corrupt recovery claim fails closed without changing the claim or lock", async (t) => {
	const root = await initializedRoot(t);
	const rootAbs = toAbsolutePath(root);
	const lockPath = join(root, "scheduler.lock");
	const claimPath = join(root, "lock-claims", "lock-n1.json");
	const deadLock = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: "lock-n1",
		owner: { pid: process.pid, startToken: MISMATCHED_TOKEN },
	});
	const corruptClaim = "{ corrupt claim";
	assert.ok(await internals.publishExclusive(lockPath, deadLock));
	assert.ok(await internals.publishExclusive(claimPath, corruptClaim));

	await assert.rejects(internals.tryBreakDeadLock(rootAbs), /corrupt/);
	assert.equal(await readFile(claimPath, "utf8"), corruptClaim);
	assert.equal(await readFile(lockPath, "utf8"), deadLock);
});

// --- Sequence hardening -------------------------------------------------------

test("a corrupt sequence file fails closed and is never reset", async (t) => {
	const root = await temporaryRoot(t);
	const lease = await acquireTerminal(root, "init");
	await lease.release();
	const seqPath = join(root, "seq");
	await writeFile(seqPath, "garbage", { mode: 0o600 });
	await assert.rejects(acquireTerminal(root, "victim"), /corrupt/);
	assert.equal(await readFile(seqPath, "utf8"), "garbage", "corruption must never be reset");
	await writeFile(seqPath, "0", { mode: 0o600 });
	await assert.rejects(acquireTerminal(root, "victim2"), /corrupt/);
});

test("a missing sequence file alongside existing records fails closed", async (t) => {
	const root = await initializedRoot(t);
	const owner = await selfOwner();
	const ticket = {
		schemaVersion: TICKET_SCHEMA,
		seq: 7,
		nonce: "orphan-nonce",
		workflowId: "wf-orphan",
		childId: "orphan",
		depth: 1,
		capacityClass: "terminal",
		owner,
		createdAt: new Date().toISOString(),
	};
	await writeFile(join(root, "tickets", "000000000007-orphan-nonce.json"), JSON.stringify(ticket), {
		mode: 0o600,
	});
	await assert.rejects(acquireTerminal(root, "victim"), /corrupt/);
});

// --- Symlink containment --------------------------------------------------------

test("a symlinked scheduler root is rejected", async (t) => {
	const base = await temporaryRoot(t);
	const realDir = join(base, "real");
	const linkPath = join(base, "link");
	await mkdir(realDir, { recursive: true });
	await symlink(realDir, linkPath);
	await assert.rejects(acquireTerminal(linkPath, "victim"), /symlink/);
});

test("a symlinked scheduler subdirectory is rejected", async (t) => {
	const base = await temporaryRoot(t);
	const root = join(base, "root");
	const outside = join(base, "outside");
	await mkdir(root, { recursive: true });
	await mkdir(outside, { recursive: true });
	await symlink(outside, join(root, "leases"));
	await assert.rejects(acquireTerminal(root, "victim"), /symlink|escapes/);
});

// --- Capacity class construction ----------------------------------------------

test("non-nesting proofs require a reason and forged proofs are rejected", async (t) => {
	assert.throws(() => proveStaticallyNonNesting("   "), /reason/);
	const root = await temporaryRoot(t);
	const forged = { mark: "forged", reason: "nope" } as unknown as NonNestingProof;
	await assert.rejects(
		acquireChildSlot({
			schedulerRoot: toAbsolutePath(root),
			workflowId: "wf-forged",
			childId: "forged",
			work: { depth: 1, nonNesting: forged },
			signal: new AbortController().signal,
		}),
		/proof/,
	);
});
