export type AskOption = { id: string; label: string };

export type AskRequest = {
	prompt: string;
	options?: AskOption[];
	allowMultiple?: boolean;
	confirm?: boolean;
};

export function parseAskParams(params: {
	prompt?: string;
	options?: Array<{ id?: string; label?: string } | string>;
	allowMultiple?: boolean;
	confirm?: boolean;
}): AskRequest | { error: string } {
	if (!params.prompt?.trim()) return { error: "prompt is required" };
	const options = (params.options ?? []).map((opt, i) => {
		if (typeof opt === "string") return { id: opt, label: opt };
		return { id: opt.id ?? `opt-${i}`, label: opt.label ?? opt.id ?? `opt-${i}` };
	});
	return {
		prompt: params.prompt.trim(),
		options: options.length > 0 ? options : undefined,
		allowMultiple: params.allowMultiple === true,
		confirm: params.confirm === true,
	};
}

export function richerAskPresent(toolNames: readonly string[]): boolean {
	return toolNames.some(
		(name) => name === "ask_user_question" || name === "AskUserQuestion" || name === "rpiv_ask_user_question",
	);
}
