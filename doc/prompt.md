# 목표

현재 Nidus 저장소에 **관리자 → 작업자 → 관리자 검토 → 완료/재작업/사람 판단**으로 이어지는 핵심 업무 순환을 구현하라.

이번 작업의 목적은 새로운 “검증 전용 객체”를 만드는 것이 아니다.

Nidus에서 검토 역시 하나의 업무이며,
**관리자가 작업의 완료 기준을 정의하고, 작업자는 그 기준을 보며 수행하고, 관리자가 최종적으로 그 결과를 검토하는 조직적 책임 구조**를 구현하는 것이 목표다.

현재까지 구현된 Runtime, Model Gateway, 권한 승인, 결정적 검증, Archive, Git, Gemini/NVIDIA/Copilot Provider Pool을 최대한 재사용하라.

---

# 핵심 원칙

Nidus의 기본 업무 흐름을 다음과 같이 만든다.

```text
사용자 요청
↓
관리자
↓
작업 정의
+ 완료 기준 작성
+ 제약 정의
↓
작업자에게 배정
↓
작업자 작업 수행
↓
작업자 자기 점검
↓
결과 제출
↓
기존 결정적 검증
↓
관리자 검토
├─ 승인
├─ 재작업 요청
└─ 사람 판단 요청
```

승인된 경우에만 최종적으로:

```text
Completed
→ Archive
```

된다.

---

# 중요한 설계 원칙

## 1. 별도의 검증 객체를 만들지 않는다

다음과 같은 구조를 만들지 마라.

```text
Worker
→ Verifier
→ Verifier of Verifier
→ ...
```

검토는 관리자 역할의 일부다.

관리자는 자신의 검토 결과를 또 다른 자동 검토 객체에게 전달하지 않는다.

관리자의 책임 경계는 다음과 같다.

```text
검토 가능
→ 승인 또는 재작업

판단 불가능
→ 사람에게 전달
```

이 지점이 자동 업무 흐름의 책임 종료점이다.

---

# 2. 결정적 검증은 기존대로 유지한다

기존 Nidus가 코드로 확실하게 확인할 수 있는 검증은 제거하지 않는다.

예:

```text
원문 변경 여부
결과 파일 존재 여부
후보 결과와 파일 일치 여부
해시 일치
응답 정상 종료
필수 문자열
권한 승인
전송 승인
```

이러한 검증은 인공지능 판단이 아니라 프로그램의 결정적 확인이다.

따라서 새로운 관리자 검토와 별도로 유지한다.

전체 구조는:

```text
결정적 안전 확인
+
관리자의 업무 품질 검토
```

가 된다.

---

# 3. 완료 기준은 작업 생성 시점에 만들어진다

관리자는 작업자를 호출하기 전에 반드시 작업 계약을 만든다.

최소한 다음을 포함한다.

```text
작업 목적

작업 범위

완료 기준 목록

제약 조건

사용 가능한 자료

예상 결과물

사람의 판단이 필요한 조건
```

예:

```json
{
  "goal": "주어진 문서를 세 개의 핵심 항목으로 요약한다.",
  "completion_criteria": [
    {
      "id": "C1",
      "description": "정확히 세 개의 핵심 항목을 작성한다."
    },
    {
      "id": "C2",
      "description": "모든 사실은 제공된 자료에 근거해야 한다."
    },
    {
      "id": "C3",
      "description": "제공되지 않은 새로운 사실을 추가하지 않는다."
    }
  ],
  "constraints": [
    "원본 자료를 수정하지 않는다.",
    "승인되지 않은 외부 자료를 사용하지 않는다."
  ]
}
```

구체적인 저장 구조와 자료형은 현재 코드 구조를 보고 적절하게 결정하라.

---

# 4. v1에서는 완료 기준을 임의로 복잡하게 자동 생성하지 않는다

이번 구현의 핵심은 업무 순환이다.

거대한 계획 생성 체계를 새로 만들지 마라.

관리자가 생성형 모델을 이용해 완료 기준을 만들 수는 있지만,
결과는 명시적인 작업 계약으로 저장되어야 한다.

필요하다면 사용자 요청과 간단한 기본 원칙을 바탕으로 관리자가 완료 기준을 작성하게 하라.

현재 구조상 자동 생성이 너무 큰 변경이라면
테스트와 명시적 입력을 통해 계약을 제공할 수 있도록 먼저 구현해도 된다.

