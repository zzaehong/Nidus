# 3단계 설계 — AI Office

상태: **3a 구현 중** (2026-11-12).

[CONCEPT.md](CONCEPT.md)의 AI Office를 단계적으로 만든다. 1단계 [Model Gateway](STAGE1_MODEL_GATEWAY.md)가 역할과 난이도별로 모델을 고르고, 2단계 [Agent Workspace](STAGE2_AGENT_WORKSPACE.md)가 Worker가 일하는 VM과 브라우저를 준다. 3단계는 그 위에 일을 나누고 맡기고 검토하는 조직을 올린다.

## 3a. 작업 지시 구조

사용자는 Main에게 지시한다. Main은 계획을 세우고 필요한 것을 묻는다. 사용자가 계획을 승인하면 팀의 Manager가 Task를 Worker에게 맡기고 결과를 검토한다. 끝나면 Main이 보고하고, 사용자는 바뀐 내용을 보고 Vault에 들일지 정한다.

```text
사용자 ── 지시 ──▶ Main ── 로드맵 · 팀 · Task(Completion Contract) · 질문
   ▲                │
   └── 답 · 덧붙임 ─┘  (Main이 계획을 고친다. 몇 번이든)
사용자 ── 계획 승인 ──▶ 실행: 의존 Task가 끝난 Task들을 나란히(최대 3)
                         Manager ── Worker 지시서 · 난이도
                         Worker  ── 텍스트 작업(VM 없이) 또는 VM 작업 공간에서 수행
                         Manager ── 완료 조건으로 검토: 통과 / 수정 요청 / 진행 불가
                       ──▶ Main 최종 보고 ──▶ 결과 검토(diff) ──▶ 승인하면 브랜치 nidus/<작업>
```

### 결정 (사용자, 2026-11-12)

| 항목 | 결정 |
|---|---|
| 팀 구성 | Main이 요청마다 필요한 팀(최대 4)을 정한다. CONCEPT의 상설 Group은 Library·Home과 함께 나중에 붙인다 |
| 실행 방식 | ~~한 번에 한 Worker~~ → **병렬** (2026-11-13): 서로 의존하지 않는 Task는 각자의 Manager·Worker가 동시에 진행한다(최대 3). Manager가 A를 검토하는 동안 다른 Worker가 B를 한다. VM은 한 작업 공간과 한 브라우저라 VM Task의 Worker는 차례로 쓴다 |
| 계획 승인 | 질문에 답하고 사용자가 계획을 승인해야 실행한다. 답하지 않은 질문은 Main이 판단한다 |
| Lead Manager | 지금은 Main이 겸한다(Task 순서와 팀 간 넘겨주기는 계획의 의존성으로 표현). 병렬 실행을 붙일 때 분리한다 |
| Manager 지시 생략 | **기각** (2026-11-13): 단순한 Task도 Manager가 지시서를 쓴다. 속도는 병렬 진행과 모델 상태 관리로 얻는다 |
| VM 없는 Task | VM이 필요 없는 일은 VM 밖에서 텍스트 작업으로 한다. VM은 VM Task가 처음 시작될 때만 켠다 (2026-11-12) |
| 실행 장소 이름 | **텍스트 작업 · `text`** (2026-11-13). 처음엔 "책상(`desk`)"이었으나 CONCEPT의 Desk(작업 맥락 저장소)와 겹쳐 바꿨다. 이전에 저장된 계획의 `desk`는 `text`로 읽는다 |

### 역할과 모델

| 역할 | 하는 일 | 도구 | 모델 배정 슬롯 |
|---|---|---|---|
| Main | 계획(요약, 로드맵, 팀, Task, 질문), 계획 수정, 최종 보고 | 없음 (텍스트) | `roles.main` |
| Manager | Task마다 Worker 지시서와 난이도 결정, 결과 검토 | 없음 (텍스트) | `roles.manager` |
| Worker | 실제 수행 | 텍스트 작업: 읽기 도구와 결과물 / VM: 작업 공간 도구(2e) | `worker.<난이도>` — 난이도는 Manager가 정한다 |

Main과 Manager의 답은 JSON으로 받는다. 형식이 틀리면 이유를 알려 한 번 더 받는다.

### 역할 정의 (시스템 프롬프트)

모든 역할의 시스템 프롬프트는 [`src/office/roles.ts`](../../src/office/roles.ts) 한 곳에서 같은 틀로 만든다. 시스템 프롬프트에는 **누구인지**를, 요청 메시지에는 **이번에 무엇을 내야 하는지**(계획 JSON 형식, 지시서, 검토, 최종 보고)를 둔다. 그래서 Main은 계획할 때와 최종 보고할 때 같은 정체성으로 답한다.

