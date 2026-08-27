import { spawn, execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes("--mode") && process.argv.includes("json")) {
	const outDir = process.env.DSTACK_VALIDATE_DIR;
	if (outDir) {
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			join(outDir, `child-${process.pid}.json`),
			`${JSON.stringify(
				{
					argv: process.argv.slice(2),
					cwd: process.cwd(),
					nesting: process.env.DSTACK_NESTING ?? null,
					noExtensions: process.argv.includes("--no-extensions"),
					explicitExtension: (() => {
						const i = process.argv.indexOf("-e");
						return i === -1 ? null : (process.argv[i + 1] ?? null);
					})(),
					tools: (() => {
						const i = process.argv.indexOf("--tools");
						return i === -1 ? null : (process.argv[i + 1] ?? null);
					})(),
				},
				null,
				2,
			)}\n`,
		);
	}
	const task = process.argv.find((a) => a.startsWith("Task: ")) ?? "Task: unknown";
	const text = `child-ok ${task.slice(6).trim()} cwd=${process.cwd()}`;
	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "end",
				provider: "fake-router",
				model: "requested-child",
				responseModel: "concrete-child",
				usage: { input: 1, output: 1, totalTokens: 2 },
			},
		})}\n`,
	);
	process.exit(0);
}

const verdicts = [];

function record(id, status, detail) {
	verdicts.push({ id, status, detail });
	const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
	console.log(`${mark}  ${id}${detail ? `  ${detail}` : ""}`);
}

function assert(id, cond, detail) {
	if (cond) record(id, "pass", detail);
	else record(id, "fail", detail);
}

async function run(cmd, args, opts = {}) {
	const { stdout, stderr } = await execFile(cmd, args, {
		cwd: opts.cwd ?? root,
		env: opts.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	return { stdout, stderr };
}

async function runOk(id, cmd, args, opts = {}) {
	try {
		const result = await run(cmd, args, opts);
		record(id, "pass", (result.stdout + result.stderr).trim().split("\n").slice(-2).join(" | "));
		return result;
	} catch (err) {
		const error = err;
		record(id, "fail", (error.stderr || error.stdout || error.message || String(error)).slice(0, 400));
		return null;
	}
}

function makeCtx(overrides = {}) {
	const status = {};
	const notifies = [];
	const entries = overrides.entries ?? [];
	return {
		cwd: overrides.cwd ?? root,
		hasUI: true,
		mode: "rpc",
		ui: {
			notify: (message, type) => {
				notifies.push({ message, type });
			},
			setStatus: (key, text) => {
				status[key] = text;
			},
			confirm: async () => overrides.confirm ?? true,
			select: async (_title, options) => overrides.select ?? options[0],
		},
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => overrides.sessionId ?? "validate-session",
			getCwd: () => overrides.cwd ?? root,
		},
		modelRegistry: {
			getAvailable: () =>
				overrides.models ?? [
					{ provider: "acme", id: "fast" },
					{ provider: "acme", id: "smart" },
					{ provider: "acme", id: "judge" },
					{ provider: "acme", id: "writer" },
				],
		},
		status,
		notifies,
		entries,
	};
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const custom = [];
	return {
		commands,
		tools,
		custom,
		handlers,
		sendUserMessage(content) {
			custom.push({ type: "user-message", data: content });
		},
		registerCommand(name, opts) {
			commands.set(name, opts);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		appendEntry(type, data) {
			custom.push({ type, data });
		},
		getAllTools() {
			return [...tools.values()].map((t) => ({ name: t.name }));
		},
		async fire(event, ctx) {
			const handler = handlers.get(event);
			if (handler) return handler({}, ctx);
			return undefined;
		},
	};
}

async function git(args, cwd) {
	const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
	return stdout.trim();
}

async function makeRepo() {
	const dir = await mkdtemp(join(tmpdir(), "dstack-repo-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "validate@example.com"], dir);
	await git(["config", "user.name", "Validate"], dir);
	await writeFile(join(dir, "README.md"), "fixture\n", "utf8");
	await git(["add", "README.md"], dir);
	await git(["commit", "-m", "init"], dir);
	return dir;
}

async function rpcBatch(commands) {
	const proc = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			join(root, "extensions/dstack.ts"),
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-approve",
		],
		{
			cwd: root,
			env: { ...process.env, HOME: process.env.DSTACK_REAL_HOME || process.env.HOME },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const lines = [];
	let stderr = "";
	proc.stdout.on("data", (chunk) => {
		lines.push(chunk.toString());
	});
	proc.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const closed = new Promise((resolve) => proc.on("close", resolve));
	for (const [i, body] of commands.entries()) {
		proc.stdin.write(`${JSON.stringify({ id: `v${i + 1}`, ...body })}\n`);
	}
	proc.stdin.end();
	const code = await Promise.race([
		closed,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`rpc hang: ${stderr.slice(0, 400)}`)), 20000)),
	]);
	const parsed = [];
	for (const line of lines.join("").split("\n")) {
		if (!line.trim()) continue;
		try {
			parsed.push(JSON.parse(line));
		} catch {
			/* ignore banner */
		}
	}
	return { parsed, stderr, code };
}

async function main() {
	delete process.env.DSTACK_NESTING;
	const realHome = process.env.HOME || homedir();
	const home = mkdtempSync(join(tmpdir(), "dstack-home-"));
	process.env.HOME = home;
	process.env.DSTACK_REAL_HOME = realHome;
	process.env.DSTACK_VALIDATE_DIR = join(home, "children");
	mkdirSync(join(home, ".pi/agent/dstack"), { recursive: true });
	mkdirSync(process.env.DSTACK_VALIDATE_DIR, { recursive: true });

	await runOk("unit-tests", "npm", ["test"]);
	await runOk("typecheck", "npm", ["run", "typecheck"]);
	await runOk("check-skills", "npm", ["run", "check-skills"]);

	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert("package-name", pkg.name === "@dma1dma1/dstack", pkg.name);
	assert("package-keyword", Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package"));
	assert(
		"package-pi-key",
		pkg.pi?.extensions?.[0] === "./extensions/dstack.ts" &&
			pkg.pi?.skills?.[0] === "./skills" &&
			pkg.pi?.prompts?.[0] === "./prompts",
	);

	const how = readFileSync(join(root, "skills/how/SKILL.md"), "utf8");
	assert("how-explorers-general-purpose", how.includes("agent`: `general-purpose`") && how.includes("dmode: false"));
	assert("how-no-poteto-agent-explorer", !/explorer[\s\S]{0,200}poteto-agent/.test(how));

	const dmodeSkill = readFileSync(join(root, "skills/dmode/SKILL.md"), "utf8");
	assert("dmode-alias-text", /\/poteto-mode/.test(dmodeSkill) && /alias of `?\/dmode`?/.test(dmodeSkill.toLowerCase()) || /alias of \/dmode/.test(dmodeSkill));

	const { discoverAgents } = await import(join(root, "extensions/agents.ts"));
	const agents = discoverAgents();
	const names = agents.map((a) => a.name).sort();
	assert("agents-discovered", names.join(",") === "comment-sicko,general-purpose,poteto-agent", names.join(","));
	const sicko = agents.find((a) => a.name === "comment-sicko");
	assert(
		"comment-sicko-tools",
		JSON.stringify(sicko?.tools) === JSON.stringify(["read", "grep", "find", "ls"]),
		JSON.stringify(sicko?.tools),
	);

	const { default: dstack } = await import(join(root, "extensions/dstack.ts"));
	const pi = makePi();
	dstack(pi);
	assert(
		"commands-registered",
		["dmode", "poteto-mode", "setup-dstack"].every((n) => pi.commands.has(n)),
		[...pi.commands.keys()].join(","),
	);

	const ctx = makeCtx();
	await pi.fire("session_start", ctx);
	assert(
		"tools-registered",
		["dstack_task", "dstack_result", "dstack_todo", "dstack_ask", "dstack_sessions", "dstack_config"].every((n) => pi.tools.has(n)),
		[...pi.tools.keys()].join(","),
	);
	assert("status-on-at-start", ctx.status.dstack === "dmode", String(ctx.status.dstack));

	await pi.commands.get("dmode").handler("", ctx);
	assert("dmode-on", ctx.notifies.some((n) => n.message === "dmode on") && ctx.status.dstack === "dmode", ctx.status.dstack);
	assert("dmode-entry", pi.custom.some((e) => e.type === "dstack-mode" && e.data?.on === true));

	const reminder = await pi.fire("before_agent_start", ctx);
	assert(
		"dmode-reminder-path",
		typeof reminder?.message?.content === "string" && reminder.message.content.includes("skills/dmode/SKILL.md") && !reminder.message.content.includes("# Poteto mode"),
		reminder?.message?.content?.slice(0, 120),
	);

	await pi.commands.get("poteto-mode").handler("off", ctx);
	assert("poteto-mode-off", ctx.notifies.some((n) => n.message === "dmode off"));
	const afterOff = await pi.fire("before_agent_start", ctx);
	assert("reminder-gone-when-off", afterOff === undefined);

	await pi.commands.get("dmode").handler("", ctx);
	const restorePi = makePi();
	dstack(restorePi);
	const restoreCtx = makeCtx({
		entries: [{ type: "custom", customType: "dstack-mode", data: { on: true } }],
	});
	await restorePi.fire("session_start", restoreCtx);
	assert("mode-survives-reopen", restoreCtx.status.dstack === "dmode", String(restoreCtx.status.dstack));
	const restoreReminder = await restorePi.fire("before_agent_start", restoreCtx);
	assert("restored-mode-still-reminds", Boolean(restoreReminder?.message?.content));

	await pi.fire("session_before_compact", ctx);
	assert("compact-side-entry", pi.custom.some((e) => e.type === "dstack-compact-context"));

	const todoCreate = await pi.tools.get("dstack_todo").execute("1", { action: "create", content: "survive reload" }, undefined, undefined, ctx);
	assert("todo-create", todoCreate.content[0].text.includes("survive reload") && !todoCreate.isError, todoCreate.content[0].text);
	const todoFile = join(home, ".pi/agent/dstack/todos/validate-session.json");
	assert("todo-file", existsSync(todoFile), todoFile);
	const reloadPi = makePi();
	dstack(reloadPi);
	const reloadCtx = makeCtx({ sessionId: "validate-session" });
	await reloadPi.fire("session_start", reloadCtx);
	const listed = await reloadPi.tools.get("dstack_todo").execute("2", { action: "list" }, undefined, undefined, reloadCtx);
	assert("todo-survives-reload", listed.content[0].text.includes("survive reload"), listed.content[0].text);

	const askYes = await pi.tools.get("dstack_ask").execute("3", { prompt: "Write models.json?", confirm: true }, undefined, undefined, ctx);
	assert("ask-confirm", askYes.content[0].text === "yes", askYes.content[0].text);
	const askSelect = await pi.tools.get("dstack_ask").execute(
		"4",
		{ prompt: "Pick", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
		undefined,
		undefined,
		ctx,
	);
	assert("ask-select", askSelect.content[0].text === "a", askSelect.content[0].text);

	await pi.commands.get("setup-dstack").handler("", ctx);
	const kickoff = pi.custom.find((e) => e.type === "user-message");
	assert(
		"setup-kicked-chat",
		typeof kickoff?.data === "string" && kickoff.data.includes("Suggested mapping") && kickoff.data.includes("Do not open a model picker"),
		String(kickoff?.data).slice(0, 200),
	);
	assert("setup-did-not-write-yet", !existsSync(join(home, ".pi/agent/dstack/models.json")));
	const wrote = await pi.tools.get("dstack_config").execute(
		"4b",
		{
			action: "write",
			value: JSON.stringify({
				roles: { "bug-fix": "acme/fast", "how-critics": ["acme/fast", "acme/smart"] },
				worktree: { base: "~/.dma/worktrees", from: "HEAD" },
			}),
		},
		undefined,
		undefined,
		ctx,
	);
	assert("config-write", !wrote.isError && wrote.content[0].text.includes("acme/fast"), wrote.content[0].text.slice(0, 160));

	const listedCfg = await pi.tools.get("dstack_config").execute("5", { action: "list" }, undefined, undefined, ctx);
	assert("config-list", listedCfg.content[0].text.includes("roles") && !listedCfg.isError);
	const badSlug = await pi.tools.get("dstack_config").execute(
		"6",
		{ action: "set", role: "bug-fix", value: "no-such/model" },
		undefined,
		undefined,
		ctx,
	);
	assert("config-rejects-unknown-slug", badSlug.isError === true, badSlug.content[0].text);
	const allInherit = await pi.tools.get("dstack_config").execute(
		"7",
		{ action: "set", role: "how-critics", value: "inherit-parent,inherit-parent,inherit-parent,inherit-parent" },
		undefined,
		undefined,
		ctx,
	);
	assert("config-rejects-all-inherit-panel", allInherit.isError === true, allInherit.content[0].text);
	const setOk = await pi.tools.get("dstack_config").execute(
		"8",
		{ action: "set", role: "bug-fix", value: "acme/fast" },
		undefined,
		undefined,
		ctx,
	);
	assert("config-set-known-slug", !setOk.isError && setOk.content[0].text.includes("acme/fast"), setOk.content[0].text.slice(0, 160));

	const sessions = await pi.tools.get("dstack_sessions").execute("9", {}, undefined, undefined, ctx);
	assert("sessions-lists", !sessions.isError, sessions.content[0].text.slice(0, 160));

	const childRecordCount = () => readdirSync(process.env.DSTACK_VALIDATE_DIR).filter((file) => file.endsWith(".json")).length;
	const beforeNested = childRecordCount();
	process.env.DSTACK_NESTING = "1";
	const nested = await pi.tools.get("dstack_task").execute(
		"10",
		{ agent: "poteto-agent", task: "spawn terminal worker" },
		undefined,
		undefined,
		ctx,
	);
	assert("nesting-depth-1-spawns", !nested.isError && childRecordCount() === beforeNested + 1, nested.content[0].text);
	const nestedKids = readdirSync(process.env.DSTACK_VALIDATE_DIR).filter((file) => file.endsWith(".json"));
	const nestedKid = JSON.parse(readFileSync(join(process.env.DSTACK_VALIDATE_DIR, nestedKids.at(-1)), "utf8"));
	assert("nesting-depth-2-env", nestedKid.nesting === "2", String(nestedKid.nesting));

	const beforeTerminal = childRecordCount();
	process.env.DSTACK_NESTING = "2";
	const terminal = await pi.tools.get("dstack_task").execute(
		"10b",
		{ agent: "poteto-agent", task: "must refuse" },
		undefined,
		undefined,
		ctx,
	);
	assert(
		"nesting-depth-2-refused",
		terminal.isError === true && terminal.content[0].text.includes("depth 2 is terminal") && childRecordCount() === beforeTerminal,
		terminal.content[0].text,
	);

	process.env.DSTACK_NESTING = "invalid";
	const malformedDepth = await pi.tools.get("dstack_task").execute(
		"10c",
		{ agent: "poteto-agent", task: "must refuse" },
		undefined,
		undefined,
		ctx,
	);
	delete process.env.DSTACK_NESTING;
	assert(
		"nesting-malformed-refused",
		malformedDepth.isError === true && malformedDepth.content[0].text.includes("invalid DSTACK_NESTING"),
		malformedDepth.content[0].text,
	);

	// Root groups now launch through the background-task companion. Keep these
	// child-process assertions on the unchanged depth-1 synchronous path.
	process.env.DSTACK_NESTING = "1";
	const single = await pi.tools.get("dstack_task").execute(
		"11",
		{ agent: "general-purpose", task: "list tools you have", tools: "read,grep,find,ls" },
		undefined,
		undefined,
		ctx,
	);
	assert("spawn-single", !single.isError && single.content[0].text.includes("child-ok"), single.content[0].text);
	const renderedSingle = pi.tools
		.get("dstack_task")
		.renderResult(single, { expanded: false }, { fg: (_color, text) => text })
		.render(160)
		.join("\n");
	assert(
		"spawn-single-usage-rendered",
		renderedSingle.includes("general-purpose: 1 turn ↑1 ↓1 ctx:2 fake-router/concrete-child"),
		renderedSingle,
	);
	const kids = readdirSync(process.env.DSTACK_VALIDATE_DIR).filter((f) => f.endsWith(".json"));
	const lastKid = JSON.parse(readFileSync(join(process.env.DSTACK_VALIDATE_DIR, kids.at(-1)), "utf8"));
	assert("child-no-extensions", lastKid.noExtensions === true);
	assert("child-explicit-dstack", lastKid.explicitExtension === join(root, "extensions/dstack.ts"), String(lastKid.explicitExtension));
	assert("child-nesting-env", lastKid.nesting === "2");
	assert("child-tools-allowlist", lastKid.tools === "read,grep,find,ls,dstack_status", String(lastKid.tools));

	const parallel = await pi.tools.get("dstack_task").execute(
		"12",
		{
			tasks: [
				{ agent: "general-purpose", task: "alpha" },
				{ agent: "comment-sicko", task: "beta" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	assert(
		"spawn-parallel",
		!parallel.isError && parallel.content[0].text.includes("[general-purpose]") && parallel.content[0].text.includes("[comment-sicko]"),
		parallel.content[0].text.slice(0, 200),
	);
	const renderedParallel = pi.tools
		.get("dstack_task")
		.renderResult(parallel, { expanded: false }, { fg: (_color, text) => text })
		.render(160)
		.join("\n");
	assert(
		"spawn-parallel-usage-rendered",
		renderedParallel.includes("general-purpose: 1 turn ↑1 ↓1 ctx:2 fake-router/concrete-child") &&
			renderedParallel.includes("comment-sicko: 1 turn ↑1 ↓1 ctx:2 fake-router/concrete-child"),
		renderedParallel.slice(-300),
	);

	const chain = await pi.tools.get("dstack_task").execute(
		"12b",
		{
			chain: [
				{ agent: "general-purpose", task: "first" },
				{ agent: "comment-sicko", task: "then {previous}" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	const renderedChain = pi.tools
		.get("dstack_task")
		.renderResult(chain, { expanded: false }, { fg: (_color, text) => text })
		.render(160)
		.join("\n");
	assert(
		"spawn-chain-usage-rendered",
		renderedChain.includes("general-purpose: 1 turn ↑1 ↓1 ctx:2 fake-router/concrete-child") &&
			renderedChain.includes("comment-sicko: 1 turn ↑1 ↓1 ctx:2 fake-router/concrete-child"),
		renderedChain.slice(-300),
	);

	const repo = await makeRepo();
	const parentBefore = await git(["status", "--porcelain"], repo);
	const wt = await pi.tools.get("dstack_task").execute(
		"13",
		{
			tasks: [
				{ agent: "general-purpose", task: "writer-one", worktree: true },
				{ agent: "general-purpose", task: "writer-two", worktree: true },
			],
		},
		undefined,
		undefined,
		{ ...ctx, cwd: repo },
	);
	const parentAfter = await git(["status", "--porcelain"], repo);
	const results = wt.details?.results ?? [];
	const dests = results.map((r) => r.cwd);
	assert("worktree-two-dests", dests.length === 2 && dests[0] !== dests[1] && dests.every((d) => d !== repo), dests.join(" | "));
	assert(
		"worktree-parent-untouched",
		parentBefore === parentAfter && !dests.some((d) => existsSync(join(repo, "child-wrote"))),
		`before=${parentBefore} after=${parentAfter}`,
	);
	assert("worktree-not-dot", dests.every((d) => d !== "." && d !== repo));

	const notGit = await mkdtemp(join(tmpdir(), "dstack-nongit-"));
	const failedWt = await pi.tools.get("dstack_task").execute(
		"14",
		{ agent: "general-purpose", task: "should fail closed", worktree: true },
		undefined,
		undefined,
		{ ...ctx, cwd: notGit },
	);
	assert("worktree-fail-closed", failedWt.isError === true && failedWt.content[0].text.includes("worktree add failed"), failedWt.content[0].text);
	assert("worktree-fail-stays-out-of-cwd", readdirSync(notGit).length === 0, readdirSync(notGit).join(","));
	delete process.env.DSTACK_NESTING;

	const { resolveAgent, buildChildArgv } = await import(join(root, "extensions/spawn.ts"));
	const forced = resolveAgent({ agent: "poteto-agent", task: "x", dmode: false });
	assert("dmode-false-forces-general", forced.agent === "general-purpose" && forced.dmode === false, JSON.stringify(forced));
	const sickoRes = resolveAgent({ agent: "comment-sicko", task: "x" });
	assert("comment-sicko-cannot-write", sickoRes.tools === "read,grep,find,ls", sickoRes.tools);
	const childExtension = join(root, "extensions/dstack.ts");
	const argv = buildChildArgv({ task: "t", extensionPath: childExtension, tools: "read,grep,find,ls" });
	assert(
		"child-argv-isolated-dstack",
		argv.includes("--no-extensions") && argv[argv.indexOf("-e") + 1] === childExtension && argv.includes("--tools"),
	);

	try {
		const rpc = await rpcBatch([
			{ type: "get_commands" },
			{ type: "prompt", message: "/dmode" },
			{ type: "prompt", message: "/poteto-mode off" },
			{ type: "get_entries" },
		]);
		if (rpc.stderr.trim()) {
			record("rpc-stderr", rpc.stderr.includes("Failed to load") ? "fail" : "pass", rpc.stderr.slice(0, 240));
		}
		const cmds = rpc.parsed.find((o) => o.command === "get_commands");
		const names = (cmds?.data?.commands ?? []).map((c) => c.name);
		assert(
			"rpc-commands",
			names.includes("dmode") && names.includes("poteto-mode") && names.includes("setup-dstack"),
			names.join(","),
		);
		const modes = rpc.parsed
			.filter((o) => o.type === "entry_appended" && o.entry?.customType === "dstack-mode")
			.map((o) => o.entry.data?.on);
		assert("rpc-dmode", modes.includes(true), JSON.stringify(modes));
		assert("rpc-poteto-mode-off", modes.includes(false), JSON.stringify(modes));
		assert("rpc-alias-same-flag", modes.includes(true) && modes.includes(false), JSON.stringify(modes));
		const statuses = rpc.parsed.filter((o) => o.method === "setStatus" && o.statusKey === "dstack").map((o) => o.statusText);
		assert("rpc-status-line", statuses.includes("dmode"), JSON.stringify(statuses));
		const notifies = rpc.parsed.filter((o) => o.method === "notify").map((o) => o.message);
		assert("rpc-notifies", notifies.includes("dmode on") && notifies.includes("dmode off"), notifies.join(" | "));
	} catch (err) {
		record("rpc-commands", "fail", err instanceof Error ? err.message : String(err));
	}

	const failed = verdicts.filter((v) => v.status === "fail");
	const passed = verdicts.filter((v) => v.status === "pass");
	console.log(`\n${passed.length} passed, ${failed.length} failed, ${verdicts.length} total`);
	const report = join(home, "report.json");
	writeFileSync(report, `${JSON.stringify({ home, verdicts }, null, 2)}\n`);
	console.log(`report ${report}`);
	if (failed.length) process.exitCode = 1;
}

await main();
