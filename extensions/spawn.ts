import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	ASSIGNMENT_ENV,
	COMMENT_SICKO_TOOLS,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	NESTING_ENV,
	PER_TASK_OUTPUT_CAP,
	type ChildDepth,
	type NestingDepth,
	type SpawnableDepth,
	type TaskRequest,
	type TaskSpec,
	type WorkflowAssignment,
	type WorkflowContext,
} from "./types.ts";
import { parseWorkflowContext } from "./workflow-context.ts";

export class NestingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NestingError";
	}
}

export function parseNestingDepth(value: string | undefined): NestingDepth {
	if (value === undefined || value === "0") return 0;
	if (value === "1") return 1;
	if (value === "2") return 2;
	throw new NestingError(`dstack_task refused: invalid ${NESTING_ENV} value ${JSON.stringify(value)}.`);
}

export function spawnableDepth(env: NodeJS.Dict<string> = process.env): SpawnableDepth {
	const depth = parseNestingDepth(env[NESTING_ENV]);
	const assignment = env[ASSIGNMENT_ENV];
	if (assignment === "worker" || assignment === "reviewer") {
		throw new NestingError(`dstack_task refused: ${assignment} assignments are terminal and cannot spawn children.`);
	}
	if (depth === 2) {
		throw new NestingError("dstack_task refused: depth 2 is terminal and cannot spawn children.");
	}
	return depth;
}

export function childDepthFor(parentDepth: SpawnableDepth): ChildDepth {
	return parentDepth === 0 ? 1 : 2;
}

export type SpawnArgv = {
	args: string[];
	env: Record<string, string>;
};

export function buildChildArgv(input: {
	task: string;
	extensionPath: string;
	model?: string;
	omitModel?: boolean;
	tools?: string;
	systemPromptPath?: string;
}): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "-e", input.extensionPath];
	if (input.model && !input.omitModel) args.push("--model", input.model);
	if (input.tools) args.push("--tools", input.tools);
	if (input.systemPromptPath) args.push("--append-system-prompt", input.systemPromptPath);
	args.push(`Task: ${input.task}`);
	return args;
}

export function childEnv(
	depth: ChildDepth,
	parent: NodeJS.Dict<string> = process.env,
	assignment?: WorkflowAssignment,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value !== undefined) env[key] = value;
	}
	env[NESTING_ENV] = String(depth);
	if (assignment !== undefined) env[ASSIGNMENT_ENV] = assignment;
	else delete env[ASSIGNMENT_ENV];
	return env;
}

export function capOutput(output: string, cap = PER_TASK_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;
	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export async function mapWithConcurrency<TIn, TOut>(
	items: readonly TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (true) {
				const current = nextIndex++;
				if (current >= items.length) return;
				results[current] = await fn(items[current] as TIn, current);
			}
		}),
	);
	return results;
}

export function parseTaskRequest(params: {
	agent?: string;
	task?: string;
	model?: string;
	role?: string;
	overrideReason?: string;
	tools?: string;
	cwd?: string;
	worktree?: boolean;
	dmode?: boolean;
	workflow?: WorkflowContext;
	tasks?: TaskSpec[];
	chain?: TaskSpec[];
}): TaskRequest | { error: string } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	if (modeCount !== 1) return { error: "Provide exactly one of agent+task, tasks, or chain." };
	const normalizeSpec = (spec: TaskSpec, label: string): TaskSpec | { error: string } => {
		if (spec.workflow === undefined) return spec;
		const workflow = parseWorkflowContext(spec.workflow);
		if ("error" in workflow) return { error: `${label}: ${workflow.error}` };
		return { ...spec, workflow };
	};
	if (hasTasks) {
		if ((params.tasks?.length ?? 0) > MAX_PARALLEL_TASKS) {
			return { error: `Too many parallel tasks (${params.tasks?.length}). Max is ${MAX_PARALLEL_TASKS}.` };
		}
		const specs: TaskSpec[] = [];
		for (const [index, spec] of (params.tasks as TaskSpec[]).entries()) {
			const parsed = normalizeSpec(spec, `tasks[${index}]`);
			if ("error" in parsed) return parsed;
			specs.push(parsed);
		}
		return { kind: "parallel", specs };
	}
	if (hasChain) {
		const specs: TaskSpec[] = [];
		for (const [index, spec] of (params.chain as TaskSpec[]).entries()) {
			const parsed = normalizeSpec(spec, `chain[${index}]`);
			if ("error" in parsed) return parsed;
			specs.push(parsed);
		}
		return { kind: "chain", specs };
	}
	const spec = normalizeSpec({
			agent: params.agent as string,
			task: params.task as string,
			model: params.model,
			role: params.role,
			overrideReason: params.overrideReason,
			tools: params.tools,
			cwd: params.cwd,
			worktree: params.worktree,
			dmode: params.dmode,
			workflow: params.workflow,
		}, "task");
	if ("error" in spec) return spec;
	return { kind: "single", spec };
}

