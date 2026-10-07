# Mission

현재 저장소에서 **Nidus의 MVP를 설계하고 실제로 동작하는 상태까지 구현하라.**

이번 작업은 단순한 기획 작업이 아니다.

너는 다음 전체 사이클을 가능한 범위에서 자율적으로 수행해야 한다.

**Conceptual Design 확인  
→ MVP 범위 정의  
→ PRD 작성  
→ Technical Design  
→ Vertical Slice 계획  
→ Git Branch 생성  
→ 구현  
→ 테스트 및 검증  
→ 작은 단위 Commit  
→ 문서와 실제 구현 Reconciliation  
→ Feature Branch 통합  
→ 다음 Slice  
→ MVP Completion 검증**

사용자는 작업 중 자리를 비울 예정이다.

사소한 질문 때문에 실행을 중단하지 마라.

가역적이고 영향이 작은 불확실성은 가장 단순한 합리적 가정을 선택하고 문서에 기록한 뒤 계속 진행한다.

단, 아래 Hard Stop 조건에 해당하면 임의로 결정하지 말고 현재 상태를 안전하게 저장한 뒤 중단한다.

---

# Source of Truth

먼저 저장소 전체를 확인하고 다음 문서가 존재하면 반드시 읽어라.

- `Nidus_Conceptual_System_Design_v2.md`
- `Nidus_Conceptual_System_Design_v2_changes.md`
- `software-design-workflow-SKILL.md`
- `artifact-templates.md`
- 기존 `README.md`
- 기존 `AGENTS.md`
- 기존 PRD / DESIGN / plan 문서

우선순위는 다음과 같다.

**Nidus Conceptual Design v2**  
→ 제품의 개념적 책임과 구조

**PRD**  
→ MVP의 observable product behavior

**DESIGN**  
→ PRD를 구현하기 위한 기술 구조

**current-plan**  
→ 현재 구현 Slice와 진행 상태

구현 도중 Conceptual Design과 충돌하는 내용을 발견하면 Conceptual Design을 조용히 변경하지 마라.

충돌을 기록하고, Conceptual Design을 변경하지 않고 해결 가능한 방법을 우선 선택한다.

---

# MVP Hypothesis

이번 MVP가 검증해야 하는 핵심 가설은 다음과 같다.

> 사용자가 하나의 Work Request를 입력하면,
> 하나의 AI Employee가 필요한 Context를 복구하고,
> Task와 Completion Contract를 기준으로 실제 작업을 수행하며,
> 필요한 경우에만 인간의 판단을 요청하고,
> Verification을 통과한 뒤 Task를 완료 상태로 만들 수 있는가?

즉 MVP의 첫 목표는 **Nidus 전체를 구현하는 것**이 아니라,

**하나의 Work Request가 Nidus Runtime을 통해 End-to-End로 완료되는 가장 작은 시스템**

을 만드는 것이다.

---

# MVP Scope Principle

처음부터 모든 Nidus 기능을 구현하지 마라.

첫 MVP에서는 가능한 한 다음 형태를 우선한다.

```text
Human
  ↓
Inbox / Work Request
  ↓
Task 생성
  ↓
Completion Contract
  ↓
Worker 배정
  ↓
Context Recovery
Home → Desk → Task Board → 필요한 Library
  ↓
Next Action
  ↓
Security Check
  ↓
Workshop Execution
  ↓
Result
  ↓
Desk / Task Board Update
  ↓
Acceptance Criteria
  ↓
Verification
  ↓
Completed
  ↓
Archive
```

반드시 필요한 이유가 없다면 첫 MVP에서 다음을 구현하려고 범위를 넓히지 마라.

- Multi-Group orchestration
- 완전한 Red Team 자동화
- Dream Sequence
- Idea Bank 고급 기능
- Rest Room의 Cross-Pollination
- 복잡한 Manager's Office GUI
- JEV 통합
- 복수 Model 최적화
- 범용 Agent framework
- 고급 vector search
- cloud deployment

