import type { EventBus } from "@earendil-works/pi-coding-agent";

export const REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";

export const taskId = "bg-0123456789abcdef";
export const workflowId = "wf-0123456789abcdef";
export const outputFixtureSeal = Object.freeze({
	sha256: "4d3ac42b53378ed2def23b3bf88787f9fffed17b22bd42ce971d7067dc591dab",
	bytes: 15,
});

export const runningTask = Object.freeze({
	id: taskId,
	name: `dstack-v1:${workflowId}`,
	command: "/usr/bin/node --experimental-strip-types /opt/dstack/extensions/background/runner.ts",
	status: "running",
	outputPath: "/tmp/pi-background-tasks/output.txt",
	cwd: "/unrelated/companion-cwd",
	startTime: 1_700_000_000_000,
	bytesWritten: 0,
	isAgent: true,
	notified: false,
	notifyOnCompletion: true,
	triggerOnCompletion: true,
});

export const completedTask = Object.freeze({
	...runningTask,
	status: "completed",
	endTime: 1_700_000_000_001,
	exitCode: 0,
});

export function responseFrame(requestId: string, result: unknown) {
	return {
		schema_version: "pi-background-tasks.extension-response.v1",
		request_id: requestId,
		operation: "run",
		ok: true,
		result,
	};
}

export function terminalFrame(task: unknown) {
	return {
		schema_version: "pi-background-tasks.extension-terminal.v1",
		task,
	};
}

export function installImmediateCompanion(events: EventBus, observedRequests: unknown[]): () => void {
	return events.on(REQUEST_CHANNEL, (frame) => {
		observedRequests.push(frame);
		if (!isRequestFrame(frame)) throw new Error("fixture received a malformed request frame");
		events.emit(RESPONSE_CHANNEL, responseFrame(frame.request_id, runningTask));
		events.emit(TERMINAL_CHANNEL, terminalFrame(completedTask));
	});
}

function isRequestFrame(value: unknown): value is Readonly<{ request_id: string }> {
	return typeof value === "object" && value !== null && "request_id" in value && typeof value.request_id === "string";
}
