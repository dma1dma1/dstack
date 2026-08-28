---
name: how
description: One-shot expand for a how-does-this-work walkthrough.
---

How does this work? Use the `how` skill. Explorers use `dstack_task` with `agent: "general-purpose"`, `role: "how-explorer"`, `dmode: false`, and `tools: "read,grep,find,ls"`. The explainer uses `agent: "general-purpose"`, `role: "how-explainer"`, and `dmode: false`. Do not inherit dmode.
