# MVP 결과 보고서

> 최신 상태: 실제 Copilot 생성형 실행 VERIFIED, Completed/Archive 확인.
> 이전 미검증/Blocker 본문은 당시 기록입니다. MODEL_GATEWAY_REPORT.md 및
> docs/evidence/model-live-copilot.json이 최신 결과입니다.


## 상태

**부분 완료**

오프라인 Runtime MVP는 구현 및 검증이 완료되었다.

그러나 원래 Mission에서 요구한
**실제 생성형 AI Employee가 자율적으로 판단하고 작업하는 가설**은 아직 검증되지 않았다.

결정론적 Evidence Extraction이 성공했다는 사실을
AI 자율성 실험이 성공한 것으로 해석해서는 안 된다.

## 현재 동작하는 기능

- 원본 요청과 사용자가 선택한 Priority를 포함하는 CLI Inbox
- 완전한 Completion Contract를 가진 Standalone Task 생성
- Task를 `worker-1`에 Assignment
- Home / Desk / Board / 선택된 Library의 Context Recovery
- Persist되는 Native Note Checkpoint
- 제한된 UTF-8 Evidence Briefing
- Source Fingerprint 생성
- 독립적인 Output Verification
- 누락 / 변경 / 변조된 Resource의 Completion 차단
- Allow / Ask / Deny Permission 검사
- 범위가 제한된 Overwrite Approval
- Reject 처리
- 오래된 Approval 자동 무효화
- Shell / Network / Delete / Secret Tool 미노출
- Candidate 단계에서 Runtime Restart 지원
- Write Intent Recovery
- Single-Vault Process Lock
- Archive
- Audit Trail
- Local Vault Git Commit
- Overwrite 이전 파일의 Preimage 보존
- 관련 없는 사용자의 Staged File 보존
- Git Failure 발생 시 해당 Task Block 처리

## End-to-End Flow

```text
submit
→ contract
→ run
→ Home
→ Desk
→ Board
→ Library
→ Security
→ Workshop
→ Verifying
→ 독립 Verification
→ Completed
→ Archive
```

`run --execute-only`는 Persist 가능한 Candidate 단계에서 중단한다.

새로운 Process를 시작하면 해당 상태에서 작업을 재개한다.

기존 Output이 존재하는 경우 다음 Flow를 따른다.

```text
Waiting
→ Human Decision
→ Queued / Cancelled
```

## Acceptance Criteria 결과

범위가 제한된 Offline PRD의 모든 P0 Acceptance Criteria는 통과했다.

그러나 이는 원래 Mission의 더 강한 생성형 모델 가설 전체가 검증되었다는 의미는 아니다.

| AC | 결과 | 증거 |
|---|---|---|
| AC-01 | 통과 | `contract_and_complete`, `separate_process_primary_flow_and_archive` |
| AC-02 | 통과 | `contract_and_complete`, 독립적인 Byte / Source 비교 |
| AC-03 | 통과 | `restart_verification`, Lock, Separate-process CLI Test |
| AC-04 | 통과 | `desk_reconciliation_preserves_native_history` |
| AC-05 | 통과 | `denied_paths`, `source_overwrite_denied`, `source_limit` |
| AC-06 | 통과 | `approve_scoped_overwrite`, `reject_preserves_output`, `changed_approval_waits_again` |
| AC-07 | 통과 | `changed_source_blocks`, `tampered_candidate_blocks`, `missing_and_invalid_utf8_block` |
| AC-08 | 통과 | Archive CLI Test, Preimage Test, Staged-file Preservation, Git Failure Test |
| 실제 생성형 모델 실행 | 미검증 | 설치 또는 설정된 Model Host / Provider 없음 |

## Verification 증거

검증 환경:

- 날짜: 2026-10-07
- Python 3.9.6
- Git 2.54.0
- macOS

### Unit Test

```bash
python3 -m unittest discover -s tests -v
```

