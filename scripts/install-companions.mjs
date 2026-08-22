import { COMPANIONS, installCompanionSources } from "../extensions/setup.ts";

const optional = process.argv.includes("--optional");
const sources = COMPANIONS.filter((c) => optional || !c.optional).map((c) => c.source);
const results = await installCompanionSources(sources);
for (const result of results) {
	console.log(`${result.ok ? "ok" : "fail"}  ${result.source}`);
	if (result.text) console.log(result.text);
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
