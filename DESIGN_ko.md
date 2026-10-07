# 기술 설계

## 경계와 Runtime 구성요소

하나의 동기식 Python CLI Process가 사용자가 선택한 Agent Vault를 운영한다.

하나의 Employee인
`worker-1` (`Operations / document analyst`)는
Model Assignment 없이도 지속적인 Home Identity를 가진다.

Runtime은 다음 요소를 Orchestration한다.

- Inbox
- Task Board
- Desk
- Security
- Meeting Room
- Workshop
- Verification

이번 Briefing은 결정론적인 Intelligence Layer 작업이다.
생성형 Provider는 호출하지 않는다.

## 데이터 소유권과 Persistence

SQLite 파일인 `.nidus/state.sqlite3`가 다음 데이터를 소유한다.

- Request
- Contract
- Task Board
- Home Pointer
- Desk Native Note
- Reference Checkpoint
- Decision
- Audit Event

Library는 `.nidus` 외부에 존재하는
사용자가 명시적으로 선택한 `.md` / `.txt` 파일이다.

Workshop은 하나의 Output을 작성한다.

Archive는 별도의 파일로 복사하거나 Task Truth를 이동/삭제하는 방식이 아니라,
Completed 상태의 Row를 그대로 보존하고 별도 Query로 노출하는 Logical Archive 방식이다.

각 State Transition은 Transaction 단위로 Commit된다.

Process `flock`을 사용해 모든 변경 작업을 보호한다.

Runtime을 열 때 SQLite Schema Version을 확인한다.

이동 가능한 Home에는 Machine-specific Path나 Secret을 저장하지 않는다.

Vault에서는 Git 사용을 필수로 한다.

Vault에 Git Repository가 없으면 초기화 과정에서 Repository를 생성한다.

각 변경 작업에서는 다음 항목만 Stage한다.

- Nidus State
- Runtime Ignore File
- 해당 Task가 명시적으로 선택한 Source
- 해당 Task의 Output

그리고 Local Commit을 생성한다.

승인된 Replacement를 수행할 때는 기존 파일의 Preimage를 쓰기 전에 먼저 Commit한다.

Runtime Lock / Journal 파일은 Git에서 Ignore한다.

관련 없는 사용자의 Staged File은 기존 Staged 상태를 그대로 유지한다.

이 로컬 Checkpoint Commit에서는 Git Hook과 Commit Signing을 비활성화한다.

Remote Repository에는 어떠한 작업도 수행하지 않는다.

## State Transition 및 Interface

다음 Command를 제공한다.

```bash
python3 -m nidus --vault PATH init
python3 -m nidus --vault PATH submit
python3 -m nidus --vault PATH run
python3 -m nidus --vault PATH decide
python3 -m nidus --vault PATH list
python3 -m nidus --vault PATH show
```

기본 State Transition은 다음과 같다.

```text
Queued
  ↓
Running
  ↓
Verifying
  ↓
Completed
```

Overwrite가 필요한 경우:

```text
Running
  ↓
Waiting
  ├─ approve → Queued
  └─ reject  → Cancelled
```

Error 발생 시:

```text
Error → Blocked
```

명시적인 `run`을 통해 Blocked Task를 Retry할 수 있다.

Persist된 Running Task는 Execution 단계부터 Recovery한다.

Persist된 Verifying Task는 Verification 단계부터 Recovery한다.

`run --execute-only`는 Recovery Test를 위해
Verification 이전에 Checkpoint를 남기고 중단한다.

Terminal 상태의 Task는 다시 실행할 수 없다.

## Context Recovery

Context Recovery 순서는 다음과 같다.

```text
Home Identity
  ↓
마지막 Desk Checkpoint
  ↓
현재 Task Board
  ↓
선택된 Library
```

Task Board의 최신 상태는 오래된 Task Reference보다 우선한다.

Desk의 Native Note는 유지되고,
모든 Checkpoint는 History에 보존된다.

Recovery 이후 Next Action은
오래된 Desk 값이 아니라 현재 Board Status에서 다시 계산한다.

Single-Worker 환경에서 Home은 현재 선택된 Task를 가리키며,
Task가 Completed 또는 Cancelled 같은 Terminal 상태가 되면 해당 Pointer를 제거한다.

## Permission / Failure 경계

Security는 Tool이 파일을 읽거나 쓰기 전에 모든 Path를 검증한다.

다음 항목은 허용하지 않는다.

