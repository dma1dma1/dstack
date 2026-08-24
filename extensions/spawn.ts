import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	NESTING_ENV,
	PER_TASK_OUTPUT_CAP,
	type TaskRequest,
	type TaskSpec,
} from "./types.ts";

export class NestingError extends Error {
	constructor() {
		super("dstack_task refused: children cannot spawn children (DSTACK_NESTING is set).");
		this.name = "NestingError";
	}
}

export function assertNotNested(env: NodeJS.Dict<string> = process.env): void {
	if (env[NESTING_ENV]) throw new NestingError();
}

export type SpawnArgv = {
	args: string[];
	env: Record<string, string>;
};

export function buildChildArgv(input: {
	task: string;
	model?: string;
	omitModel?: boolean;
	tools?: string;
	systemPromptPath?: string;
}): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (input.model && !input.omitModel) args.push("--model", input.model);
	if (input.tools) args.push("--tools", input.tools);
	if (input.systemPromptPath) args.push("--append-system-prompt", input.systemPromptPath);
	args.push(`Task: ${input.task}`);
	return args;
}

export function childEnv(parent: NodeJS.Dict<string> = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value !== undefined) env[key] = value;
	}
	env[NESTING_ENV] = "1";
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
	tools?: string;
	cwd?: string;
	worktree?: boolean;
	dmode?: boolean;
	tasks?: TaskSpec[];
	chain?: TaskSpec[];
}): TaskRequest | { error: string } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	if (modeCount !== 1) return { error: "Provide exactly one of agent+task, tasks, or chain." };
	if (hasTasks) {
		if ((params.tasks?.length ?? 0) > MAX_PARALLEL_TASKS) {
			return { error: `Too many parallel tasks (${params.tasks?.length}). Max is ${MAX_PARALLEL_TASKS}.` };
		}
		return { kind: "parallel", specs: params.tasks as TaskSpec[] };
	}
	if (hasChain) return { kind: "chain", specs: params.chain as TaskSpec[] };
	return {
		kind: "single",
		spec: {
			agent: params.agent as string,
			task: params.task as string,
			model: params.model,
			role: params.role,
			tools: params.tools,
			cwd: params.cwd,
			worktree: params.worktree,
			dmode: params.dmode,
		},
	};
}

export function resolveAgent(spec: TaskSpec): { agent: string; dmode: boolean; tools?: string } {
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

export type JsonLineEvent = {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
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
};

export type ChildResult = {
	text: string;
	exitCode: number;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
};

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

function lastAssistantText(messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		for (const part of msg.content ?? []) {
			if (part.type === "text" && part.text) return part.text;
		}
	}
	return "";
}

export function applyJsonEvent(
	event: JsonLineEvent,
	state: { messages: NonNullable<JsonLineEvent["message"]>[]; result: ChildResult },
): void {
	if (event.type !== "message_end" || !event.message) return;
	const msg = event.message;
	state.messages.push(msg);
	if (msg.role !== "assistant") return;
	state.result.usage.turns += 1;
	const usage = msg.usage;
	if (usage) {
		state.result.usage.input += usage.input || 0;
		state.result.usage.output += usage.output || 0;
		state.result.usage.cacheRead += usage.cacheRead || 0;
		state.result.usage.cacheWrite += usage.cacheWrite || 0;
		state.result.usage.cost += usage.cost?.total || 0;
		state.result.usage.contextTokens = usage.totalTokens || 0;
	}
	const reportedModel = msg.responseModel ?? msg.model;
	if (!state.result.model && reportedModel) {
		state.result.model = msg.provider ? `${msg.provider}/${reportedModel}` : reportedModel;
	}
	if (msg.stopReason) state.result.stopReason = msg.stopReason;
	if (msg.errorMessage) state.result.errorMessage = msg.errorMessage;
	state.result.text = lastAssistantText(state.messages);
}

export async function runChildProcess(input: {
	args: string[];
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}): Promise<ChildResult> {
	const invocation = getPiInvocation(input.args);
	const result: ChildResult = {
		text: "",
		exitCode: 0,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
	const state = { messages: [] as NonNullable<JsonLineEvent["message"]>[], result };

	result.exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: input.cwd,
			env: input.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				applyJsonEvent(JSON.parse(line) as JsonLineEvent, state);
			} catch {
				return;
			}
		};
		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data: Buffer) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));
		if (input.signal) {
			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (input.signal.aborted) killProc();
			else input.signal.addEventListener("abort", killProc, { once: true });
		}
	});

	if (!result.text) result.text = result.errorMessage || result.stderr || "(no output)";
	return result;
}

export { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, PER_TASK_OUTPUT_CAP };
