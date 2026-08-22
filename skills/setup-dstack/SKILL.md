---
name: setup-dstack
description: Suggest role-to-model mappings from the models you have, then change them in chat. Writes ~/.pi/agent/dstack/models.json. Use for /setup-dstack or changing dstack model choices.
---

# Setup dstack

`/setup-dstack` detects your Pi models, collapses dated twins, and proposes one mapping. You change it in plain language. The command does not open a picker and does not dump the registry.

If the command already injected a catalog and a suggestion, use those. Do not re-enumerate every slug.

## Steps

### 1. Show the suggestion

Print the suggested mapping as a short list. Name why a role got a family (fast explorer, judgment for prose, mixed panel for critics). Mention `inherit-parent` and `auto` as always valid.

If `models.json` already exists, show current next to suggested only where they differ.

### 2. Talk

Ask what to change. Accept replies like "opus for judgment", "inherit-parent on feature work", "drop haiku from critics", "worktree from origin/main".

Resolve names to catalog slugs. Never write a slug that is not in the catalog. If a name is ambiguous, ask one clarifying question with two or three slugs, not the whole list.

### 3. Validate

Every real slug must be in the catalog. A panel of only `inherit-parent` / `auto` is a no-op. Refuse that and ask again.

### 4. Write

When the user accepts, write the full file with `dstack_config` `action=write` and a JSON value of `{ "roles", "worktree" }`. One write. Then confirm the path `~/.pi/agent/dstack/models.json`.

### 5. Companions

`/setup-dstack` already installs the required three if they were missing (MCP, permissions, background jobs). Report what happened. Offer the optional ones. Do not install optional packages unless the user asks.

- `npm:pi-mcp-adapter`
- `npm:@gotgenes/pi-permission-system`
- `npm:pi-background-tasks`
- `npm:pi-web-access`
- `npm:@juicesharp/rpiv-todo` (optional)
- `npm:@juicesharp/rpiv-ask-user-question` (optional)

If the permission package is present, offer to write `~/.pi/agent/dstack/permission-recipes.json`.
