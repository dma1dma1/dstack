import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
	DEFAULT_TOTAL_SLOTS,
	MAX_TOTAL_SLOTS,
	MIN_TOTAL_SLOTS,
	nestingCapableSlotLimit,
} from "../types.ts";
import type { AbsolutePath } from "./artifacts.ts";

/**
 * Session-wide file scheduler for child Pi processes.
 *
 * Coordination happens through plain files under one scheduler root shared by
 * every runner process in the session:
 *
 *   <root>/scheduler.lock    short exclusive lock, atomically published via
 *                            temp file + fsync + link so a partial record is
 *                            never visible
 *   <root>/lock-claims/*.json nonce-specific recovery claims: exactly one
 *                            proven-dead-lock breaker may remove a dead lock;
 *                            existing claims require explicit cleanup
 *   <root>/seq               monotonic FIFO ticket counter, mutated under the
 *                            lock; corruption fails closed and never resets
 *   <root>/tickets/*.json    one file per waiting acquisition
 *   <root>/leases/*.json     one file per admitted child slot
 *   <root>/events/*.json     immutable ticket and slot telemetry records
 *
 * Admission rules (safety before fairness):
 *   - at most the persisted total slot capacity leases exist at once;
 *   - work is admitted by internal capacity class. Depth-1 work is "reserved"
 *     (nesting-capable) unless its explicit tool allowlist excludes
 *     `dstack_task`; the persisted nesting-capable limit leaves terminal
 *     headroom so nesting cannot deadlock. Depth-2 work and depth-1 work whose
 *     allowlist excludes `dstack_task` is "terminal" and may use that headroom;
 *   - tickets are served FIFO by sequence number, except a terminal ticket may
 *     bypass an earlier reserved ticket that is currently blocked by the
 *     nesting reserve.
 *
 * A lease records the runner owner and, once bound, the actual spawned child
 * (PID plus process start token). Callers must bind the spawned child before
 * it does any useful work. A lease is reclaimed only after proving that every
 * recorded owner is dead: each PID must be gone, or the process occupying the
 * PID must carry a different start token. Unknown liveness (including
 * unsupported platforms such as Windows) fails closed and keeps the record,
 * occupying the slot rather than granting an extra one.
 *
 * Corrupt scheduler state (unparsable lock, claim, or sequence file) fails
 * closed with an error. It is never deleted or reset.
 */

export const MAX_ACTIVE_CHILDREN = DEFAULT_TOTAL_SLOTS;
export const MAX_NESTING_CAPABLE_CHILDREN = nestingCapableSlotLimit(DEFAULT_TOTAL_SLOTS);

export type SchedulerCapacity = Readonly<{
	totalActiveSlots: number;
	nestingCapableLimit: number;
}>;

export type LeaseSnapshot = Readonly<{
	workflowId: string;
	childId: string;
	depth: ChildDepth;
	acquiredAt: string;
}>;

const TICKET_SCHEMA = "dstack.scheduler.ticket.v2";
const LEASE_SCHEMA = "dstack.scheduler.lease.v2";
export const QUEUE_EVENT_SCHEMA = "dstack.scheduler.queue-event.v1" as const;
const LOCK_SCHEMA = "dstack.scheduler.lock.v2";
const CLAIM_SCHEMA = "dstack.scheduler.lockclaim.v1";
const CAPACITY_SCHEMA = "dstack.scheduler.capacity.v1";
const UNPROVABLE_START_TOKEN = "unprovable";
const POLL_INTERVAL_MS = 40;
const LOCK_RETRY_MS = 10;

export type ChildDepth = 1 | 2;

/** Internal capacity classes derived from the work shape, never caller-set. */
export type CapacityClass = "reserved" | "terminal";

export type ChildWork = Readonly<{
	depth: ChildDepth;
	/** Undefined means the child receives Pi's default tool set. */
	tools?: readonly string[];
}>;

