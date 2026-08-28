import { spawn } from "node:child_process";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./background/artifacts.ts";
import type { SemanticStatus } from "./background/journal.ts";
import type { NestedChild, TreeChild, TreeChildState, TreeSnapshot } from "./background/tree.ts";

export const DSTACK_STATUS_SCHEMA_VERSION = "dstack.status.v1";
export const DSTACK_STATUS_HEARTBEAT_INTERVAL_MS = 5_000;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

export type DstackRollupState =
	| "working"
	| "waiting_on_input"
	| "waiting_on_approval"
	| "idle"
	| "completed"
	| "failed";

export type DstackRootState = "working" | "idle";
export type DstackTaskState = "queued" | "working" | "completed" | "failed" | "cancelled";

export type DstackStatusTask = Readonly<{
	id: string;
	kind: "workflow" | "agent";
	state: DstackTaskState;
	summary: string;
	phase?: string;
	status?: SemanticStatus;
	children: readonly DstackStatusTask[];
}>;

export type DstackStatusSnapshot = Readonly<{
	schemaVersion: typeof DSTACK_STATUS_SCHEMA_VERSION;
	sessionId: string;
	process: Readonly<{
		pid: number;
		startedAt: string;
		hostname: string;
		cwd: string;
		execPath: string;
	}>;
	heartbeat: Readonly<{
		updatedAt: string;
		intervalMs: number;
	}>;
	rollup: DstackRollupState;
	root: Readonly<{
		state: DstackRootState;
		status?: SemanticStatus;
	}>;
	task?: DstackStatusTask;
	shutdown?: Readonly<{
		clean: true;
		at: string;
	}>;
}>;

export type DstackStatusInput = Readonly<{
	sessionId: string;
	process: DstackStatusSnapshot["process"];
	heartbeatAt: string;
	heartbeatIntervalMs: number;
	rootState: DstackRootState;
	rootStatus?: SemanticStatus;
	tree?: TreeSnapshot;
	task?: DstackStatusTask;
	taskTerminalState?: "completed" | "failed" | "cancelled";
	shutdownAt?: string;
}>;

export type DstackStatusHealth = "live" | "stale" | "crashed" | "shutdown";

function childState(state: TreeChildState): DstackTaskState {
	switch (state) {
		case "queued": return "queued";
		case "running": return "working";
		case "succeeded": return "completed";
		case "failed": return "failed";
		case "cancelled": return "cancelled";
		case "skipped": return "cancelled";
	}
}

function nestedTask(child: NestedChild): DstackStatusTask {
	if ("groupId" in child) {
		return {
			id: `${child.groupId}:${child.nestedIndex}`,
			kind: "agent",
			state: childState(child.state),
			summary: child.taskPreview,
			...(child.status?.phase !== undefined ? { phase: child.status.phase } : {}),
			...(child.status !== undefined ? { status: child.status } : {}),
			children: [],
		};
	}
	return {
		id: child.childId,
		kind: "agent",
		state: "working",
		summary: `depth ${child.depth} agent`,
		children: [],
	};
}

function treeChildTask(child: TreeChild, index: number): DstackStatusTask {
	const nested = child.nestedGroups.flatMap((group) => group.children.map(nestedTask));
	return {
		id: String(index),
		kind: "agent",
		state: childState(child.state),
		summary: child.taskPreview,
		...(child.status?.phase !== undefined ? { phase: child.status.phase } : child.phase !== undefined ? { phase: child.phase } : {}),
		...(child.status !== undefined ? { status: child.status } : {}),
		children: nested,
	};
}

function taskFromTree(tree: TreeSnapshot, terminal?: "completed" | "failed" | "cancelled"): DstackStatusTask {
	const children = tree.children.map(treeChildTask);
	const failed = children.some((child) => child.state === "failed");
	const cancelled = children.some((child) => child.state === "cancelled");
	const settledState: DstackTaskState = failed ? "failed" : cancelled ? "cancelled" : "completed";
	const state: DstackTaskState = terminal ?? (tree.committed ? settledState : "working");
	return {
		id: tree.taskId,
		kind: "workflow",
		state,
		summary: tree.playbook === undefined ? `${tree.mode} workflow` : `${tree.playbook} workflow`,
		children,
	};
}

function taskHasBlocker(task: DstackStatusTask | undefined, blocker: "human" | "approval"): boolean {
	if (task === undefined) return false;
	return task.status?.blockedOn === blocker || task.children.some((child) => taskHasBlocker(child, blocker));
}