이들은 후속 Slice 또는 Change Candidate로 기록할 수 있다.

---

# Phase 1 — Shape & PRD

먼저 현재 저장소와 Conceptual Design을 분석한다.

그 후 `PRD.md`를 작성하거나 기존 문서가 있으면 현재 MVP에 맞게 정리한다.

PRD에는 최소한 다음이 명확해야 한다.

- Purpose
- Target user
- MVP hypothesis
- Goals
- Non-goals
- Primary scenarios
- Functional Requirements
- Acceptance Criteria
- Relevant quality requirements
- Constraints
- Dependencies
- Open decisions

Requirements와 Acceptance Criteria에는 추적 가능한 ID를 사용한다.

예:

`FR-01`  
`FR-02`

`AC-01`  
`AC-02`

Acceptance Criteria는 반드시 **실행하거나 관찰해서 확인할 수 있는 상태**로 작성한다.

구현 세부사항을 PRD에 섞지 않는다.

PRD 작성 후 스스로 다음 질문을 검토한다.

> 이 MVP가 성공했을 때 사용자가 실제로 어떤 행동을 할 수 있는가?

> 이 MVP만으로 Nidus의 핵심 가설을 검증할 수 있는가?

> Conceptual Design 전체를 구현하려는 범위 팽창이 발생하지 않았는가?

문제가 있으면 PRD를 수정한 후 다음 단계로 이동한다.

---

# Phase 2 — Technical Design

PRD를 바탕으로 `DESIGN.md`를 작성한다.

현재 MVP에 필요한 만큼만 설계한다.

다음을 정의한다.

- System Boundary
- Runtime Units
- Responsibilities
- Data Ownership
- State Transitions
- Interfaces
- Failure Boundaries
- Permission Boundary
- Persistence
- Context Recovery
- Verification Strategy
- Local execution / development path

Conceptual Design에서 아직 미정인 기술은 여기에서 실제 MVP에 필요한 경우에만 결정한다.

예:

- 저장 방식
- Runtime process 구조
- Queue 필요 여부
- sandbox 방식
- model 호출 방식
- Local Agent Host 실행 방식

각 중요한 선택에서는 최소한 한 번 다음을 검토한다.

```text
Option A
Option B

왜 이번 MVP에서는 선택한 방법이 가장 단순한가?
나중에 교체 가능한가?
Conceptual Design을 침범하지 않는가?
```

필요 없는 abstraction이나 미래 확장용 infrastructure를 만들지 마라.

---

# Phase 3 — Implementation Gate

코딩을 시작하기 전에 다음 조건을 확인한다.

- Problem / user / outcome이 명확하다.
- MVP Scope와 Non-goal이 명확하다.
- Primary Flow가 정의되어 있다.
- Acceptance Criteria가 테스트 가능하다.
- 주요 책임과 데이터 소유권이 정해져 있다.
- 현재 Slice에 영향을 주는 critical unknown이 해결되었거나 명시적으로 수용되었다.
- 다음 Vertical Slice에 완료조건과 Verification 방법이 있다.

이 조건이 충족되지 않았다면 필요한 문서를 먼저 보완한다.

---

# Phase 4 — Create Execution Plan

다음 파일을 사용한다.

`docs/plans/current-plan.md`

없으면 생성한다.

전체 MVP를 한꺼번에 구현하지 말고 End-to-End Vertical Slice로 나눈다.

가능하면 첫 Slice는 아주 작은 실제 경로를 만든다.

예:

```text
Work Request 입력
→ Task 생성
→ Worker가 Task 읽기
→ 단순 Action 수행
→ Result 저장
→ Verification
→ Completed
```

그리고 이후 Slice에서 Context Recovery, Permission, Archive 등을 확장한다.

각 Slice에는 최소한 다음이 있어야 한다.

- Requirements / AC covered
- Expected changes
- Verification commands
- Done when
- Excluded
- Current status
- Git branch
- 관련 commit

