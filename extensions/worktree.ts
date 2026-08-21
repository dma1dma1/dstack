import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { WorktreeFrom } from "./types.ts";

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeError";
	}
}

export type RunGit = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

export function kebabSlug(text: string): string {
	const kebab = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return kebab || "task";
}

export function uniqueSlug(task: string, now = Date.now(), entropy = randomBytes(3).toString("hex")): string {
	return `${kebabSlug(task)}-${now.toString(36)}-${entropy}`;
}

export function worktreeDest(input: { base: string; repo: string; slug: string; home?: string }): string {
	return join(expandHome(input.base, input.home), input.repo, input.slug);
}

async function defaultRunGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		return { stdout, stderr };
	} catch (err) {
		const error = err as Error & { stderr?: string };
		throw new WorktreeError(error.stderr?.trim() || error.message);
	}
}

export async function createWorktree(input: {
	repoRoot: string;
	task: string;
	base: string;
	from: WorktreeFrom;
	runGit?: RunGit;
	home?: string;
	slug?: string;
}): Promise<string> {
	const runGit = input.runGit ?? defaultRunGit;
	let repo = "repo";
	try {
		const { stdout } = await runGit(["rev-parse", "--show-toplevel"], input.repoRoot);
		repo = basename(stdout.trim()) || repo;
	} catch {
		throw new WorktreeError("worktree add failed: not a git repository");
	}
	const slug = input.slug ?? uniqueSlug(input.task);
	const dest = worktreeDest({ base: input.base, repo, slug, home: input.home });
	const branch = `dma/${slug}`;
	try {
		await runGit(["worktree", "add", "-b", branch, dest, input.from], input.repoRoot);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new WorktreeError(`worktree add failed: ${message}`);
	}
	return dest;
}