function validatedTools(tools: readonly string[] | undefined): readonly string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) throw new Error("an explicit tools allowlist must not be empty");
	const seen = new Set<string>();
	for (const tool of tools) {
		if (typeof tool !== "string" || tool === "" || tool.trim() !== tool || tool.includes(",")) {
			throw new Error("the resolved tools allowlist contains an invalid tool name");
		}
		if (seen.has(tool)) throw new Error(`the resolved tools allowlist repeats ${tool}`);
		seen.add(tool);
	}
	return tools;
}

function capacityClassOf(work: ChildWork): CapacityClass {
	if (work.depth !== 1 && work.depth !== 2) throw new Error("child depth must be 1 or 2");
	const tools = validatedTools(work.tools);
	if (work.depth === 2) return "terminal";
	return tools !== undefined && !tools.includes("dstack_task") ? "terminal" : "reserved";
}

export type AcquireChildSlotInput = Readonly<{
	schedulerRoot: AbsolutePath;
	workflowId: string;
	childId: string;
	work: ChildWork;
	requestedTotalSlots?: number;
	signal: AbortSignal;
	/** Test-only seam; production callers must not set this. */
	__testHooks?: Readonly<{ afterAdmission?: () => void | Promise<void> }>;
}>;

export type ChildSlotLease = Readonly<{
	leaseId: string;
	/**
	 * Record the actual spawned child on the lease. Must be called before the
	 * child does any useful work; until then the runner is the only recorded
	 * owner and runner death makes the slot reclaimable.
	 */
	bindChild: (pid: number) => Promise<void>;
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
	capacityClass: CapacityClass;
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
	capacityClass: CapacityClass;
	owner: OwnerIdentity;
	acquiredAt: string;
	child?: OwnerIdentity;
	childBoundAt?: string;
}>;

export type QueueEventV1 =
	| Readonly<{
			schemaVersion: typeof QUEUE_EVENT_SCHEMA;
			eventId: string;
			kind: "ticket_created";
			ticketId: string;
			workflowId: string;
			childId: string;
			seq: number;
			depth: ChildDepth;
			capacityClass: CapacityClass;
			occurredAt: string;
		}>
	| Readonly<{
			schemaVersion: typeof QUEUE_EVENT_SCHEMA;
			eventId: string;
			kind: "slot_acquired";
			ticketId: string;
			slotAcquisitionId: string;
			workflowId: string;
			childId: string;
			seq: number;
			depth: ChildDepth;
			capacityClass: CapacityClass;
			occurredAt: string;
		}>;

type LockRecord = Readonly<{ nonce: string; owner: OwnerIdentity }>;
type ClaimRecord = Readonly<{ lockNonce: string; owner: OwnerIdentity }>;
type CapacityRecord = SchedulerCapacity & Readonly<{ schemaVersion: typeof CAPACITY_SCHEMA }>;

type Liveness = "live" | "dead" | "unknown";
type LivenessCache = Map<string, Liveness>;

const execFileAsync = promisify(execFile);

function corruptStateError(what: string): Error {
	return new Error(
		`scheduler state is corrupt: ${what}; failing closed without resetting or deleting state`,
	);
}

function errnoCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capacityFor(totalActiveSlots: number): CapacityRecord {
	if (!Number.isSafeInteger(totalActiveSlots) || totalActiveSlots < MIN_TOTAL_SLOTS || totalActiveSlots > MAX_TOTAL_SLOTS) {
		throw new Error(`requestedTotalSlots must be an integer from ${MIN_TOTAL_SLOTS} to ${MAX_TOTAL_SLOTS}`);
	}
	return {
		schemaVersion: CAPACITY_SCHEMA,
		totalActiveSlots,
		nestingCapableLimit: nestingCapableSlotLimit(totalActiveSlots),
	};
}

function parseCapacity(value: unknown): CapacityRecord | undefined {
	if (!isRecord(value) || value.schemaVersion !== CAPACITY_SCHEMA) return undefined;
	const totalActiveSlots = value.totalActiveSlots;
	const nestingCapableLimit = value.nestingCapableLimit;
	if (!Number.isSafeInteger(totalActiveSlots) || !Number.isSafeInteger(nestingCapableLimit)) return undefined;
	const expected = capacityFor(totalActiveSlots as number);
	if (nestingCapableLimit !== expected.nestingCapableLimit) return undefined;
	return expected;
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
	// Unsupported liveness (e.g. Windows) fails closed as unknown.
	if (process.platform === "win32") return { kind: "unknown" };
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
			timeout: 1_000,
			killSignal: "SIGKILL",
		});
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

