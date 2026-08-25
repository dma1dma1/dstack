// Real multiprocess scheduler worker driven over stdin/stdout lines.
//
// stdout protocol: "acquired", "released", "aborted", "bound",
//                  "cycle-done", "all-cycles-done"
// stdin commands:  "release" | "abort" | "exit" | "exit-holding" | "bind <pid>"
//
// "exit-holding" exits without releasing, simulating a crashed lease owner.
// With --cycles N --hold-ms M the worker instead loops acquire/hold/release
// N times, printing "cycle-done" per cycle, and ignores stdin.
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { toAbsolutePath } from "../../extensions/background/artifacts.ts";
import { acquireChildSlot, type ChildWork } from "../../extensions/background/scheduler.ts";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(flag: string): string {
	const value = argValue(flag);
	if (value === undefined) {
		process.stderr.write(`missing required flag ${flag}\n`);
		process.exit(2);
	}
	return value;
}

const schedulerRoot = toAbsolutePath(required("--root"));
const workflowId = argValue("--workflow") ?? "wf-scheduler-test";
const childId = required("--child");
const work: ChildWork = {
	depth: argValue("--depth") === "2" ? 2 : 1,
	...(process.argv.includes("--non-nesting") ? { tools: ["read"] } : {}),
};

const cycles = Number.parseInt(argValue("--cycles") ?? "0", 10);
const holdMs = Number.parseInt(argValue("--hold-ms") ?? "0", 10);

function fail(error: unknown): never {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
}

if (cycles > 0) {
	try {
		for (let index = 0; index < cycles; index += 1) {
			const lease = await acquireChildSlot({
				schedulerRoot,
				workflowId,
				childId: `${childId}-cycle-${index}`,
				work,
				signal: new AbortController().signal,
			});
			if (holdMs > 0) await sleep(holdMs);
			await lease.release();
			process.stdout.write("cycle-done\n");
		}
		process.stdout.write("all-cycles-done\n");
		process.exit(0);
	} catch (error) {
		fail(error);
	}
}

const controller = new AbortController();
let release: (() => Promise<void>) | undefined;
let bindChild: ((pid: number) => Promise<void>) | undefined;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	handleCommand(line).catch(fail);
});

async function handleCommand(line: string): Promise<void> {
	if (line === "abort") {
		controller.abort();
	} else if (line === "release") {
		if (release === undefined) return;
		await release();
		process.stdout.write("released\n");
	} else if (line.startsWith("bind ")) {
		if (bindChild === undefined) return;
		await bindChild(Number.parseInt(line.slice("bind ".length), 10));
		process.stdout.write("bound\n");
	} else if (line === "exit") {
		process.exit(0);
	} else if (line === "exit-holding") {
		// Die without releasing: the lease file must survive this process.
		process.exit(0);
	}
}

try {
	const lease = await acquireChildSlot({
		schedulerRoot,
		workflowId,
		childId,
		work,
		signal: controller.signal,
	});
	release = lease.release;
	bindChild = lease.bindChild;
	process.stdout.write("acquired\n");
} catch (error) {
	if (controller.signal.aborted) {
		process.stdout.write("aborted\n");
		process.exit(0);
	}
	fail(error);
}