- Absolute Path
- `..` Path Traversal
- Symlink
- Hidden Component
- 일반 파일이 아닌 Resource
- Source Overwrite
- 지원하지 않는 파일 확장자

임의의 Code Execution Tool은 존재하지 않는다.

따라서 이번 Slice에서 Docker를 추가해도 추가적인 보호 효과가 없다.

기존 Destination이 존재하면 인간의 승인을 요청한다.

Decision Scope에는 Source Hash와 Output Hash가 포함된다.

Approval을 통해 허용된 Path 범위를 확장할 수 없다.

파일을 쓰기 직전에 다시 검증한다.

새 Output은 Exclusive Creation을 사용한다.

Replacement는 Atomic Rename을 사용한다.

파일 작성 후 DB Commit 이전에 Process가 실패한 경우,
Retry 시 Contract를 기준으로 상태를 Reconcile한다.

Verification은 독립적으로 재생성한 Byte와 Source Hash를 비교한다.

DB 또는 Schema가 손상된 경우 Fail Closed한다.

Git Checkpoint에 실패하면:

- Error를 보고하고
- 해당 Task를 Blocked 처리하며
- Git으로 추적된 성공이라고 잘못 판단하지 않도록 Completion Result를 제거한다.

DB / Filesystem / Git에 걸친 작업은 하나의 Atomic Transaction이 아니다.

명시적인 Retry를 통해 기록된 Write Intent를 확인하고,
Git Failure 이후 다시 Commit하여 상태를 Reconcile할 수 있다.

신뢰할 수 없는 외부 Process가 동시에 Path를 변경하는 경쟁 조건은
이번 협력적 Local Model의 범위 밖이다.

## 기술 선택: 대안과 교체 가능성

### SQLite vs JSON File

SQLite를 선택한다.

이유:

- 외부 Dependency 없이 Transaction 지원
- Audit 순서 보장
- 상태 조회 용이

DB 접근은 Store 계층에 유지하여 추후 교체 가능하게 한다.

### CLI vs Web GUI

CLI를 선택한다.

이유:

- Server / UI Scope 없이 실제 실행 가능한 Vertical Slice를 만들 수 있다.
- Inbox Matrix는 추후 구현하며 Conceptual Design은 변경하지 않는다.

### 동기식 Process vs Queue / Daemon

하나의 Worker만 사용하기 때문에 Scheduler가 필요하지 않다.

Persist된 Phase를 통해 Queue 없이도 Restart 이후 작업을 복구할 수 있다.

### 결정론적 Worker vs 외부 모델

이번 MVP에서는 결정론적 Worker를 사용한다.

이유:

- Credential 불필요
- 비용 없음
- 외부 데이터 전송 없음

정직한 Evidence Extraction은 Runtime Orchestration을 검증할 수 있지만
생성형 Reasoning 자체를 검증하는 것은 아니다.

### Allowlist 기반 File Operation vs Docker

Shell / Network Execution이 존재하지 않으므로
신뢰 가능한 Local Use에서는 Application Boundary만으로 충분하다.

추후 Tool Execution을 추가하기 전에 Sandbox 도입을 다시 검토한다.

### Logical Archive vs 별도 Archive File

하나의 Source of Truth를 유지하기 위해 Logical Archive를 사용한다.

Task를 별도 파일로 이동하면 상태 불일치 가능성이 생기기 때문이다.

## Verification / 로컬 개발

다음 Command로 Test를 실행한다.

```bash
python3 -m unittest discover -s tests -v
```

다음 항목을 검증한다.

- Contract
- Completion Guard
- Crash Checkpoint
- Approval 무효화
- Path Attack
- Archive
- Locking

Syntax Check:

```bash
python3 -m compileall -q nidus tests
```

실제 임시 Vault를 이용한 CLI Flow를 통해
별도 Process와 Git History도 검증한다.

별도의 Third-party Build / Lint Tool은 필요하지 않다.

Acceptance Criteria Mapping과 Command는
`docs/plans/current-plan.md`에서 관리한다.

## Change Candidate

다음 항목은 향후 후보로 남긴다.

- Network / Secret Approval을 지원하는 Generative Model Adapter
- 자연어 기반 Contract 생성
- Inbox Matrix GUI
- 더 강력한 OS Sandbox
- 적대적 TOCTOU 보호
- Multi-Worker 실행
- 장기 Knowledge Promotion

이 항목들은 Nidus Conceptual Design v2를 조용히 변경하지 않는다.
