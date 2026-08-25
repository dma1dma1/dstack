// Real multiprocess scheduler worker driven over stdin/stdout lines.
//
// stdout protocol: "acquired", "released", "aborted"
// stdin commands:  "release" | "abort" | "exit" | "exit-holding"
//
// "exit-holding" exits without releasing, simulating a crashed lease owner.
import { createInterface } from "node:readline";
import { toAbsolutePath } from "../../extensions/background/artifacts.ts";
import { acquireChildSlot, type ChildDepth } from "../../extensions/background/scheduler.ts";

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
const depth: ChildDepth = argValue("--depth") === "2" ? 2 : 1;
const canNest = process.argv.includes("--can-nest");

const controller = new AbortController();
let release: (() => Promise<void>) | undefined;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	void handleCommand(line);
});

async function handleCommand(line: string): Promise<void> {
	if (line === "abort") {
		controller.abort();
	} else if (line === "release") {
		if (release === undefined) return;
		await release();
		process.stdout.write("released\n");
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
		depth,
		canNest,
		signal: controller.signal,
	});
	release = lease.release;
	process.stdout.write("acquired\n");
} catch (error) {
	if (controller.signal.aborted) {
		process.stdout.write("aborted\n");
		process.exit(0);
	}
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
}
