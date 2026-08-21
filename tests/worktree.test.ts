import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorktree, uniqueSlug, worktreeDest, WorktreeError } from "../extensions/worktree.ts";

test("worktree dest path is ~/.dma/worktrees/<repo>/<slug>", () => {
	const dest = worktreeDest({
		base: "~/.dma/worktrees",
		repo: "app",
		slug: "fix-auth",
		home: "/Users/me",
	});
	assert.equal(dest, "/Users/me/.dma/worktrees/app/fix-auth");
});

test("worktree fail-closed does not return parent cwd", async () => {
	const parent = "/tmp/parent-repo";
	await assert.rejects(
		() =>
			createWorktree({
				repoRoot: parent,
				task: "write files",
				base: "~/.dma/worktrees",
				from: "HEAD",
				home: "/tmp/home",
				slug: "nope",
				runGit: async (args) => {
					if (args[0] === "rev-parse") return { stdout: `${parent}\n`, stderr: "" };
					throw new WorktreeError("fatal: 'nope' already exists");
				},
			}),
		(err: unknown) => {
			assert.ok(err instanceof WorktreeError);
			assert.match(err.message, /worktree add failed/);
			assert.equal((err as WorktreeError).message.includes(parent), false);
			return true;
		},
	);
});

test("unique slugs differ for parallel writers", () => {
	assert.notEqual(uniqueSlug("edit", 1, "aaa"), uniqueSlug("edit", 1, "bbb"));
});
