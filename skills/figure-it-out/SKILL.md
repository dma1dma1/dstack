---
name: figure-it-out
description: "Design an auditable playbook when no narrower one fits. Matches evidence and review to the task, runs a hypothesis loop, and logs decisions via show-me-your-work. Use for /figure-it-out, 'figure it out', or when no narrower playbook applies."
disable-model-invocation: true
---

# Figure it out

When the task matches no playbook, design one. The deliverable before any code is the workflow itself: a sequence of phases matched to the task, a scientific method, and a decision trail a human can audit after stepping away.

Don't reinvent a playbook you already have. A task that matches Bug fix, Perf, Feature, Visual parity, Eval, or Multi-phase plan routes there regardless of size. Use figure-it-out only when no narrower playbook fits.

## Start

Open a todolist whose first item states the falsifiable definition of done and whose second item reads the Principles section of the **dmode** skill. Then add the phases below as todos.

## Phase A: Frame

Ground first, then commit. Don't start the run until you can state:

- The definition of done as a falsifiable predicate (the **prove-it-works** principle skill). "Done well" has to be checkable.
- Scope, quantified: rough units and effort, plus the blockers grounding surfaced. Raise them before spending hours, not after fifty doomed commits.
- The evidence and review needed for this task's actual risks. One-way doors and high blast radius need stronger proof; reversible low-stakes steps need less.

Present the framing and tradeoffs before committing to a long run. Reversible work proceeds (the **never-block-on-the-human** principle skill), but a multi-hour run earns one checkpoint.

## Phase B: Design the workflow

Decompose into atomic, independently-landable units. Sequence riskiest-unknown-first so option value stays high. Scaffold and verification come before features (the **foundational-thinking** principle skill).

- Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as "old value vs new value".
- Add a design phase only when framing exposes a consequential unresolved choice with multiple plausible shapes. If needed, consume an existing `design.md` or run **architect** once in design-only mode. Do not add or rerun Architect merely because the task is large.
- Decide what fans out. Parallelize only across genuine seams, and give each worker its own worktree or branch (the **separate-before-serializing-shared-state** principle skill). Don't over-fan.
- Write the designed phase list down. That list is what the human reviews.

Then put the design into motion. Add its steps to the todolist as concrete items, after the Phase C entry and before Phase D. Run each under the Phase C loop discipline, and weave the Phase D log through them, a row as each step lands, rather than saving the whole trail for the end.

## Phase C: Run the loop

Each unit is an experiment: state the hypothesis, make the smallest change, measure against the predicate on the real artifact, keep it if it advanced, revert it if it didn't.
Apply the **sequence-verifiable-units** principle skill, verifying each unit before starting the next instead of batching checks at the end.

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system. A blank screenshot passes a lazy gate.
- Per unit: run the relevant tests, typecheck, and build. Read the diff yourself. Do not spawn a per-unit judge. Add an independent final review only when the task's stated risks or the user require it. If a worker games the check, reset and harden the contract. If the check itself is wrong, fix it in its own change rather than routing around it.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass. Don't hide a negative.

## Phase D: Keep the audit trail

Log the run via the **show-me-your-work** skill, one canonical TSV with a row per decision and per unit, evidence as links. figure-it-out's work is usually ambitious enough to commit the trail so the reviewer can read it in the PR; commit it when confidence has to be shown. Prefer evidence produced by committed scripts so a reviewer can re-run it. The trail plus the diff is what lets the human come back and trust the work.

## Phase E: Verify and hand back

Check the whole against the Phase A predicate on the real product, not just the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script, so the win can't silently regress (the **encode-lessons-in-structure** principle skill).

**Reply:** the playbook you designed, the evidence and review choices, the decision-trail path, what's verified against the predicate, and what's still open.