다만 최종 업무 흐름에서는 작업자가 반드시 완료 기준을 전달받아야 한다.

---

# 5. 작업자는 완료 기준을 보고 작업한다

작업자에게 전달되는 작업 문맥에는 최소한 다음이 포함되어야 한다.

```text
사용자의 원래 요청
작업 목적
완료 기준
제약 조건
선택된 자료
```

작업자의 지침에는 다음 원칙을 포함한다.

```text
완료 기준을 작업 시작 전에 읽는다.

결과를 만들 때 완료 기준을 계속 참고한다.

기준을 충족할 수 없는 경우 사실을 만들어내지 않는다.

확실하지 않은 내용은 확실한 것처럼 표현하지 않는다.

완료했다고 주장하기 전에 각 완료 기준을 스스로 점검한다.
```

---

# 6. 작업자 제출에는 자기 점검을 포함한다

작업자는 단순히 결과 텍스트만 반환해서는 안 된다.

개념적으로 다음과 같은 제출 구조를 만든다.

```json
{
  "result": "...",
  "self_check": [
    {
      "criterion_id": "C1",
      "status": "satisfied",
      "reason": "..."
    },
    {
      "criterion_id": "C2",
      "status": "satisfied",
      "reason": "..."
    }
  ],
  "known_limitations": [],
  "questions": []
}
```

실제 자료형은 현재 구현과 잘 맞도록 변경할 수 있다.

작업자의 자기 점검은 참고 자료일 뿐,
최종 완료 판정으로 사용하지 않는다.

---

# 7. 관리자가 결과를 검토한다

관리자에게 다음 정보를 제공한다.

```text
사용자의 원래 요청
작업 계약
완료 기준
작업 결과
작업자의 자기 점검
사용된 자료
필요한 실행 기록
```

관리자의 검토 지침은 최소한 다음 내용을 포함해야 한다.

```text
1. 완료 기준을 하나씩 확인한다.

2. 작업자의 자기 점검을 그대로 신뢰하지 않는다.

3. 작업 결과가 완료 기준을 실제로 충족하는지 독립적으로 판단한다.

4. 사용자의 원래 요청을 다시 읽고,
   완료 기준에 명시되지 않았지만 중요한 요구가 빠지지 않았는지 확인한다.

5. 잘못된 가정, 누락, 모순, 불필요한 추가 내용,
   요청과 다른 결과가 없는지 확인한다.

6. 문제가 있다면 무엇이 문제인지 구체적으로 작성한다.

7. 불확실하거나 사람의 가치 판단이 필요한 문제를 임의로 결정하지 않는다.
```

---

# 8. 관리자 판정

관리자의 최종 판정은 세 가지로 제한한다.

```text
APPROVE
REWORK
ESCALATE
```

내부 이름은 현재 코드 규칙에 맞게 정할 수 있다.

의미는 다음과 같다.

### APPROVE

```text
모든 중요한 완료 조건을 충족했다.
추가적인 중대한 누락도 발견되지 않았다.
```

→ 최종 완료 가능.

### REWORK

```text
수정 가능한 문제가 존재한다.
```

반드시 구체적인 수정 지시를 포함한다.

예:

```json
{
  "decision": "rework",
  "issues": [
    "두 번째 항목은 원문 근거가 부족하다.",
    "사용자가 요구한 세 번째 조건이 누락되었다."
  ],
  "instructions": [
    "두 번째 항목을 원문 근거에 맞게 수정한다.",
    "누락된 조건을 추가한다."
  ]
}
```

### ESCALATE

```text
현재 정보나 권한만으로 관리자가 책임 있게 판단할 수 없다.
사람의 판단이 필요하다.
```

사람에게 전달할 질문과 이유를 포함한다.

---

# 9. 재작업 순환

REWORK가 나오면 Task를 실패로 종료하지 않는다.

다시 작업자에게 돌려보낸다.

```text
Worker
↓
Manager Review
↓
REWORK
↓
Worker
↓
Manager Review
↓
...
```

작업자에게는 이전 결과와 관리자의 수정 지시를 전달한다.

기존 결과를 무시하고 처음부터 무작정 다시 생성하게 하지 말고,
가능하면 다음 정보를 활용한다.

```text
기존 결과
관리자 지적 사항
수정 지시
완료 기준
원래 요청
```

재작업 횟수도 기록한다.

