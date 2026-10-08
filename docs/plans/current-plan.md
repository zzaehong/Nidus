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
Status: Blocked (actual model completion). Branch: feat/model-live-acceptance.
Requirements: MG-AC-02 and full mission completion gate.
Changes: synthetic live script, real evidence, README, reports/blocker reconciliation,
Korean document addenda reflecting the extension.
Verification: opt-in live CLI flow against real free external provider; no sensitive
inputs; final integrated offline suite; Git status/history/diff review.
Done when: real generated summary meets observable contract and completes.
Excluded: paid fallback, account creation and client impersonation.
Evidence: actual synthetic OpenCode Zen/big-pickle call returned an access/auth
refusal; Task Blocked, Result null, Archive empty. Gateway failure evidence is
retained at docs/evidence/model-live.json. First evidence predates HTTP-status
hardening and is not rewritten. Actual success remains NOT VERIFIED.
User requested OmniRoute installation; it is now installed/running, but normal
free Provider/Combo and Endpoint Key configuration remain necessary.
Commits: no successful live acceptance commit; see separate evidence slice below.


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
Commits: 5516660 (default connection), 2161b95 (installation/readiness). Actual model completion remains in MG Slice 2.


## MG Slice 1c — failure/retry hardening
Status: Complete. Branch: feat/model-gateway-hardening.
Requirements: MG-AC-03/05/06. Commit: fd79649.
Changes: preserve safe HTTP status, distinguish access denied, clear prior model
error on explicit retry, block source changes during call and reask next run.
Verification: 37 offline tests and 3 loopback HTTP tests pass.
Excluded: provider account or live success. Done when: above regression guards pass.

## MG Slice 2a — live harness / failure evidence / reconciliation
Status: Complete (evidence preparation, not actual live success).
Branch: feat/model-live-evidence. Requirements: live observability and accurate
reporting; MG-AC-02 remains Blocked in MG Slice 2.
Changes: opt-in synthetic-only script; genuine failed API evidence; README; English
source-report and Korean addenda; current blocker and installation reconciliation.
Verification: actual script executed with exit 2 and failure evidence; JSON validates
Blocked/result-null/archive-0; syntax/diff checks; final integrated offline/HTTP tests.
Done when: reproducible harness and genuine outcome preserved without fabricated
success or secrets. Excluded: accepting failed call as success.
Commits: see feat/model-live-evidence history.

## Final state for current session
Current/integration branch: feat/model-gateway after evidence merge. Completed
implementation/preparation slices integrated; actual model acceptance remains
blocked. Only uncommitted change is user's doc/prompt.md. No remote operations or
main/develop merge. Provider Key values were never printed or committed.


## MG Slice 2 — completed Copilot acceptance (supersedes blocked state above)
Status: Complete. Feature: feat/model-live-acceptance. Integration: feat/model-gateway.
User connected Copilot. Created one restricted Nidus Endpoint Key outside Repo/Vault;
explicit paid-policy path to gh/gpt-4o-mini, no fallback or billing changes.
Real synthetic task 879034f98e4b4c11a933e9a8e17e30f6 completed; six checks true;
Active 0 / Archive 1. Response manually reviewed: exactly three factual bullets.
Tokens 202/33/235; cost unknown. gpt-5-mini failure preserved separately.
Evidence: docs/evidence/model-live-copilot.json. MG-AC-02 now PASS.
37 offline + 3 HTTP regression, compileall, diff, real key Repo/Vault scan pass.
No remaining mission blocker. Only user doc/prompt.md remains uncommitted after
integration. No push/PR/main/develop merge. Commit identifiers: feature Git history.


## Multi-provider live validation — 2026-10-08 (latest scope)
Feature: feat/model-provider-validation; integration feat/model-gateway.
Status: Partial / provider blockers recorded; fallback acceptance complete.
Gemini/NVIDIA real catalogs and valid connections, three individual candidate
calls each: 404/400 Blocked. Preserve each evidence. No speculative taxonomy change.
Injected Gemini 503 → actual NVIDIA 429 → real Copilot Completed/Archive; also
two injected 503 → Copilot complete and injected 401 → stop without fallback.
Harness exact-sequence expectation broadened for valid NVIDIA retryable failure;
raw observations preserved. Old Copilot evidence untouched. Expiring temporary
keys only in memory, deleted; no existing credential reads or account/billing edits.
37 offline + 3 HTTP tests, compileall, diff checks PASS. Reports list standalone
blockers and injection limits. No main/develop/remote operations. User prompt and
pre-existing .DS_Store files remain outside commits. Commits: Feature history.
