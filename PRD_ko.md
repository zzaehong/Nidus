# Nidus 로컬 MVP PRD

## 목적 및 대상 사용자

단일 로컬 사용자가 범위가 제한된 문서 브리핑 작업을 하나의 지속적인 Employee에게 위임하고,
해당 Employee의 권한, 진행 상태, 결과 및 검증 상태를 확인할 수 있도록 한다.

`doc/prompt.md`에 정의된 가설 중 Runtime 부분을 검증한다.

`요청 → 계약 → Context Recovery → 허가된 실행 → 검증된 완료 → Archive`

오프라인에서 확보한 증거만으로는 생성형 모델의 자율적인 판단 능력까지 검증되었다고 볼 수 없다.

## 목표 / 비목표

### P0 목표

- 실행 가능한 로컬 Flow
- 지속 가능한 Recovery
- 명시적인 인간의 의사결정
- 사용자 원본 파일 보호
- 관찰 가능한 Verification
- 작업 이력 보존

### 비목표

다음 항목은 이번 MVP 범위에 포함하지 않는다.

- GUI(Conceptual Design의 Inbox Matrix 포함)
- 임의의 자연어 Task
- Shell Tool
- 네트워크 / 모델 Provider
- Manager
- Project
- Multi-Worker
- Daemon
- Vector Search
- Red Team
- Dream Sequence
- Deployment

CLI는 이번 MVP의 Interface이며,
장기적으로 Conceptual Design에서 정의한 Inbox UX를 대체하는 것은 아니다.

## 주요 시나리오

1. 사용자가 선택한 Markdown/Text Source와 새로운 Output Path를 포함한 Note를 제출한다.
   Worker를 실행한 뒤 Evidence Briefing과 Archive된 Task를 확인한다.

2. 기존 Output 파일을 덮어써야 하는 경우,
   교체 전에 인간의 승인을 요구한다.
   사용자가 거절하면 기존 파일을 보존하고,
   승인하면 검토 당시의 정확한 Input/Output Snapshot에 대해서만 쓰기를 허용한다.

3. 실행 이후 작업을 중단한 뒤 Runtime을 다시 시작한다.
   이미 기록된 쓰기 작업을 반복하지 않고 Persist된 Candidate를 검증한다.
   잘못되었거나 존재하지 않는 Output은 절대로 Verification을 통과하지 않는다.

4. 잘못된 Path 또는 사용할 수 없는 Source가 입력되면
   Task를 Blocked 상태로 전환하고 사용자가 확인할 수 있는 이유를 기록한다.

## 기능 요구사항 / P0 Acceptance Criteria

| 요구사항 | 관찰 가능한 Acceptance Criterion |
|---|---|
| FR-01 Inbox 및 Contract | AC-01 제출 시 원본 요청, 사용자 Priority, Worker Assignment와 Goal, Scope, Constraints, Acceptance Criteria, Verification, Result를 포함하는 Contract가 보존된다. |
| FR-02 Workshop Briefing | AC-02 UTF-8 Source에 대해 Output에 요청 내용, Source Path, SHA-256 Hash, 각 Source의 첫 3개 비어 있지 않은 줄이 포함되며 원본은 변경되지 않는다. |
| FR-03 지속 가능한 Task Board | AC-03 새로운 Process에서도 Task를 확인할 수 있고 Candidate 실행 이후 작업을 재개할 수 있다. 동시에 실행된 Worker 두 개가 동일 Vault를 동시에 점유할 수 없다. |
| FR-04 Context Recovery | AC-04 실행 전에 `Home → Desk → Task Board → Library` 순서가 기록된다. 오래된 Desk Reference는 Board의 최신 상태와 일치하도록 조정되고, Native Note는 Checkpoint History에 보존된다. |
| FR-05 Permission 경계 | AC-05 Absolute Path, Path Traversal, Symlink, Hidden-System Path를 거부한다. 원본 파일을 Output으로 사용할 수 없으며 Shell, 삭제, 네트워크 또는 Secret Tool을 제공하지 않는다. |
| FR-06 Human Attention | AC-06 기존 Output이 존재하면 Background, Reason, Choice, Effect를 포함한 Waiting 상태로 전환된다. 승인은 Input/Output Hash에 묶이며 파일이 변경되면 새로운 의사결정이 필요하다. 거절 시 파일을 쓰지 않고 Task를 취소한다. |
| FR-07 Verification | AC-07 완료를 위해 예상 Byte를 독립적으로 다시 계산하고 Source Snapshot이 일치하는지 확인해야 한다. 변조되었거나 누락된 Candidate는 Blocked가 되며 Completed가 될 수 없다. |
| FR-08 Archive / Audit | AC-08 Completed Task는 Active Listing에서 제거된다. Archive에는 Brief, Contract, Result, Verification, Decision, 순서가 보존된 Audit History가 유지된다. Vault 변경사항은 로컬 Git으로 Versioning한다. |

## 품질 요구사항 / 제약 / 의존성

Python 3.9 이상과 Git만 사용한다.
Package Download, Credential 또는 유료 Service는 사용하지 않는다.

한 번에 하나의 Vault와 하나의 Worker만 실행한다.

Source는 명시적으로 선택한 일반 UTF-8 `.md` / `.txt` 파일만 허용한다.

- 파일당 최대 1 MiB
- 최대 20개 Source

Output은 일반 `.md` / `.txt` 파일로 제한한다.

모든 Nidus 내부 상태는 `.nidus/`에 저장하고,
사용자의 Library와 Output은 `.nidus/` 외부에 유지한다.

Failure는 사용자가 확인할 수 있어야 하며,
안전한 경우 Retry할 수 있어야 한다.

Runtime을 종료한 후에는 Vault 파일을 Backup하거나 이동할 수 있어야 한다.

신뢰할 수 있는 로컬 사용자가 CLI와 Vault를 통제하는 것을 전제로 한다.
악의적인 외부 Process가 Filesystem을 수정하는 상황까지 격리하는 시스템은 이번 MVP 범위가 아니다.

## 미결정 사항 및 가정

가짜 Semantic Summarization을 구현하는 대신,
결정론적인 Evidence Briefing임을 명확하게 표시한다.

실제 모델의 Planning / Judgment는 추후 Change Candidate로 남긴다.
또한 별도의 실제 실행 Acceptance Evidence가 필요하다.

Manual Approval은 명시적인 CLI 입력으로만 이루어지며,
시간이 지났다는 이유로 자동 승인하지 않는다.

Priority는 사용자가 직접 선택한다.
Conceptual Design의 네 가지 우선순위 Quadrant는 CLI Value로 모두 표현한다.

## Implementation Gate

다음이 정의되어 있다.

- Problem
- 범위가 제한된 Outcome
- Primary Flow
- 관찰 가능한 Acceptance Criteria

Ownership, Permission, Recovery 관련 결정은 `DESIGN.md`에 정의되어 있다.

현재 오프라인 Scope에서는 구현을 막을 Critical Unknown이 남아 있지 않다.

각 다음 Slice에는 실행 Command와 Completion Condition이 존재한다.