무한 반복을 방지하기 위해 명시적인 최대 반복 횟수를 둔다.

초기값은 코드와 테스트에 적절한 작은 값으로 설정하되
정책 또는 설정으로 변경 가능하게 만드는 것을 우선한다.

반복 한도를 넘으면:

```text
ESCALATE
```

또는 명확한 사람 판단 대기 상태로 전환한다.

자동으로 Completed 처리하지 않는다.

---

# 10. 사람 판단

관리자가 ESCALATE를 선택하거나 재작업 한도를 초과하면
기존 Meeting Room / Waiting 개념을 활용한다.

사람에게 최소한 다음을 보여준다.

```text
원래 요청
현재 결과
완료 기준
작업자의 자기 점검
관리자의 판단
관리자가 판단하지 못한 이유
선택 가능한 행동
```

가능한 사람 결정의 최소 형태:

```text
승인
재작업
취소
```

현재 CLI 구조와 기존 decide 명령을 최대한 재사용하되,
기존 권한 승인과 업무 품질 판단이 혼동되지 않도록
결정 종류 또는 문맥을 명확히 구분한다.

---

# 11. 상태 폭증을 피한다

새로운 상태를 무분별하게 추가하지 마라.

가능하면 현재 상태 체계를 유지한다.

```text
Queued
Running
Waiting
Verifying
Blocked
Completed
Cancelled
```

대신 Task 내부에 현재 업무 단계를 명시할 수 있다.

예:

```text
workflow_stage:
- manager_planning
- worker_execution
- worker_self_check
- manager_review
- rework
- human_review
- done
```

구체적인 이름과 저장 방식은 현재 코드와 테스트를 검토해서 결정하라.

상태와 업무 단계를 혼동하지 않도록 설계한다.

---

# 12. 역할과 정체성

이번 v1에서는 완전한 다중 직원 조직을 만들 필요가 없다.

최소한 두 책임을 구분할 수 있으면 된다.

```text
Manager
Worker
```

직원 정체성과 실제 사용 모델은 분리한다.

예를 들어:

```text
Manager
→ Gemini 사용 가능

Worker
→ Gemini 사용 가능
```

하더라도 둘은 다른 역할이다.

반대로 정책상 가능하다면:

```text
Worker → Gemini
Manager → NVIDIA
```

처럼 다른 모델을 사용할 수도 있다.

하지만 특정 Provider를 코드에 고정하지 마라.

역할과 모델 선택은 분리한다.

---

# 13. 시스템 지침

이번 구조의 핵심은 역할별 지침이다.

관리자 지침과 작업자 지침을 코드에서 명시적으로 분리하라.

## 관리자 지침의 책임

```text
작업 정의
완료 기준 작성
업무 범위 설정
결과 검토
누락 탐색
재작업 지시
사람 판단 요청
최종 승인 책임
```

## 작업자 지침의 책임

```text
주어진 작업 수행
완료 기준 준수
제약 준수
자료 기반 작업
자기 점검
한계 보고
```

관리자와 작업자가 동일한 지침을 공유하는 구조로 만들지 마라.

---

# 14. 기존 Model Gateway 재사용

새로운 외부 모델 계층을 만들지 않는다.

현재 구현된 Provider-neutral Model Gateway를 재사용한다.

역할마다 다른 호출 문맥과 정책을 사용할 수 있도록 필요한 최소 확장만 한다.

기존:

```text
Gemini
NVIDIA NIM
Copilot
Fallback
```

지원과 안전 경계를 깨지 마라.

Provider 호출 오류 정책도 그대로 유지한다.

---

# 15. 전송 승인

작업자 호출과 관리자 검토가 외부 모델을 사용한다면
둘 다 외부 데이터 전송이라는 사실을 고려한다.

기존 Security 경계를 우회하지 않는다.

다만 동일 Task의 같은 자료에 대해
불필요하게 반복 승인을 요구하지 않는 안전한 방법이 현재 구조와 잘 맞는다면
정확한 승인 범위 안에서 재사용할 수 있다.

승인 범위가 달라지거나 새로운 자료가 추가되면
기존 승인 무효화 원칙을 유지한다.

---

# 16. 완료 판정

최종 Completed 조건을 명확하게 한다.

최소한:

```text
작업자 결과 존재

작업자 자기 점검 존재

기존 결정적 검증 PASS

관리자 최종 판정 APPROVE

현재 결과가 관리자 승인 당시의 결과와 동일함
```

