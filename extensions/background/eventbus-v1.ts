import type { EventBus } from "@earendil-works/pi-coding-agent";

const REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";

const TASK_STATUSES = ["running", "completed", "failed", "killed"] as const;
const TASK_KEYS = new Set([
	"id", "name", "command", "description", "status", "outputPath", "cwd", "startTime",
	"endTime", "exitCode", "signal", "pid", "bytesWritten", "isAgent", "error", "notified",
	"notifyOnCompletion", "triggerOnCompletion", "timeoutSeconds", "contextUsage", "tokenUsage",
	"toolUsage", "model", "telemetryUnavailableReason", "attestationPath", "delegate", "fusion",
]);

export type DstackTaskId = string & { readonly __brand: "DstackTaskId" };
export type CompanionStatus = (typeof TASK_STATUSES)[number];

export type CompanionTaskState = Readonly<{
	id: string;
	name?: string;
	command: string;
	status: CompanionStatus;
	outputPath: string;
}>;

export type BackgroundCapabilitiesV1 = Readonly<{
	api_version: 1;
	run: true;
	run_is_agent: true;
	run_completion_trigger: true;
	status: true;
	logs: true;
	logs_bounded: true;
	kill: true;
}>;

export type BackgroundLaunchRequest = Readonly<{
	name: string;
	command: string;
	timeoutSeconds?: number;
}>;

export interface BackgroundTaskPort {
	capabilities(signal?: AbortSignal): Promise<BackgroundCapabilitiesV1>;
	launch(input: Readonly<{
		request: BackgroundLaunchRequest;
		onAccepted: (state: CompanionTaskState) => void;
		signal?: AbortSignal;
	}>): Promise<CompanionTaskState>;
	enumerate(signal?: AbortSignal): Promise<readonly CompanionTaskState[]>;
	statusExact(taskId: string, signal?: AbortSignal): Promise<CompanionTaskState | undefined>;
	kill(taskId: string, signal?: AbortSignal): Promise<CompanionTaskState>;
	close(): void;
}

type JsonRecord = Record<string, unknown>;
type Operation = "capabilities" | "run" | "status" | "kill";

function requireRecord(value: unknown, label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return Object.fromEntries(Object.entries(value));
}

