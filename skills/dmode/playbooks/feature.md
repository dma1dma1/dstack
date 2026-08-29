### Feature

**You own the outcome. Ground, plan, integrate, review, and verify.** Delegate bounded implementation slices; stay in the lead.

1. Ground the request and name the data shape. If grounding exposes a consequential unresolved choice with multiple plausible shapes, run `architect` once in design-only mode and use its `design.md` as a handoff artifact. Otherwise proceed from the existing architecture. A large diff alone does not require Architect.
2. Before the first worker batch, record the decomposition decision. Independent read-only or non-overlapping implementation slices default to one parallel `tasks[]` batch. Give each concurrent writer a distinct worktree (`worktree: true`); one checkout has one writer. Name the independent workstreams and any shared writes that must serialize per **separate-before-serializing-shared-state**. If clearly decomposable work stays with a single worker, state a brief reason.
3. Delegate code-writing in as many bounded worker batches as the decomposition needs. Use `role: "implementation-worker"` when the brief settles the implementation choices; choose a specialized role when the worker still owns substantive prose, investigation, or judgment. Give every worker a specific scope, success criteria, and workflow metadata containing the current phase, completed phases, and artifact paths. Name the data shape and its organizing structure per **principle-model-the-domain** before the worker writes logic. Workers do not reopen completed phases or spawn children. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
4. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass; flag it.
5. Rebase into small, ordered commits; stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
6. Read the combined diff yourself. Run `interrogate` only when the user explicitly requests adversarial review or a still-unresolved, high-consequence concern makes independent challenge part of this feature's definition of done. Review the completed change once, never each implementation step.
7. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline; that owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries; spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, open decisions. Tables for design alternatives.
