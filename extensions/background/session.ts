import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { snapshotActiveLeases } from "./scheduler.ts";

export const CHILD_SESSION_SCHEMA = "dstack.child-session.v1";

export const DEFAULT_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_ENV = "DSTACK_SESSION_RETENTION_MS";

const MAX_SESSION_REF_BYTES = 16 * 1024;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 128 * 1024;
export const DEFAULT_MAX_BYTES_PER_CALL = 512 * 1024;
export const DEFAULT_MAX_STORED_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_TAIL_RECORDS = 2000;
const MAX_PARTIAL_BYTES = 64 * 1024;

export type ChildSessionRefV1 = Readonly<{
	schemaVersion: "dstack.child-session.v1";
	sessionId: string;
	sessionFile: string;
	sessionDir: string;
	createdAt: string;
}>;

export type SessionTailRecord = Readonly<Record<string, unknown>>;

export type SessionTailState = {
	identity?: Readonly<{ dev: number; ino: number }>;
	offset: number;
	partial: Buffer;
	records: SessionTailRecord[];
	totalRecordBytes: number;
};

export function createSessionTailState(): SessionTailState {
	return {
		offset: 0,
		partial: Buffer.alloc(0),
		records: [],
		totalRecordBytes: 0,
	};
}

export type TailSessionOptions = Readonly<{
	maxChunkBytes?: number;
	maxBytesPerCall?: number;
	maxRecordBytes?: number;
	maxRecords?: number;
}>;

export type TailSessionResult = Readonly<{
	changed: boolean;
	records: readonly SessionTailRecord[];
	error?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function normalizedAbsolute(value: unknown): value is string {
	return nonEmptyString(value) && isAbsolute(value) && normalize(value) === value;
}

export function parseChildSessionRef(raw: unknown): ChildSessionRefV1 | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw["schemaVersion"] !== CHILD_SESSION_SCHEMA) return undefined;
	const { sessionId, sessionFile, sessionDir, createdAt } = raw;
	if (!nonEmptyString(sessionId)) return undefined;
	if (!normalizedAbsolute(sessionFile) || !normalizedAbsolute(sessionDir)) return undefined;
	if (!nonEmptyString(createdAt) || !Number.isFinite(Date.parse(createdAt))) return undefined;
	const rel = relative(sessionDir, sessionFile);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return {
		schemaVersion: CHILD_SESSION_SCHEMA,
		sessionId,
		sessionFile,
		sessionDir,
		createdAt,
	};
}

type SessionManagerLike = Readonly<{
	getSessionId?: () => string;
	getSessionFile?: () => string | undefined;
	getSessionDir?: () => string;
}>;

export function buildChildSessionRef(manager: SessionManagerLike): ChildSessionRefV1 | undefined {
	try {
		const sessionId = manager.getSessionId?.();
		const sessionFile = manager.getSessionFile?.();
		const sessionDir = manager.getSessionDir?.();
		if (!nonEmptyString(sessionId) || !nonEmptyString(sessionFile) || !nonEmptyString(sessionDir)) return undefined;
		if (!isAbsolute(sessionFile) || !isAbsolute(sessionDir)) return undefined;
		return parseChildSessionRef({
			schemaVersion: CHILD_SESSION_SCHEMA,
			sessionId,
			sessionFile: normalize(sessionFile),
			sessionDir: normalize(sessionDir),
			createdAt: new Date().toISOString(),
		});
	} catch {
		return undefined;
	}
}

async function readRegularFileNoFollow(path: string, maxBytes: number): Promise<Buffer | undefined> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow);
		const opened = await handle.stat();
		const linked = await lstat(path);
		if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()) return undefined;
		if (opened.dev !== linked.dev || opened.ino !== linked.ino) return undefined;
		const size = Math.min(opened.size, maxBytes);
		const buffer = Buffer.alloc(size);
		await handle.read(buffer, 0, size, 0);
		return buffer;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function sessionHeaderMatches(sessionFile: string, sessionId: string): Promise<boolean> {
	const bytes = await readRegularFileNoFollow(sessionFile, MAX_SESSION_HEADER_BYTES);
	if (bytes === undefined) return false;
	const text = bytes.toString("utf8");
	const newline = text.indexOf("\n");
	const firstLine = newline === -1 ? text : text.slice(0, newline);
	try {
		const header: unknown = JSON.parse(firstLine);
		return isRecord(header) && header["type"] === "session" && header["id"] === sessionId;
	} catch {
		return false;
	}
}

