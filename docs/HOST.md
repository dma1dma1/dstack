# Host binding

Skills in this package talk to Pi through dstack tools. This file is the rewrite dictionary used when porting pstack 0.14.2 markdown.

## Tools

| Skill name | Host |
| --- | --- |
| `dstack_task` | Background single, parallel, or chain group at root depth. Returns a task id immediately. Depth-1 owners use synchronous nested calls for terminal workers. |
| `dstack_result` | Nonblocking bounded summary after the normal completion notification. Full detail is opt-in. |
| `dstack_todo` | First-party todos, or `@juicesharp/rpiv-todo` if that package is already loaded. |
| `dstack_ask` | Typed options via `ctx.ui.select` / `ctx.ui.confirm`. |
| `dstack_sessions` | `SessionManager.list(cwd)`. Do not glob session dirs. |
| `dstack_config` | Read and write `~/.pi/agent/dstack/models.json`. |

## Mode and tree

The user-facing mode command is `/dmode`. `/poteto-mode` is an alias of `/dmode`. Skills mention `/poteto-mode` only as that alias.

Structured dmode launches carry `workflow` metadata with `playbook`, `assignment`, `phase`, `completedPhases`, and `artifacts`. Root launches one `poteto-agent` owner for a nontrivial request. Owners may submit repeated worker batches. Workers and reviewers are terminal, and only owners read the selected playbook. The file scheduler caps all root and nested child processes at four per session.

The active workflow renders a compact one-line ambient widget above the editor while running. Use `/dagents` or `shift+up` to open the interactive agent inspector overlay for live monitoring, hierarchy drill-down, telemetry, and bounded output tails. Use `/dtree` to append a read-only snapshot card to the chat transcript, `/dtree <taskId>` to inspect older workflows, or `/dtree on` and `/dtree off` to toggle the live ambient widget. Durable workflow state lives in `progress.json`, `children/<index>/activity.json`, and `children/<index>/spawns/*.json`.

`/reload` reloads the extension source already configured. It does not search the current worktree for another package entrypoint. If the global package points at another checkout, passing `-e ./extensions/dstack.ts` alone also causes duplicate dstack tool conflicts. Start Pi from the worktree with discovered extensions disabled, then attach the original session id so `/dtree <taskId>` can read its session-scoped bindings:

```bash
pi -ne -e ./extensions/dstack.ts --session <session-id>
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
