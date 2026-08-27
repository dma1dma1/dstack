---
name: tdd
description: "Use only when the user explicitly asks for TDD, a failing test, or a regression test, OR when a bug has an obvious cheap local test target whose permanent value is exceptionally strong. Skip when the test path is unclear, expensive, integration-heavy, or weakly justified."
disable-model-invocation: true
---

# TDD Bug Fix

When fixing a bug with a clear, cheap test path, make the broken behavior executable before changing production code. A focused regression test that fails before the fix and passes after it is one option, not the default.

Permanent tests are maintenance liabilities. Before writing each one, justify the exact behavior or regression it uniquely protects, why existing tests and cheaper executable checks are insufficient, the realistic failure it will catch, its maintenance and runtime cost, and why the codebase would be significantly worse without it. Write it only with exceedingly strong conviction. A request for TDD or general regression coverage does not excuse a weak test.

Do not force a test when it would require broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, large unrelated fixture churn, or a long-running suite path. Use the closest useful one-off verification instead.

## Workflow

1. **Understand the bug.** Identify the intended behavior, current behavior, affected path, and smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer an existing targeted test or a disposable reproduction. If no practical path is obvious, do not create one from scratch just to satisfy the workflow.
3. **Apply the permanent-test gate.** Record the test-specific justification above. If any part is weak, keep the reproduction transient and add no test.
4. **Run the failing check before fixing.** Confirm it fails for the intended reason. If it passes or fails for an unrelated reason, correct the check or reproduction before editing the implementation.
5. **Fix the bug.** Make the smallest production change that satisfies the intended behavior while preserving nearby contracts.
6. **Rerun the regression check.** Confirm it now passes.
7. **Run nearby validation.** Run relevant adjacent tests, type checks, lint, or scenario checks when the change has broader risk.

## If a Failing Test Is Impractical

Do not silently skip the regression step. Before fixing, explicitly explain why a failing test is impossible or not worth the cost, then choose the closest executable regression check available. Examples include a targeted script, manual reproduction command, browser automation, snapshot comparison, log assertion, or focused integration check.

Prefer no new test unless the codebase would be significantly worse without that exact test. A bad test mostly tests mocks, encodes current implementation details, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, duplicates nearby signal, or is costly to run.

## Guardrails

- Do not change tests merely to match a wrong implementation.
- Do not weaken existing assertions unless the expected behavior has genuinely changed and the reason is clear.
- Keep the regression test focused on the bug; avoid broad fixture churn or unrelated coverage expansion.
- Do not add tests when the practical signal is weak; use manual or scripted verification and say why.
- If the bug is flaky, make the test deterministic where possible and document the signal being locked down.
- If the bug exposes a broader class of failures, fix the broader class rather than only the reported instance. First land the focused regression path, then consider additional sibling coverage. Each additional persistent test must still independently clear the same exceptionally high bar.

## Final Response

Report the evidence, not just the outcome:

- Name the failing-before test or executable check and the failure it produced.
- Name the passing-after test run and any nearby validation performed.
- For every test added or materially expanded, state why the codebase would be significantly worse without that exact test.
- If failing-before evidence could not be demonstrated, state why and describe the closest regression check used instead.