export function resolveAgent(spec: TaskSpec): { agent: string; dmode: boolean; tools?: string } {
	if (spec.workflow?.assignment === "reviewer") {
		return { agent: "general-purpose", dmode: false, tools: spec.tools ?? COMMENT_SICKO_TOOLS };
	}
	const forcedGeneral = spec.dmode === false;
	if (forcedGeneral || spec.agent === "general-purpose") {
		return { agent: "general-purpose", dmode: false, tools: spec.tools };
	}
	if (spec.agent === "comment-sicko") {
		return { agent: "comment-sicko", dmode: false, tools: spec.tools ?? "read,grep,find,ls" };
	}
	if (spec.agent === "poteto-agent") {
		return { agent: "poteto-agent", dmode: spec.dmode !== false, tools: spec.tools };
	}
	return { agent: spec.agent, dmode: spec.dmode === true, tools: spec.tools };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function regularRealPath(path: string, label: string): Promise<string> {
	const resolved = await realpath(path);
	if (!(await stat(resolved)).isFile()) throw new Error(`${label} must be a regular file`);
	return resolved;
}

async function executableRealPath(path: string, label: string): Promise<string> {
	const resolved = await regularRealPath(path, label);
	if (process.platform !== "win32") await access(resolved, constants.X_OK);
	return resolved;
}

async function resolvePathCommand(command: string, pathValue: string | undefined): Promise<string> {
	for (const directory of (pathValue ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, process.platform === "win32" ? `${command}.exe` : command);
		try {
			return await executableRealPath(candidate, command);
		} catch {
			continue;
		}
	}
	throw new Error(`Cannot resolve ${command} to an absolute executable from PATH`);
}

export async function freezePiChildLaunch(input: Readonly<{
	execPath?: string;
	entryScript?: string;
	pathValue?: string;
}> = {}): Promise<ChildInvocation> {
	const execPath = input.execPath ?? process.execPath;
	const entryScript = input.entryScript ?? process.argv[1];
	const bunVirtual = entryScript?.startsWith("/$bunfs/root/") === true;
	if (entryScript !== undefined && !bunVirtual && existsSync(entryScript)) {
		return {
			command: await executableRealPath(execPath, "Pi runtime"),
			argsPrefix: [await regularRealPath(entryScript, "Pi entry script")],
		};
	}
	const execName = basename(execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: await executableRealPath(execPath, "Pi executable"), argsPrefix: [] };
	}
	return { command: await resolvePathCommand("pi", input.pathValue ?? process.env.PATH), argsPrefix: [] };
}

export type ChildContentPart =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> }
	| {
			type: "toolUpdate";
			id: string;
			name: string;
			text: string;
			agents: Array<{ agent: string; exitCode: number; text: string }>;
	  };

export type ChildMessage = {
	role: string;
	content: ChildContentPart[];
	toolCallId?: string;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
};

export type ChildUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

export type ChildResult = {
	text: string;
	exitCode: number;
	stderr: string;
	messages: ChildMessage[];
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	usage: ChildUsage;
};

