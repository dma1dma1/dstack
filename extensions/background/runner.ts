import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_PREFLIGHT_PROTOCOL = "dstack.runner-preflight.v1";

export function runRuntimePreflight(argv: readonly string[]): number {
	if (argv.length === 1 && argv[0] === "--runtime-preflight") {
		process.stdout.write(`${RUNNER_PREFLIGHT_PROTOCOL}\n`);
		return 0;
	}
	process.stderr.write("Usage: runner.ts --runtime-preflight\n");
	return 2;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
	process.exitCode = runRuntimePreflight(process.argv.slice(2));
}