/** A lease is reclaimable only when every recorded owner is proven dead. */
async function leaseIsReclaimable(lease: LeaseRecord, cache: LivenessCache): Promise<boolean> {
	if (await ownerLiveness(lease.owner, cache) !== "dead") return false;
	if (lease.child === undefined) return true;
	return await ownerLiveness(lease.child, cache) === "dead";
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

function parseCapacityClass(value: unknown): CapacityClass | undefined {
	return value === "reserved" || value === "terminal" ? value : undefined;
}

type RecordBody = Readonly<{
	seq: number;
	nonce: string;
	workflowId: string;
	childId: string;
	depth: ChildDepth;
	capacityClass: CapacityClass;
	owner: OwnerIdentity;
}>;

function parseRecordBody(value: Record<string, unknown>): RecordBody | undefined {
	const owner = parseOwner(value.owner);
	const depth = parseDepth(value.depth);
	const capacityClass = parseCapacityClass(value.capacityClass);
	const { seq, nonce, workflowId, childId } = value;
	if (owner === undefined || depth === undefined || capacityClass === undefined) return undefined;
	// Depth-2 work is terminal by construction; a reserved depth-2 record is corrupt.
	if (depth === 2 && capacityClass !== "terminal") return undefined;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
	if (typeof nonce !== "string" || nonce === "") return undefined;
	if (typeof workflowId !== "string" || workflowId === "") return undefined;
	if (typeof childId !== "string" || childId === "") return undefined;
	return { seq, nonce, workflowId, childId, depth, capacityClass, owner };
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
	const base: LeaseRecord = { schemaVersion: LEASE_SCHEMA, ...body, acquiredAt: value.acquiredAt };
	if (value.child === undefined) return base;
	const child = parseOwner(value.child);
	if (child === undefined || typeof value.childBoundAt !== "string") return undefined;
	return { ...base, child, childBoundAt: value.childBoundAt };
}

function parseLockRecord(raw: string): LockRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.schemaVersion !== LOCK_SCHEMA) return undefined;
	const owner = parseOwner(value.owner);
	if (owner === undefined || typeof value.nonce !== "string" || value.nonce === "") return undefined;
	return { nonce: value.nonce, owner };
}

function parseClaimRecord(raw: string): ClaimRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.schemaVersion !== CLAIM_SCHEMA) return undefined;
	const owner = parseOwner(value.owner);
	if (owner === undefined || typeof value.lockNonce !== "string" || value.lockNonce === "") return undefined;
	return { lockNonce: value.lockNonce, owner };
}

// --- Filesystem primitives -------------------------------------------------

/** Write the complete content, fsync it, then atomically rename into place. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
	const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
}

/**
 * Atomically publish a complete record at `path` only if nothing exists there.
 * Uses temp file + fsync + hard link so a partial record is never observable.
 * Returns false when the path is already occupied.
 */
async function publishExclusive(path: string, content: string): Promise<boolean> {
	const temporary = `${path}.pub-${randomBytes(6).toString("hex")}`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temporary, path);
		return true;
	} catch (error) {
		if (errnoCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
}

type TextRead =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "missing" }>
	| Readonly<{ kind: "unreadable" }>;

/** Read a file without following a symlinked final component. */
async function readTextNoFollow(path: string): Promise<TextRead> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "unreadable" };
	}
	try {
		return { kind: "text", text: await handle.readFile({ encoding: "utf8" }) };
	} catch {
		return { kind: "unreadable" };
	} finally {
		await handle.close();
	}
}

type JsonFileRead =
	| Readonly<{ kind: "value"; value: unknown }>
	| Readonly<{ kind: "missing" }>
	| Readonly<{ kind: "invalid" }>;

async function readJsonFile(path: string): Promise<JsonFileRead> {
	const read = await readTextNoFollow(path);
	if (read.kind === "missing") return { kind: "missing" };
	if (read.kind === "unreadable") return { kind: "invalid" };
	try {
		return { kind: "value", value: JSON.parse(read.text) };
	} catch {
		return { kind: "invalid" };
	}
}