결과:

- 총 18개 Test 통과
- Primary Flow를 별도 Process에서 검증
- 명시적인 Human Approval Flow 포함

### Syntax Check

```bash
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
```

결과: 통과

기본 macOS Python Cache 경로는 처음에 Sandbox에서 거부되었으나,
Cache 경로를 `/tmp/nidus-pycache`로 변경한 후
검사 자체를 변경하지 않고 통과했다.

### 실제 Demo

```bash
python3 scripts/demo.py
```

실제 격리된 임시 Vault를 사용했다.

결과:

- Task: Completed
- 3개의 Verification Field: 모두 `true`
- Active Task List: 비어 있음
- Archive: 보존됨

### Git 검증

```bash
git diff --check
```

결과: 통과

Feature Merge 이후 최종 Integrated Regression,
Clean Tree 및 History Review를 완료했다.

`main` 또는 `develop`에는 Merge하지 않았으며,
Remote Operation도 수행하지 않았다.

## Architecture 결정

SQLite + Python Standard Library CLI + 동기식 Process를 사용하여
Service Infrastructure를 추가하지 않았다.

Home Identity는 결정론적 Execution Mode와 독립적이다.

데이터 소유권은 다음과 같다.

- Board → Task Status
- Desk → Native Note
- Library → 사용자 원본 파일

Logical Archive는 하나의 Task Record를 그대로 보존한다.

제한된 File Tool만 사용하므로 Shell Container는 필요하지 않았다.

Git Snapshot에는 다음만 포함한다.

- Nidus State
- 해당 Task에서 선택한 Resource
- Overwrite 이전 Preimage

Conceptual Source Document는 수정하지 않았다.

세부 내용은 `DESIGN.md`를 참조한다.

## Git 요약

### Base

Clean 상태의 `develop` Branch:

```text
e68b29e
```

기존 사용자의 변경사항은 없었다.

### MVP Integration Branch

최종 Current Branch:

```text
feat/nidus-mvp
```

### 보존된 Feature Branch

```text
feat/mvp-design
feat/task-lifecycle
feat/context-security
feat/task-archive
```

모든 Feature Branch는 Local 환경에서 `--no-ff` 방식으로 Merge했다.

### 주요 Commit

```text
fe742a8  design
57852c3  persistence
aafa4d3  execution
68360fe  recovery / permission
76245f1  archive / versioning
ec79653  lock hygiene
5e28e31  demo and model boundary
```

Documentation / Reconciliation Commit과
Integration Merge Commit은 Git Log와 `current-plan`에서 확인할 수 있다.

최종 상태:

```bash
git status --short
```

결과: 변경사항 없음

Branch 상태:

```text
main    → 8166662
develop → e68b29e
```

다음 작업은 수행하지 않았다.

- Push
- Pull Request
- Release
- Tag
- Branch 삭제
- Shared History Rewrite

이 Report 자체는 마지막 Slice의 Documentation Commit에 포함된다.

Report 자신의 Commit Hash와 마지막 Merge Hash는
문서 내부에 Self-reference하지 않고 Git History에서 확인할 수 있도록 했다.

## 생성된 파일 / Component

```text
PRD.md
DESIGN.md
docs/plans/current-plan.md

nidus/
  store.py
  runtime.py
  versioning.py
  __main__.py
  __init__.py

tests/
  test_runtime.py
  test_security.py
  test_archive.py

scripts/
  demo.py

BLOCKED.md
MVP_REPORT.md
```

다음 파일도 수정되었다.

```text
README.md
.gitignore
```

## 알려진 제한사항

실제 LLM은 아직 연결되어 있지 않다.

Worker는 Evidence를 추출할 뿐,
임의의 Work Request를 의미적으로 Summarize하거나 Interpret하지 않는다.

다음 기능은 존재하지 않는다.

- GUI
- Manager
- Project
- Multi-Worker Scheduling
- Background Service