export function sumChildUsage(usages: readonly ChildUsage[]): Usage | undefined {
	const input = usages.reduce((total, usage) => total + usage.input, 0);
	const output = usages.reduce((total, usage) => total + usage.output, 0);
	const cacheRead = usages.reduce((total, usage) => total + usage.cacheRead, 0);
	const cacheWrite = usages.reduce((total, usage) => total + usage.cacheWrite, 0);
	const total = usages.reduce((sum, usage) => sum + usage.cost, 0);
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsageStats(usage: ChildResult["usage"], model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseContentPart(value: unknown): ChildContentPart | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
	if (value.type === "toolCall" && typeof value.name === "string" && isRecord(value.arguments)) {
		return { type: "toolCall", name: value.name, arguments: value.arguments };
	}
	return undefined;
}

function parseMessage(value: unknown): ChildMessage | undefined {
	if (!isRecord(value) || typeof value.role !== "string" || !Array.isArray(value.content)) return undefined;
	const content = value.content.map(parseContentPart).filter((part): part is ChildContentPart => part !== undefined);
	const rawUsage = isRecord(value.usage) ? value.usage : undefined;
	const rawCost = rawUsage && isRecord(rawUsage.cost) ? rawUsage.cost : undefined;
	return {
		role: value.role,
		content,
		toolCallId: optionalString(value.toolCallId),
		stopReason: optionalString(value.stopReason),
		errorMessage: optionalString(value.errorMessage),
		provider: optionalString(value.provider),
		model: optionalString(value.model),
		responseModel: optionalString(value.responseModel),
		usage: rawUsage
			? {
					input: optionalNumber(rawUsage.input),
					output: optionalNumber(rawUsage.output),
					cacheRead: optionalNumber(rawUsage.cacheRead),
					cacheWrite: optionalNumber(rawUsage.cacheWrite),
					totalTokens: optionalNumber(rawUsage.totalTokens),
					cost: rawCost ? { total: optionalNumber(rawCost.total) } : undefined,
				}
			: undefined,
	};
}

function parseToolUpdate(event: Record<string, unknown>): Extract<ChildContentPart, { type: "toolUpdate" }> | undefined {
	if (event.type !== "tool_execution_update") return undefined;
	if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return undefined;
	const partialResult = isRecord(event.partialResult) ? event.partialResult : undefined;
	if (!partialResult) return undefined;
	const content = Array.isArray(partialResult.content) ? partialResult.content : [];
	const textPart = content.find((part) => isRecord(part) && part.type === "text" && typeof part.text === "string");
	const details = isRecord(partialResult.details) ? partialResult.details : undefined;
	const rawResults = details && Array.isArray(details.results) ? details.results : [];
	const agents = rawResults.flatMap((value) => {
		if (!isRecord(value) || typeof value.agent !== "string" || typeof value.exitCode !== "number") return [];
		const text = typeof value.text === "string" ? value.text : typeof value.errorMessage === "string" ? value.errorMessage : "";
		return [{ agent: value.agent, exitCode: value.exitCode, text }];
	});
	return {
		type: "toolUpdate",
		id: event.toolCallId,
		name: event.toolName,
		text: textPart && isRecord(textPart) && typeof textPart.text === "string" ? textPart.text : "(working...)",
		agents,
	};
}

function lastAssistantText(messages: ChildMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text) return part.text;
		}
	}
	return "";
}

export function applyJsonEvent(event: unknown, state: { messages: ChildMessage[]; result: ChildResult }): boolean {
	if (!isRecord(event)) return false;
	const toolUpdate = parseToolUpdate(event);
	if (toolUpdate) {
		for (let messageIndex = state.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
			const message = state.messages[messageIndex];
			if (!message) continue;
			const partIndex = message.content.findIndex((part) => part.type === "toolUpdate" && part.id === toolUpdate.id);
			if (partIndex !== -1) {
				message.content[partIndex] = toolUpdate;
				state.result.messages = state.messages;
				return true;
			}
		}
		state.messages.push({ role: "activity", content: [toolUpdate] });
		state.result.messages = state.messages;
		return true;
	}
	if (event.type !== "message_end" && event.type !== "tool_result_end") return false;
	const message = parseMessage(event.message);
	if (!message) return false;
	if (
		message.role === "toolResult" &&
		message.toolCallId !== undefined &&
		state.messages.some((existing) => existing.role === "toolResult" && existing.toolCallId === message.toolCallId)
	) return false;
	state.messages.push(message);
	state.result.messages = state.messages;
	if (message.role === "toolResult" && message.usage) {
		state.result.usage.input += message.usage.input ?? 0;
		state.result.usage.output += message.usage.output ?? 0;
		state.result.usage.cacheRead += message.usage.cacheRead ?? 0;
		state.result.usage.cacheWrite += message.usage.cacheWrite ?? 0;
		state.result.usage.cost += message.usage.cost?.total ?? 0;
		return true;
	}
	if (message.role !== "assistant") return true;
	state.result.usage.turns += 1;
	const usage = message.usage;
	if (usage) {
		state.result.usage.input += usage.input ?? 0;
		state.result.usage.output += usage.output ?? 0;
		state.result.usage.cacheRead += usage.cacheRead ?? 0;
		state.result.usage.cacheWrite += usage.cacheWrite ?? 0;
		state.result.usage.cost += usage.cost?.total ?? 0;
		state.result.usage.contextTokens = usage.totalTokens ?? state.result.usage.contextTokens;
	}
	const reportedModel = message.responseModel ?? message.model;
	if (!state.result.model && reportedModel) {
		state.result.model = message.provider ? `${message.provider}/${reportedModel}` : reportedModel;
	}
	if (message.stopReason) state.result.stopReason = message.stopReason;
	if (message.errorMessage) state.result.errorMessage = message.errorMessage;
	state.result.text = lastAssistantText(state.messages);
	return true;
}

