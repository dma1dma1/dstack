---
name: setup-dstack
description: Detect available Pi models and write ~/.pi/agent/dstack/models.json. Lists companion packages. Use for /setup-dstack or changing dstack model choices.
---

# Setup dstack

Run `/setup-dstack`. That command detects models from `ctx.modelRegistry`, writes `~/.pi/agent/dstack/models.json`, and lists companions. Prefer the command over editing the file by hand.

If you must write the file yourself, follow the steps below. Use `dstack_ask`, not free text.

## Steps

### 1. Detect available models

Read slugs from `ctx.modelRegistry.getAvailable()` as `provider/id`. Never write a slug you have not seen. `inherit-parent` and `auto` are always valid.

### 2. Load current state

If `~/.pi/agent/dstack/models.json` exists, treat it as the current choices. Otherwise start from `inherit-parent` on scalar roles.

### 3. Map and confirm

Show every role. Confirm with `dstack_ask`. Panel roles (how critics, arena runners, architect runners, interrogate reviewers, arena cross-judge pool) are lists. A list of only `inherit-parent` / `auto` is a no-op. Refuse to save that.

### 4. Validate

Every real slug must be in the detected set. `dstack_config` will refuse unknown slugs and all-inherit critic panels.

### 5. Write the file

Overwrite `~/.pi/agent/dstack/models.json`. Shape:

```json
{
  "roles": {
    "how explorer": "inherit-parent",
    "how critics": ["inherit-parent", "provider/model"]
  },
  "worktree": {
    "base": "~/.dma/worktrees",
    "from": "HEAD"
  }
}
```

### 6. Companions

List these and print `pi install` lines for anything missing. Do not install them unless the user confirms.

- `npm:pi-mcp-adapter`
- `npm:@gotgenes/pi-permission-system`
- `npm:pi-background-tasks`
- `npm:pi-web-access`
- `npm:@juicesharp/rpiv-todo` (optional)
- `npm:@juicesharp/rpiv-ask-user-question` (optional)

If the permission package is present, offer to write `~/.pi/agent/dstack/permission-recipes.json`.
