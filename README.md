# dstack

A Pi package that ports [pstack](https://github.com/cursor/plugins/tree/main/pstack) 0.14.2 (Lauren Tan). You install it, run `/setup-dstack`, then work in `/dmode`.

The npm name `dstack` is taken. This package is `@dma1dma1/dstack`.

## Install

```bash
pi install npm:@dma1dma1/dstack
```

Pi has no package-to-package install graph, so that line only loads dstack. Required companions are MCP, permission confirms, and background jobs. `/setup-dstack` installs those if they are missing. From this repo you can also run:

```bash
npm run install-companions
```

Add `-- --optional` to include richer todos, questions, and web.

Open Pi in a repo. Run `/setup-dstack`. That installs missing required companions, then proposes a mapping from the models you have. Change it in chat, then it writes `~/.pi/agent/dstack/models.json`.

dmode starts on by default. Use `/dmode off` to turn it off and `/dmode` to turn it back on.

`/poteto-mode` is an alias of `/dmode`. The flag survives `/new` and session reopen.

## Cost status and overlay

The `dstack-cost` extension status is one merged dollar amount. It adds persisted root-session usage, including dstack usage already claimed through a `dstack_result` tool result, to live dstack usage that the root session has not persisted yet. Reconciliation keys claims by task ID, so a task moves from live to persisted without changing the total or counting twice. `/dcost` opens a live breakdown by task and agent. Rows say `claimed`, `claimed/pending`, `pending`, or `approximate`. An approximate row means the child session ledger was unavailable and dstack fell back to workflow telemetry.

Pi Powerline users should make `dstack-cost` the only cost segment. Merge this into `~/.pi/agent/settings.json`, or into `.pi/settings.json` for one project:

```json
{
  "powerline": {
    "preset": "default",
    "disabledSegments": ["cost"],
    "customItems": [
      {
        "id": "dstack-cost",
        "statusKey": "dstack-cost",
        "position": "right",
        "color": "warning"
      }
    ]
  }
}
```

Keep any existing disabled segments and custom items when merging the object. The custom item hides `dstack-cost` from Powerline's aggregate extension-status segment by default. The separate `dstack` mode status remains there. Run `/reload` after editing settings.

For nontrivial work, dmode routes the request to depth-1 playbook owners: one owner for single requests or related outcomes, or one owner per outcome in a single parallel `tasks[]` batch when one user turn asks for multiple genuinely independent outcomes. The owner grounds the task, chooses the playbook phases, launches bounded batches of terminal workers, integrates their work, and verifies the result. The root keeps only the task receipt and each owner's final evidence.

## Full stack

dstack does not reimplement MCP, permissions, or background jobs. `/setup-dstack` installs the required three if they are missing. To do that from a shell:

```bash
pi install npm:pi-mcp-adapter
pi install npm:@gotgenes/pi-permission-system
pi install npm:pi-background-tasks
```

Optional richer todos, questions, and web:

```bash
pi install npm:@juicesharp/rpiv-todo
pi install npm:@juicesharp/rpiv-ask-user-question
```

If those two are already loaded, dstack does not register a second todo or ask tool.

The first `/setup-dstack` also writes `~/.pi/agent/extensions/pi-permission-system/config.json` when that file is missing. Routine reads, edits, and bash run. Pushes, deploys, and `sudo` ask. `rm -rf` is denied. Yolo stays off. Edit that file or use `/permission-system` to change it.

## Tools

| Tool | Role |
| --- | --- |
| `dstack_task` | Launches one background single, parallel, or chain group through `pi-background-tasks`. Each batch accepts 12 tasks. One session-wide scheduler limits child processes across root and nested groups. |
| `dstack_result` | Returns current progress or a bounded completed summary. `detail: "full"` is an explicit escape hatch. |
| `dstack_todo` | Durable todos under `~/.pi/agent/dstack/todos/`. |
| `dstack_ask` | Typed questions. |
| `dstack_sessions` | `SessionManager.list(cwd)`. |
| `dstack_config` | Get / set / list `models.json`. |

`dstack_task` returns a task ID immediately. Root tasks send a completion notification; call `dstack_result` once after it arrives. A depth-1 owner may do independent work, then calls `dstack_result`, which waits for its nested task to finish. If the owner tries to finish first, dstack queues a collection turn instead of tearing down the worker. Do not poll.

Set `scheduler.totalSlots` in `~/.pi/agent/dstack/models.json` to an integer from 3 through 64. It defaults to 12:

```json
{
  "scheduler": { "totalSlots": 12 },
  "roles": {}
}
```

The first scheduler process in a session persists the effective capacity for that session. Later config changes apply to new sessions. The scheduler reserves `max(1, floor(totalSlots / 4))` slots for terminal work, so nesting-capable work can use at most `totalSlots - max(1, floor(totalSlots / 4))` slots. The default leaves 3 terminal slots.

Nesting has three depths. An unset `DSTACK_NESTING` or `0` is root depth 0. A structured dmode request names depth-1 `owner` tasks. Independent read-only or non-overlapping worker slices default to parallel `tasks[]` calls. That owner may launch as many batches as needed. Each depth-2 `worker` or `reviewer` receives a playbook phase, completed phase names, and artifact paths. Worker and reviewer assignments are terminal even if their process depth is malformed or reused. dstack rejects malformed values instead of guessing. Parallel writers should each set `worktree: true`.

`worktree: true` on `dstack_task` creates `~/.dma/worktrees/<repo>/<slug>` on branch `dma/<slug>` and runs the child there. The default base is `HEAD`, so the child sees the parent's current commit, not `origin/main`, unless `worktree.from` in `models.json` is `origin/main`. If `git worktree add` fails, the child does not run in the parent tree. Uncommitted parent diffs stay invisible either way.

Leftover trees stay on disk. From the parent repo: `git worktree remove <path>`, then `git worktree prune`.

## Security

Extensions run with full access to your machine. Review this package before you install it. Child agents launch with `--no-extensions` plus explicit absolute `-e` paths for dstack and the MCP extension already loaded in the parent session. This propagation happens at both nesting levels. An explicit `tools` allowlist on a task can still restrict MCP intentionally. dstack sets `DSTACK_NESTING=1` for root children and `2` for their terminal children.

## License

MIT. Skill text is rewritten from pstack 0.14.2 (Copyright Lauren Tan, MIT). See `LICENSE`.
