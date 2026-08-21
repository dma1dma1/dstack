export type SessionRow = {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
};

export function formatSessions(sessions: readonly SessionRow[]): string {
	if (sessions.length === 0) return "(no sessions in this cwd)";
	return sessions
		.map((s) => {
			const name = s.name ? `${s.name} ` : "";
			const first = s.firstMessage.replace(/\s+/g, " ").slice(0, 80);
			return `${s.id} ${name}${s.modified.toISOString()} msgs=${s.messageCount} ${first}`;
		})
		.join("\n");
}