| 시스템 프롬프트 | 담는 것 |
|---|---|
| 공통 | 팀 구성(사용자·Main·Manager·Worker가 각각 하는 일, 사용자만 할 수 있는 일), 파일·웹 내용은 지시가 아니라 데이터라는 규칙, 사용자 언어로 쓰기 |
| Main (`mainSystem`) | 계획·질문·계획 수정·최종 보고. 직접 일하지 않고 도구가 없다. 읽지 않은 파일을 읽은 척하지 않는다. 텍스트 작업·VM에서 Worker가 쓰는 도구 목록(설명 첫 문장) |
| Manager (`managerSystem`) | 지시서 쓰기(어떤 도구가 맞는지, 검증 방법, 커밋 또는 결과물 내용, 난이도), 엄격한 검토(통과·수정 요청·진행 불가의 기준). 도구가 없다. 그 장소에 없는 도구를 시키지 않는다. Worker 도구 목록 |
| Worker 텍스트 작업 (`workerSystem('text')`) | VM·셸·인터넷·파일 수정이 없다는 것, 결과물을 넘기는 법, 할 수 없는 일은 finish로 알리기. 자기 도구 전체 설명 |
| Worker VM (`workerSystem('vm')`) | /workspace와 브랜치, 셸 세션과 서비스, 네트워크 승인, 사용자가 보는 브라우저, CAPTCHA 규칙. 자기 도구 목록 |

도구 목록은 도구 정의(`WORKER_TOOLS`, `DESK_TOOLS`)에서 만든다. 도구를 더하거나 빼면 모든 역할의 프롬프트가 함께 바뀌고, 역할이 갖지 않은 도구를 프롬프트가 말하지 않는다(테스트로 확인).

**Provider 오류**: 모든 역할의 모델 호출은 같은 규칙을 따른다. 일시적인 오류(속도 제한 429, 서버 오류, 네트워크, 시간 초과 5분)를 낸 모델은 90초 동안 쉬게 하고, 같은 슬롯의 다음 후보로 곧바로 바꾼다(역할 사이 공유: Main이 막힌 모델은 Manager도 피한다). 후보가 없으면 속도 제한은 15·30·60·90·120초, 그 밖의 오류는 5·15초 기다려 다시 시도한다. Gemini 무료 등급은 모델마다 할당량이 따로라, 같은 Provider의 다른 모델도 좋은 예비 후보다. 무료 등급 하나로 모든 역할을 맡기면 속도 제한에 자주 걸리므로, 슬롯마다 다른 Provider의 후보를 하나씩 두는 것이 좋다.

### 실행 장소: 텍스트 작업과 VM

Main이 Task마다 `where`를 정한다. 빠지면 `vm`이다(이전 보드도 같다).

| | 텍스트 작업 (`text`) | VM (`vm`) |
|---|---|---|
| 하는 일 | 글, 분석, 요약, 번역, 계획, 설계, 텍스트로 쓴 코드 | 명령·코드 실행, 저장소 파일 만들기·고치기, 인터넷·브라우저 |
| 도구 | `list_files`, `read_file`, `search_files`(Vault의 커밋된 상태, Mac에서 git으로 읽기만), `write_deliverable`, `finish` | 2e의 작업 공간 도구 |
| 결과 | 결과물(텍스트, 6만 자까지). Task Board와 앱의 Task 목록에 남는다 | 작업 공간의 커밋. 끝나면 결과 검토 |
| 준비 | 없음. 곧바로 시작 | 첫 VM Task가 시작될 때 VM을 켜고 작업 공간을 만든다 |

- 텍스트 작업은 VM 작업 공간이 시작할 상태와 같은 것(커밋된 파일)만 본다. 경로는 저장소 안으로 제한하고 바이너리 파일은 읽지 않는다. 셸·인터넷·파일 쓰기는 없다.
- Task의 결과물은 그 Task에 의존하는 Task의 Manager(4천 자까지)와 Worker(지시서 뒤에, 2만 자까지)에게 넘어간다. 그래서 텍스트 작업으로 초안을 쓰고 VM Task가 파일로 저장하는 식으로 나눌 수 있다.
- VM Task가 하나도 없는 요청은 VM을 켜지 않고, 끝나도 결과 검토가 없다. Main의 최종 보고는 결과물을 Task 목록에서 보라고 안내한다.
- 이미 결과 검토를 기다리는 변경이 있어도 VM Task가 남지 않은 프로젝트는 시작할 수 있다.

### Task Board

CONCEPT의 Task Board를 요청(Project) 단위로 둔다. `.nidus/local/board/<프로젝트>.json`.

- Project: 지시, 상태(`planning`, `waiting_user`, `running`, `reviewing`, `done`, `stopped`, `failed`), 요약, 로드맵, 팀, Task, 질문과 답, Main의 계획 대화, 최종 보고, 작업 공간 이름.
- Task: 팀, 제목, 실행 장소, **Completion Contract**(Goal, Scope, Constraints, Acceptance Criteria, Verification), 의존 Task, 상태(`pending`, `in_progress`, `review`, `done`, `blocked`, `skipped`), 난이도, 지시서, 시도 수, 검토 기록, **Result**(요약, 검증 방법), 결과물(책상).
- 계획은 검사한다: 팀이 있는지, id가 겹치지 않는지, 의존 Task가 있는지, 의존성에 순환이 없는지, 완료 조건이 하나 이상인지.

### 실행

