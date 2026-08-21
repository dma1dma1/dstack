#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source =
	process.argv[2] ??
	join(process.env.HOME ?? "", ".cursor/plugins/cache/cursor-public/pstack/46125561306434d8a1d7745d540d8932ab0cd2a2/skills");
const dest = join(root, "skills");

if (!existsSync(source)) {
	console.error(`pstack skills not found at ${source}`);
	process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

function shouldSkip(rel) {
	if (rel.startsWith("poteto-mode/scripts")) return true;
	if (rel.includes("/scripts/orch") || rel.includes("/scripts/watch-pr")) return true;
	return false;
}

function walk(dir, acc = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const rel = relative(source, full);
		if (shouldSkip(rel)) continue;
		if (statSync(full).isDirectory()) walk(full, acc);
		else acc.push(rel);
	}
	return acc;
}

for (const rel of walk(source)) {
	const from = join(source, rel);
	const to = join(dest, rel);
	mkdirSync(dirname(to), { recursive: true });
	cpSync(from, to);
}

function renameDir(fromName, toName) {
	const from = join(dest, fromName);
	const to = join(dest, toName);
	if (existsSync(from)) renameSync(from, to);
}

renameDir("poteto-mode", "dmode");
renameDir("setup-pstack", "setup-dstack");

const MODEL_SLUG = /\b(grok-4[^\s`"',]*)|\b(claude-(?:fable|opus|sonnet|haiku)[^\s`"',]*)|\b(gpt-5[^\s`"',]*)/g;

function rewrite(text) {
	let out = text;
	out = out.replace(/subagent_type:\s*"poteto-agent"/g, 'agent: "poteto-agent"');
	out = out.replace(/subagent_type:\s*"generalPurpose"/g, 'agent: "general-purpose", `dmode: false`');
	out = out.replace(/subagent_type:\s*"Comment Sicko"/g, 'agent: "comment-sicko"');
	out = out.replace(/subagent_type/g, "agent");
	out = out.replace(/~\/\.cursor\/rules\/pstack-models\.mdc/g, "~/.pi/agent/dstack/models.json");
	out = out.replace(/\/setup-pstack/g, "/setup-dstack");
	out = out.replace(/AskQuestion/g, "dstack_ask");
	out = out.replace(/TodoWrite/g, "dstack_todo");
	out = out.replace(/move_agent_to_root/g, "worktree cwd");
	out = out.replace(/readonly:\s*true/g, 'tools: "read,grep,find,ls"');
	out = out.replace(/^[ \t]*run_in_background:\s*true\n/gm, "");
	out = out.replace(/^[ \t]*environment:\s*"cloud"\n/gm, "");
	out = out.replace(/\benvironment:\s*"cloud"/g, "");
	out = out.replace(/\bTask\b/g, "dstack_task");
	out = out.replace(/^name:\s*Poteto Mode\s*$/m, "name: dmode");
	out = out.replace(/^name:\s*setup-pstack\s*$/m, "name: setup-dstack");
	out = out.replace(/skills\/poteto-mode/g, "skills/dmode");
	out = out.replace(/\/poteto-mode(?! off)/g, "/dmode");
	out = out.replace(/`poteto-mode`/g, "`dmode`");
	out = out.replace(/\bpoteto-mode\b/g, "dmode");
	out = out.replace(/CURSOR_AGENT/g, "DSTACK_NESTING");
	out = out.replace(/cursor-team-kit/g, "host companion");
	out = out.replace(/\.cursor\/rules/g, ".pi/agent/dstack");
	out = out.replace(/\/loop\b/g, "a host wake companion");
	out = out.replace(MODEL_SLUG, "the configured role model");
	out = out.replace(/\bgeneralPurpose\b/g, "general-purpose");
	return out;
}

function walkDest(dir, acc = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walkDest(full, acc);
		else if (name.endsWith(".md")) acc.push(full);
	}
	return acc;
}

for (const file of walkDest(dest)) {
	writeFileSync(file, rewrite(readFileSync(file, "utf8")));
}

console.log(`rewrote skills from ${source} into ${dest}`);
