# 목표

현재 Nidus `develop` 브랜치를 기준으로 **다중 작업 조정 v1**을 구현하라.

현재 Nidus는 하나의 Task에 대해 다음 순환을 지원한다.

```text
사용자 요청
→ Manager가 Completion Contract 정의
→ Worker 실행 + 자기 점검
→ 결정적 검증
→ Manager 검토
→ APPROVE / REWORK / ESCALATE
→ Completed / Human Review
```

이번 구현에서는 이 구조를 변경하지 않는다.

그 위에 다음 상위 흐름을 추가한다.

```text
사용자의 상위 목표
→ Manager가 전체 목표와 완료 기준 정의
→ 여러 Task로 분해
→ Task 간 의존 관계 구성
→ Task Board 저장
→ 실행 가능한 Task 선택
→ 기존 단일 Task 업무 순환 실행
→ Task 완료 및 의존 관계 갱신
→ 다음 Task
→ 모든 필요한 Task 완료
→ Manager 전체 결과 검토
→ COMPLETE / ADD_TASKS / ESCALATE
```

핵심 목표는:

> **하나의 큰 목표를 Manager가 여러 Task로 계획하고, Runtime이 계획의 무결성과 진행을 관리하며, 기존 Worker 업무 순환을 반복 사용하여 목표를 끝까지 완료하는 구조를 만드는 것**

이다.

---

# 1. 핵심 설계 원칙

이번 구현에서는 **프롬프트의 책임과 프로그램의 책임을 명확히 분리**한다.

## AI / Prompt 책임

AI가 의미를 해석해야 하는 영역:

```text
목표 해석
전체 완료 기준 작성
Task 분해
의미적 의존 관계 판단
새 Task 필요성 판단
Plan 변경 이유 판단
Worker 작업 수행
개별 Task 품질 검토
전체 목표 완료 판단
사람 판단 필요성 판단
```

## Runtime / Program 책임

결정적으로 검증하거나 강제할 수 있는 영역:

```text
Plan / Task ID 생성
영속 저장
Task-Plan 관계
Dependency graph
Cycle / invalid reference 검사
Ready Task 계산
상태 전이
Task / Plan 수정 한도
Completed history 보호
Approval snapshot / hash
권한 / Secret / Git / Recovery / Audit
```

원칙:

```text
AI 판단
→ 구조화된 제안
→ Runtime 검증
→ 상태 변경
```

AI가 시스템 상태를 직접 변경하게 하지 않는다.

---

# 2. 기존 단일 Task Runtime 재사용

다중 작업을 위해 새로운 Task 실행기를 만들지 않는다.

각 Task는 계속 기존 구조를 따른다.

```text
Task
→ Completion Contract
→ Worker
→ Self Check
→ Deterministic Verification
→ Manager Review
→ APPROVE / REWORK / ESCALATE
```

새 기능은 이 Task들을 **계획하고 연결하고 순서대로 실행하는 상위 조정 계층**이다.

이번 단계에서는 Project / Phase / 여러 Worker / 병렬 실행까지 구현하지 않는다.

범위는:

```text
Manager 1
Worker 1
Multiple Tasks
```

이다.

---

# 3. Execution Plan

상위 목표마다 별도의 영속 `Execution Plan`을 둔다.

Execution Plan은 새로운 Employee나 조직 계층이 아니라:

> Manager가 현재 목표를 달성하기 위해 유지하는 변경 가능한 Task 지도

다.

Task JSON 안에 전체 Plan을 억지로 넣지 말고 별도 영속 객체로 관리한다.

최소 데이터:

```text
plan_id
original_request
goal
top-level completion contract
manager
created_at
status
version
task references
change history
final review
result
```

구체적인 SQLite 구조는 기존 Store를 분석한 뒤 가장 자연스러운 방식으로 구현한다.

기존 Task와 호환성을 불필요하게 깨뜨리지 않는다.

---

# 4. Manager 역할

별도의 Planner Employee를 만들지 않는다.

기존 `manager-1`이 상황에 따라 세 가지 책임을 수행한다.

```text
Planning
→ 전체 목표와 Task 계획

Task Review
→ 개별 Worker 결과 검토

Final Review
→ 전체 목표 완료 여부 판단
```

Employee Identity와 모델 호출 목적은 분리한다.