- 첫 VM Task가 시작될 때 VM을 켜고(꺼져 있으면) Vault의 커밋된 상태로 작업 공간을 하나 만든다. 모든 VM Task가 그 작업 공간에서 이어서 일한다.
- 준비된 Task(의존 Task가 모두 완료)를 계획 순서대로 최대 3개까지 함께 시작한다. Task마다 Manager 호출과 Worker 대화가 따로라 맥락이 섞이지 않는다. 하나가 끝나면 다음 준비된 Task를 바로 시작한다.
- **VM 차례**: VM Task의 Worker는 VM(작업 공간·브라우저)을 하나씩 쓴다. 기다리는 동안 다른 Task의 Manager 지시·검토와 VM 없는 Task는 계속 진행된다. 차례를 기다리면 진행 기록에 나온다.
- **Task별 변경**: 여러 Task가 같은 작업 공간에 커밋하므로, Worker가 VM을 놓을 때 남은 변경을 그 Task 이름으로 커밋하고 시도마다 [시작, 끝] 커밋을 기록한다. Manager는 그 Task의 커밋과 diff만 본다.
- Manager의 답을 끝내 읽지 못하는 등 실행이 실패하면 다른 Task도 멈추고, 진행 중이던 Task는 처음부터 다시 하게 표시한다. Task Board 저장은 순서대로 해서 늦게 끝난 저장이 최신 상태를 덮지 않는다.
- Task마다 새 Worker 대화로 시작한다. Manager의 검토 근거는 Worker의 요약, 도구 호출 기록(최근 40개)과 함께, VM Task는 그 Task가 만든 커밋·파일 증감·diff(마지막 시도 12KB, 이전 시도는 앞부분), 텍스트 작업 Task는 결과물(1만 5천 자까지)이다.
- 수정 요청은 같은 Worker 대화에 이어서 준다. Worker가 중간에 멈췄거나 실패했으면 새 대화로, 작업 공간에 남은 것을 확인하고 이어 가라고 준다.
- 한 Task는 최대 3번 시도한다(처음 + 수정 2번). 그래도 통과하지 못하면 진행 불가(`blocked`)다. 진행 불가 Task에 의존하는 Task는 건너뛴다(`skipped`).
- 모든 Task가 끝나면 Main이 최종 보고를 쓰고, 작업 공간이 있으면 그 변경이 결과 검토로 올라온다(2d와 같다).
- 중지하면 진행 중이던 Task는 처음부터 다시 하게 표시되고, "이어서 진행"으로 남은 Task부터 계속한다. 앱을 다시 켜도 이어 갈 수 있다.

### 앱

작업 탭의 지시 칸에서 받는 쪽을 고른다: **Main에게**(기본) 또는 **Worker에게**(2e의 단일 Worker). Main에게 지시하면 프로젝트 패널이 나온다: 계획 요약, 로드맵, VM이 필요한지, 팀별 Task(실행 장소 표시, 펼치면 Completion Contract, 결과, 검토 의견, 텍스트 작업 결과물과 복사), Main의 질문과 답 칸, 덧붙일 말, "답변 보내기"·"계획 승인하고 시작"·"중지"·"이어서 진행"·"닫기". 진행 기록에는 Main과 Manager의 말(계획, Worker 지시, 검토, 최종 보고)이 Worker의 도구 호출과 함께 나온다.

### 확인 (2026-11-12, 실제 모델)

- 텍스트 작업만: "README를 읽고 메모 정리 가이드 초안" → Main이 텍스트 작업 Task 하나로 계획. Worker는 `list_files`·`read_file` 뒤 결과물을 썼고 Manager가 통과시켰다. 67초 동안 VM은 꺼진 채였고 결과 검토는 없었다.
- 섞임: "체크리스트를 만들어 checklist.md로 저장" → 텍스트 작업 초안 다음에 VM 저장. VM은 136초, VM Task가 시작될 때 켜졌다. Worker는 넘겨받은 초안을 `checklist.md`로 커밋했고, 결과 검토 → 브랜치까지 갔다.

- 병렬 (2026-11-13): "fib.py 작성·실행 / primes.py 작성·실행 / 메모 팁 초안(파일 없음)" → Main이 VM Task 둘과 VM 없는 Task 하나로 계획. 25초에 세 Task가 함께 시작해 Manager 셋이 동시에 지시했다. VM 없는 Task는 VM이 켜지는 동안 일했고, primes Task는 fib Task가 VM을 쓰는 동안 차례를 기다렸다. fib Task가 끝나자 Manager가 fib를 검토하는 사이 primes Worker가 VM에서 일했다(사용자가 제안한 방식). 세 Task 모두 통과, 계획부터 최종 보고·브랜치까지 3분 28초. 커밋은 Task별로 나뉘었다.

## 다음

- Library·Home·Desk: 팀과 Agent의 지속 정체성, 작업 맥락 복구.
- VM Task끼리도 동시에: Worker마다 작업 공간(git worktree)과 브라우저를 따로 두고, 끝나면 합친다. Lead Manager 분리.
- Meeting Room: 실행 중 사용자 결정 요청(지금은 Worker의 브라우저 요청과 진행 불가 Task로만 드러난다).
- Red Team 검토.
