# Host binding

Skills in this package talk to Pi through dstack tools. This file is the rewrite dictionary used when porting pstack 0.14.2 markdown.

## Tools

| Skill name | Host |
| --- | --- |
| `dstack_task` | Child Pi process. Never `Task` or `subagent`. |
| `dstack_todo` | First-party todos, or `@juicesharp/rpiv-todo` if that package is already loaded. |
| `dstack_ask` | Typed options via `ctx.ui.select` / `ctx.ui.confirm`. |
| `dstack_sessions` | `SessionManager.list(cwd)`. Do not glob session dirs. |
| `dstack_config` | Read and write `~/.pi/agent/dstack/models.json`. |

## Mode

The user-facing mode command is `/dmode`. `/poteto-mode` is an alias of `/dmode`. Skills mention `/poteto-mode` only as that alias.

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
| `run_in_background: true` | omit in v1 |

## Worktrees

`dstack_task` with `worktree: true` creates `~/.dma/worktrees/<repo>/<slug>` off `HEAD` (or `origin/main` if config says so), branch `dma/<slug>`, and passes that path as `cwd`. Isolation is a directive, not a sandbox. Creation failure is a hard error. The child does not fall back to the parent checkout. Uncommitted parent diffs are invisible.

Leftover trees stay on disk. Remove one with `git worktree remove <path>` from the parent repo, then `git worktree prune`.