---

# Git Development Workflow

Git은 단순한 최종 백업이 아니라 **MVP 개발 과정의 상태 관리와 복구 수단**으로 사용한다.

모든 구현 작업은 Git Branch와 Commit 단위로 추적한다.

## 1. 시작 전 Repository 상태 확인

작업 시작 전에 반드시 다음을 확인한다.

```bash
git status
git branch --show-current
git log --oneline --decorate -10
```

기존 사용자의 수정사항이 존재하면 임의로 삭제하거나 덮어쓰지 마라.

Uncommitted change가 있다면 그 내용을 확인하고 보존한다.

다음 명령을 사용자 허가 없이 사용하지 마라.

```bash
git reset --hard
git clean -fd
git checkout -- .
git restore .
```

기존 작업을 제거하는 명령은 금지한다.

---

## 2. Main / Develop에서 직접 구현 금지

`main` 또는 `develop`에서 직접 기능을 구현하지 마라.

저장소에 기존 Branch Convention이 있다면 그것을 우선한다.

별도의 Convention이 없다면 다음 구조를 기본으로 사용한다.

```text
main
└── develop
    └── feat/nidus-mvp
         ├── feat/task-lifecycle
         ├── feat/context-recovery
         ├── feat/security-check
         ├── feat/workshop-execution
         └── feat/task-archive
```

`feat/nidus-mvp`는 이번 MVP 개발을 모으기 위한 Integration Branch다.

처음 작업을 시작할 때 적절한 base branch에서 다음과 같은 MVP Branch를 만든다.

```bash
git switch develop
git switch -c feat/nidus-mvp
```

단, 저장소의 실제 branch 구조가 다르면 기존 Convention을 우선한다.

---

## 3. 기능 / Vertical Slice마다 새 Branch 사용

각 기능 또는 Vertical Slice는 별도의 Branch에서 구현한다.

예:

```text
feat/task-lifecycle
feat/context-recovery
feat/security-check
feat/workshop-execution
feat/task-verification
feat/task-archive
```

Branch는 가능한 한 **하나의 명확한 책임**만 가져야 한다.

새 Slice를 시작할 때:

```bash
git switch feat/nidus-mvp
git switch -c feat/<slice-name>
```

현재 Feature Branch가 끝나기 전에 관련 없는 다음 기능을 섞지 마라.

---

## 4. 작은 변경마다 Commit

하나의 Feature Branch 안에서도 모든 변경을 마지막에 한 번에 Commit하지 마라.

의미 있는 작은 변경마다 Commit한다.

좋은 Commit의 예:

```text
feat: add task domain model
feat: create completion contract schema
test: add task completion validation
feat: persist task state transitions
docs: document task lifecycle
fix: prevent completion before verification
```

나쁜 Commit의 예:

```text
update
work
changes
mvp implementation
lots of fixes
```

Commit은 다음 기준을 따른다.

**한 Commit = 하나의 논리적인 변경**

가능하면 다음 범위를 분리한다.

- data model
- domain logic
- persistence
- API / interface
- test
- documentation
- bug fix

단순히 파일 수가 적다는 이유가 아니라 **되돌렸을 때 하나의 의미 있는 변경이 취소되는 단위**로 Commit한다.

---

## 5. Commit 전 Verification

가능한 경우 Commit 전에 해당 변경에 가장 가까운 검증을 먼저 수행한다.

예:

```text
작은 코드 변경
→ 관련 unit test
→ 성공
→ commit

Vertical Slice 완료
→ 관련 test
→ typecheck
→ lint
→ end-to-end verification
→ commit
```

깨진 상태를 의도적으로 Commit하지 마라.

단, 장시간 작업 중 안전한 Checkpoint가 반드시 필요한 예외 상황이라면 다음과 같이 명확한 임시 Commit임을 표시한다.

```text
chore: checkpoint blocked task lifecycle implementation
```

