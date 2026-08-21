#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skills = join(dirname(dirname(fileURLToPath(import.meta.url))), "skills");
const FOUR = "`the configured role model`, `the configured role model`, `the configured role model`, `the configured role model`";

const replacements = [
	[FOUR, "the list for that role in models.json"],
	[/\(default `the configured role model`\)/g, "(or inherit-parent if unset)"],
	[/defaults `the configured role model` for code, `the configured role model` for (?:prose and )?judgment/g, "defaults inherit-parent unless models.json sets the role"],
	[/your strongest judgment model \(`the configured role model`\)/g, "the hardest-tasks role"],
	[/your strongest instruction-following model \(`the configured role model`\)/g, "the bug-fix role"],
	[/Otherwise default to one each on the list for that role in models\.json/g, "Otherwise inherit-parent for each runner"],
	[/Otherwise use the list for that role in models\.json/g, "Otherwise inherit-parent"],
	[/Otherwise use `the configured role model`\./g, "Otherwise inherit-parent."],
	[/\| `the configured role model` \|/g, "| inherit-parent |"],
	[/`the configured role model`/g, "inherit-parent"],
];

function walk(dir, acc = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, acc);
		else if (name.endsWith(".md")) acc.push(full);
	}
	return acc;
}

let files = 0;
for (const file of walk(skills)) {
	let text = readFileSync(file, "utf8");
	const before = text;
	for (const [re, to] of replacements) text = text.replace(re, to);
	if (text !== before) {
		writeFileSync(file, text);
		files += 1;
	}
}
console.log(`rewrote role placeholders in ${files} files`);
