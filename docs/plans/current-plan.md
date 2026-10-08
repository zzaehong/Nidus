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
Excluded: shell/network/model tools. Commits: 68360fe (implementation), b11e873 (evidence).
Evidence: 14 distinct tests pass, including approval invalidation, checkpoint recovery,
path denial, native Desk history and Home terminal cleanup; compileall/diff checks pass.

## Slice 3 — archive and completion evidence
Status: Complete (offline scope). Branch: feat/task-archive.
Requirements: FR-08; AC-08 and full regression.
Changes: vault Git tracking, archive/audit, README, MVP_REPORT and final evidence.
Verification: full suite; compileall; separate-process primary/approval flows;
git diff --check; integration status/history review.
Done when: all offline P0 ACs pass, docs reconcile, clean integration branch.
Excluded: live generative hypothesis proof. Commits: 76245f1 (archive/Git),
ec79653 (clean checkpoints), 5e28e31 (demo/reconciliation).
Evidence: 18 distinct tests pass; real separate-process demo passes; compileall and
diff checks pass. Final integration verification is recorded in MVP_REPORT.md.

## Mission reconciliation / safe stop
Offline AC-01–AC-08 pass; original full mission remains PARTIAL because no actual
generative Employee is connected. No model runtime/config exists. BLOCKED.md records
the required human model/data/Secret boundary decision. No AC was removed or relaxed
to make a failure pass. Completed offline slices are integrated locally; main/develop
and remotes remain unchanged. Conceptual v2 is unchanged.

# Model Gateway mission — 2026-10-08
Base: feat/nidus-mvp c9c0022. User-owned modification: doc/prompt.md; preserve it
uncommitted and never stage it. New integration: feat/model-gateway.
Conceptual v2 stays unchanged. New prompt supersedes earlier provider-decision stop.

## MG Slice 0 — design
Status: Complete. Branch: feat/model-gateway-design.
Requirements: MG-FR-01–06 / MG-AC-01–06 defined above existing offline contract.
Changes: PRD/DESIGN extension, execution plan. Excluded: implementation.
Verification: git diff --check and requirement/permission/ownership review.
Done when: route boundary, stochastic verification and live evidence defined.
Commits: 762c12e.

## MG Slice 1 — adapter and runtime execution
Status: Complete. Branch: feat/generative-execution.
Requirements: MG-AC-01/03/04/05/06 plus AC-01–08 regression.
Changes: gateway, route configuration, scoped transmission permission, persisted
candidate, verification, unit/fake/local HTTP tests and CLI.
Verification: full unittest suite; compileall; zero-network-before-approval tests;
separate-process fake-provider E2E and candidate restart.
Done when: all offline gateway/security/failure criteria pass. Excluded: dashboard,
autodiscovery, actual payment, arbitrary agent tooling.
Commits: af13bab (gateway), 97527c2 (runtime), 57d6824 (HTTP tests), plus
follow-up test fix for existing Blocked inspection exit code 2.
Evidence: 35 offline tests and 3 separate-process loopback HTTP tests pass; syntax
and diff checks pass. Loopback sockets require sandbox escalation. An HTTP test
first assumed show exited 0 for Blocked; corrected to existing exit 2 behavior.
The failing expectation was inadvertently committed before inspecting the tool
result; corrected in a follow-up commit without rewriting history.

## MG Slice 2 — live free-provider acceptance
Status: Pending. Branch: feat/model-live-acceptance.
Requirements: MG-AC-02 and full mission completion gate.
Changes: synthetic live script, real evidence, README, reports/blocker reconciliation,
Korean document addenda reflecting the extension.
Verification: opt-in live CLI flow against real free external provider; no sensitive
inputs; final integrated offline suite; Git status/history/diff review.
Done when: real generated summary meets observable contract and completes, or a
hard blocker is accurately preserved. Excluded: paid fallback or account creation.
Commits: pending.


## MG Slice 1b — installed OmniRoute connection (user steering)
Status: Complete. Branch: feat/omniroute-connection.
Requirements: MG-AC-01/03/04/06; actual MG-AC-02 success is not claimed.
Changes: official global installation, loopback daemon, compatible default policy,
free-only combo placeholder and installation report.
Verification: version/help; dashboard 200; unauthenticated model API 401; loopback
LISTEN; full offline/HTTP regression and syntax checks.
Done when: installation/server readiness and configured client boundary are verified.
Excluded: account/payment setup, unknown paid auto routing, client impersonation.
Verification result: 37 offline tests and 3 HTTP tests pass; compileall/diff checks pass.
Commits: see feat/omniroute-connection history. Actual model completion remains in MG Slice 2.
