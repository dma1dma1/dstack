#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skills = join(dirname(dirname(fileURLToPath(import.meta.url))), "skills");

const replacements = [
	[/~\/\.cursor\/projects\/\*\//g, "host transcript dirs/"],
	[/~\/\.cursor\/projects/g, "host transcript dirs"],
	[/~\/\.cursor\/skills/g, "user skills"],
	[/~\/\.cursor\/plugins/g, "host plugin cache"],
	[/\.cursor\/skills/g, "project skills"],
	[/\.cursor\/worktrees/g, "~/.dma/worktrees"],
	[/Cursor cloud agents?/g, "child agents"],
	[/Cursor's built-in/g, "the host's built-in"],
	[/a Cursor restart/g, "a host restart"],
	[/cloud-agent URL/g, "prior-session URL"],
	[/cloud workers/g, "workers"],
	[/cloud concurrency/g, "concurrency"],
	[/cloud root/g, "remote root"],
	[/cloud spawn/g, "child spawn"],
	[/cloud spawns/g, "child spawns"],
	[/cloud environment/g, "remote environment"],
	[/cloud sleeper/g, "remote sleeper"],
	[/cloud-sleeper/g, "remote-sleeper"],
	[/cloud agent/g, "child agent"],
	[/a cloud one/g, "a remote one"],
	[/in cloud/g, "remotely"],
	[/cursor location/g, "insertion point"],
	[/`readonly`: `true`/g, '`dmode: false`\n- `tools: "read,grep,find,ls"`'],
	[/`readonly`: `false`/g, "`dmode: false`"],
	[/agent mode \(`readonly: false`\)/g, "agent mode (`dmode: false`)"],
	[/readonly strips MCP/g, "missing MCP companions skip that source"],
	[/pass `cloud_base_branch`\.?/g, "pass that branch as `cwd` after creating a worktree."],
	[/Use `environment: "local"` only when the worker needs access to something on the user's computer\.\n?/g, ""],
	[/`run_in_background: true`, and /g, ""],
	[/, ``, /g, ", "],
];

function walk(dir, acc = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, acc);
		else if (name.endsWith(".md")) acc.push(full);
	}
	return acc;
}

for (const file of walk(skills)) {
	let text = readFileSync(file, "utf8");
	for (const [re, to] of replacements) text = text.replace(re, to);
	writeFileSync(file, text);
}
console.log("scrubbed remaining host words");