export async function readChildSessionRef(input: Readonly<{
	refPath: string;
	sessionDir: string;
}>): Promise<ChildSessionRefV1 | undefined> {
	const expectedDir = normalize(input.sessionDir);
	if (!isAbsolute(expectedDir)) return undefined;
	const bytes = await readRegularFileNoFollow(input.refPath, MAX_SESSION_REF_BYTES);
	if (bytes === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString("utf8"));
	} catch {
		return undefined;
	}
	const ref = parseChildSessionRef(raw);
	if (ref === undefined) return undefined;
	if (ref.sessionDir !== expectedDir) return undefined;
	try {
		const fileStats = await lstat(ref.sessionFile);
		if (!fileStats.isFile() || fileStats.isSymbolicLink()) return undefined;
		const realDir = await realpath(expectedDir);
		const realFile = await realpath(ref.sessionFile);
		if (realFile !== realDir && !realFile.startsWith(`${realDir}${sep}`)) return undefined;
	} catch {
		return undefined;
	}
	if (!(await sessionHeaderMatches(ref.sessionFile, ref.sessionId))) return undefined;
	return ref;
}

export async function tailSessionFile(
	state: SessionTailState,
	filePath: string,
	options?: TailSessionOptions,
): Promise<TailSessionResult> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	let handle;
	try {
		handle = await open(filePath, constants.O_RDONLY | noFollow);
		const stats = await handle.stat();
		const linked = await lstat(filePath);
		if (!stats.isFile() || !linked.isFile() || linked.isSymbolicLink()) {
			return { changed: false, records: state.records };
		}
		if (stats.dev !== linked.dev || stats.ino !== linked.ino) {
			return { changed: false, records: state.records };
		}

		let resetOccurred = false;
		const hadPreviousData = state.records.length > 0 || state.offset > 0 || state.partial.length > 0;

		if (state.identity !== undefined && (state.identity.dev !== stats.dev || state.identity.ino !== stats.ino)) {
			state.offset = 0;
			state.partial = Buffer.alloc(0);
			state.records = [];
			state.totalRecordBytes = 0;
			if (hadPreviousData) resetOccurred = true;
		}

		if (stats.size < state.offset) {
			state.offset = 0;
			state.partial = Buffer.alloc(0);
			state.records = [];
			state.totalRecordBytes = 0;
			if (hadPreviousData) resetOccurred = true;
		}

		state.identity = { dev: stats.dev, ino: stats.ino };

		if (stats.size === state.offset && state.partial.length === 0) {
			return { changed: resetOccurred, records: state.records };
		}

		const maxChunk = options?.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
		const maxBytesPerCall = options?.maxBytesPerCall ?? DEFAULT_MAX_BYTES_PER_CALL;
		const maxRecordBytes = options?.maxRecordBytes ?? DEFAULT_MAX_STORED_RECORD_BYTES;
		const maxRecords = options?.maxRecords ?? DEFAULT_MAX_TAIL_RECORDS;
		let anyChanged = resetOccurred;
		let bytesReadThisCall = 0;

		while (state.offset < stats.size && bytesReadThisCall < maxBytesPerCall) {
			const available = stats.size - state.offset;
			if (available <= 0) break;
			const remainingCallBudget = maxBytesPerCall - bytesReadThisCall;
			const bytesToRead = Math.min(available, maxChunk, remainingCallBudget);
			if (bytesToRead <= 0) break;

			const buf = Buffer.alloc(bytesToRead);
			const { bytesRead } = await handle.read(buf, 0, bytesToRead, state.offset);
			if (bytesRead <= 0) break;
			state.offset += bytesRead;
			bytesReadThisCall += bytesRead;

			const chunk = bytesRead === bytesToRead ? buf : buf.subarray(0, bytesRead);
			const combined = state.partial.length > 0 ? Buffer.concat([state.partial, chunk]) : chunk;
			const lastLf = combined.lastIndexOf(0x0a);

			if (lastLf === -1) {
				state.partial = combined.length > MAX_PARTIAL_BYTES
					? combined.subarray(combined.length - MAX_PARTIAL_BYTES)
					: combined;
				break;
			}

			const complete = combined.subarray(0, lastLf + 1);
			state.partial = combined.subarray(lastLf + 1);

			const text = complete.toString("utf8");
			const lines = text.split("\n");
			const newRecords: SessionTailRecord[] = [];
			let newRecordBytes = 0;

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed: unknown = JSON.parse(trimmed);
					if (isRecord(parsed)) {
						newRecords.push(parsed);
						newRecordBytes += Buffer.byteLength(JSON.stringify(parsed), "utf8");
					}
				} catch {}
			}

			if (newRecords.length > 0) {
				state.records.push(...newRecords);
				state.totalRecordBytes += newRecordBytes;

				while (
					(state.records.length > maxRecords || state.totalRecordBytes > maxRecordBytes) &&
					state.records.length > 0
				) {
					const shifted = state.records.shift();
					if (shifted !== undefined) {
						const shiftedBytes = Buffer.byteLength(JSON.stringify(shifted), "utf8");
						state.totalRecordBytes = Math.max(0, state.totalRecordBytes - shiftedBytes);
					}
				}
				anyChanged = true;
			}
		}

		return { changed: anyChanged, records: state.records };
	} catch (error) {
		return {
			changed: false,
			records: state.records,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export function sessionRetentionMs(env: NodeJS.Dict<string> = process.env): number {
	const raw = env[SESSION_RETENTION_ENV];
	if (raw === undefined) return DEFAULT_SESSION_RETENTION_MS;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_SESSION_RETENTION_MS;
	return parsed;
}

async function newestMtimeMs(dir: string): Promise<number | undefined> {
	try {
		const dirStats = await lstat(dir);
		if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) return undefined;
		let newest = dirStats.mtimeMs;
		const walk = async (current: string, depth: number): Promise<void> => {
			if (depth > 4) return;
			const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const path = join(current, entry.name);
				const stats = await lstat(path).catch(() => undefined);
				if (stats === undefined) continue;
				newest = Math.max(newest, stats.mtimeMs);
				if (stats.isDirectory() && !stats.isSymbolicLink()) await walk(path, depth + 1);
			}
		};
		await walk(dir, 0);
		return newest;
	} catch {
		return undefined;
	}
}

