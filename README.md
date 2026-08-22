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

Turn the sticky workflow on:

```text
/dmode
```

`/poteto-mode` is an alias of `/dmode`. `/dmode off` turns it off. The flag survives `/new` and session reopen.

Ask "how does X work?" on a real repo. dmode fans out `general-purpose` explorers with `dmode: false`, then one explainer.

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

## Tools

| Tool | Role |
| --- | --- |
| `dstack_task` | Isolated child `pi --mode json --print --no-session --no-extensions`. Max 8 tasks, 4 at a time. |
| `dstack_todo` | Durable todos under `~/.pi/agent/dstack/todos/`. |
| `dstack_ask` | Typed questions. |
| `dstack_sessions` | `SessionManager.list(cwd)`. |
| `dstack_config` | Get / set / list `models.json`. |

`worktree: true` on `dstack_task` creates `~/.dma/worktrees/<repo>/<slug>` on branch `dma/<slug>` and runs the child there. The default base is `HEAD`, so the child sees the parent's current commit, not `origin/main`, unless `worktree.from` in `models.json` is `origin/main`. If `git worktree add` fails, the child does not run in the parent tree. Uncommitted parent diffs stay invisible either way.

Leftover trees stay on disk. From the parent repo: `git worktree remove <path>`, then `git worktree prune`.

## Security

Extensions run with full access to your machine. Review this package before you install it. Child agents launch with `--no-extensions` and `DSTACK_NESTING=1` so they cannot spawn further children.

## License

MIT. Skill text is rewritten from pstack 0.14.2 (Copyright Lauren Tan, MIT). See `LICENSE`.
