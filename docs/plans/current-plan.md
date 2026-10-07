# MVP execution plan

Base: clean `develop`, e68b29e. Integration: `feat/nidus-mvp`.
Source workflow/template files and AGENTS.md were absent; follow doc/prompt.md.
Concept documents remain unchanged. No remote operations or main/develop merges.

## Slice 0 — shape/design
Status: Complete. Branch: feat/mvp-design.
Requirements: all FR/AC defined; implementation gate passed.
Changes: PRD, DESIGN, plan. Verification: inspect traceability and git diff --check.
Done when: documents define bounded flow and testable AC. Excluded: implementation.
Commits: fe742a8.

## Slice 1 — durable task lifecycle
Status: Complete. Branch: feat/task-lifecycle.
Requirements: FR-01/02/03/07; AC-01/02/03/07.
Changes: Store, deterministic Workshop, CLI and lifecycle tests.
Verification: python3 -m unittest discover -s tests -v; compileall.
Done when: separate-process submit/run/inspect works and failed verification blocks.
Excluded: overwrite approval, full Desk reconciliation. Commits: 57852c3 (persistence), aafa4d3 (execution), 7bf61d2 (evidence).
Evidence: 6 tests pass; compileall passes with PYTHONPYCACHEPREFIX=/tmp/nidus-pycache.
Default macOS cache location was sandbox-denied; no product failure.

## Slice 2 — recovery and permission
Status: Complete. Branch: feat/context-security.
Requirements: FR-04/05/06; AC-04/05/06 (and AC-03 recovery).
Changes: Desk history, Home reconciliation, allow/ask/deny, scoped decisions/tests.
Verification: full unittest suite and approval/restart CLI flows.
Done when: unsafe paths fail closed and changed approval snapshots wait again.
Excluded: shell/network/model tools. Commits: see feat/context-security history.
Evidence: 14 distinct tests pass, including approval invalidation, checkpoint recovery,
path denial, native Desk history and Home terminal cleanup; compileall/diff checks pass.

## Slice 3 — archive and completion evidence
Status: Pending. Branch: feat/task-archive.
Requirements: FR-08; AC-08 and full regression.
Changes: vault Git tracking, archive/audit, README, MVP_REPORT and final evidence.
Verification: full suite; compileall; separate-process primary/approval flows;
git diff --check; integration status/history review.
Done when: all offline P0 ACs pass, docs reconcile, clean integration branch.
Excluded: live generative hypothesis proof. Commits: pending.