function assertClosed(record: JsonRecord, keys: ReadonlySet<string>, label: string): void {
	for (const key of Object.keys(record)) {
		if (!keys.has(key)) throw new Error(`${label} contains unknown key ${key}`);
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
	return value;
}

function parseStatus(value: unknown): CompanionStatus {
	switch (value) {
		case "running":
		case "completed":
		case "failed":
		case "killed":
			return value;
		default:
			throw new Error("task.status is invalid");
	}
}

function parseTask(value: unknown): CompanionTaskState {
	const task = requireRecord(value, "task");
	assertClosed(task, TASK_KEYS, "task");
	const status = parseStatus(task["status"]);
	const nameValue = task["name"];
	if (nameValue !== undefined && typeof nameValue !== "string") throw new Error("task.name must be a string");

	const base = {
		id: requireString(task["id"], "task.id"),
		command: requireString(task["command"], "task.command"),
		status,
		outputPath: requireString(task["outputPath"], "task.outputPath"),
	};
	return nameValue === undefined ? base : { ...base, name: nameValue };
}

function parseCapabilities(value: unknown): BackgroundCapabilitiesV1 {
	const result = requireRecord(value, "capabilities result");
	assertClosed(result, new Set(["api_version", "run", "run_is_agent", "run_completion_trigger", "status", "logs", "logs_bounded", "kill"]), "capabilities result");
	if (result["api_version"] !== 1) throw new Error("unsupported background task API version");
	for (const key of ["run", "run_is_agent", "run_completion_trigger", "status", "logs", "logs_bounded", "kill"] as const) {
		if (!requireBoolean(result[key], `capabilities.${key}`)) throw new Error(`capabilities.${key} is unavailable`);
	}
	return { api_version: 1, run: true, run_is_agent: true, run_completion_trigger: true, status: true, logs: true, logs_bounded: true, kill: true };
}

function parseTaskList(value: unknown): readonly CompanionTaskState[] {
	const result = requireRecord(value, "status result");
	assertClosed(result, new Set(["tasks"]), "status result");
	if (!Array.isArray(result["tasks"])) throw new Error("status result.tasks must be an array");
	return result["tasks"].map(parseTask);
}

function parseKill(value: unknown): CompanionTaskState {
	const result = requireRecord(value, "kill result");
	assertClosed(result, new Set(["task", "message"]), "kill result");
	requireString(result["message"], "kill result.message");
	return parseTask(result["task"]);
}

export function createEventBusV1Port(options: Readonly<{
	events: EventBus;
	makeRequestId: () => string;
}>): BackgroundTaskPort {
	let closed = false;
	const pendingStops = new Set<() => void>();

	function request<T>(operation: Operation, payload: Readonly<Record<string, unknown>>, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
		if (closed) return Promise.reject(new Error("background task port is closed"));
		const requestId = requireString(options.makeRequestId(), "request id");
		if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error("background task request aborted"));

		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (outcome: Readonly<{ kind: "resolve"; value: T }> | Readonly<{ kind: "reject"; error: unknown }>) => {
				if (settled) return;
				settled = true;
				offResponse();
				signal?.removeEventListener("abort", onAbort);
				pendingStops.delete(stop);
				if (outcome.kind === "resolve") resolve(outcome.value);
				else reject(outcome.error);
			};
			const onAbort = () => finish({ kind: "reject", error: signal?.reason ?? new Error("background task request aborted") });
			const stop = () => finish({ kind: "reject", error: new Error("background task port is closed") });
			const offResponse = options.events.on(RESPONSE_CHANNEL, (raw: unknown) => {
				try {
					const frame = requireRecord(raw, "response frame");
					if (frame["request_id"] !== requestId) return;
					if (frame["schema_version"] !== RESPONSE_SCHEMA || frame["operation"] !== operation || typeof frame["ok"] !== "boolean") throw new Error("malformed background task response");
					if (frame["ok"]) {
						assertClosed(frame, new Set(["schema_version", "request_id", "operation", "ok", "result"]), "response frame");
						finish({ kind: "resolve", value: parse(frame["result"]) });
					} else {
						assertClosed(frame, new Set(["schema_version", "request_id", "operation", "ok", "error"]), "response frame");
						throw new Error(requireString(frame["error"], "response error"));
					}
				} catch (error) {
					finish({ kind: "reject", error });
				}
			});
			pendingStops.add(stop);
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				options.events.emit(REQUEST_CHANNEL, { schema_version: REQUEST_SCHEMA, request_id: requestId, operation, payload });
			} catch (error) {
				finish({ kind: "reject", error });
			}
		});
	}

	return {
		capabilities: (signal) => request("capabilities", {}, parseCapabilities, signal),
		launch(input) {
			const payload = {
				name: input.request.name,
				command: input.request.command,
				isAgent: true,
				notifyOnCompletion: true,
				triggerOnCompletion: true,
				...(input.request.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.request.timeoutSeconds }),
			};
			return request("run", payload, (raw) => {
				const task = parseTask(raw);
				input.onAccepted(task);
				return task;
			}, input.signal);
		},
		enumerate: (signal) => request("status", {}, parseTaskList, signal),
		async statusExact(taskId, signal) {
			const tasks = await request("status", {}, parseTaskList, signal);
			return tasks.find((task) => task.id === taskId);
		},
		kill: (taskId, signal) => request("kill", { taskId }, parseKill, signal),
		close() {
			if (closed) return;
			closed = true;
			for (const stop of [...pendingStops]) stop();
		},
	};
}