function snapshotChildResult(result: ChildResult): ChildResult {
	return { ...result, messages: [...result.messages], usage: { ...result.usage } };
}

export type ChildInvocation = Readonly<{
	command: string;
	argsPrefix: readonly string[];
}>;

export async function runChildProcess(input: {
	args: string[];
	cwd: string;
	env: Record<string, string>;
	invocation?: ChildInvocation;
	signal?: AbortSignal;
	onSpawn?: (pid: number) => void | Promise<void>;
	onUpdate?: (result: ChildResult) => void;
	onStdout?: (chunk: Buffer) => void;
}): Promise<ChildResult> {
	const invocation = input.invocation === undefined
		? getPiInvocation(input.args)
		: { command: input.invocation.command, args: [...input.invocation.argsPrefix, ...input.args] };
	const result: ChildResult = {
		text: "",
		exitCode: -1,
		stderr: "",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	const state = { messages: result.messages, result };

	result.exitCode = await new Promise<number>((resolve, reject) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: input.cwd,
			env: input.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let wasAborted = input.signal?.aborted === true;
		let spawnBoundarySettled = false;
		let closeCode: number | null | undefined;
		let boundaryError: unknown;
		let killTimer: NodeJS.Timeout | undefined;
		proc.stdout.pause();

		const terminate = () => {
			proc.kill("SIGTERM");
			killTimer ??= setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, 5000);
		};
		const finish = () => {
			if (!spawnBoundarySettled || closeCode === undefined) return;
			if (killTimer !== undefined) clearTimeout(killTimer);
			input.signal?.removeEventListener("abort", abortChild);
			if (boundaryError !== undefined) {
				reject(boundaryError);
				return;
			}
			if (buffer.trim()) processLine(buffer);
			if (wasAborted) {
				result.stopReason = "aborted";
				result.errorMessage = "Child agent was aborted";
			}
			resolve(closeCode ?? (wasAborted ? 1 : 0));
		};
		const abortChild = () => {
			wasAborted = true;
			if (spawnBoundarySettled && boundaryError === undefined) terminate();
		};
		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event: unknown = JSON.parse(line);
				if (applyJsonEvent(event, state)) input.onUpdate?.(snapshotChildResult(result));
			} catch {
				return;
			}
		};
		proc.stdout.on("data", (data: Buffer) => {
			input.onStdout?.(data);
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data: Buffer) => {
			result.stderr += data.toString();
		});
		proc.on("spawn", () => {
			const pid = proc.pid;
			if (pid === undefined) {
				boundaryError = new Error("spawned child did not expose a pid");
				spawnBoundarySettled = true;
				terminate();
				finish();
				return;
			}
			Promise.resolve().then(() => input.onSpawn?.(pid)).then(
				() => {
					spawnBoundarySettled = true;
					if (wasAborted) terminate();
					else proc.stdout.resume();
					finish();
				},
				(error: unknown) => {
					boundaryError = error;
					spawnBoundarySettled = true;
					terminate();
					finish();
				},
			);
		});
		proc.on("close", (code) => {
			closeCode = code;
			finish();
		});
		proc.on("error", (error) => {
			result.errorMessage = error.message;
			spawnBoundarySettled = true;
			closeCode ??= 1;
			finish();
		});
		input.signal?.addEventListener("abort", abortChild, { once: true });
	});

	if (!result.text) result.text = result.errorMessage || result.stderr || "(no output)";
	return result;
}

export { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, PER_TASK_OUTPUT_CAP };