이 모두 충족되어야 Completed가 가능하다.

관리자가 승인한 뒤 결과가 바뀌었다면 승인은 무효다.

---

# 17. 관리자 판단 자체를 또 검증하지 않는다

다음 구조를 절대 만들지 않는다.

```text
Manager Review
→ Review Verifier
→ Review Review Verifier
```

관리자는 조직상의 책임 종료점이다.

관리자가 확신하지 못하면 사람에게 올린다.

```text
Manager
├─ 책임 있게 승인 가능 → APPROVE
├─ 수정 가능 → REWORK
└─ 책임 있게 판단 불가 → ESCALATE
```

이 원칙을 문서와 코드에 명확하게 남긴다.

---

# 18. 핵심 실험 시나리오

이번 Slice에서는 실제 업무 순환을 검증해야 한다.

최소 다음 시나리오를 테스트한다.

## 시나리오 A — 정상 완료

```text
Manager
→ 완료 기준 생성

Worker
→ 정확한 결과
→ 자기 점검

Manager
→ APPROVE

Deterministic checks
→ PASS

Completed
→ Archive
```

---

## 시나리오 B — 작업자 결과 오류

의도적으로 완료 기준 하나를 위반하는 결과를 만든다.

예:

```text
세 항목 요청
→ 작업자가 두 항목만 제출
```

기대:

```text
Manager
→ REWORK
```

Completed가 되어서는 안 된다.

---

## 시나리오 C — 재작업 성공

```text
첫 결과
→ REWORK

수정 지시
→ Worker

두 번째 결과
→ Manager APPROVE

Completed
```

재작업 이력 전체가 남아야 한다.

---

## 시나리오 D — 관리자 판단 불가능

불충분한 자료 또는 사람의 가치 판단이 필요한 테스트를 만든다.

기대:

```text
Manager
→ ESCALATE
→ Waiting for human
```

Completed가 되어서는 안 된다.

---

## 시나리오 E — 반복 한도

반복적으로 기준을 충족하지 않는 작업을 만든다.

기대:

```text
REWORK
→ REWORK
→ ...
→ limit
→ human review
```

무한 호출이 발생하면 안 된다.

---

## 시나리오 F — 승인 후 결과 변경

관리자가 승인한 결과를 완료 전에 변경한다.

기대:

```text
Manager approval invalidated
→ Completed 금지
```

---

# 19. 실제 모델 검증

오프라인/가짜 Adapter 테스트와 실제 모델 테스트를 구분한다.

먼저 결정적인 테스트로 업무 순환을 충분히 검증한다.

그 이후 합성 공개 자료를 이용해 실제 Provider Pool로 최소 하나의 전체 흐름을 검증한다.

예:

```text
Manager → Gemini

Worker → Gemini 또는 NVIDIA

Manager Review → Gemini 또는 NVIDIA
```

특정 조합을 강제하지 않는다.

현재 실제 접근 가능한 모델과 비용/안전 범위를 보고 선택한다.

실제 개인 자료를 사용하지 않는다.

---

# 20. 실행 증거

기존 `docs/evidence/` 방식을 재사용한다.

실제 전체 업무 순환 증거에는 최소 다음이 남아야 한다.

```text
원래 요청

완료 기준

관리자 작업 정의

작업자 결과

작업자 자기 점검

관리자 검토

관리자 판정

재작업 이력

사용한 모델/경로

결정적 검증 결과

최종 상태

Active / Archive
```

Secret은 기록하지 않는다.

---

# 21. Git 작업 흐름

현재 저장소의 최신 정책을 따른다.

`main`을 유일한 통합 브랜치로 사용한다.

최신 main에서 짧은 작업 브랜치를 만든다.

권장:

```text
feat/core-workflow
```

또는 의미가 더 분명하다면:

```text
feat/manager-worker-loop
```

중 하나를 선택한다.

불필요한 장기 통합 브랜치를 만들지 않는다.

작은 논리 단위로 Commit한다.

예:

```text
feat: persist completion checklist and workflow stage

feat: add worker self-check submission

feat: add manager review decisions

feat: implement bounded rework loop

test: verify manager-worker lifecycle

docs: document core Nidus workflow
```

작업 완료 후에도 Remote push 또는 PR은 사용자 요청 없이 수행하지 않는다.

---

