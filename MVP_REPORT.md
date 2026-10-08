# MVP Result

> 최신 상태: 실제 Copilot 생성형 실행 VERIFIED, Completed/Archive 확인.
> 이전 미검증/Blocker 본문은 당시 기록입니다. MODEL_GATEWAY_REPORT.md 및
> docs/evidence/model-live-copilot.json이 최신 결과입니다.


## Status
PARTIAL — the offline runtime MVP is implemented and validated. The original
mission's actual generative AI Employee hypothesis remains unvalidated; do not
interpret deterministic extraction as a successful AI autonomy experiment.

## What works
- CLI Inbox with original request and user-selected priority; a standalone Task
  assigned to worker-1 with a complete Completion Contract.
- Home/Desk/Board/selected Library recovery, persisted native-note checkpoints.
- Restricted UTF-8 evidence briefing, source fingerprints and independent output
  verification. Missing, changed or tampered resources cannot complete.
- Allow/Ask/Deny checks, scoped overwrite approval, rejection and stale approval
  invalidation. No shell, network, deletion or Secret tools are exposed.
- Candidate-phase restart, write-intent recovery and single-vault process locking.
- Archive, audit trail, local Vault Git commits and retained overwrite preimages.
  Unrelated staged user files are preserved. Git failure blocks affected tasks.

## End-to-End Flow
`submit → contract → run → Home → Desk → Board → Library → Security → Workshop →
Verifying → independent verification → Completed → Archive`.
`run --execute-only` stops at the durable candidate. A new process resumes.
Existing output takes `Waiting → human decision → queued/cancelled`.

## Acceptance Criteria Results
All P0 criteria in the bounded offline PRD pass; this is not all of the original
mission's stronger model hypothesis.

| AC | Result | Evidence |
|---|---|---|
| AC-01 | PASS | contract_and_complete; separate_process_primary_flow_and_archive |
| AC-02 | PASS | contract_and_complete; independent byte/source comparisons |
| AC-03 | PASS | restart_verification; lock; separate-process CLI tests |
| AC-04 | PASS | desk_reconciliation_preserves_native_history |
| AC-05 | PASS | denied_paths; source_overwrite_denied; source_limit |
| AC-06 | PASS | approve_scoped_overwrite; reject_preserves_output; changed_approval_waits_again |
| AC-07 | PASS | changed_source_blocks; tampered_candidate_blocks; missing_and_invalid_utf8_block |
| AC-08 | PASS | archive CLI test; preimage test; staged-file preservation; Git failure test |
| Actual generative model execution | NOT VERIFIED | no installed/configured model host/provider |

## Verification Evidence
2026-10-07, Python 3.9.6, Git 2.54.0, macOS:
- `python3 -m unittest discover -s tests -v`: 18 tests pass, including separate
  processes for primary flow and explicit human approval.
- `PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts`:
  pass. Default macOS Python cache was initially sandbox-denied; redirected cache
  passed without changing checks.
- `python3 scripts/demo.py`: real isolated temporary Vault, Completed, all three
  verification fields true, empty active list, retained archive.
- `git diff --check`: pass.
- Final integrated regression and clean-tree/history review: completed after
  feature merge; no main/develop integration or remote operation.

## Architecture Decisions
SQLite/stdlib CLI and synchronous process avoid service infrastructure. Home
identity is independent of the deterministic execution mode. Board owns Task
status; Desk owns native notes; Library originals remain ordinary files. Logical
archive preserves one task record. Restricted file tools need no shell container.
Git snapshots cover only state and selected task resources, including overwrite
preimages. No conceptual source document was modified. Details: DESIGN.md.

## Git Summary
- Base: clean develop at e68b29e; pre-existing user changes: none.
- MVP integration branch and final current branch: feat/nidus-mvp.
- Preserved feature branches: feat/mvp-design, feat/task-lifecycle,
  feat/context-security, feat/task-archive. All are merged locally using no-ff.
- Important commits: fe742a8 (design), 57852c3 (persistence), aafa4d3 (execution),
  68360fe (recovery/permission), 76245f1 (archive/versioning), ec79653 (lock hygiene),
  5e28e31 (demo and model boundary). Documentation/reconciliation commits and
  integration merge commits are visible in Git log and current-plan.
- Final `git status --short`: empty. main remains 8166662; develop remains e68b29e.
- No push, PR, release, tag, branch deletion or shared-history rewrite.
- This report is tracked with the final slice documentation commit; its own and
  final merge hashes are intentionally discoverable in Git rather than self-referential.

## Files / Components Created
PRD.md, DESIGN.md, docs/plans/current-plan.md, nidus/{store,runtime,versioning,
__main__,__init__}.py, tests/test_{runtime,security,archive}.py, scripts/demo.py,
BLOCKED.md, MVP_REPORT.md. README and .gitignore updated.

## Known Limitations
No actual LLM is connected. Worker extracts evidence rather than semantically
summarizing or interpreting arbitrary work requests. No GUI, managers, projects,
multi-worker scheduling or background service. POSIX flock requires macOS/Linux.
Source limit 20 × 1 MiB; output snapshot limit 32 MiB. Task contract generation is
fixed to this bounded operation. SQLite is versioned as a binary snapshot and
may grow Git history. Database/filesystem/Git are not one atomic transaction;
recorded write intent and retries handle the tested interruption points. This is
not OS isolation against an adversarial process racing filesystem changes.
The local human is trusted to control Vault and CLI; copying requires stopping
runtime. Missing Git prevents normal operation. Deleted historical artifacts
remain inspectable in Git rather than automatically restored.

## Deferred Change Candidates
Real generative model adapter/assignment and adaptive action planning; permission
for model data transmission; natural-language contract formation; Inbox matrix
GUI; stronger OS sandbox; knowledge promotion; multi-worker scheduling. These
are not silently added to this PRD or concept design.

## Blockers
See BLOCKED.md: no configured model runtime, provider or credentials. Both ollama
and llama-cli are absent from PATH. A local-model choice or explicit provider,
data and credential authorization is needed before extending the permission
boundary. No services were created or external data sent.

## How to Run
From repository root: `python3 scripts/demo.py`. It leaves its temporary Vault and
output path available for review. Direct CLI commands and approval examples are
in README.md. No dependency install is required.

## How to Test
`python3 -m unittest discover -s tests -v`

`PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts`

## Recommended Next Slice
After the human chooses the model/data/Secret boundary, add one real generative
Employee adapter, preserving the permission checks and completion guard. Test
mock failures offline, then run a genuinely model-backed work request and record
its live acceptance evidence before claiming the original hypothesis achieved.


## Model Gateway follow-up — 2026-10-08
Actual generative model execution: **VERIFIED**. OmniRoute → GitHub Copilot
`gh/gpt-4o-mini` processed a synthetic Nidus summary through exact transmission
approval, all six verification checks, Completed and Archive (Active 0 / Archive 1).
Evidence: docs/evidence/model-live-copilot.json. Tokens 202 input / 33 output;
cost unknown. See MODEL_GATEWAY_REPORT.md for scope, security and limitations.
Earlier offline report sections above are historical; the model route blocker is resolved.