이 경우 `current-plan.md`에도 현재 실패 상태를 기록한다.

---

## 6. Feature Branch 완료 조건

Feature Branch는 다음 조건이 충족되어야 완료된 것으로 본다.

- 해당 Slice의 구현 완료
- 담당 Acceptance Criteria 검증
- 관련 테스트 통과
- 문서와 실제 코드의 불일치 확인
- `current-plan.md` 업데이트
- 작업 tree가 예상 가능한 상태
- 의미 있는 Commit들이 생성됨

그 후 MVP Integration Branch로 통합한다.

---

## 7. Integration Branch

완료된 Feature Branch는 `feat/nidus-mvp`로 통합한다.

```text
feat/task-lifecycle
        ↓
feat/nidus-mvp

feat/context-recovery
        ↓
feat/nidus-mvp
```

통합 후 다시 관련 테스트를 실행한다.

다른 기능과 합쳐졌을 때 실패한다면 Integration Branch를 완료된 상태로 간주하지 마라.

Merge conflict가 발생하면 단순히 한쪽을 선택하지 말고 양쪽 변경의 의도를 확인한다.

Conceptual Design / PRD / DESIGN과 일치하는 방향으로 해결한다.

---

## 8. Integration 후 다음 Branch

Feature를 통합한 후 다음 Slice를 시작한다.

```text
feat/nidus-mvp
        ↓
새 feat/<slice>
        ↓
구현
        ↓
작은 commit 반복
        ↓
Verification
        ↓
feat/nidus-mvp로 통합
```

이 Cycle을 MVP가 완료될 때까지 반복한다.

---

## 9. Git과 current-plan 연결

`docs/plans/current-plan.md`에는 각 Slice의 Git 상태를 같이 기록한다.

예:

```text
## Slice 2 — Context Recovery

Status: In Progress

Branch:
feat/context-recovery

Requirements:
FR-04
FR-05

Acceptance Criteria:
AC-06
AC-07

Commits:
- abc1234 feat: add desk context loader
- def5678 feat: reconcile task state during recovery

Verification:
- pytest tests/context
- npm run typecheck

Done when:
Context Recovery AC-06 / AC-07 pass.
```

Git History만 봐도 개발 흐름을 추적할 수 있고,

`current-plan.md`만 봐도 어떤 Branch와 Commit이 어떤 Slice에 대응하는지 알 수 있어야 한다.

---

## 10. Commit History 품질 유지

다음 상황은 피한다.

```text
30개의 서로 다른 변경 → 하나의 commit
```

또한 의미 없는 수준으로 지나치게 잘게 쪼개지도 않는다.

```text
파일 한 줄 수정
→ commit

변수명 한 번 변경
→ commit
```

기준은 항상:

> **이 Commit 하나만 읽거나 되돌려도 하나의 논리적 변경을 이해할 수 있는가?**

이다.

---

## 11. Push / PR / Merge 제한

Local Commit은 적극적으로 사용한다.

하지만 다음 작업은 사용자가 명시적으로 지시하지 않는 한 수행하지 않는다.

- Remote push
- Pull Request 생성
- `main` merge
- `develop` merge
- Remote branch 삭제
- Release / tag 생성

즉 Codex가 자율적으로 관리하는 최대 범위는 기본적으로:

```text
Local Feature Branch
↓
Local MVP Integration Branch
```

까지다.

사용자가 돌아온 후 검토할 수 있도록 한다.

---

# Phase 5 — Autonomous Implementation Loop

다음 Loop를 반복한다.