async function directoryNames(dir: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export async function cleanupStaleChildSessions(input: Readonly<{
	root: string;
	maxAgeMs?: number;
	now?: number;
}>): Promise<number> {
	const maxAgeMs = input.maxAgeMs ?? sessionRetentionMs();
	const now = input.now ?? Date.now();
	const workflowsDir = join(input.root, "workflows");
	let activeWorkflows: ReadonlySet<string>;
	try {
		const leases = await snapshotActiveLeases(join(input.root, "scheduler"));
		activeWorkflows = new Set(leases.map((lease) => lease.workflowId));
	} catch {
		return 0;
	}
	let removed = 0;
	for (const workflowId of await directoryNames(workflowsDir)) {
		if (activeWorkflows.has(workflowId)) continue;
		const workflowDir = join(workflowsDir, workflowId);
		if (await exists(join(workflowDir, "COMMITTED"))) continue;
		const candidates: string[] = [];
		const childrenDir = join(workflowDir, "children");
		for (const childName of await directoryNames(childrenDir)) {
			const childDir = join(childrenDir, childName);
			candidates.push(join(childDir, "session"));
			for (const nested of await directoryNames(join(childDir, "sessions"))) {
				candidates.push(join(childDir, "sessions", nested));
			}
		}
		for (const candidate of candidates) {
			const newest = await newestMtimeMs(candidate);
			if (newest === undefined) continue;
			if (now - newest <= maxAgeMs) continue;
			try {
				await rm(candidate, { recursive: true, force: true });
				removed += 1;
			} catch {
			}
		}
	}
	return removed;
}