Prompt도 다음 책임을 명확히 분리한다.

```text
Common Principles
Manager Planning
Manager Task Review
Manager Final Review
Worker Execution
```

현재 `workflow.py`에 프롬프트가 섞여 있다면 유지보수하기 좋은 구조로 분리한다.

프롬프트는 단순 문자열이 아니라 **Nidus의 조직 운영 규정**으로 취급한다.

---

# 5. Manager Planning 원칙

Manager는 계획 시 다음 원칙을 따른다.

1. 사용자의 최종 목표와 전체 완료 기준을 먼저 정의한다.
2. 목표 달성에 필요한 **최소한의 충분한 Task**로 분해한다.
3. 각 Task에는 명확한 목적과 완료 기준이 있어야 한다.
4. Task 간 결과 의존성이 있으면 명시한다.
5. Worker가 결정할 Action 수준까지 과도하게 세분화하지 않는다.
6. 불필요한 Task를 만들지 않는다.
7. 완료된 Task를 수정하지 않는다. 추가 작업이 필요하면 새 Task를 제안한다.
8. 현재 정보로 알 수 없는 것을 임의로 가정하지 않는다.
9. Plan은 고정 절차가 아니라 변경 가능한 작업 지도다.
10. 사람이 판단해야 하는 문제는 사람에게 올린다.

---

# 6. 구조화된 Plan Proposal

Manager는 자연어 계획을 직접 실행하지 않고 구조화된 Proposal을 반환한다.

예:

```json
{
  "goal": "...",
  "completion_criteria": ["..."],
  "tasks": [
    {
      "local_key": "T1",
      "title": "...",
      "goal": "...",
      "priority": 1,
      "depends_on": [],
      "sources": ["..."],
      "completion_criteria": ["..."],
      "expected_output": "..."
    }
  ],
  "planning_reason": "..."
}
```

Malformed 응답을 임의로 복구하거나 추정하지 않는다.

Runtime은 Proposal을 검증한 뒤에만 Plan과 Task를 생성한다.

---

# 7. Plan / Task ID

AI는 영구 ID를 만들지 않는다.

Manager는 Plan 내부에서:

```text
T1
T2
T3
```

같은 `local_key`만 사용한다.

영구 ID는 Runtime이 생성한다.

Task ID에는 추적 가능한 정보를 포함한다.

```text
객체 종류
생성 시각
Plan 식별자
생성 당시 Manager
Plan 내부 순번
짧은 충돌 방지 값
```

예:

```text
tsk_20261012T080301Z_A7K2_mgr01_003_3F8C
```

Plan도 동일한 원칙으로 ID를 가진다.

```text
pln_20261012T080250Z_mgr01_A7K2
```

원칙:

- ID는 생성 후 변경하지 않는다.
- ID의 Manager는 **생성 당시 Manager**다.
- 현재 담당 Manager/Worker는 별도 필드다.
- 문자열 규칙만 믿지 말고 DB 고유성 제약 또는 동등한 검사를 둔다.
- `local_key ↔ permanent task_id` 매핑을 보존한다.

---

# 8. Dependency Graph

Runtime은 다음을 결정적으로 검사한다.

```text
local_key 중복
존재하지 않는 dependency
self dependency
cycle
빈 goal
없는 completion criteria
invalid source
output collision
잘못된 priority
Task/Plan ID 중복
Task 수 제한
```

Task 실행 가능 여부도 모델에게 묻지 않는다.

```text
Task.status == queued
AND
모든 depends_on Task == completed
```

이면 Ready 상태로 본다.

Ready Task가 여러 개면 결정적으로:

```text
priority
→ plan sequence
→ created_at
→ stable ID
```

순으로 하나를 선택한다.

v1에서는 병렬 실행하지 않는다.

---

# 9. 선행 Task 결과 전달

Dependency는 단순 순서가 아니라 결과 전달도 의미한다.

후속 Task는 승인된 선행 Task 결과를 입력으로 사용할 수 있어야 한다.

최소 Result Reference:

```text
task_id
plan_id
output/result reference
output hash
completion state
approval/review reference
```

후속 Task가 **어떤 버전의 선행 결과를 사용했는지** 추적 가능해야 한다.

과거 실행이 조용히 최신 파일을 참조하도록 만들지 않는다.

---