```text
LOOP

1. current-plan.md 확인

2. 아직 완료되지 않은 가장 앞의 Vertical Slice 선택

3. feat/nidus-mvp를 최신 기준으로 확인

4. 해당 Slice 전용 feat/<slice-name> branch 생성

5. 관련 PRD / DESIGN / Conceptual Design 확인

6. Slice 구현

7. 의미 있는 작은 변경 단위마다:
   - 관련 검증
   - git diff 확인
   - commit 작성

8. 가능한 가장 좁은 테스트 실행

9. build / typecheck / lint 등 필요한 검증 실행

10. 해당 Slice가 담당하는 Acceptance Criteria 확인

11. 실패하면 원인을 분석하고 수정

12. 다시 검증

13. 통과하면:
    - current-plan.md 업데이트
    - 필요한 안정 문서 업데이트
    - 중요한 Decision 기록
    - 새로운 요구사항은 Change Candidate로 기록
    - 마지막 Slice Commit 작성

14. feat/nidus-mvp로 통합

15. 통합된 상태에서 다시 테스트

16. 성공하면 다음 Slice 선택

17. 모든 MVP Acceptance Criteria가 충족될 때까지 반복
```

단순히 코드가 생성되었다는 이유로 Slice를 완료 처리하지 마라.

**Acceptance Criteria + Verification이 통과해야 완료다.**

---

# Failure Loop

동일한 문제에 대해 의미 있는 진전 없이 반복해서 수정하지 마라.

같은 실패 원인을 대략 3번 이상 해결하지 못한 경우:

1. 현재 변경을 안전하게 보존한다.
2. 가능하면 Checkpoint Commit을 남긴다.
3. 실패한 명령과 결과를 기록한다.
4. 가능한 원인을 정리한다.
5. `docs/plans/current-plan.md`를 업데이트한다.
6. 정말 인간 판단이 필요한 경우 `BLOCKED.md`를 작성한다.
7. 안전한 다른 Slice가 독립적으로 존재하면 진행할 수 있다.
8. 그렇지 않으면 중단한다.

실패를 성공으로 간주하지 마라.

실패를 숨기기 위해 테스트를 삭제하거나 Acceptance Criteria를 완화하지 마라.

---

# Change Control

구현 중 좋은 아이디어를 발견했다고 바로 구현하지 마라.

현재 PRD에 없는 기능은 우선:

`Change Candidate`

로 기록한다.

다음 중 하나가 아니라면 현재 MVP Scope에 넣지 않는다.

- 현재 Acceptance Criteria 달성에 필수
- 보안 또는 데이터 무결성에 필수
- 현재 구현을 실제로 작동시키기 위해 필수

“있으면 좋다” 수준의 기능은 구현하지 마라.

---

# Security / Permission Rules

사용자가 자리를 비운 상태라고 해서 권한 범위를 확대하지 마라.

저장소 내부의 일반적인 개발 작업과 테스트는 진행한다.

다음 작업은 Hard Stop 대상으로 본다.

- 사용자 파일의 대규모 삭제
- 저장소 밖의 중요한 파일 수정
- Secret 또는 Credential 노출
- 임의의 유료 서비스 생성
- 실제 결제
- Production 배포
- 외부 사용자에게 데이터 전송
- 파괴적인 DB migration
- OS 수준의 위험한 설정 변경
- 현재 프로젝트와 무관한 시스템 변경
- Git history를 파괴하는 작업

다음 Git 작업도 사용자 승인 없이 수행하지 않는다.

```text
force push
history rewrite
rebase로 기존 공유 history 변경
reset --hard
remote branch 삭제
main / develop 강제 변경
```

Secret이 필요한 경우 fake / mock / local configuration으로 구현 가능한 부분까지 진행한다.

---

# Decision Policy

사소한 기술 결정 때문에 사용자에게 질문하지 마라.

다음 우선순위를 따른다.

1. 기존 repository convention
2. Conceptual Design
3. PRD
4. DESIGN
5. 가장 단순한 구현
6. 쉽게 교체 가능한 구현

하지만 다음과 같이 이후 구조를 크게 뒤집을 수 있는 결정은 임의로 확정하지 않는다.

- 제품 Scope 변경
- Conceptual Architecture 변경
- 데이터 손실 가능성이 있는 선택
- 외부 서비스 비용 발생
- 보안 모델 변경
- 사용자 승인 정책 변경

