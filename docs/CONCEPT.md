# 개념 설계 / Conceptual design

[한국어](#한국어) · [English](#english)

## 한국어

### Manager/Worker의 핵심 책임

```text
Manager → Task Definition → Completion Contract → Assignment
Worker → Execution → Self Check → Submission
Manager → Review → APPROVE / REWORK / ESCALATE
```

Manager가 작업자를 호출하기 전에 목적·범위·완료 기준·제약·자료·결과물·사람 판단 조건을 정한다. Worker는 기준을 보며 수행하고 자기 점검·한계를 제출한다. Manager는 자기 점검을 그대로 신뢰하지 않고 원 요청과 실제 결과/자료를 독립적으로 대조한다. 수정 가능하면 구체적인 지시로 재작업, 판단 불가능하거나 한도에 도달하면 인간에게 올린다. 검토는 업무이며 Manager 책임의 일부다. Manager 검토를 다시 검증하는 전용 AI 계층은 만들지 않는다.

완료는 결정적 안전 확인과 현재 결과에 대한 책임 있는 승인 모두를 요구한다. 인간의 명시적 품질 승인은 Manager 판단을 위조하지 않는 별도 최종 결정이다. 승인 후 결과·자료·계약이 바뀌면 승인은 무효다. 역할 정체성은 실행 모델과 분리한다.

현재 구현은 생성형 문서 Task의 두 역할과 제한된 재작업/사람 판단이다. 기존 결정적 추출은 호환 기능이며 전체 Group/Lead Manager/Project/GUI/Red Team 구조가 구현된 것은 아니다.

### 문서 지위와 변경 이력

기존 Conceptual System Design v1·v2·v2 changes를 통합한 v2 책임 모델이다. 구현 완료 목록이 아니다.
반복되는 흐름도와 설명은 합쳤으며 개념적 책임·Source of Truth·권한·종료 조건은 유지한다. 현재 구현은 [DESIGN](../DESIGN.md), 요구사항은 [PRD](../PRD.md)에 있다.
원문은 통합 전 Commit `d8ab677`의 `doc/Nidus_Conceptual_System_Design_v1.md`, `..._v2.md`, `..._v2_changes.md`에서 확인할 수 있다.

v2는 Local Agent Host와 Intelligence Layer를 추가하고 Vault > Project > Phase > Task > Action을 명시했다.
Employee Identity/Decision Engine/Execution Model을 분리했으며 JEV·Docker·DB·Queue 등을 제품 필수사항으로 고정하지 않았다.
v1의 11개 Office 공간, Completion Contract, 인간 승인, Git, Context Recovery와 Runtime 책임·종료 원칙은 유지한다.

### Vault, Host와 Employee

Agent Vault는 사용자가 지정한 로컬 디렉터리 전체다. `.nidus/`는 Library 이외 Office 상태와 운영 데이터, 그 밖의 일반 파일/Markdown은 사용자 소유 Library다.
Secret은 둘 모두와 분리한다. Vault에는 식별·호환성·무결성 확인용 메타데이터와 버전을 두며 다른 Vault와 기본적으로 격리한다.
Vault는 이동·복사·백업 단위이며 다른 Host에서 Nidus와 기기별 설정/Secret을 다시 연결해 이어갈 수 있어야 한다. 정체성과 지속 상태는 Vault 자체가 아닌 Home이 담당한다.
Task는 Project 없이 독립 업무로도 존재한다.

Local Agent Host는 Vault와 Runtime·Workshop 도구·Git·선택적 격리 및 외부 Model/API 연결을 제공하는 사용자 컴퓨터다.
장시간 켜둔 개인 컴퓨터를 고려하되 Mac mini는 예시일 뿐이다. 이는 별도 프로세스·설치 단위를 확정하지 않는다.
외부 모델이 Host 안에 설치될 필요는 없다. Host 중단/이동 후에도 Home·Desk·Board로 복구하며 무한·무중단 실행을 보장하지 않는다.
Host의 모든 실행과 연결에도 Security 정책이 적용된다.

Employee는 모델/세션이 아니라 Home의 지속적 정체성을 가진 주체다. 한 상설 전문 Group에 소속되고 Role을 가진다.
Group은 Manager 한 명과 여러 Worker로 구성한다. Finance/Development/Marketing 등 여러 Group이 한 Project에 참여한다.
Role은 시작 시 정하고 가능한 한 안정적으로 유지한다. 임시 필요는 가까운 Worker가 겸하고 반복 수요는 신규 Employee 제안으로 올린다.
Domain Group도 간단한 개발을 할 수 있지만 전문 Production 작업은 전문 Group으로 넘긴다.
개념상 Manager에는 고성능 모델, Worker에는 비용 효율 모델을 기본 배치하고 어려운 업무는 일시적 상향을 허용한다. 이는 현재 Runtime의 자동 모델 배치 기능이 아니다.

### AI Office의 11개 공간

| 공간 | 책임과 경계 |
|---|---|
| Home | 모델과 독립적인 Identity/Role/Principles와 복구용 State 포인터. 의미 있는 시작/진행/완료 변화만 반영하며 전체 맥락은 저장하지 않음 |
| Library | 장기·반복 사용 지식. 사용자 원문 보호, 허용된 Wiki Link·분류·이동만 수행. AI 문서는 버전 추적하며 통합 가능. Wiki는 원문 복제가 아닌 연결·요약·종합. Library Manager와 Dream Sequence로 중복·모순·노후 정보 정리 |
| Desk | 현재 Working Context. 외부 사실은 Source of Truth를 참조하는 Referential Context, 미완성 가설·발견·진행·Next Action 등 Native Context는 Desk 자체가 원본. 수시 갱신·Checkpoint하고 필요 지식만 Library 승격 |
| Task Board | Task 할당·상태·이력의 Source of Truth. 목적/범위/Project/출처/담당/우선순위/의존성/결과와 계약 보존. 검색·파일 열기·테스트는 세부 Action. 시작 전 담당/진행 기록, 완료 후 삭제 없이 Archive |
| Workshop | 코딩·조사·분석·작성·테스트·도구 실행 공간. 실제 환경은 Host가 제공하며 Security 범위 안에서만 실행. 코드/Shell과 브라우저 격리를 지향하되 Docker 적용·인증/다운로드/GUI 제약은 기술 설계에서 결정 |
| Inbox | 인간 업무/관리 지시의 공식 진입점. 포스트잇 Eisenhower Matrix: Do Now/Schedule/Quick Task/Later. AI 추천 가능, 최종 우선순위는 인간. Work Request는 Task/Desk로, Management Command는 권한 검사 후 기존 상태 변경. 상세 원문/Project/유형/우선순위 편집; 장기 이력은 Board |
| Meeting Room | 안건/배경/근거/선택/영향을 제시하고 인간 승인·반려·수정·추가정보 요청을 기록. Project/자동화/개선 제안은 효과·비용·영향을 검토한 승인 후 실행. 결정은 Desk/Task, 장기 결정은 Library에 반영 |
| Security Office | Agent × Resource × Action × Risk로 Allow/Ask/Deny. 읽기/쓰기/삭제/실행/네트워크/전송/Secret 통제. 자체 권한 확대 금지; 변경 제안만 가능. 위험 행동은 인간 판단, Git 추적/복구 필수. Secret은 Context 대신 인증 실행에서 사용 |
| Idea Bank | 인간/AI의 자유로운 생각. 즉시 Task/지식으로 확정하거나 과도하게 평가하지 않음. 무작위 재노출, Manager의 중복 통합/연결, Comment/Connection 이력으로 숙성. 인간은 삭제 가능하며 충분히 발전하면 판단 후 Task/Project/제안/지식 전환 |
| Rest Room | Session Budget 후 Desk Checkpoint → 파생 Idea 추출 → 먼 관련 Idea 검토/연결 → Session Reset → Context Recovery. 원 Idea는 고치지 않고 Comment/Connection 추가. 관점 생성이며 Task 종료/아이디어 최종 가치 판단 아님 |
| Manager's Office | 인간의 최상위 GUI. 전체 진행/비용/로그/승인 요청을 관찰하며 지금 인간의 주의가 필요한 일을 압축해 보여줌 |

### Intelligence Layer

새 Office/Manager나 고정 파이프라인이 아니라 각 책임 계층이 선택해 쓰는 수단이다.

| 수단 | 책임 |
|---|---|
| Deterministic Layer | 명확한 규칙·계산·정책·상태·Budget 처리 |
| Decision Engine | 후보 선택·분류·ranking·routing·scoring·관련성 평가 |
| Generative / Reasoning Model | 복잡한 추론·계획·조사·작성·코딩 |

Decision Engine은 제품 독립적 추상화이며 JEV는 후보 구현의 예시다. Action/Tool/Model 선택, Risk/Permission 보조, relevance/reranking, Verification/Guardrail 보조는 가능 영역이지 확정 기능이 아니다.
Employee Identity는 Home, Execution Model 선택·API·작업 강도는 Model Assignment가 담당한다. Decision Engine은 Employee나 Model Assignment 자체가 아니다.
엔진의 점수는 Security Allow/Ask/Deny·인간 승인·Completion Contract·검증·Red Team을 대체하거나 우회할 수 없다.
별도 Source of Truth나 새로운 상하 책임 계층을 만들지 않는다.

### Runtime과 책임별 Loop

```text
Human: Direction / Final Decision
  → Lead Manager: Next Phase
    → Group Manager: Next Task
      → Worker: Next Action
        → Runtime: Continue / Rest
```

상위 계층은 목표·제약·상태를 전달하며 세부 행동을 micro-manage하지 않는다. 하위 계층은 그 범위에서 자율적으로 수행한다.

| Loop | 흐름과 계속·종료 조건 |
|---|---|
| Project | Idea → 전제/철학 → 기획 → MVP → Feedback/Update → Deploy → Feedback/Update → Review → Knowledge Integration → Close. Phase마다 Goal/Exit Condition. Origin Group과 Lead 소속은 달라도 됨; Lead 변경은 Goal/Decision을 보존한 운영 변화로 기록 |
| Lead Manager | Phase 확인 → Group/Task 파악·전달 → 의존성/진행 조정 → 통합 → Exit Condition → Red Team → 다음 Phase/수정. 준비 전 계속 조정; 중대한 Blocker/방향/중단은 인간 판단; Closure 충족 시 종료 |
| Group Manager | Phase Goal → 영역별 Task 분해·배정 → 의존성/Blocker → 결과 수집/필요 Task → Lead 전달. 책임 결과 충족 시 불필요한 Task 생성 중단; 결과 미달인데 유효 Task가 없으면 Blocked/상위 판단; 외부 의존은 Waiting/Blocked |
| Worker | Desk → Next Action → Security → Action Routing/실행 → Result → Desk Update → 필요 시 Board/Library 갱신 → Budget Check. Contract 충족 전 유효 Action 탐색; Action 없음은 성공이 아님. 판단/의존은 Waiting/Blocked/Escalation |
| Human Attention | Issue → 안건 → Waiting → Human Decision → Desk/Task/필요 제약 갱신 → 재개. 결정 전 대기 유지; 인간 중단 결정이면 재개 대신 종료 절차 |
| Session / Rest | Budget 이내 작업; Budget/Reset 필요 시 Final Checkpoint와 Rest 후 Recovery. Task는 진행 중이며 세션만 종료. 복구 불가능/상태 불일치는 Blocked/Escalation |
| Completion | Candidate → Acceptance Criteria → Verification. 실패 시 다음 Action/Blocked/Escalation, 통과 시 Manager Review/승인 → Desk Final Update → Result → Completed → Archive → 필요한 장기 지식 → Manager 전달 |
| Red Team | 기본적으로 Phase 종료 시 독립 검토. 전제/취약점/실패/반례/대안 검토 → Pass/Revise/Conflict. Manager는 근거로 방어하거나 추가 Task 생성, 중대한 충돌은 인간 판단 |
| Closure / Knowledge | Final Phase → Result Review → Red Team → Close → Decision/Lesson/Result → Library → Dream Sequence. 만든 것/성공/실패/중요 결정/다음 개선/재사용 지식 검토 |

Context Recovery는 Home → Desk → Board → 필요한 Library → Desk Update 후 시작한다.
참조 사실은 최신 Source of Truth와 대조하고 충돌 시 그것을 우선한다. 외부 검증이 어려운 Desk Native Context는 최근 정상 Checkpoint와 Version History로 복구한다.
Action Routing은 실제 실행은 Workshop, 인간 판단은 Meeting Room, 지식은 Library, 상태는 Board, 새로운 생각은 Idea Bank로 보낸다.

Completion Contract에는 Goal, Scope, Constraints, Acceptance Criteria, Verification, Result가 필수다.
Manager는 달성 목표/완료 상태를 정하고 Worker는 Next Action을 결정한다. 완료는 작업 중단이나 파일 생성만으로 인정하지 않는다.
Archive는 Brief·계약·결과/검증·중요 변경·결정을 보존한다. 모든 내용을 Library로 복사하지 않고 장기·반복 사용 지식만 승격한다.
모든 Loop는 책임 수준의 계속/종료 조건을 가지며 “더 할 일이 없다”는 이유로 Task/Phase를 완료하지 않는다.

### 기술 설계로 남긴 선택

DB/저장, Queue/스케줄링, 프로세스/Runtime framework, vector DB, agent framework, Provider/API, Docker/sandbox/브라우저 격리, daemon/service 수명주기,
Decision Engine(JEV 포함)의 구현·인터페이스·적용 범위, Intelligence Layer 선택 기준과 판단 불가/실패 처리는 개념 설계가 제품으로 고정하지 않는다.
Git 기반 버전 관리는 유지한다. 현재 기술 선택과 후속 범위는 DESIGN/PRD가 따로 명시한다.

## English

### Manager/Worker responsibility boundary

```text
Manager → Task Definition → Completion Contract → Assignment
Worker → Execution → Self Check → Submission
Manager → Review → APPROVE / REWORK / ESCALATE
```

Before assignment, Manager defines purpose, scope, criteria, constraints, materials, deliverable and human-judgment conditions. Worker executes against those criteria and submits self-check/limitations. Manager independently compares the original request, actual result and source evidence rather than trusting self-check. Repairable issues return with concrete instructions; insufficient authority/evidence and exhausted rework go to humans. Review is work owned by Manager, not a separate verifier hierarchy.

Completion requires deterministic safety checks and accountable approval of current content. Explicit human quality approval is a distinct final decision, preserving the Manager judgment. Changed results/materials/contracts invalidate approval. Role identity remains independent of the execution model.

The implementation covers two roles on generative document tasks, bounded rework and human decisions. Deterministic extraction remains compatible; full Group/Lead Manager/Project/GUI/Red Team organization is still conceptual.

### Status and revision history

This consolidates Conceptual System Design v1, v2 and v2 changes into the v2 responsibility model, not a list of implemented features.
Repeated diagrams/prose are combined while retaining responsibilities, sources of truth, permissions and stopping conditions. Current implementation is in [DESIGN](../DESIGN.md); requirements are in [PRD](../PRD.md).
Originals are available at pre-consolidation commit `d8ab677`: `doc/Nidus_Conceptual_System_Design_v1.md`, `..._v2.md`, `..._v2_changes.md`.

v2 added Local Agent Host and Intelligence Layer and made Vault > Project > Phase > Task > Action explicit.
It separated Employee Identity/Decision Engine/Execution Model without making JEV/Docker/DB/Queue products mandatory.
v1's eleven Office spaces, Completion Contract, human approval, Git, recovery and runtime responsibilities/stopping principles remain.

### Vault, Host and Employee

Agent Vault is the complete user-selected local directory. `.nidus/` holds Office state/operations except Library; ordinary files/Markdown outside it form the user-owned Library.
Separate secrets from both. Include metadata/version for identity, compatibility and integrity; isolate vaults by default.
A vault is a move/copy/backup unit: another host reconnects Nidus and device settings/secrets to continue. Home, rather than the vault itself, owns identity/persistent state.
Tasks may exist independently of projects.

Local Agent Host is the user's computer providing vault/runtime/Workshop tools/Git/optional isolation/external model/API connections.
Consider long-running personal computers; Mac mini is only an example. This does not prescribe process/installation units.
External models need not be installed on the host. Recover through Home/Desk/Board after interruption/migration; do not promise infinite/uninterrupted execution.
Security applies to every host action and external connection.

An Employee is a persistent Home identity, not a model/session. It belongs to one standing domain Group with a role.
A Group has one Manager and multiple Workers. Finance/Development/Marketing groups can collaborate on one project.
Set roles initially and keep them stable where possible. Cover temporary needs with a nearby Worker; propose new Employees for recurring demand.
Domain groups may do simple development; transfer specialized production work to the specialist group.
Conceptually favor capable models for Managers and economical models for Workers, allowing temporary upgrades for difficult tasks. Current Runtime does not implement automatic model assignment.

### Eleven AI Office spaces

| Space | Responsibility and boundary |
|---|---|
| Home | Model-independent Identity/Role/Principles and recovery State pointers; update on meaningful start/progress/completion changes, not full working context |
| Library | Long-term/repeated knowledge; protect user originals, allow only authorized wiki links/classification/moves. Version and consolidate AI documents. Wiki connects/summarizes/synthesizes rather than duplicates originals. Library Manager/Dream Sequence review duplication, contradictions and stale information |
| Desk | Current working context: Referential Context points to external sources of truth; native hypotheses/discoveries/progress/next action originate in Desk. Update/checkpoint continually and promote only useful lasting knowledge |
| Task Board | Source of truth for assignment/status/history. Retain purpose/scope/project/origin/owner/priority/dependencies/results/contracts. Searches/opening files/tests are Actions. Record assignment/in-progress before work; archive without deleting completed truth |
| Workshop | Coding/research/analysis/writing/testing/tool execution. Host supplies the environment; execute within Security. Aim for shell/code/browser isolation while technical design decides Docker scope and auth/download/GUI constraints |
| Inbox | Official human work/management entry point. Sticky-note Eisenhower Matrix: Do Now/Schedule/Quick Task/Later. AI may recommend; human sets priority. Requests create tasks/Desk context; management commands permission-check state changes. Edit original/project/type/priority details; Board owns lasting history |
| Meeting Room | Present issue/background/reason/choices/effects and record approval/rejection/revision/information requests. Execute project/automation/improvement proposals only after reviewing effects/cost/impact and approval. Reflect decisions in Desk/Task and lasting decisions in Library |
| Security Office | Agent × Resource × Action × Risk determines Allow/Ask/Deny. Control read/write/delete/execute/network/transmission/Secret use. Agents cannot expand their own privileges, only propose changes. Human decisions for risk; Git tracking/recovery mandatory. Use secrets through authenticated execution, not context |
| Idea Bank | Free human/AI ideas, not immediately tasks/knowledge or prematurely evaluated. Mature through random resurfacing, Manager deduplication/linking and Comment/Connection history. Humans may delete; developed ideas become tasks/projects/proposals/knowledge through judgment |
| Rest Room | After session budget: Desk checkpoint → derived ideas → examine/connect distant ideas → session reset → recovery. Add comments/connections without altering original ideas. Generate perspectives rather than end tasks or decide final idea value |
| Manager's Office | Top-level human GUI observing progress/cost/logs/approvals and condensing what needs human attention now |

### Intelligence Layer

Means chosen by each responsibility layer, not another Office/Manager or mandatory pipeline.

| Means | Responsibility |
|---|---|
| Deterministic Layer | Explicit rules/calculations/policies/state/budget |
| Decision Engine | Candidate selection/classification/ranking/routing/scoring/relevance |
| Generative / Reasoning Model | Complex reasoning/planning/research/writing/coding |

Decision Engine is product-independent; JEV is an example candidate implementation. Action/tool/model selection, risk/permission support, relevance/reranking and verification/guardrail support are possible uses, not committed features.
Home owns Employee Identity; Model Assignment owns Execution Model selection/API/intensity. Decision Engine is neither the Employee nor Model Assignment itself.
Scores cannot replace/bypass Security Allow/Ask/Deny, human approval, Completion Contract, verification or Red Team.
Create no separate source of truth or new hierarchy of responsibility.

### Runtime and responsibility loops

```text
Human: Direction / Final Decision
  → Lead Manager: Next Phase
    → Group Manager: Next Task
      → Worker: Next Action
        → Runtime: Continue / Rest
```

Upper layers convey goals/constraints/state rather than micro-manage actions. Lower layers operate autonomously within that scope.

| Loop | Flow and continuation/stopping conditions |
|---|---|
| Project | Idea → premises/philosophy → planning → MVP → feedback/update → deploy → feedback/update → review → knowledge integration → close. Each phase has goal/exit condition. Origin and Lead groups may differ; record Lead changes while preserving goals/decisions |
| Lead Manager | Inspect phase → identify/assign groups/tasks → coordinate dependencies/progress → integrate → exit condition → Red Team → next phase/revision. Continue coordination until ready; escalate major blockers/direction/stopping; end at closure |
| Group Manager | Phase goal → domain task decomposition/assignment → dependencies/blockers → collect results/add necessary tasks → report to Lead. Stop unnecessary generation once responsibility fulfilled; no valid task with unmet result means Blocked/escalation; dependencies mean Waiting/Blocked |
| Worker | Desk → next action → Security → route/execute → result → Desk update → Board/Library if needed → budget check. Seek valid actions until contract satisfied; no action is not success. Decisions/dependencies mean Waiting/Blocked/Escalation |
| Human Attention | Issue → agenda → Waiting → human decision → update Desk/task/constraints → resume. Wait until recorded decision; a human stop leads to closure rather than resumption |
| Session / Rest | Work within budget; budget/reset triggers final checkpoint and Rest/recovery. Task remains in progress while session ends. Unrecoverable errors/inconsistency mean Blocked/Escalation |
| Completion | Candidate → acceptance criteria → verification. Failure returns to next action/Blocked/Escalation; pass leads to Manager review/approval → Desk final update → result → Completed → archive → lasting knowledge → Manager report |
| Red Team | Independently review at phase end by default: premises/vulnerabilities/failures/counterexamples/alternatives → Pass/Revise/Conflict. Manager defends with evidence or creates tasks; humans resolve major conflicts |
| Closure / Knowledge | Final phase → result review → Red Team → close → decisions/lessons/results → Library → Dream Sequence. Review output/success/failure/important decisions/improvements/reusable knowledge |

Recover Home → Desk → Board → necessary Library → Desk update before work.
Compare referenced facts with current sources of truth and prefer those on conflict. Recover externally unverifiable native Desk context from the latest valid checkpoint/version history.
Route execution to Workshop, human decisions to Meeting Room, knowledge to Library, state changes to Board and new thoughts to Idea Bank.

Completion Contract requires Goal, Scope, Constraints, Acceptance Criteria, Verification and Result.
Managers define outcomes/completion states; Workers decide next actions. Stopping work or producing a file is insufficient for completion.
Archive retains brief/contract/result/verification/important changes/decisions. Promote only lasting/repeated knowledge instead of copying everything to Library.
Every loop has responsibility-level continuation/stopping conditions; “nothing left to do” never completes an unmet task/phase.

### Decisions left to technical design

Conceptual design does not mandate products for DB/storage, queue/scheduling, process/runtime framework, vector DB, agent framework, providers/APIs, Docker/sandbox/browser isolation, daemon/service lifecycle,
Decision Engine/JEV implementation/interfaces/scope or Intelligence Layer selection/failure handling.
Retain Git-based versioning. DESIGN/PRD separately specify actual choices and deferred scope.