POSIX `flock`을 사용하므로 macOS / Linux가 필요하다.

Source 제한:

```text
최대 20개
각 파일 최대 1 MiB
```

Output Snapshot 제한:

```text
최대 32 MiB
```

Task Contract 생성은 현재 범위가 제한된 Operation에 고정되어 있다.

SQLite는 Binary Snapshot 형태로 Git Versioning되므로
시간이 지나면 Git History 크기가 증가할 수 있다.

Database / Filesystem / Git 작업은 하나의 Atomic Transaction이 아니다.

대신 기록된 Write Intent와 Retry를 사용하여
검증된 Failure Point에서 상태를 복구한다.

악의적인 외부 Process가 Filesystem Path를 동시에 변경하는 상황을
OS 수준에서 격리하지 않는다.

로컬 Human이 Vault와 CLI를 신뢰할 수 있게 통제한다고 가정한다.

Vault를 복사하려면 Runtime을 먼저 종료해야 한다.

Git이 없으면 정상적으로 동작하지 않는다.

삭제된 과거 Artifact는 자동 복원하지 않으며,
Git History에서 확인할 수 있다.

## 추후 Change Candidate

다음 항목은 향후 구현 후보로 남긴다.

- 실제 Generative Model Adapter / Assignment
- Adaptive Action Planning
- Model Data Transmission에 대한 Permission
- 자연어 기반 Contract 생성
- Inbox Matrix GUI
- 더 강력한 OS Sandbox
- Knowledge Promotion
- Multi-Worker Scheduling

이 항목들을 현재 PRD 또는 Conceptual Design에 자동으로 추가하지 않는다.

## Blocker

자세한 내용은 `BLOCKED.md`를 참조한다.

현재 다음이 존재하지 않는다.

- 설정된 Model Runtime
- Model Provider
- Credential

다음 명령도 PATH에 없다.

```text
ollama
llama-cli
```

다음 단계로 진행하려면 다음 중 하나에 대한 인간의 결정이 필요하다.

1. 로컬 모델 선택
2. 명시적으로 승인된 외부 Provider 선택

그리고 함께 다음 사항을 결정해야 한다.

- 어떤 데이터를 전송할 수 있는지
- Credential을 어떻게 처리할지

현재까지:

- 새로운 Service를 생성하지 않았다.
- 외부로 데이터를 전송하지 않았다.

## 실행 방법

Repository Root에서 다음을 실행한다.

```bash
python3 scripts/demo.py
```

실행 후 실제 임시 Vault와 Output Path가 남아 있어
직접 확인할 수 있다.

직접 CLI Command와 Approval 예시는 `README.md`에 있다.

Dependency 설치는 필요하지 않다.

## Test 방법

```bash
python3 -m unittest discover -s tests -v
```

```bash
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
```

## 권장 다음 Slice

인간이 Model / Data / Secret Boundary를 결정한 뒤,
실제 Generative Employee Adapter 하나를 추가한다.

기존의 Permission Check와 Completion Guard는 그대로 유지한다.

우선 Mock Failure를 Offline으로 Test한다.

그 후 실제 모델을 사용하는 Work Request를 실행하고
Live Acceptance Evidence를 기록한다.

이 실제 검증이 끝나기 전에는
원래의 생성형 AI Employee 가설이 달성되었다고 선언하지 않는다.


## Model Gateway follow-up — 2026-10-08
Actual generative model execution: **VERIFIED**. OmniRoute → GitHub Copilot
`gh/gpt-4o-mini` processed a synthetic Nidus summary through exact transmission
approval, all six verification checks, Completed and Archive (Active 0 / Archive 1).
Evidence: docs/evidence/model-live-copilot.json. Tokens 202 input / 33 output;
cost unknown. See MODEL_GATEWAY_REPORT.md for scope, security and limitations.
Earlier offline report sections above are historical; the model route blocker is resolved.