이 경우 현재 진행상황을 checkpoint하고 `BLOCKED.md`에 필요한 결정만 명확하게 기록한다.

---

# Documentation Reconciliation

각 Slice가 끝날 때 코드와 문서를 비교한다.

코드가 PRD와 다르면 코드에 맞춰 PRD를 조용히 수정하지 마라.

먼저 차이가 다음 중 무엇인지 판단한다.

- Implementation bug
- Design refinement
- New requirement
- Scope change

Implementation bug라면 코드를 수정한다.

Technical reality 때문에 DESIGN이 달라졌다면 DESIGN을 업데이트한다.

Product behavior가 바뀌어야 한다면 Change Candidate로 남긴다.

문서 변경도 구현 변경과 마찬가지로 의미 있는 Commit으로 기록한다.

예:

```text
docs: align design with task persistence implementation
docs: record sandbox architecture decision
```

---

# MVP Completion Gate

다음 조건이 모두 충족되었을 때만 MVP를 완료로 선언한다.

- 모든 P0 Acceptance Criteria가 충족되었다.
- 관련 테스트가 통과한다.
- 실제 End-to-End primary flow를 실행할 수 있다.
- 실패 상태가 성공으로 숨겨져 있지 않다.
- PRD와 실제 구현이 일치한다.
- DESIGN과 실제 구조가 일치한다.
- current-plan의 MVP Slice가 완료되었다.
- Known limitation이 기록되어 있다.
- 모든 완료 Feature Branch가 `feat/nidus-mvp`에 통합되어 있다.
- Integration 상태에서 전체 MVP Verification이 통과한다.
- Git working tree에 설명되지 않은 변경이 남아 있지 않다.

`main` 또는 `develop`에는 자동 merge하지 않는다.

---

# Final Git State

MVP 완료 시 이상적인 상태는 다음과 같다.

```text
main
│
develop
│
└── feat/nidus-mvp
      ├─ task lifecycle commits
      ├─ context recovery commits
      ├─ security commits
      ├─ workshop commits
      ├─ verification commits
      └─ documentation commits
```

완료된 개별 Feature Branch는 삭제하지 않아도 된다.

사용자가 돌아온 후 Branch와 Commit History를 검토할 수 있도록 보존한다.

---

# Final Deliverable

MVP 완료 또는 Hard Stop 시 다음 파일을 작성한다.

`MVP_REPORT.md`

다음을 포함한다.

```text
# MVP Result

## Status
COMPLETED | PARTIAL | BLOCKED

## What works

## End-to-End Flow

## Acceptance Criteria Results

## Verification Evidence

## Architecture Decisions

## Git Summary
- MVP integration branch
- Feature branches
- Important commits
- Current git status

## Files / Components Created

## Known Limitations

## Deferred Change Candidates

## Blockers

## How to Run

## How to Test

## Recommended Next Slice
```

마지막으로 다음을 확인한다.

```bash
git status
git branch
git log --oneline --graph --decorate --all
```

그리고 `MVP_REPORT.md`에 현재 Git 상태를 정확히 기록한다.

---

# Core Rule

가장 중요한 원칙은 다음이다.

> **Do not maximize implementation. Maximize validated progress.**

그리고 Git에서는:

> **Do not maximize commit size. Preserve understandable development history.**

Nidus 전체를 구현하려 하지 마라.

현재 MVP의 핵심 가설을 검증할 수 있는 가장 작은 시스템을 만들고,

각 Vertical Slice를 별도의 Feature Branch에서 구현하고,

의미 있는 작은 변경마다 검증 가능한 Commit을 남기며,

완료된 Slice만 MVP Integration Branch에 통합하라.

지금부터 저장소를 분석하고 Phase 1부터 시작하라.

사용자에게 계획만 설명하고 멈추지 말고, 가능한 범위에서 PRD 작성부터 Branch 생성, MVP 구현, 테스트, Commit, Integration, 최종 검증까지 계속 진행하라.