# 10. Worker의 Plan 권한

Worker는 현재 배정된 Task만 책임진다.

Worker Prompt에 다음을 포함한다.

```text
전체 Plan을 변경하지 않는다.
Task를 직접 추가/삭제/취소하지 않는다.
다른 Task의 책임을 대신 수행하지 않는다.
새 Task가 필요하면 Manager에게 보고한다.
현재 Completion Contract를 기준으로 작업한다.
선행 Task 결과를 참고할 수 있지만 무조건 사실로 간주하지 않는다.
Task 밖의 문제는 limitations/questions/follow-up 제안으로 보고한다.
```

새 Task 생성 흐름:

```text
Worker 보고
→ Manager 판단
→ Plan Change Proposal
→ Runtime 검증
→ Task 생성
```

---

# 11. Completed Task 보호

Completed Task의 다음 정보는 과거 기록으로 보호한다.

```text
goal
completion contract
approved result
historical dependencies
manager approval
worker submission
```

새로운 검토가 필요하면 기존 Task를 수정하지 말고 새 Task를 만든다.

모든 의미 있는 Plan 변경은 Event와 Version history로 남긴다.

---

# 12. 동적 Plan 변경

Manager는 작업 중 필요하면 Plan Change Proposal을 반환할 수 있다.

v1에서 최소 지원할 작업:

```text
add_task
cancel_unstarted_task
modify_unstarted_task
add_dependency
remove_dependency
```

Runtime은 변경 후 전체 Graph를 다시 검증한다.

Cycle이나 invalid reference가 발생하면 적용하지 않는다.

각 변경에는 최소:

```text
version
timestamp
authority
reason
operations
affected_tasks
previous_plan_hash
new_plan_hash
```

를 기록한다.

---

# 13. 폭주 방지

무한 Task 생성과 계획 수정을 막는다.

초기 기본값 예:

```text
Initial Tasks <= 10
Total Tasks <= 20
Plan revisions <= 5
```

설정 가능하게 만드는 것을 선호한다.

한도를 초과하면 자동 확장하지 말고 Human Review 또는 명확한 제한 상태로 전환한다.

---

# 14. Manager를 다시 부르는 시점

Task가 하나 끝날 때마다 Planning Manager를 호출하지 않는다.

정상 진행은 Runtime이 처리한다.

```text
Task Completed
→ Dependency 갱신
→ Ready Task 계산
→ 다음 Task 실행
```

Manager의 추가 판단은 최소 다음 경우에만 필요하다.

```text
Worker가 추가 Task 필요성을 보고
Task가 Blocked
Ready Task가 없는데 Plan 미완료
모든 계획 Task 완료
현재 Plan으로 전체 목표 달성 여부 판단 필요
```

불필요한 모델 호출을 줄인다.

---

# 15. Final Review

모든 필수 Task가 완료돼도 Plan을 자동 완료하지 않는다.

Manager가 마지막으로 다음을 검토한다.

```text
Original Request
Top-level Completion Contract
Current Plan
Plan Change History
Completed Task results
Approved outputs
Limitations / Questions
```

원칙:

1. 모든 Task가 완료됐다는 이유만으로 전체 목표를 완료 처리하지 않는다.
2. 원래 요청과 전체 완료 기준을 다시 확인한다.
3. Task 결과 간 누락·모순·공백을 확인한다.
4. 부족하면 필요한 최소 Task를 추가한다.
5. 충분하면 완료를 승인한다.
6. 책임 있게 판단할 수 없으면 사람에게 올린다.

판정은:

```text
COMPLETE
ADD_TASKS
ESCALATE
```

세 가지로 제한한다.

`ADD_TASKS`는 Plan Change Proposal로 연결한다.

`ESCALATE`는 기존 Waiting / Human Review 구조를 재사용한다.

---

# 16. Security / Gateway

Planning과 Final Review도 외부 모델 전송이다.

기존 Security/Gateway 규칙을 우회하지 않는다.

각 호출은 필요한 최소 문맥만 보낸다.

```text
role
prompt
selected sources/results
policy
snapshot
```

불필요한 Home/전체 Vault를 전송하지 않는다.

Secret은 Prompt, Plan, Task 결과에 들어가지 않는다.

특정 Provider를 코드에 고정하지 않는다.

---

# 17. CLI / Recovery

