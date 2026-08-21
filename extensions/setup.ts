export const COMPANIONS = [
	{ need: "MCP", source: "npm:pi-mcp-adapter", optional: false },
	{ need: "Permission confirms", source: "npm:@gotgenes/pi-permission-system", optional: false },
	{ need: "Wake / background jobs", source: "npm:pi-background-tasks", optional: false },
	{ need: "Optional richer todos", source: "npm:@juicesharp/rpiv-todo", optional: true },
	{ need: "Optional richer questions", source: "npm:@juicesharp/rpiv-ask-user-question", optional: true },
	{ need: "Optional web", source: "npm:pi-web-access", optional: true },
] as const;

export const PERMISSION_RECIPES = {
	ask: [
		"gt submit*",
		"gt merge*",
		"gh pr merge*",
		"kubectl apply*",
		"terraform apply*",
		"vercel deploy*",
	],
	deny: ["rm -rf *"],
	askIfLooksLikeDataLoss: ["recursive deletes that look like data loss"],
};

export type InstalledPackage = { source: string };

export function packageSourceName(source: string): string {
	return source.replace(/^npm:/, "").replace(/@.+$/, "");
}

export function companionStatus(
	packages: readonly InstalledPackage[],
): Array<{ need: string; source: string; optional: boolean; installed: boolean }> {
	const names = new Set(packages.map((p) => packageSourceName(p.source)));
	return COMPANIONS.map((c) => ({
		...c,
		installed: names.has(packageSourceName(c.source)),
	}));
}

export function installLines(
	status: ReturnType<typeof companionStatus>,
	missingOnly = true,
): string[] {
	return status
		.filter((s) => (missingOnly ? !s.installed : true))
		.map((s) => `pi install ${s.source}`);
}

export function formatCompanionReport(status: ReturnType<typeof companionStatus>): string {
	const lines = status.map((s) => {
		const mark = s.installed ? "ok" : s.optional ? "missing (optional)" : "missing";
		return `${s.need}: ${s.source} [${mark}]`;
	});
	const missing = installLines(status, true);
	if (missing.length > 0) {
		lines.push("", "Install missing companions:", ...missing);
	} else {
		lines.push("", "All listed companions are installed.");
	}
	return lines.join("\n");
}

export function parseSettingsPackages(raw: unknown): InstalledPackage[] {
	if (raw === null || typeof raw !== "object") return [];
	const packages = (raw as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return [];
	const out: InstalledPackage[] = [];
	for (const item of packages) {
		if (typeof item === "string") out.push({ source: item });
		else if (item && typeof item === "object" && typeof (item as { source?: unknown }).source === "string") {
			out.push({ source: (item as { source: string }).source });
		}
	}
	return out;
}
