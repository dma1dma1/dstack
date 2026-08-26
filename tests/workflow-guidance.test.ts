import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const dmode = read("skills/dmode/SKILL.md");
const feature = read("skills/dmode/playbooks/feature.md");
const figureItOut = read("skills/figure-it-out/SKILL.md");
const implementationPlaybooks = [
	feature,
	read("skills/dmode/playbooks/bug-fix.md"),
	read("skills/dmode/playbooks/perf-issue.md"),
	read("skills/dmode/playbooks/refactoring.md"),
].join("\n");

test("dmode routes one owner and lets playbooks own phases", () => {
	assert.match(dmode, /route each nontrivial request to exactly one depth-1 owner/);
	assert.match(dmode, /playbook owns its phases/);
	assert.match(dmode, /as many bounded worker batches as needed/);
	assert.match(dmode, /There is no global rigor level and no universal design or judge gate/);
	assert.match(dmode, /Feature handles features of any size.*figure-it-out.*only when no bundled playbook fits/s);
});

test("implementation playbooks use design only for unresolved consequential choices", () => {
	assert.match(feature, /consequential unresolved choice with multiple plausible shapes/);
	assert.match(feature, /A large diff alone does not require Architect/);
	assert.doesNotMatch(implementationPlaybooks, /selected rigor|Rigor table|single design gate|medium\/high/i);
	assert.doesNotMatch(implementationPlaybooks, /function boundary[^\n]*architect/i);
});

test("worker checks stay mechanical and reviews happen at the integrated change", () => {
	assert.match(figureItOut, /Per unit: run the relevant tests, typecheck, and build\. Read the diff yourself\. Do not spawn a per-unit judge/);
	assert.match(feature, /Review the completed change once, never each implementation step/);
	assert.doesNotMatch(feature, /no skip-with-reason escape/);
});
