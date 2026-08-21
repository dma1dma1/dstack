import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentConfig = {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
};

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

export function packageRoot(from = import.meta.url): string {
	return dirname(dirname(fileURLToPath(from)));
}

export function packageAgentsDir(from = import.meta.url): string {
	return join(packageRoot(from), "agents");
}

export function parseFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return { frontmatter: {}, body: content };
	}
	const end = content.indexOf("\n---", 4);
	if (end === -1) return { frontmatter: {}, body: content };
	const raw = content.slice(4, end);
	const body = content.slice(end + 4).replace(/^\r?\n/, "");
	const frontmatter: AgentFrontmatter = {};
	for (const line of raw.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
		if (key === "name" || key === "description" || key === "tools" || key === "model") {
			frontmatter[key] = value;
		}
	}
	return { frontmatter, body };
}

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return agents;
	}
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const filePath = join(dir, name);
		try {
			if (!statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			filePath,
		});
	}
	return agents;
}

export function discoverAgents(extraDirs: readonly string[] = [], from = import.meta.url): AgentConfig[] {
	const map = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(packageAgentsDir(from))) map.set(agent.name, agent);
	for (const dir of extraDirs) {
		for (const agent of loadAgentsFromDir(dir)) map.set(agent.name, agent);
	}
	return [...map.values()];
}