# 22. 기존 회귀 유지

현재 회귀 기준을 깨뜨리지 않는다.

최소한 기존:

```text
37 offline tests
3 local HTTP integration tests
compileall
git diff --check
```

가 모두 통과해야 한다.

새로운 핵심 업무 순환 테스트도 추가한다.

기존 Copilot/Gemini/NVIDIA Live Evidence는 수정하지 않는다.

---

# 23. 문서 갱신

이번 구현은 Nidus의 핵심 개념을 실제로 코드화하는 중요한 단계다.

따라서 최소한 다음을 갱신한다.

```text
PRD.md
DESIGN.md
docs/CONCEPT.md
docs/VALIDATION.md
docs/plans/current-plan.md
README.md
```

특히 `docs/CONCEPT.md`에는 다음 책임 구조가 명확하게 표현되어야 한다.

```text
Manager
→ Task Definition
→ Completion Contract
→ Assignment

Worker
→ Execution
→ Self Check
→ Submission

Manager
→ Review
→ Approve / Rework / Escalate
```

단, 장기 개념 설계 전체가 구현됐다고 과장하지 않는다.

---

# 범위 밖

이번 Slice에서 다음을 구현하지 마라.

```text
완전한 다중 Worker 조직
Group Manager 계층 전체
Lead Manager
Red Team
JEV
자동 역할 생성
복잡한 장기 계획
Tool execution
Browser automation
GUI
Streaming
Responses API 전환
여러 검토자의 다수결
검증 전용 객체
무한 자기 수정
```

필요한 기반 인터페이스 정도는 열어둘 수 있지만
이번 완료 조건에는 포함하지 않는다.

---

# 완료 기준

이번 작업은 다음을 모두 충족할 때 완료로 선언한다.

1. 관리자가 작업 계약과 완료 기준을 정의할 수 있다.
2. 작업자가 완료 기준을 전달받고 작업한다.
3. 작업자가 결과와 자기 점검을 제출한다.
4. 기존 결정적 검증이 유지된다.
5. 관리자가 결과를 독립적으로 검토한다.
6. 관리자가 APPROVE / REWORK / ESCALATE 중 하나를 반환한다.
7. APPROVE 전에는 Completed가 불가능하다.
8. REWORK 시 수정 지시와 함께 작업자에게 다시 전달된다.
9. 재작업 이력이 보존된다.
10. 무한 재작업을 막는 한도가 있다.
11. ESCALATE 시 사람 판단 대기로 이동한다.
12. 관리자 승인 이후 결과 변경 시 승인이 무효화된다.
13. 정상 흐름이 Completed → Archive까지 실제 통과한다.
14. 기존 Security / Gateway / Archive / Git 경계를 유지한다.
15. 기존 회귀와 새 테스트가 모두 통과한다.
16. 실제 공개용 합성 자료를 이용한 전체 업무 순환 증거가 최소 하나 있다.
17. 문서와 실제 코드가 같은 구조를 설명한다.

---

# 최종 보고

작업 완료 후 다음을 정리한다.

```text
Status

Architecture changes

Manager responsibility

Worker responsibility

Completion Contract structure

Worker self-check structure

Manager review structure

Rework loop

Human escalation

State / workflow-stage changes

Security implications

Model usage

Actual end-to-end evidence

Regression tests

Git commits

Known limitations

Recommended next step
```

---

# 가장 중요한 원칙

이번 구현의 핵심은 다음 문장이다.

> Nidus에서 완료란 인공지능이 결과를 생성한 순간이 아니라,
> 관리자가 사전에 정의된 완료 기준과 사용자의 원래 요청을 기준으로
> 작업자의 결과를 검토하고 승인한 순간이다.

검증 전용 인공지능 객체를 만들지 마라.

대신 조직의 책임을 코드로 구현하라.

```text
관리자가 정의한다.
작업자가 수행한다.
작업자가 스스로 점검한다.
관리자가 검토한다.
문제가 있으면 다시 수행한다.
관리자도 판단할 수 없으면 사람에게 묻는다.
승인된 결과만 완료된다.
```

이 흐름이 Nidus의 기본 업무 순환이 되도록 구현하라.

계획만 작성하고 멈추지 말고,
현재 저장소를 먼저 분석한 뒤
설계 → 구현 → 결정적 테스트 → 실제 합성 작업 검증 → 문서화 → Commit까지
안전하게 수행하라.