현재 CLI 스타일을 최대한 유지한다.

필요하면 다음과 비슷한 명령을 추가한다.

```text
plan-submit
plan-run
plan-show
plan-list
plan-decide
```

정확한 이름은 기존 CLI 구조에 맞춰 결정한다.

지원해야 하는 흐름:

```text
상위 요청 등록
→ Planning 승인
→ Plan 생성
→ Plan 실행
→ Task별 기존 업무 순환
→ 중단
→ 재시작
→ 정확한 Next Task 복구
→ Final Review
→ Completed / Human Review
```

하나의 `plan-run`에서 무제한 모델 호출을 반복하지 않는다.

---

# 18. 핵심 테스트

최소 다음을 검증한다.

### 정상 흐름

```text
T1 → T2 → T3 → Final Review → COMPLETE → Archive
```

### Dependency

- 선행 Task 미완료 시 후속 Task 실행 금지
- 여러 Ready Task 중 결정적 순서 선택
- Cycle 거부
- 없는 dependency 거부

### 기존 Task Workflow 재사용

- Worker REWORK 후 완료
- Worker ESCALATE 시 dependent Task 중단
- 기존 Manager/Worker 테스트 유지

### 동적 계획

```text
Task 결과
→ ADD_TASK 필요
→ Plan 수정
→ 새 Task
→ 다시 실행
```

### Final Review

```text
모든 Task 완료
→ ADD_TASKS
→ 추가 실행
→ COMPLETE
```

및:

```text
Final Review → ESCALATE → Human Review
```

### 안전성

- Total Task limit
- Plan revision limit
- Completed Task mutation 거부
- 중단 후 Recovery
- dependency result snapshot 보존

---

# 19. 실제 모델 검증

결정적 테스트 후 공개 합성 자료로 실제 Model Gateway 전체 흐름을 최소 한 번 수행한다.

예:

```text
Manager Planning
→ 2~3 Tasks

Task 1
→ Worker
→ Manager Review

Task 2
→ Worker
→ Manager Review

Final Review
→ COMPLETE

Plan
→ Archive
```

실제 개인 자료를 사용하지 않는다.

현재 호출 가능한 Provider를 사용하고 특정 Provider 성공을 하드코딩하지 않는다.

실패를 성공으로 재해석하지 않는다.

Evidence는 기존 `docs/evidence/`에 보존한다.

---

# 20. 회귀 / 문서

현재 `develop`의 실제 테스트 기준을 먼저 확인한다.

기존:

```text
Manager/Worker workflow
Gateway
Security
Archive
Git
Recovery
```

관련 회귀를 모두 유지한다.

최소:

```text
전체 unit tests
local integration tests
compileall
git diff --check
```

를 통과한다.

다음 문서를 실제 구현과 일치하도록 갱신한다.

```text
README.md
PRD.md
DESIGN.md
docs/CONCEPT.md
docs/VALIDATION.md
docs/plans/current-plan.md
```

특히 DESIGN에는 **Prompt 책임 / Runtime 책임 경계**를 명확히 기록한다.

---

# 21. Git Flow — 반드시 실제 작업 과정에서 적용

이번 작업은 `main`에서 수행하지 않는다.

```text
main
→ 안정 버전

develop
→ 기능 통합

feature/*
→ 기능 개발
```

최신 `develop`에서 시작한다.

기능 규모가 크므로 필요에 따라 논리적 단위의 feature branch로 나눈다.

권장 예:

```text
feature/plan-model
feature/task-identity
feature/task-dependency
feature/manager-planning
feature/plan-runtime
feature/final-review
feature/multi-task-evidence
```

브랜치 수를 억지로 늘릴 필요는 없지만 **하나의 거대한 변경으로 처리하지 않는다.**

기본 반복:

```text
develop
→ feature branch 생성
→ 기능 구현
→ 관련 테스트
→ 논리 단위 commit
→ 전체 관련 회귀 확인
→ develop merge
→ develop 검증
→ 최신 develop에서 다음 feature branch 생성
```

각 기능이 완성될 때마다 중간 커밋한다.

예:

```text
feat: persist execution plans
feat: generate traceable task identifiers
feat: validate dependency graphs
feat: add manager planning contract
feat: orchestrate sequential plan execution
feat: add final plan review
test: verify multi-task lifecycle
docs: document orchestration responsibilities
```

