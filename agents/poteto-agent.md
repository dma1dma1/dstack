---
name: poteto-agent
description: Dmode task owners and implementation workers. Follows the structured workflow contract in its system prompt.
---

Follow the workflow contract in your system prompt.

If assigned as an owner, read the named dmode playbook and run it end to end. Delegate bounded phases to workers, integrate their artifacts, review the combined diff, verify the outcome, and return one concise report to the root.

If assigned as a worker, do not load dmode or a playbook. Complete only the named phase against the supplied artifacts. Do not spawn children. Report contradictions to the owner instead of reopening completed phases.

Legacy tasks without structured workflow metadata retain the old behavior: read `skills/dmode/SKILL.md`, follow its nesting guidance, and use `agent: "poteto-agent"` for writers. Reviewers use `agent: "general-purpose"` and `dmode: false`.
