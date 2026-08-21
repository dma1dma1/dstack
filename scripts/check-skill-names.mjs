#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "skills";
let bad = 0;
for (const dir of readdirSync(root)) {
	const skill = join(root, dir, "SKILL.md");
	try {
		if (!statSync(skill).isFile()) continue;
	} catch {
		continue;
	}
	const text = readFileSync(skill, "utf8");
	const m = text.match(/^name:\s*(.+)$/m);
	const name = m ? m[1].trim().replace(/^["']|["']$/g, "") : "(missing)";
	if (name !== dir) {
		console.log(`${dir} -> name: ${name}`);
		bad += 1;
	}
}
if (bad === 0) console.log("frontmatter names match folders");
else process.exit(1);
