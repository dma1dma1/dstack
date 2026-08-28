# Host binding

Skills in this package talk to Pi through dstack tools. This file is the rewrite dictionary used when porting pstack 0.14.2 markdown.

## Tools

| Skill name | Host |
| --- | --- |
| `dstack_task` | Background single, parallel, or chain group at root depth. Returns a task id immediately. Depth-1 owners use synchronous nested calls for terminal workers. |
| `dstack_result` | Nonblocking bounded summary after the normal completion notification. Full detail is opt-in. |
| `dstack_todo` | First-party todos, or `@juicesharp/rpiv-todo` if that package is already loaded. |
| `dstack_ask` | Typed options via `ctx.ui.select` / `ctx.ui.confirm`. |
| `dstack_status` | Child progress with optional phase, note, blocking flag, and typed blocker. |
| `dstack_sessions` | `SessionManager.list(cwd)`. Do not glob session dirs. |
| `dstack_config` | Read and write `~/.pi/agent/dstack/models.json`. |

## Mode and tree

The user-facing mode command is `/dmode`. `/poteto-mode` is an alias of `/dmode`. Skills mention `/poteto-mode` only as that alias.

Structured dmode launches carry `workflow` metadata with `playbook`, `assignment`, `phase`, `completedPhases`, and `artifacts`. Root launches one `poteto-agent` owner for a nontrivial request. Owners may submit repeated worker batches. Workers and reviewers are terminal, and only owners read the selected playbook. The file scheduler caps all root and nested child processes at the session's persisted `scheduler.totalSlots` capacity (default 8).

The active workflow renders a compact one-line ambient widget above the editor while running. Use `/dagents` or `shift+up` to open the interactive agent inspector overlay for live monitoring, hierarchy drill-down, telemetry, and bounded output tails. Use `/dtree` to append a read-only snapshot card to the chat transcript, `/dtree <taskId>` to inspect older workflows, or `/dtree on` and `/dtree off` to toggle the live ambient widget. Durable workflow state lives in `progress.json`, `children/<index>/activity.json`, and `children/<index>/spawns/*.json`.

`/reload` reloads the extension source already configured. It does not search the current worktree for another package entrypoint. If the global package points at another checkout, passing `-e ./extensions/dstack.ts` alone also causes duplicate dstack tool conflicts. Start Pi from the worktree with discovered extensions disabled, then attach the original session id so `/dtree <taskId>` can read its session-scoped bindings:

```bash
pi -ne -e ./extensions/dstack.ts --session <session-id>
```

## Machine-readable session status

Each loaded dstack session atomically replaces one JSON file:

```text
~/.pi/agent/dstack/status/<base64url-encoded-UTF-8-session-id>.json
```

The filename encoding has no padding. The file mode is `0600`; parent directories use `0700`. `schemaVersion` versions the public contract. All timestamp fields are ISO 8601 strings.

```ts
type DstackStatusSnapshot = {
  schemaVersion: "dstack.status.v1";
  sessionId: string;
  process: {
    pid: number;
    startedAt: string;
    hostname: string;
    cwd: string;
    execPath: string;
  };
  heartbeat: {
    updatedAt: string;
    intervalMs: number;
  };
  rollup:
    | "working"
    | "waiting_on_input"
    | "waiting_on_approval"
    | "idle"
    | "completed"
    | "failed";
  root: {
    state: "working" | "idle";
    status?: {
      phase?: string;
      note?: string;
      blocking?: boolean;
      blockedOn?: "human" | "approval" | "dependency" | "external";
      updatedAt: string;
    };
  };
  task?: StatusTask;
  shutdown?: {
    clean: true;
    at: string;
  };
};

type StatusTask = {
  id: string;
  kind: "workflow" | "agent";
  state: "queued" | "working" | "completed" | "failed" | "cancelled";
  summary: string;
  phase?: string;
  status?: {
    phase?: string;
    note?: string;
    blocking?: boolean;
    blockedOn?: "human" | "approval" | "dependency" | "external";
    updatedAt: string;
  };
  children: StatusTask[];
};
```

`blockedOn: "human"` maps to `waiting_on_input`. `blockedOn: "approval"` maps to `waiting_on_approval`. The reducer checks the root and every task descendant. Dependency and external blockers remain visible without changing the rollup. Task children include nested agents when the workflow tree has them.

A heartbeat is stale only when `now > updatedAt + (2 * intervalMs)`. A session is crashed only when its heartbeat is stale, no clean `shutdown` marker exists, and the recorded process identity is no longer alive. Readers should treat a reused PID whose process start time does not match `process.startedAt` as a dead recorded identity. `classifyDstackStatus` in `extensions/status.ts` implements this rule after the reader supplies the process-liveness result. A clean shutdown always classifies as `shutdown`; dstack writes a final `idle` snapshot and stops its heartbeat timer.

Set `DSTACK_STATUS_NOTIFY_COMMAND` to an executable path to receive rollup transitions. Dstack executes the path directly with no shell and no arguments. It writes the complete snapshot JSON to stdin. The first snapshot counts as a transition from no prior rollup. Heartbeats and other writes with the same rollup do not invoke the command.

This macOS example prints a compact view whenever any session snapshot changes:

```bash
status_dir="$HOME/.pi/agent/dstack/status"
mkdir -p "$status_dir"
fswatch -0 "$status_dir" | while IFS= read -r -d '' file; do
  jq '{sessionId, rollup, heartbeat, pid: .process.pid, task}' "$file"
done
```

## Rewrite map

| Upstream | dstack |
| --- | --- |
| `Task` | `dstack_task` |
| `subagent_type: "poteto-agent"` | `agent: "poteto-agent"` |
| `subagent_type: "generalPurpose"` | `agent: "general-purpose"`, `dmode: false` |
| `subagent_type: "Comment Sicko"` | `agent: "comment-sicko"` |
| `readonly: true` | `tools: "read,grep,find,ls"` |
| `AskQuestion` | `dstack_ask` |
| `TodoWrite` | `dstack_todo` |
| Cursor model slugs in prose | role names. Slugs live only in `models.json`. |
| `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/dstack/models.json` |
| `/setup-pstack` | `/setup-dstack` |
| `/poteto-mode` as the mode trigger | `/dmode` |
| skill folder `poteto-mode/` | `dmode/` |
| frontmatter `name: Poteto Mode` | `name: dmode` |
| `environment: "cloud"` | delete the line |
| `move_agent_to_root` | worktree `cwd` |
| `run_in_background: true` | omit the field. Root `dstack_task` calls always run in the background. |

## Worktrees

`dstack_task` with `worktree: true` creates `~/.dma/worktrees/<repo>/<slug>` off `HEAD` (or `origin/main` if config says so), branch `dma/<slug>`, and passes that path as `cwd`. Isolation is a directive, not a sandbox. Creation failure is a hard error. The child does not fall back to the parent checkout. Uncommitted parent diffs are invisible.

Leftover trees stay on disk. Remove one with `git worktree remove <path>` from the parent repo, then `git worktree prune`.