export function reduceDstackStatus(input: DstackStatusInput): DstackStatusSnapshot {
	const task = input.task ?? (input.tree === undefined ? undefined : taskFromTree(input.tree, input.taskTerminalState));
	let rollup: DstackRollupState;
	if (input.shutdownAt !== undefined) rollup = "idle";
	else if (input.rootStatus?.blockedOn === "human" || taskHasBlocker(task, "human")) rollup = "waiting_on_input";
	else if (input.rootStatus?.blockedOn === "approval" || taskHasBlocker(task, "approval")) rollup = "waiting_on_approval";
	else if (input.rootState === "working") rollup = "working";
	else if (task?.state === "failed") rollup = "failed";
	else if (task?.state === "completed") rollup = "completed";
	else if (task?.state === "cancelled") rollup = "idle";
	else if (task?.state === "working" || task?.state === "queued") rollup = "working";
	else rollup = "idle";

	return {
		schemaVersion: DSTACK_STATUS_SCHEMA_VERSION,
		sessionId: input.sessionId,
		process: input.process,
		heartbeat: { updatedAt: input.heartbeatAt, intervalMs: input.heartbeatIntervalMs },
		rollup,
		root: {
			state: input.shutdownAt === undefined ? input.rootState : "idle",
			...(input.rootStatus !== undefined ? { status: input.rootStatus } : {}),
		},
		...(task !== undefined ? { task } : {}),
		...(input.shutdownAt !== undefined ? { shutdown: { clean: true, at: input.shutdownAt } } : {}),
	};
}

export function classifyDstackStatus(
	snapshot: DstackStatusSnapshot,
	input: Readonly<{ nowMs: number; processAlive: boolean }>,
): DstackStatusHealth {
	if (snapshot.shutdown?.clean === true) return "shutdown";
	const heartbeatMs = Date.parse(snapshot.heartbeat.updatedAt);
	const stale = !Number.isFinite(heartbeatMs) || input.nowMs - heartbeatMs > snapshot.heartbeat.intervalMs * 2;
	if (!stale) return "live";
	return input.processAlive ? "stale" : "crashed";
}

export function encodedSessionId(sessionId: string): string {
	return Buffer.from(sessionId, "utf8").toString("base64url");
}

export function dstackStatusPath(sessionId: string, home = homedir()): string {
	return join(home, ".pi", "agent", "dstack", "status", `${encodedSessionId(sessionId)}.json`);
}

function notify(command: string, json: string): void {
	const child = spawn(command, [], { shell: false, stdio: ["pipe", "ignore", "ignore"] });
	child.once("error", () => undefined);
	child.stdin.once("error", () => undefined);
	child.stdin.end(json);
	child.unref();
}

export class DstackStatusWriter {
	readonly sessionId: string;
	readonly path: string;
	readonly heartbeatIntervalMs: number;
	readonly processIdentity: DstackStatusSnapshot["process"];
	private readonly notifyCommand: string | undefined;
	private lastRollup: DstackRollupState | undefined;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		sessionId: string,
		path = dstackStatusPath(sessionId),
		heartbeatIntervalMs = DSTACK_STATUS_HEARTBEAT_INTERVAL_MS,
		notifyCommand = process.env.DSTACK_STATUS_NOTIFY_COMMAND,
	) {
		this.sessionId = sessionId;
		this.path = path;
		this.heartbeatIntervalMs = heartbeatIntervalMs;
		this.notifyCommand = notifyCommand;
		this.processIdentity = {
			pid: process.pid,
			startedAt: PROCESS_STARTED_AT,
			hostname: hostname(),
			cwd: process.cwd(),
			execPath: process.execPath,
		};
	}

	write(input: Omit<DstackStatusInput, "sessionId" | "process" | "heartbeatIntervalMs">): Promise<DstackStatusSnapshot> {
		const operation = this.writeChain.then(async () => {
			const snapshot = reduceDstackStatus({
				...input,
				sessionId: this.sessionId,
				process: this.processIdentity,
				heartbeatIntervalMs: this.heartbeatIntervalMs,
			});
			const json = `${JSON.stringify(snapshot, null, 2)}\n`;
			await atomicWriteFile(this.path, json);
			const rollupChanged = snapshot.rollup !== this.lastRollup;
			this.lastRollup = snapshot.rollup;
			if (this.notifyCommand !== undefined && this.notifyCommand !== "" && rollupChanged) {
				notify(this.notifyCommand, json);
			}
			return snapshot;
		});
		this.writeChain = operation.then(() => undefined, () => undefined);
		return operation;
	}
}