브랜치를 바꾸기 전에는 반드시:

```text
git status
미커밋 변경 확인
관련 테스트 확인
```

을 수행한다.

미완성 변경을 다른 feature branch로 들고 가지 않는다.

기능 branch를 `develop`에 병합한 뒤 전체 회귀를 확인하고 다음 branch를 만든다.

`main`, `release/*`, `hotfix/*`는 이번 작업에서 변경하지 않는다.

원격 push / PR / main merge는 사용자가 별도로 요청하지 않는 한 수행하지 않는다.

Git 이력을 마지막에 사후 조작하지 말고 **실제 개발 순서가 브랜치와 커밋 기록에 드러나도록 작업한다.**

---

# 범위 밖

이번 Slice에서는 다음을 구현하지 않는다.

```text
Multiple Workers
Parallel Execution
Group / Lead Manager
Project / Phase 전체
Red Team
JEV / Decision Engine
Tool / Shell / Browser execution
GUI
Daemon / Scheduler
Vector DB
자동 Employee 생성
자동 Model 최적화
무한 자율 실행
```

---

# 완료 조건

다음이 모두 충족되어야 한다.

1. Manager가 하나의 상위 요청을 여러 Task로 분해한다.
2. 상위 Completion Contract와 Execution Plan이 영속 저장된다.
3. Plan/Task 영구 ID는 Runtime이 생성하고 고유성이 보장된다.
4. Dependency graph와 Ready Task 계산이 결정적으로 동작한다.
5. 각 Task는 기존 Manager/Worker workflow를 사용한다.
6. 승인된 선행 Task 결과를 후속 Task가 명시적으로 참조한다.
7. Worker는 Plan을 직접 수정하지 못한다.
8. Manager의 Plan Change Proposal을 Runtime이 검증 후 적용한다.
9. Plan version/history와 Completed Task history가 보존된다.
10. Task/Plan 확장 한도가 존재한다.
11. 모든 Task 완료 후 Manager Final Review를 수행한다.
12. COMPLETE / ADD_TASKS / ESCALATE가 실제 동작한다.
13. 중단 후 정확히 복구된다.
14. 기존 Security/Gateway/Git/Archive 경계를 유지한다.
15. 기존 회귀 + 새 multi-task 테스트가 모두 통과한다.
16. 실제 공개 합성 multi-task 실행이 최소 한 번 성공한다.
17. 문서와 실제 구현이 동일한 책임 구조를 설명한다.
18. Git Flow를 실제 작업 과정에서 지키고 기능 단위 커밋/병합 이력을 남긴다.

---

# 최종 보고

작업 완료 후 다음을 보고한다.

```text
Status

Architecture changes

Prompt vs Runtime responsibility

Execution Plan / Task ID design

Dependency / scheduling

Manager Planning

Worker integration

Dynamic Plan changes

Final Review

Security / Recovery

Tests / Live evidence

Known limitations

Git Flow
- starting develop commit
- feature branches
- 주요 commits
- develop merge commits
- final develop HEAD
- main unchanged 여부
- working tree 상태

Recommended next step
```

---

# 핵심 원칙

```text
Manager
→ 무엇을 해야 하는지 판단

Worker
→ 배정된 Task를 어떻게 수행할지 판단

Runtime
→ 무엇이 유효하고 허용되며 실행 가능한지 강제
```

Nidus는 AI의 판단을 전부 코드로 대체하지 않는다.

동시에 상태 무결성과 안전성을 AI의 프롬프트 준수에만 의존하지 않는다.

이번 구현은:

> **Manager의 계획 능력과 Runtime의 결정적 통제를 결합하여, 하나의 상위 목표를 여러 Task로 분해하고 기존 단일 Task 업무 순환을 반복 사용해 끝까지 완료하는 Nidus 최초의 다중 Task 조정 구조를 만드는 것**

이다.

현재 저장소를 먼저 분석하고 기존 구조를 최대한 재사용하라.

계획만 작성하고 멈추지 말고:

```text
분석
→ 설계
→ feature 단위 구현/테스트/커밋
→ develop 통합
→ 전체 회귀
→ 실제 합성 multi-task 검증
→ 문서화
→ 최종 develop 검증
```

까지 완료하라.