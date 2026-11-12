# 3단계 설계 — AI Office

상태: **3a 구현 중** (2026-11-12).

[CONCEPT.md](CONCEPT.md)의 AI Office를 단계적으로 만든다. 1단계 [Model Gateway](STAGE1_MODEL_GATEWAY.md)가 역할과 난이도별로 모델을 고르고, 2단계 [Agent Workspace](STAGE2_AGENT_WORKSPACE.md)가 Worker가 일하는 VM과 브라우저를 준다. 3단계는 그 위에 일을 나누고 맡기고 검토하는 조직을 올린다.

## 3a. 작업 지시 구조

사용자는 Main에게 지시한다. Main은 계획을 세우고 필요한 것을 묻는다. 사용자가 계획을 승인하면 팀의 Manager가 Task를 Worker에게 맡기고 결과를 검토한다. 끝나면 Main이 보고하고, 사용자는 바뀐 내용을 보고 Vault에 들일지 정한다.

```text
사용자 ── 지시 ──▶ Main ── 로드맵 · 팀 · Task(Completion Contract) · 질문
   ▲                │
   └── 답 · 덧붙임 ─┘  (Main이 계획을 고친다. 몇 번이든)
사용자 ── 계획 승인 ──▶ 실행: Task를 의존성 순서로 하나씩
                         Manager ── Worker 지시서 · 난이도
                         Worker  ── VM 작업 공간에서 수행
                         Manager ── 완료 조건으로 검토: 통과 / 수정 요청 / 진행 불가
                       ──▶ Main 최종 보고 ──▶ 결과 검토(diff) ──▶ 승인하면 브랜치 nidus/<작업>
```

### 결정 (사용자, 2026-11-12)

| 항목 | 결정 |
|---|---|
| 팀 구성 | Main이 요청마다 필요한 팀(최대 4)을 정한다. CONCEPT의 상설 Group은 Library·Home과 함께 나중에 붙인다 |
| 실행 방식 | 한 번에 한 Worker. 모든 Task가 한 작업 공간과 한 브라우저를 순서대로 쓴다 |
| 계획 승인 | 질문에 답하고 사용자가 계획을 승인해야 실행한다. 답하지 않은 질문은 Main이 판단한다 |
| Lead Manager | 지금은 Main이 겸한다(Task 순서와 팀 간 넘겨주기는 계획의 의존성으로 표현). 병렬 실행을 붙일 때 분리한다 |

### 역할과 모델

| 역할 | 하는 일 | 도구 | 모델 배정 슬롯 |
|---|---|---|---|
| Main | 계획(요약, 로드맵, 팀, Task, 질문), 계획 수정, 최종 보고 | 없음 (텍스트) | `roles.main` |
| Manager | Task마다 Worker 지시서와 난이도 결정, 결과 검토 | 없음 (텍스트) | `roles.manager` |
| Worker | 실제 수행 | 작업 공간 도구(2e) | `worker.<난이도>` — 난이도는 Manager가 정한다 |

Main과 Manager의 답은 JSON으로 받는다. 형식이 틀리면 이유를 알려 한 번 더 받는다.

**Provider 오류**: 모든 역할의 모델 호출은 같은 규칙을 따른다. 일시적인 오류(속도 제한 429, 서버 오류, 네트워크, 시간 초과 5분)를 낸 모델은 90초 동안 쉬게 하고, 같은 슬롯의 다음 후보로 곧바로 바꾼다(역할 사이 공유: Main이 막힌 모델은 Manager도 피한다). 후보가 없으면 속도 제한은 15·30·60·90·120초, 그 밖의 오류는 5·15초 기다려 다시 시도한다. Gemini 무료 등급은 모델마다 할당량이 따로라, 같은 Provider의 다른 모델도 좋은 예비 후보다. 무료 등급 하나로 모든 역할을 맡기면 속도 제한에 자주 걸리므로, 슬롯마다 다른 Provider의 후보를 하나씩 두는 것이 좋다.

### Task Board

CONCEPT의 Task Board를 요청(Project) 단위로 둔다. `.nidus/local/board/<프로젝트>.json`.

- Project: 지시, 상태(`planning`, `waiting_user`, `running`, `reviewing`, `done`, `stopped`, `failed`), 요약, 로드맵, 팀, Task, 질문과 답, Main의 계획 대화, 최종 보고, 작업 공간 이름.
- Task: 팀, 제목, **Completion Contract**(Goal, Scope, Constraints, Acceptance Criteria, Verification), 의존 Task, 상태(`pending`, `in_progress`, `review`, `done`, `blocked`, `skipped`), 난이도, 지시서, 시도 수, 검토 기록, **Result**(요약, 검증 방법).
- 계획은 검사한다: 팀이 있는지, id가 겹치지 않는지, 의존 Task가 있는지, 의존성에 순환이 없는지, 완료 조건이 하나 이상인지.

### 실행

- 계획을 승인하면 VM을 켜고(꺼져 있으면) Vault의 커밋된 상태로 작업 공간을 하나 만든다. 모든 Task가 그 작업 공간에서 이어서 일한다.
- 준비된 Task(의존 Task가 모두 완료)를 계획 순서대로 하나씩 실행한다.
- Task마다 새 Worker 대화로 시작한다. Manager의 검토 근거는 Worker의 요약, 도구 호출 기록(최근 40개), Task 시작 커밋 이후의 커밋·파일 증감·diff(15KB까지)다.
- 수정 요청은 같은 Worker 대화에 이어서 준다. Worker가 중간에 멈췄거나 실패했으면 새 대화로, 작업 공간에 남은 것을 확인하고 이어 가라고 준다.
- 한 Task는 최대 3번 시도한다(처음 + 수정 2번). 그래도 통과하지 못하면 진행 불가(`blocked`)다. 진행 불가 Task에 의존하는 Task는 건너뛴다(`skipped`).
- 모든 Task가 끝나면 Main이 최종 보고를 쓰고, 작업 공간의 변경이 결과 검토로 올라온다(2d와 같다).
- 중지하면 진행 중이던 Task는 처음부터 다시 하게 표시되고, "이어서 진행"으로 남은 Task부터 계속한다. 앱을 다시 켜도 이어 갈 수 있다.

### 앱

작업 탭의 지시 칸에서 받는 쪽을 고른다: **Main에게**(기본) 또는 **Worker에게**(2e의 단일 Worker). Main에게 지시하면 프로젝트 패널이 나온다: 계획 요약, 로드맵, 팀별 Task(펼치면 Completion Contract, 결과, 검토 의견), Main의 질문과 답 칸, 덧붙일 말, "답변 보내기"·"계획 승인하고 시작"·"중지"·"이어서 진행"·"닫기". 진행 기록에는 Main과 Manager의 말(계획, Worker 지시, 검토, 최종 보고)이 Worker의 도구 호출과 함께 나온다.

## 다음

- Library·Home·Desk: 팀과 Agent의 지속 정체성, 작업 맥락 복구.
- 병렬 실행과 Lead Manager 분리.
- Meeting Room: 실행 중 사용자 결정 요청(지금은 Worker의 브라우저 요청과 진행 불가 Task로만 드러난다).
- Red Team 검토.
