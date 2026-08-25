import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AbsolutePath } from "./artifacts.ts";

/**
 * Session-wide file scheduler for child Pi processes.
 *
 * Coordination happens through plain files under one scheduler root shared by
 * every runner process in the session:
 *
 *   <root>/scheduler.lock   short exclusive lock (O_EXCL create, removed on exit)
 *   <root>/seq              monotonic FIFO ticket counter, mutated under the lock
 *   <root>/tickets/*.json   one file per waiting acquisition
 *   <root>/leases/*.json    one file per admitted child slot
 *
 * Admission rules:
 *   - at most MAX_ACTIVE_CHILDREN leases exist at once;
 *   - at most MAX_NESTING_CAPABLE_CHILDREN leases belong to depth-1 children
 *     that can nest, reserving capacity for terminal work (depth-2 children
 *     and non-nesting depth-1 children) so nesting cannot deadlock;
 *   - tickets are served FIFO by sequence number, except a depth-2 ticket may
 *     bypass an earlier depth-1 nesting-capable ticket that is currently
 *     blocked by the nesting reserve.
 *
 * A lease or ticket is reclaimed only after proving its owner is dead: the
 * PID must be gone, or the process occupying the PID must carry a different
 * start token. Unknown liveness fails closed and keeps the record, blocking
 * admission rather than granting an extra slot.
 */

export const MAX_ACTIVE_CHILDREN = 4;
export const MAX_NESTING_CAPABLE_CHILDREN = 3;

const TICKET_SCHEMA = "dstack.scheduler.ticket.v1";
const LEASE_SCHEMA = "dstack.scheduler.lease.v1";
const LOCK_SCHEMA = "dstack.scheduler.lock.v1";
const UNPROVABLE_START_TOKEN = "unprovable";
const POLL_INTERVAL_MS = 40;
const LOCK_RETRY_MS = 10;

export type ChildDepth = 1 | 2;

export type AcquireChildSlotInput = Readonly<{
	schedulerRoot: AbsolutePath;
	workflowId: string;
	childId: string;
	depth: ChildDepth;
	canNest: boolean;
	signal: AbortSignal;
}>;

export type ChildSlotLease = Readonly<{
	leaseId: string;
	/** Idempotent: repeated calls return the same settled promise. */
	release: () => Promise<void>;
}>;

type OwnerIdentity = Readonly<{
	pid: number;
	startToken: string;
}>;

type TicketRecord = Readonly<{
	schemaVersion: typeof TICKET_SCHEMA;
	seq: number;
	nonce: string;
	workflowId: string;
	childId: string;
	depth: ChildDepth;
	canNest: boolean;
	owner: OwnerIdentity;
	createdAt: string;
}>;

type LeaseRecord = Readonly<{
	schemaVersion: typeof LEASE_SCHEMA;
	seq: number;
	nonce: string;
	workflowId: string;
	childId: string;
	depth: ChildDepth;
	canNest: boolean;
	owner: OwnerIdentity;
	acquiredAt: string;
}>;

type Liveness = "live" | "dead" | "unknown";
type LivenessCache = Map<string, Liveness>;

const execFileAsync = promisify(execFile);

function errnoCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Liveness -------------------------------------------------------------

function pidExists(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = errnoCode(error);
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

type StartTokenProbe =
	| Readonly<{ kind: "token"; token: string }>
	| Readonly<{ kind: "dead" }>
	| Readonly<{ kind: "unknown" }>;

async function probeStartToken(pid: number): Promise<StartTokenProbe> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
	if (pidExists(pid) === false) return { kind: "dead" };
	if (process.platform === "linux") {
		let stat: string;
		try {
			stat = await readFile(`/proc/${pid}/stat`, "utf8");
		} catch (error) {
			const code = errnoCode(error);
			return code === "ENOENT" || code === "ESRCH" ? { kind: "dead" } : { kind: "unknown" };
		}
		const commEnd = stat.lastIndexOf(")");
		if (commEnd < 0) return { kind: "unknown" };
		const fields = stat.slice(commEnd + 1).trim().split(/\s+/u);
		const startTime = fields[19];
		if (startTime === undefined || !/^\d+$/u.test(startTime)) return { kind: "unknown" };
		return { kind: "token", token: `linux-starttime:${startTime}` };
	}
	if (process.platform === "win32") return { kind: "unknown" };
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
		const raw = stdout.trim();
		return raw === "" ? { kind: "dead" } : { kind: "token", token: `posix-lstart:${raw}` };
	} catch (error) {
		// `ps -p` exits 1 with empty stdout when the pid does not exist.
		if (isRecord(error) && error.code === 1) {
			const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "missing";
			if (stdout === "") return { kind: "dead" };
		}
		return { kind: "unknown" };
	}
}