async function readDirOrEmpty(path: string): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return [];
		throw error;
	}
}

const SCHEDULER_SUBDIRS = ["tickets", "leases", "events", "lock-claims"] as const;

/**
 * Create scheduler directories and validate realpath containment: the root
 * itself and every subdirectory must be real directories, not symlinks, and
 * each subdirectory must resolve inside the resolved root.
 */
async function ensureSchedulerDirs(root: AbsolutePath): Promise<void> {
	let rootStat;
	try {
		rootStat = await lstat(root);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
	if (rootStat === undefined) {
		await mkdir(root, { recursive: true, mode: 0o700 });
	} else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("scheduler root must be a real directory, not a symlink");
	}
	const realRoot = await realpath(root);
	for (const name of SCHEDULER_SUBDIRS) {
		const dir = join(root, name);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const stat = await lstat(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`scheduler ${name} directory must be a real directory, not a symlink`);
		}
		if (await realpath(dir) !== join(realRoot, name)) {
			throw new Error(`scheduler ${name} directory escapes the scheduler root`);
		}
	}
}

// --- Short exclusive scheduler lock ----------------------------------------

type BreakHooks = Readonly<{
	afterDeadProof?: () => void | Promise<void>;
	afterClaimObserved?: () => void | Promise<void>;
}>;

/**
 * Break a scheduler lock whose owner is proven dead. Exactly one breaker may
 * act: it must first win the nonce-specific recovery claim, then re-verify
 * the lock still carries the proven-dead nonce before removing it. Any
 * existing claim blocks every contender, regardless of owner liveness. A
 * crashed breaker therefore requires explicit cleanup.
 */
async function tryBreakDeadLock(root: AbsolutePath, hooks?: BreakHooks): Promise<void> {
	const lockPath = join(root, "scheduler.lock");
	const read = await readTextNoFollow(lockPath);
	if (read.kind === "missing") return;
	if (read.kind === "unreadable") throw corruptStateError("scheduler.lock is unreadable");
	const record = parseLockRecord(read.text);
	if (record === undefined) throw corruptStateError("scheduler.lock does not parse as a lock record");
	const cache: LivenessCache = new Map();
	if (await ownerLiveness(record.owner, cache) !== "dead") return;
	await hooks?.afterDeadProof?.();
	const claimPath = join(root, "lock-claims", `${record.nonce}.json`);
	const claimBody = JSON.stringify({
		schemaVersion: CLAIM_SCHEMA,
		lockNonce: record.nonce,
		owner: { pid: process.pid, startToken: await currentStartToken() },
	});
	if (!(await publishExclusive(claimPath, claimBody))) {
		const claimRead = await readTextNoFollow(claimPath);
		if (claimRead.kind === "missing") return;
		if (claimRead.kind === "unreadable") throw corruptStateError("a lock recovery claim is unreadable");
		const claim = parseClaimRecord(claimRead.text);
		if (claim === undefined) throw corruptStateError("a lock recovery claim does not parse");
		await hooks?.afterClaimObserved?.();
		return;
	}
	try {
		// Holding the claim, confirm the lock still carries the proven-dead
		// nonce. A different nonce means the dead lock was already broken and
		// a new live lock exists; it must not be touched.
		const confirm = await readTextNoFollow(lockPath);
		if (confirm.kind === "missing") return;
		if (confirm.kind === "unreadable") throw corruptStateError("scheduler.lock is unreadable");
		const current = parseLockRecord(confirm.text);
		if (current === undefined) throw corruptStateError("scheduler.lock does not parse as a lock record");
		if (current.nonce !== record.nonce) return;
		await rm(lockPath, { force: true });
	} finally {
		await rm(claimPath, { force: true });
	}
}

