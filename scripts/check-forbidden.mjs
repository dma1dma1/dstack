#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skills = join(root, "skills");
const forbidden = [
	{ name: "subagent_type", re: /subagent_type/g },
	{ name: "AskQuestion", re: /AskQuestion/g },
	{ name: "TodoWrite", re: /TodoWrite/g },
	{ name: "move_agent", re: /move_agent/g },
	{ name: "Task", re: /\bTask\b/g },
	{ name: "grok-4", re: /grok-4/g },
	{ name: "claude-", re: /claude-/g },
	{ name: "gpt-5", re: /gpt-5/g },
	{ name: "cursor", re: /\bcursor\b/gi },
	{ name: "cloud", re: /\bcloud\b/gi },
	{ name: "the configured role model", re: /the configured role model/g },
];

function walk(dir, acc = []) {
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return acc;
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, acc);
		else acc.push(full);
	}
	return acc;
}

let failed = false;
for (const file of walk(skills)) {
	const text = readFileSync(file, "utf8");
	const rel = relative(root, file);
	for (const item of forbidden) {
		const matches = text.match(item.re);
		if (!matches) continue;
		failed = true;
		console.error(`${rel}: ${item.name} x${matches.length}`);
	}
}

if (failed) {
	process.exit(1);
}
console.log("skills forbidden-name grep: clean");
