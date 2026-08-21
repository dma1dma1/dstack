export type RewriteHit = { pattern: string; count: number };

const ORDERED_REPLACEMENTS: Array<[RegExp, string]> = [
	[/subagent_type:\s*"poteto-agent"/g, 'agent: "poteto-agent"'],
	[/subagent_type:\s*"generalPurpose"/g, 'agent: "general-purpose"\n- `dmode: false`'],
	[/subagent_type:\s*"Comment Sicko"/g, 'agent: "comment-sicko"'],
	[/subagent_type:\s*"poteto-agent"/g, 'agent: "poteto-agent"'],
	[/~\/\.cursor\/rules\/pstack-models\.mdc/g, "~/.pi/agent/dstack/models.json"],
	[/\/setup-pstack/g, "/setup-dstack"],
	[/AskQuestion/g, "dstack_ask"],
	[/TodoWrite/g, "dstack_todo"],
	[/move_agent_to_root/g, "worktree cwd"],
	[/readonly:\s*true/g, 'tools: "read,grep,find,ls"'],
	[/run_in_background:\s*true\n?/g, ""],
	[/environment:\s*"cloud"\n?/g, ""],
	[/\bsubagent_type\b/g, "agent"],
	[/\bTask\b/g, "dstack_task"],
];

export function rewriteSkillText(input: string): string {
	let out = input;
	for (const [pattern, replacement] of ORDERED_REPLACEMENTS) {
		out = out.replace(pattern, replacement);
	}
	out = out.replace(/^name:\s*Poteto Mode\s*$/m, "name: dmode");
	out = out.replace(/^name:\s*setup-pstack\s*$/m, "name: setup-dstack");
	out = out.replace(/skills\/poteto-mode/g, "skills/dmode");
	return out;
}

export const FORBIDDEN_PATTERNS = [
	"subagent_type",
	"AskQuestion",
	"TodoWrite",
	"move_agent",
	"grok-4",
	"claude-",
	"gpt-5",
] as const;

export function forbiddenHits(text: string): RewriteHit[] {
	const hits: RewriteHit[] = [];
	for (const pattern of FORBIDDEN_PATTERNS) {
		const count = text.split(pattern).length - 1;
		if (count > 0) hits.push({ pattern, count });
	}
	const taskCount = (text.match(/\bTask\b/g) ?? []).length;
	if (taskCount > 0) hits.push({ pattern: "Task", count: taskCount });
	return hits;
}