async function withSchedulerLock<T>(
	root: AbsolutePath,
	signal: AbortSignal,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = join(root, "scheduler.lock");
	const body = JSON.stringify({
		schemaVersion: LOCK_SCHEMA,
		nonce: randomBytes(8).toString("hex"),
		owner: { pid: process.pid, startToken: await currentStartToken() },
	});
	for (;;) {
		signal.throwIfAborted();
		if (await publishExclusive(lockPath, body)) break;
		await tryBreakDeadLock(root);
		await sleep(LOCK_RETRY_MS, undefined, { signal });
	}
	try {
		return await fn();
	} finally {
		// Safe blind removal: a live owner's lock is never broken, so the path
		// still holds this process's lock record.
		await rm(lockPath, { force: true });
	}
}

// --- Queue state (only ever read or mutated under the scheduler lock) ------

type CollectedLeases = Readonly<{ active: readonly LeaseRecord[]; opaqueCount: number }>;
type CollectedTickets = Readonly<{ pending: readonly TicketRecord[]; opaqueCount: number }>;

async function jsonFileNames(dir: string): Promise<readonly string[]> {
	return (await readDirOrEmpty(dir)).filter((name) => name.endsWith(".json")).sort();
}

function ticketId(nonce: string): string {
	return `dstack.scheduler-ticket.v2:${nonce}`;
}

function queueEventId(kind: QueueEventV1["kind"], nonce: string): string {
	return `dstack.scheduler-queue-event.v1:${kind}:${nonce}`;
}

function queueEventFileName(kind: QueueEventV1["kind"], nonce: string): string {
	return `${nonce}-${kind}.json`;
}

function queueEventMatches(value: unknown, event: QueueEventV1): boolean {
	if (!isRecord(value)) return false;
	const expected = Object.entries(event);
	return Object.keys(value).length === expected.length && expected.every(([key, field]) => value[key] === field);
}

async function publishQueueEvent(root: AbsolutePath, event: QueueEventV1): Promise<void> {
	const nonce = event.ticketId.slice("dstack.scheduler-ticket.v2:".length);
	const path = join(root, "events", queueEventFileName(event.kind, nonce));
	const existing = await readJsonFile(path);
	if (existing.kind === "value" && queueEventMatches(existing.value, event)) return;
	if (existing.kind !== "missing") {
		throw corruptStateError(`queue event ${event.eventId} conflicts with an existing record`);
	}
	if (await publishExclusive(path, JSON.stringify(event))) return;
	const raced = await readJsonFile(path);
	if (raced.kind !== "value" || !queueEventMatches(raced.value, event)) {
		throw corruptStateError(`queue event ${event.eventId} conflicts with an existing record`);
	}
}

async function ensureTicketCreatedEvent(root: AbsolutePath, ticket: TicketRecord): Promise<void> {
	await publishQueueEvent(root, {
		schemaVersion: QUEUE_EVENT_SCHEMA,
		eventId: queueEventId("ticket_created", ticket.nonce),
		kind: "ticket_created",
		ticketId: ticketId(ticket.nonce),
		workflowId: ticket.workflowId,
		childId: ticket.childId,
		seq: ticket.seq,
		depth: ticket.depth,
		capacityClass: ticket.capacityClass,
		occurredAt: ticket.createdAt,
	});
}

async function ensureSlotAcquiredEvent(root: AbsolutePath, lease: LeaseRecord): Promise<void> {
	await publishQueueEvent(root, {
		schemaVersion: QUEUE_EVENT_SCHEMA,
		eventId: queueEventId("slot_acquired", lease.nonce),
		kind: "slot_acquired",
		ticketId: ticketId(lease.nonce),
		slotAcquisitionId: `dstack.scheduler-slot-acquisition.v1:${lease.nonce}`,
		workflowId: lease.workflowId,
		childId: lease.childId,
		seq: lease.seq,
		depth: lease.depth,
		capacityClass: lease.capacityClass,
		occurredAt: lease.acquiredAt,
	});
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
		await ensureSlotAcquiredEvent(root, lease);
		if (await leaseIsReclaimable(lease, cache)) {
			await rm(path, { force: true });
			continue;
		}
		active.push(lease);
	}
	return { active, opaqueCount };
}