let ownStartTokenPromise: Promise<string> | undefined;

function currentStartToken(): Promise<string> {
	ownStartTokenPromise ??= probeStartToken(process.pid).then((probe) =>
		probe.kind === "token" ? probe.token : UNPROVABLE_START_TOKEN,
	);
	return ownStartTokenPromise;
}

async function ownerLiveness(owner: OwnerIdentity, cache: LivenessCache): Promise<Liveness> {
	const key = `${owner.pid}:${owner.startToken}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	let liveness: Liveness;
	if (owner.pid === process.pid && owner.startToken === await currentStartToken()) {
		liveness = "live";
	} else {
		const probe = await probeStartToken(owner.pid);
		if (probe.kind === "dead") {
			liveness = "dead";
		} else if (probe.kind === "unknown" || owner.startToken === UNPROVABLE_START_TOKEN) {
			liveness = "unknown";
		} else {
			liveness = probe.token === owner.startToken ? "live" : "dead";
		}
	}
	cache.set(key, liveness);
	return liveness;
}

// --- Record parsing (files cross process boundaries) ----------------------

function parseOwner(value: unknown): OwnerIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const { pid, startToken } = value;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (typeof startToken !== "string" || startToken === "") return undefined;
	return { pid, startToken };
}

function parseDepth(value: unknown): ChildDepth | undefined {
	return value === 1 || value === 2 ? value : undefined;
}

type RecordBody = Readonly<{
	seq: number;
	nonce: string;
	workflowId: string;
	childId: string;
	depth: ChildDepth;
	canNest: boolean;
	owner: OwnerIdentity;
}>;

function parseRecordBody(value: Record<string, unknown>): RecordBody | undefined {
	const owner = parseOwner(value.owner);
	const depth = parseDepth(value.depth);
	const { seq, nonce, workflowId, childId, canNest } = value;
	if (owner === undefined || depth === undefined) return undefined;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
	if (typeof nonce !== "string" || nonce === "") return undefined;
	if (typeof workflowId !== "string" || workflowId === "") return undefined;
	if (typeof childId !== "string" || childId === "") return undefined;
	if (typeof canNest !== "boolean") return undefined;
	return { seq, nonce, workflowId, childId, depth, canNest, owner };
}

function parseTicket(value: unknown): TicketRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== TICKET_SCHEMA) return undefined;
	const body = parseRecordBody(value);
	if (body === undefined || typeof value.createdAt !== "string") return undefined;
	return { schemaVersion: TICKET_SCHEMA, ...body, createdAt: value.createdAt };
}

function parseLease(value: unknown): LeaseRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== LEASE_SCHEMA) return undefined;
	const body = parseRecordBody(value);
	if (body === undefined || typeof value.acquiredAt !== "string") return undefined;
	return { schemaVersion: LEASE_SCHEMA, ...body, acquiredAt: value.acquiredAt };
}

function parseLockOwner(raw: string): OwnerIdentity | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.schemaVersion !== LOCK_SCHEMA) return undefined;
	return parseOwner(value);
}

// --- Filesystem primitives -------------------------------------------------

async function atomicWriteFile(path: string, content: string): Promise<void> {
	const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	await writeFile(temporary, content, { mode: 0o600 });
	await rename(temporary, path);
}

async function readDirOrEmpty(path: string): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return [];
		throw error;
	}
}

type JsonFileRead =
	| Readonly<{ kind: "value"; value: unknown }>
	| Readonly<{ kind: "missing" }>
	| Readonly<{ kind: "invalid" }>;

async function readJsonFile(path: string): Promise<JsonFileRead> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "invalid" };
	}
	try {
		return { kind: "value", value: JSON.parse(raw) };
	} catch {
		return { kind: "invalid" };
	}
}

async function ensureSchedulerDirs(root: AbsolutePath): Promise<void> {
	await mkdir(join(root, "tickets"), { recursive: true, mode: 0o700 });
	await mkdir(join(root, "leases"), { recursive: true, mode: 0o700 });
}

// --- Short exclusive scheduler lock ----------------------------------------

async function breakLockIfOwnerDead(lockPath: string, cache: LivenessCache): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(lockPath, "utf8");
	} catch {
		return;
	}
	const owner = parseLockOwner(raw);
	// Malformed content may be a write in flight; fail closed and keep waiting.
	if (owner === undefined) return;
	if (await ownerLiveness(owner, cache) !== "dead") return;
	// Confirm the exact dead owner still holds the lock before breaking it.
	let confirm: string;
	try {
		confirm = await readFile(lockPath, "utf8");
	} catch {
		return;
	}
	if (confirm !== raw) return;
	await rm(lockPath, { force: true });
}

async function withSchedulerLock<T>(
	root: AbsolutePath,
	signal: AbortSignal,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = join(root, "scheduler.lock");
	const body = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		pid: process.pid,
		startToken: await currentStartToken(),
		nonce: randomBytes(8).toString("hex"),
	});
	for (;;) {
		signal.throwIfAborted();
		try {
			await writeFile(lockPath, body, { flag: "wx", mode: 0o600 });
			break;
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") throw error;
		}
		await breakLockIfOwnerDead(lockPath, new Map());
		await sleep(LOCK_RETRY_MS, undefined, { signal });
	}
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true });
	}
}

// --- Queue state (only ever read or mutated under the scheduler lock) ------

type CollectedLeases = Readonly<{ active: readonly LeaseRecord[]; opaqueCount: number }>;
type CollectedTickets = Readonly<{ pending: readonly TicketRecord[]; opaqueCount: number }>;

async function jsonFileNames(dir: string): Promise<readonly string[]> {
	return (await readDirOrEmpty(dir)).filter((name) => name.endsWith(".json")).sort();
}

async function collectLeases(root: AbsolutePath, cache: LivenessCache): Promise<CollectedLeases> {
	const dir = join(root, "leases");
	const active: LeaseRecord[] = [];
	let opaqueCount = 0;
	for (const name of await jsonFileNames(dir)) {
		const path = join(dir, name);
		const read = await readJsonFile(path);
		if (read.kind === "missing") continue;
		if (read.kind === "invalid") {
			opaqueCount += 1;
			continue;
		}
		const lease = parseLease(read.value);
		if (lease === undefined) {
			opaqueCount += 1;
			continue;
		}
		if (await ownerLiveness(lease.owner, cache) === "dead") {
			await rm(path, { force: true });
			continue;
		}
		active.push(lease);
	}
	return { active, opaqueCount };
}

async function collectTickets(root: AbsolutePath, cache: LivenessCache): Promise<CollectedTickets> {
	const dir = join(root, "tickets");
	const pending: TicketRecord[] = [];
	let opaqueCount = 0;
	for (const name of await jsonFileNames(dir)) {
		const path = join(dir, name);
		const read = await readJsonFile(path);
		if (read.kind === "missing") continue;
		if (read.kind === "invalid") {
			opaqueCount += 1;
			continue;
		}
		const ticket = parseTicket(read.value);
		if (ticket === undefined) {
			opaqueCount += 1;
			continue;
		}
		if (await ownerLiveness(ticket.owner, cache) === "dead") {
			await rm(path, { force: true });
			continue;
		}
		pending.push(ticket);
	}
	pending.sort((a, b) => a.seq - b.seq);
	return { pending, opaqueCount };
}

function ticketFileName(ticket: TicketRecord): string {
	return `${String(ticket.seq).padStart(12, "0")}-${ticket.nonce}.json`;
}

async function nextSequence(root: AbsolutePath): Promise<number> {
	const path = join(root, "seq");
	let current = 0;
	try {
		const raw = await readFile(path, "utf8");
		const parsed = Number.parseInt(raw.trim(), 10);
		if (Number.isSafeInteger(parsed) && parsed > 0) current = parsed;
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
	const next = current + 1;
	await atomicWriteFile(path, String(next));
	return next;
}

// --- Admission --------------------------------------------------------------

function makeRelease(root: AbsolutePath, nonce: string): () => Promise<void> {
	let released: Promise<void> | undefined;
	return () => {
		released ??= (async () => {
			const detached = new AbortController();
			await withSchedulerLock(root, detached.signal, async () => {
				await rm(join(root, "leases", `${nonce}.json`), { force: true });
			});
		})();
		return released;
	};
}

async function tryAdmit(root: AbsolutePath, ticket: TicketRecord): Promise<ChildSlotLease | undefined> {
	const cache: LivenessCache = new Map();
	const leases = await collectLeases(root, cache);
	const tickets = await collectTickets(root, cache);
	// An unparsable ticket cannot be ordered; fail closed until it is repaired.
	if (tickets.opaqueCount > 0) return undefined;
	if (!tickets.pending.some((pending) => pending.nonce === ticket.nonce)) {
		throw new Error("the scheduler ticket disappeared while waiting for a child slot");
	}
	// Opaque leases fail closed: they occupy a slot and the nesting reserve.
	const activeCount = leases.active.length + leases.opaqueCount;
	const nestingHeld =
		leases.active.filter((lease) => lease.depth === 1 && lease.canNest).length + leases.opaqueCount;
	const admissible = (candidate: Readonly<{ depth: ChildDepth; canNest: boolean }>): boolean =>
		activeCount < MAX_ACTIVE_CHILDREN &&
		!(candidate.depth === 1 && candidate.canNest && nestingHeld >= MAX_NESTING_CAPABLE_CHILDREN);
	if (!admissible(ticket)) return undefined;
	for (const earlier of tickets.pending) {
		if (earlier.seq >= ticket.seq) break;
		const bypassable = ticket.depth === 2 && earlier.depth === 1 && earlier.canNest && !admissible(earlier);
		if (bypassable) continue;
		return undefined;
	}
	const lease: LeaseRecord = {
		schemaVersion: LEASE_SCHEMA,
		seq: ticket.seq,
		nonce: ticket.nonce,
		workflowId: ticket.workflowId,
		childId: ticket.childId,
		depth: ticket.depth,
		canNest: ticket.canNest,
		owner: ticket.owner,
		acquiredAt: new Date().toISOString(),
	};
	await atomicWriteFile(join(root, "leases", `${ticket.nonce}.json`), JSON.stringify(lease));
	await rm(join(root, "tickets", ticketFileName(ticket)), { force: true });
	return { leaseId: ticket.nonce, release: makeRelease(root, ticket.nonce) };
}

async function removeTicketBestEffort(root: AbsolutePath, ticket: TicketRecord): Promise<void> {
	try {
		await rm(join(root, "tickets", ticketFileName(ticket)), { force: true });
	} catch {
		// Best effort: a live-owner ticket left behind is reclaimed once this
		// process exits and its liveness proof fails.
	}
}

/**
 * Acquire one session-wide child Pi slot, waiting FIFO behind earlier tickets.
 * Resolves with an idempotent release once a slot is granted; rejects with the
 * abort reason if the signal fires first, removing the queued ticket.
 */
export async function acquireChildSlot(input: AcquireChildSlotInput): Promise<ChildSlotLease> {
	const { schedulerRoot, workflowId, childId, depth, canNest, signal } = input;
	if (workflowId === "") throw new Error("workflowId must not be empty");
	if (childId === "") throw new Error("childId must not be empty");
	if (depth === 2 && canNest) throw new Error("depth-2 children are terminal and cannot nest");
	signal.throwIfAborted();
	await ensureSchedulerDirs(schedulerRoot);
	const owner: OwnerIdentity = { pid: process.pid, startToken: await currentStartToken() };
	const nonce = randomBytes(12).toString("hex");
	const ticket = await withSchedulerLock(schedulerRoot, signal, async () => {
		const seq = await nextSequence(schedulerRoot);
		const record: TicketRecord = {
			schemaVersion: TICKET_SCHEMA,
			seq,
			nonce,
			workflowId,
			childId,
			depth,
			canNest,
			owner,
			createdAt: new Date().toISOString(),
		};
		await atomicWriteFile(join(schedulerRoot, "tickets", ticketFileName(record)), JSON.stringify(record));
		return record;
	});
	try {
		for (;;) {
			const admitted = await withSchedulerLock(schedulerRoot, signal, () => tryAdmit(schedulerRoot, ticket));
			if (admitted !== undefined) return admitted;
			await sleep(POLL_INTERVAL_MS, undefined, { signal });
		}
	} catch (error) {
		await removeTicketBestEffort(schedulerRoot, ticket);
		throw error;
	}
}