export async function snapshotSchedulerCapacity(root: string | AbsolutePath): Promise<SchedulerCapacity> {
	const read = await readJsonFile(join(root, "capacity.json"));
	let capacity: CapacityRecord;
	if (read.kind === "missing") {
		capacity = capacityFor(DEFAULT_TOTAL_SLOTS);
	} else {
		if (read.kind !== "value") throw corruptStateError("capacity.json is unreadable");
		const parsed = parseCapacity(read.value);
		if (parsed === undefined) throw corruptStateError("capacity.json does not parse as a capacity record");
		capacity = parsed;
	}
	return {
		totalActiveSlots: capacity.totalActiveSlots,
		nestingCapableLimit: capacity.nestingCapableLimit,
	};
}

export async function snapshotActiveLeases(root: string | AbsolutePath): Promise<readonly LeaseSnapshot[]> {
	const dir = join(root, "leases");
	const cache: LivenessCache = new Map();
	const active: LeaseSnapshot[] = [];
	for (const name of await jsonFileNames(dir)) {
		const path = join(dir, name);
		const read = await readJsonFile(path);
		if (read.kind !== "value") continue;
		const lease = parseLease(read.value);
		if (lease === undefined) continue;
		if (await leaseIsReclaimable(lease, cache)) continue;
		active.push({
			workflowId: lease.workflowId,
			childId: lease.childId,
			depth: lease.depth,
			acquiredAt: lease.acquiredAt,
		});
	}
	return active;
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
		await ensureTicketCreatedEvent(root, ticket);
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

/**
 * Advance the FIFO sequence. A missing file with no existing records means a
 * fresh scheduler root; a missing file alongside records, or an unparsable or
 * non-positive value, is corruption and fails closed. It never resets.
 */
async function nextSequence(root: AbsolutePath): Promise<number> {
	const path = join(root, "seq");
	const read = await readTextNoFollow(path);
	let current: number;
	if (read.kind === "missing") {
		const tickets = await jsonFileNames(join(root, "tickets"));
		const leases = await jsonFileNames(join(root, "leases"));
		if (tickets.length > 0 || leases.length > 0) {
			throw corruptStateError("the sequence file is missing while tickets or leases exist");
		}
		current = 0;
	} else if (read.kind === "unreadable") {
		throw corruptStateError("the sequence file is unreadable");
	} else {
		const trimmed = read.text.trim();
		const parsed = Number.parseInt(trimmed, 10);
		if (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
			throw corruptStateError("the sequence file does not hold a positive integer");
		}
		current = parsed;
	}
	const next = current + 1;
	await writeFileAtomic(path, String(next));
	return next;
}

// --- Admission --------------------------------------------------------------

function makeLease(root: AbsolutePath, lease: LeaseRecord): ChildSlotLease {
	const nonce = lease.nonce;
	let released: Promise<void> | undefined;
	const release = (): Promise<void> => {
		released ??= (async () => {
			const detached = new AbortController();
			await withSchedulerLock(root, detached.signal, async () => {
				await ensureSlotAcquiredEvent(root, lease);
				await rm(join(root, "leases", `${nonce}.json`), { force: true });
			});
		})();
		return released;
	};
	const bindChild = async (pid: number): Promise<void> => {
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("child pid must be a positive integer");
		if (released !== undefined) throw new Error("cannot bind a child to a released lease");
		const probe = await probeStartToken(pid);
		if (probe.kind !== "token") {
			throw new Error("cannot bind a child: its process start token could not be verified");
		}
		const startToken = probe.token;
		const detached = new AbortController();
		await withSchedulerLock(root, detached.signal, async () => {
			const path = join(root, "leases", `${nonce}.json`);
			const read = await readJsonFile(path);
			if (read.kind !== "value") {
				throw new Error("cannot bind a child: the lease record is missing or corrupt");
			}
			const lease = parseLease(read.value);
			if (lease === undefined || lease.nonce !== nonce) {
				throw new Error("cannot bind a child: the lease record is missing or corrupt");
			}
			if (lease.child !== undefined) throw new Error("cannot bind a child: the lease is already bound");
			const updated: LeaseRecord = {
				...lease,
				child: { pid, startToken },
				childBoundAt: new Date().toISOString(),
			};
			await writeFileAtomic(path, JSON.stringify(updated));
		});
	};
	return { leaseId: nonce, bindChild, release };
}

async function tryAdmit(root: AbsolutePath, ticket: TicketRecord): Promise<ChildSlotLease | undefined> {
	const capacity = await snapshotSchedulerCapacity(root);
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
	const reservedHeld =
		leases.active.filter((lease) => lease.capacityClass === "reserved").length + leases.opaqueCount;
	const admissible = (candidate: Readonly<{ capacityClass: CapacityClass }>): boolean =>
		activeCount < capacity.totalActiveSlots &&
		!(candidate.capacityClass === "reserved" && reservedHeld >= capacity.nestingCapableLimit);
	if (!admissible(ticket)) return undefined;
	for (const earlier of tickets.pending) {
		if (earlier.seq >= ticket.seq) break;
		const bypassable =
			ticket.capacityClass === "terminal" &&
			earlier.capacityClass === "reserved" &&
			!admissible(earlier);
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
		capacityClass: ticket.capacityClass,
		owner: ticket.owner,
		acquiredAt: new Date().toISOString(),
	};
	await writeFileAtomic(join(root, "leases", `${ticket.nonce}.json`), JSON.stringify(lease));
	await ensureTicketCreatedEvent(root, ticket);
	await ensureSlotAcquiredEvent(root, lease);
	await rm(join(root, "tickets", ticketFileName(ticket)), { force: true });
	return makeLease(root, lease);
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
 * abort reason if the signal fires first, removing the queued ticket. An abort
 * that races admission releases the just-granted lease and still rejects.
 */
export async function acquireChildSlot(input: AcquireChildSlotInput): Promise<ChildSlotLease> {
	const { schedulerRoot, workflowId, childId, work, requestedTotalSlots, signal } = input;
	if (workflowId === "") throw new Error("workflowId must not be empty");
	if (childId === "") throw new Error("childId must not be empty");
	const capacityClass = capacityClassOf(work);
	signal.throwIfAborted();
	await ensureSchedulerDirs(schedulerRoot);
	const requestedCapacity = capacityFor(requestedTotalSlots ?? DEFAULT_TOTAL_SLOTS);
	const owner: OwnerIdentity = { pid: process.pid, startToken: await currentStartToken() };
	const nonce = randomBytes(12).toString("hex");
	const ticket = await withSchedulerLock(schedulerRoot, signal, async () => {
		const capacityPath = join(schedulerRoot, "capacity.json");
		const capacityRead = await readJsonFile(capacityPath);
		if (capacityRead.kind === "missing") {
			await writeFileAtomic(capacityPath, JSON.stringify(requestedCapacity));
		} else if (capacityRead.kind !== "value" || parseCapacity(capacityRead.value) === undefined) {
			throw corruptStateError("capacity.json does not parse as a capacity record");
		}
		const seq = await nextSequence(schedulerRoot);
		const record: TicketRecord = {
			schemaVersion: TICKET_SCHEMA,
			seq,
			nonce,
			workflowId,
			childId,
			depth: work.depth,
			capacityClass,
			owner,
			createdAt: new Date().toISOString(),
		};
		await writeFileAtomic(join(schedulerRoot, "tickets", ticketFileName(record)), JSON.stringify(record));
		await ensureTicketCreatedEvent(schedulerRoot, record);
		return record;
	});
	try {
		for (;;) {
			const admitted = await withSchedulerLock(schedulerRoot, signal, () => tryAdmit(schedulerRoot, ticket));
			if (admitted !== undefined) {
				await input.__testHooks?.afterAdmission?.();
				// Recheck the signal after admission: an abort that raced the
				// grant must not leak the lease.
				if (signal.aborted) {
					await admitted.release();
					signal.throwIfAborted();
				}
				return admitted;
			}
			await sleep(POLL_INTERVAL_MS, undefined, { signal });
		}
	} catch (error) {
		await removeTicketBestEffort(schedulerRoot, ticket);
		throw error;
	}
}

/** Test-only access to internal primitives. Production code must not use it. */
export const __schedulerInternalsForTesting = {
	ensureSchedulerDirs,
	tryBreakDeadLock,
	publishExclusive,
	currentStartToken,
} as const;
