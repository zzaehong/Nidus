- **Agent Vault** — 시스템의 물리적 경계
- **AI Office** — Vault 내부의 운영 환경과 11개 공간의 관계
- **AI Employee** — 실제 작업 주체
- **Library & Desk / Context** — 장기 지식과 현재 작업 맥락
- **Task Board / Coordination** — Task 생성·할당·의존성·실행 흐름
- **Meeting Room / Attention** — 인간 개입과 승인·판단 요청
- **Security Office / Permission** — 읽기·쓰기·실행·외부 접근 권한
- **Inbox** — 인간이 직접 업무를 투입하는 경로
- **Idea Bank & Rest Room** — 생각의 생성·숙성·재검토
- **Workshop** — 실제 도구 실행과 작업 환경
- **Manager's Office** — 전체 상태·비용·로그·승인 요청 관찰
- **전체 Runtime Flow** — 위 구성요소가 한 Task에서 어떻게 연결되는지
# Agent Vault
---
 **Agent Vault는 사용자가 지정한 로컬 디렉터리 전체이며, Nidus와 AI Employee가 활동하는 기본적인 파일시스템 경계를 제공한다.**
 Agent Vault의 루트에는 `.nidus/`가 존재한다. Library를 제외한 AI Office의 시스템 상태와 Nidus 운영 데이터는 원칙적으로 `.nidus/`에서 관리한다.
 Library의 실제 콘텐츠는 `.nidus/` 밖에 일반 파일과 Markdown 형태로 존재하며 사용자에게 소유권과 관리권이 있다.
 API Key와 Credential 등의 Secret은 `.nidus/`와 Library 모두에서 분리하여 보호하며, 필요한 작업에서 인증된 방법으로만 사용할 수 있도록 한다.
 Agent Vault는 가능한 한 독립적인 이동·복사·백업 단위이며, 다른 Vault와 기본적으로 격리된다. 다른 환경으로 Vault를 이동한 뒤 Nidus를 설치하고 필요한 기기별 설정과 Secret을 다시 연결하면 기존 환경을 이어갈 수 있어야 한다.
 Nidus의 작업 계층은 기본적으로 **Agent Vault > Project > Task**이며, Task는 Project와 무관한 독립적인 업무로도 존재할 수 있다.
 각 Agent Vault에는 Nidus가 Vault를 식별하고 호환성과 무결성을 확인하기 위한 로컬 메타데이터와 버전 정보가 존재한다. 
 Agent의 정체성·지침·지속 상태는 Agent Vault 자체의 책임이 아니라 AI Office의 **Home**이 담당한다.
# AI Office
---
**Home → Library → Desk → Task Board → Workshop → Inbox → Meeting Room → Security Office → Idea Bank → Rest Room → Manager's Office**
## 1. Home
- Home은 AI Employee의 **정체성, 역할, 원칙, 상태**를 관리한다.
- **Identity**는 Model과 독립적이며, 실행 모델이 바뀌어도 동일한 Agent로 행동하게 한다.
- **Role**은 Researcher, Developer, Designer처럼 Agent가 조직에서 맡는 역할을 정의한다.
- **Principles**는 역할 기반 기본 원칙과 Agent별 Custom Principles로 구성한다.
- **State**는 전체 맥락이나 진행상황을 저장하지 않고, 현재 Project·Task와 필요한 정보의 위치를 가리키는 복구용 상태다.
- 작업 상태는 **시작 / 진행 / 완료**처럼 의미 있는 변화가 발생했을 때 갱신한다.
- Agent는 세션이 끊겨도 Home을 통해 현재 위치를 파악하고 Desk와 Task Board를 다시 읽어 작업을 재개할 수 있어야 한다.
- Home에는 특정 AI Model을 기록하지 않으며, 모델 선택·API·작업 강도는 별도의 Model Assignment 시스템에서 관리한다.
## 2. Library
- Library는 사용자와 AI가 함께 사용하는 **장기 지식 공간**이다.
- 사용자의 Markdown 문서는 원문을 유지하는 것을 기본으로 하며, AI는 본문을 임의로 수정하지 않는다.(허용된 참조 삽입은 예외)
- AI는 사용자 문서에 `[[Wiki Link]]` 형태의 참조를 추가하고, 사용자가 정한 분류 규칙에 따라 폴더를 생성하거나 문서를 이동할 수 있다.
- Library Manager Agent는 사용자 문서를 분류·연결하고, 장기적·반복적으로 필요한 내용을 Wiki·Decision·Lesson·Skill 등으로 추출한다.
- Wiki는 원문을 복제하는 공간이 아니라 여러 문서를 **연결·요약·종합하는 지식 계층**으로 사용한다.
- AI가 작성한 문서는 AI가 자유롭게 수정·통합·재구성할 수 있으며, 모든 변경은 버전 관리로 추적 가능해야 한다.
- Library의 기록 기준은 **“장기적으로, 혹은 반복적으로 필요한 내용인가?”** 이다.
- 주기적인 Dream Sequence를 통해 중복·모순·낡은 정보·연결 관계를 검토하고 지식 구조를 지속적으로 정제한다.
- 사용자 원본의 내용은 보호하되, 문서의 위치와 연결 구조는 사용자가 허용한 범위에서 AI가 관리할 수 있다.
- 핵심 목적은 **지식을 단순히 저장하는 것이 아니라, 시간이 지날수록 더 잘 연결되고 활용하기 쉬운 지식 체계로 발전시키는 것** 이다.
## 3. Desk
- Desk는 AI Employee가 현재 Project·Task를 수행하기 위해 유지하는 Working Context Store다.
- Agent는 작업을 시작하거나 재개할 때 항상 Desk를 확인하고 다음 행동을 결정한다.
- Desk의 정보는 두 종류로 구분된다.
- **Referential Context**는 Task 상태, Decision, Library 문서, 파일 등 다른 공간에 Source of Truth가 존재하는 정보를 가리킨다. Desk는 이를 복제하는 대신 위치와 관계를 참조한다.
- **Native Working Context**는 현재 사고 과정, 작업 중 발견한 내용, 미완성 가설, 세부 진행상황, Next Action처럼 다른 공간에 적절한 저장 위치가 없는 현재 작업 맥락이다. 
  이 정보에 대해서는 Desk 자체가 Source of Truth다.
- 작업 중 발견한 내용, 현재까지의 진행상황, 다음 행동 등은 Desk에 수시로 반영한다.
- 다른 공간에 Source of Truth가 존재하는 정보는 복제하지 않고 참조하며, 관련 정보에 빠르게 접근할 수 있게 한다.
- Project·Task가 변경되면 Desk를 새로운 작업에 맞게 재구성하고, 장기적·반복적으로 필요한 내용은 Library로 승격한다.
- 의미 있는 작업 상태 변화는 Home에도 전달하여 세션 복구가 가능하도록 한다.
## 4. Task Board
- Task Board는 Nidus의 **Task 배정·실행 상태·작업 이력의 Source of Truth**다.
- Task는 독립적인 Task Brief와 기록을 남길 가치가 있을 만큼 크면서도 Agent가 혼동 없이 수행할 수 있도록 범위가 명확해야 한다.
- 검색·파일 열기·테스트 실행 같은 세부 행동은 Task가 아니라 Task 내부의 **Action**으로 취급한다.
- 각 Task는 목적·범위·소속 Project·생성 출처·담당 Agent·우선순위·의존성·실행 상태·결과 등을 관리한다.
- 각 Task에는 **Completion Contract**를 둔다. Completion Contract는 해당 Task가 무엇을 달성해야 하며 어떤 상태가 되어야 완료로 인정되는지를 정의한다.
- Completion Contract는 최소한 **Goal, Scope, Constraints, Acceptance Criteria, Verification, Result**를 포함한다.
- **Goal**은 달성하려는 목적, **Scope**는 이번 Task에서 다루는 범위, **Constraints**는 작업 중 지켜야 할 제약을 정의한다.
- **Acceptance Criteria**는 Task 완료를 인정할 수 있는 관찰 가능한 조건이며, **Verification**은 그 조건의 충족 여부를 확인하는 방법이다.
- **Result**는 실제 수행 결과와 검증 결과, 주요 변경 및 남은 제한사항을 기록한다.
- Task는 Project에 속하거나 사용자의 단발성 요청을 위한 **Standalone Task**로 존재할 수 있다.
- Agent가 작업을 시작하면 담당 Agent와 **진행 중 상태**를 먼저 기록하여 중복 작업을 방지한다.
- 세부 작업 진행상황과 현재 맥락은 Desk가 관리하며, Task Board는 Task 수준의 상태를 관리한다.
- Task가 완료되면 활성 목록에서 제거하되 Task Brief·결과·변경 이력은 Archive에 보존한다.
- Task Archive는 **“무슨 일을 수행했고 어떤 결과가 나왔는가”**를 보존하며, 장기적으로 필요한 지식은 Library로 추출한다.
## 5. Workshop
- Workshop은 AI Employee가 **실제 업무를 수행하는 실행 공간**이다. 코딩, 조사, 분석, 작성, 테스트, 도구 실행 등이 여기에서 이루어진다.
- Agent가 Task를 시작하면 Task Board에 **담당 Agent와 진행 중 상태**를 먼저 기록하여 여러 Agent의 중복 작업을 방지한다.
- Task Board는 작업의 상세 진행도를 저장하지 않고, 현재 어떤 Task가 실행 중이며 누가 담당하는지를 중심으로 관리한다.
- 실제 작업 맥락과 세부 진행상황은 **Desk에 수시로 반영**한다.
- Home은 모든 진행 내용을 기록하지 않고, 작업 상태가 **시작 → 진행 → 완료**처럼 의미 있게 변경될 때 State를 갱신한다.
- Task 완료 시 활성 Task 목록에서는 제거하고, Task Brief·결과·이력을 포함한 완료 기록은 Archive에 보존한다.
- Workshop의 모든 행동은 **Security Office의 Permission 정책** 안에서 이루어지며 임의로 시스템 권한을 확장할 수 없다.
- 실행 환경은 기본적으로 격리를 원칙으로 하며, 특히 코드·Shell 실행은 **Docker 등의 격리 환경**을 사용하는 방향으로 설계한다.
- 브라우저 역시 가능한 한 격리된 환경을 사용하되, 인증·다운로드·GUI 상호작용 등의 제약을 고려해 구체적인 격리 방식은 기술 설계 단계에서 결정한다.
## 6. Inbox
- Inbox는 인간 관리자가 Nidus에 **새로운 업무나 운영 지시를 전달하는 공식 진입점**이다.
- 사용자 화면은 **포스트잇 메모를 아이젠하워 매트릭스에 붙이는 형태**로 구성한다.
- 사용자는 간단한 메모를 먼저 작성하고, 중요도와 긴급도에 따라 Do Now / Schedule / Quick Task / Later 영역에 배치한다.
- AI는 중요도와 긴급도를 추천할 수 있지만 최종 판단과 포스트잇의 위치는 사용자가 결정한다.
- 각 입력은 **Work Request** 또는 **Management Command**로 구분한다.
- Work Request는 Project Task 또는 Standalone Task로 구조화되어 Task Board에 등록되고, 실행에 필요한 맥락은 Desk에 구성된다.
- Management Command는 Task 생성 없이 기존 Project·Task·Agent의 우선순위 변경, 중단, 방향 수정 등 시스템 상태를 변경한다. (Management Command도 Permission 검사를 받는다)
- 포스트잇을 선택하면 원문, 상세 설명, 관련 Project, 유형, 우선순위 등을 확인·수정할 수 있는 상세 화면을 제공한다.
- Inbox는 장기 기록 저장소가 아니며, Task로 전환된 이후의 업무 상태와 이력은 Task Board가 관리한다.
- 핵심 UX는 **“복잡한 구조를 몰라도 메모를 붙이듯 AI 조직에 일을 전달한다”** 는 경험을 제공하는 것이다.
## 7. Meeting Room
- Meeting Room은 AI가 독자적으로 결정해서는 안 되는 사안이나, **인간의 판단을 받고 싶은 제안**을 올리는 공간이다.
- Agent는 중요한 판단이 필요한 경우 회사의 결재 방식처럼 안건을 정리해 사용자에게 제출한다.
- 결재 요청에는 **안건, 배경정보, 판단 근거, 가능한 선택지와 영향**이 포함되어야 한다.
- 사용자는 승인, 반려, 수정 지시, 추가 정보 요청 등의 결정을 내릴 수 있으며, 관련 Task는 필요 시 판단 대기 상태로 전환한다.
- 사용자의 결정은 Task와 Desk에 반영하고, 장기적으로 중요한 결정은 Library에도 기록한다.
- Meeting Room은 결재 외에도 AI가 **새로운 Project, 자동화, 개선안, 아이디어** 등을 사용자에게 제안하는 공간으로 사용한다.
- 제안은 즉시 실행하지 않고, 기대 효과·필요 비용·영향 등을 정리하여 사용자의 의견과 승인을 받는다.
- 사용자는 제안을 승인하거나 수정·보류·거절할 수 있으며, 승인된 제안만 실제 Project·자동화로 전환한다.
- 어떤 행동이 반드시 결재를 요구하는지는 Attention 및 Security Office 정책과 연결하여 관리한다.
- 핵심 원칙은 **AI가 판단을 대신하는 것이 아니라, 인간이 좋은 판단을 내릴 수 있도록 안건과 자신의 의견을 정리해 제시하는 것**이다.
## 8. Security Office
- Security Office는 AI Employee의 **읽기, 쓰기, 삭제, 실행, 네트워크 접근, 외부 전송, Secret 사용 권한**을 통제하는 보안 계층이다.
- AI Employee가 권한을 요구하는 Action을 수행하기 전에는 Security Office의 Permission 정책을 확인한다.
- 권한은 기본적으로 **Allow / Ask / Deny**로 구분하며, 위험도가 높은 행동은 Meeting Room의 사용자 결재로 넘긴다.
- Agent는 자신의 권한을 스스로 확장할 수 없으며, 필요한 경우 권한 변경을 제안만 할 수 있다.
- 권한 판단은 **Agent × Resource × Action × Risk** 조합을 기준으로 설계한다.
- Vault 내부의 저위험 작업은 자동 허용할 수 있지만, 삭제·외부 전송·민감한 변경 등 되돌리기 어렵거나 영향이 큰 행동은 보수적으로 처리한다.
- **Agent Vault에는 버전 관리 시스템 사용을 필수화하며 기본 수단은 Git으로 한다.** 파일 수정·삭제 등의 사고가 발생해도 이전 상태를 추적하고 복구할 수 있어야 한다.
- API Key, OAuth Token 등 Secret은 Agent Context에 직접 노출하지 않고, 필요 시 인증된 실행 과정에서만 사용한다.
- Workshop은 실행 능력을 제공하고 Security Office는 그중 **무엇을 실제로 허용할지 결정**하며, 중요한 행동은 Audit Log에도 기록한다.
- 핵심 목적은 **AI의 자율성을 유지하면서도 권한 통제·변경 추적·복구 수단을 통해 인간이 위험을 관리할 수 있게 하는 것**이다.
## 9. Idea Bank
- Idea Bank는 인간과 AI가 **떠오른 생각을 제한 없이 기록하는 공용 아이디어 공간**이며, 아이디어는 즉시 Task나 지식으로 확정하지 않는다.
- 아이디어의 **숙성은 단순히 일정 시간을 기다리는 것이 아니라**, 새로운 상황과 다른 생각 속에서 반복적으로 다시 검토·연결하는 과정이다.
- 아이디어는 양이나 완성도를 제한하지 않고 자유롭게 축적하며, 생성 당시부터 과도하게 분류하거나 평가하지 않는다.
- 사용자가 Idea Bank를 확인할 때는 아이디어를 **무작위로 재노출**하여 오래된 생각도 새로운 맥락에서 다시 만날 수 있게 한다.
- 일정 주기마다 Manager Agent가 전체 Idea Bank를 검토하여 **중복·유사 아이디어를 통합하고, 연관된 아이디어를 그룹화하거나 서로 연결**한다.
- Manager Agent의 정리는 아이디어를 구조화하기 위한 것이며, 아이디어의 가치 자체를 최종 판단하지 않는다.
- 인간 사용자는 가치가 없다고 판단한 아이디어를 직접 삭제할 수 있다.
- 인간과 Agent는 각 Idea에 의견과 새로운 연결을 추가할 수 있으며, 원래 생각과 이후 논의의 흐름을 추적할 수 있어야 한다.
- 충분히 발전한 Idea는 인간의 판단을 거쳐 Project·Task·Meeting Room의 제안 또는 Library의 장기 지식으로 발전할 수 있다.
- 핵심 목적은 **많은 생각을 자유롭게 축적하고, 의도적인 재노출·연결·정리 과정을 통해 양질의 아이디어가 자연스럽게 살아남도록 만드는 것**이다.
## 10. Rest Room
- Rest Room은 Agent가 하나의 Session과 사고 맥락에 과도하게 고착되는 것을 방지하기 위한 Context Reset과, 서로 다른 작업·아이디어 사이의 새로운 연결을 유도하는 Idea Cross-Pollination 공간이다.
- Rest는 Task의 중단이나 종료를 의미하지 않는다. Agent는 현재 작업 상태를 Desk에 Checkpoint한 뒤 Session을 초기화하고, Context Recovery를 통해 동일한 Task를 다시 이어간다.
- Agent가 일정 Session Budget을 소모하면 Rest Room에 진입해 현재 작업을 잠시 멈춘다.
- Rest 직전 세션의 맥락을 유지한 채, 현재 작업에서 파생된 Idea를 추출해 Idea Bank에 보낸다.
- 이후 Idea Bank에서 적당히 먼 연관성을 가진 Idea를 꺼내 현재 세션의 관점으로 검토한다.
- 이 과정에서 발견한 새로운 연결이나 해석은 원본 Idea를 수정하지 않고 **Comment 또는 Connection**으로 남긴다.
- 서로 다른 Project·Task·Agent의 맥락에서 반복적으로 Idea를 검토함으로써 의도적인 우연과 새로운 연결의 발생 빈도를 높인다.
- Rest Room에서의 목적은 Idea의 최종 가치를 판단하는 것이 아니라 **새로운 관점을 생성하는 것**이다.
- Idea 검토가 끝나면 세션을 초기화하고, Agent는 Desk로 돌아가 현재 Task의 맥락을 다시 구성한다.
- Rest 과정에서 Agent는 현재 작업에서 파생된 Idea를 Idea Bank에 남기고, 다른 맥락에서 생성된 Idea를 검토할 수 있다. 
  이 과정의 목적은 Idea의 가치를 판단하거나 일정 시간 동안 숙성시키는 것이 아니라, 서로 다른 맥락 사이의 연결 가능성을 탐색하는 것이다.
- 이후 Agent는 기존 작업을 새로운 관점에서 재검토하고 이어서 수행한다.
## 11. Manager's Office
- Manager's Office는 인간 관리자가 Nidus 전체의 상태를 한눈에 확인하고 필요한 곳에 개입하는 **운영 대시보드**다.
- 자체적인 Source of Truth를 만들지 않고, Home·Task Board·Meeting Room·Security Office 등 각 공간의 정보를 집계해 보여준다.
- 주요 화면에는 **Active Projects, Active Agents, Task Overview, Pending Decisions, Alerts, Cost & Usage, Recent Activity, System Health** 등을 표시한다.
- 정상적으로 진행되는 정보는 요약하고, 실패·Blocked Task·보안 경고·결재 대기처럼 **주의가 필요한 항목은 우선적으로 강조**한다.
- 사용자는 이 화면에서 Project와 Task의 진행 상황, Agent 배치, 우선순위, 비용과 사용량을 확인할 수 있다.
- Meeting Room의 결재 요청이나 Security Office의 경고 등 즉각적인 판단이 필요한 항목으로 바로 이동할 수 있어야 한다.
- Manager Agent 역시 이 정보를 활용해 Project 진행 상태를 점검하고 Task 조정이나 개선안을 제안할 수 있다.
- 다만 Manager Agent의 모든 행동 역시 기존 Permission과 Human Approval 정책을 따라야 한다.
- 핵심 UX는 **“모든 활동을 감시하는 화면”이 아니라 “지금 인간의 주의가 필요한 것을 압축해서 보여주는 화면”** 이다.
- Manager's Office는 Nidus의 주요 GUI이자 인간과 AI 조직 전체를 연결하는 최상위 관리 화면 역할을 한다.
# AI Employee
---
- AI Employee는 특정 Model이나 Session이 아니라, **Home에 지속적인 정체성을 가진 작업 주체**다.
- Model이 변경되거나 Session이 초기화되어도 Home·Desk·Task Board를 통해 기존 업무를 복원하고 이어갈 수 있어야 한다.
- AI Employee는 하나의 **Group에 소속**되고, 그 안에서 자신의 Role을 가진다.
- 상위 역할군은 **Manager와 Worker**로 구분한다.
- Manager는 Group당 1명만 존재하며 Project 관점에서 업무를 조직하고 Task를 조정한다.
- Worker는 Researcher, Developer, Analyst 등 전문 Role을 가지고 Task 단위의 실제 업무를 수행한다.
- 역할은 Group이나 Project 시작 시 기본적으로 정하며, 실행 중에는 가능한 한 변경하지 않는다.
- 일시적으로 다른 역량이 필요하면 가장 가까운 Worker가 해당 역할을 겸하고, 반복적인 수요가 확인되면 신규 Employee 생성을 제안한다.
- Model은 Employee 정체성과 분리하며, 기본적으로 Manager에는 고성능·고비용 모델, Worker에는 비용 효율적인 모델을 배치한다.
- 어려운 Task 등 필요한 경우 Worker도 일시적으로 더 높은 성능의 Model을 사용할 수 있도록 한다.
# Group & Role
---
- Group은 특정 Project에 종속되지 않는 **기능·전문 도메인 중심의 상설 팀**이다.
- Finance, Development, Marketing 등 각 Group은 자신의 전문 영역을 담당하며 하나의 Project에 여러 Group이 함께 참여할 수 있다.
- 각 Group은 **Manager 1명과 여러 Worker**로 구성하며, 자주 필요한 기본 Role을 미리 보유한다.
- Domain Group에도 간단한 코드·자동화·MVP를 수행할 Developer 등 범용 Role을 둘 수 있다.
- 복잡하거나 Production 수준의 전문 작업은 Development Group 등 해당 전문 Group으로 넘긴다.
- 새로운 Role이 일시적으로 필요하면 기존 Worker가 겸하며, 반복적으로 필요해지면 Manager가 Meeting Room을 통해 신규 Employee 생성을 제안한다.
- 별도로 **Red Team Group**을 두어 다른 Group의 결정·아이디어·Project 진행을 독립적인 관점에서 검증한다.
- Red Team은 내부 의사결정 과정에 깊게 동화되지 않은 상태에서 목표·결과·핵심 근거를 받아 전제, 취약점, 실패 시나리오와 반례를 공격적으로 검토한다.
- Red Team의 목적은 무조건 반대하는 것이 아니라, **외부의 실제 비판을 견딜 수 있을 만큼 결정과 아이디어를 강하게 만드는 것**이다.
- Red Team의 비판은 최종 결정이 아니며, 중요한 충돌과 미해결 문제의 최종 판단권은 인간 사용자에게 있다.
# Runtime Flow
---
## 전체 구조
```text
┌───────────────────────────────────────────────────────────────┐
│                         HUMAN MANAGER                         │
│              방향 설정 · 결재 · Feedback · 개입                │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                         PROJECT LOOP                          │
│                                                               │
│ Idea → 철학/전제 → 기획 → MVP → Feedback → Update → Deploy    │
│                         → Feedback → Update                   │
│                         → Review → Knowledge                  │
│                                                               │
│                     Lead Manager                              │
│                      NEXT PHASE                               │
└──────────────────────────────┬────────────────────────────────┘
                               │
                      Phase Goal / Exit Condition
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        Finance Group    Development Group   Marketing Group
              │                │                │
              └────────────────┼────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                       GROUP MANAGER LOOP                      │
│                                                               │
│ Phase 확인                                                    │
│    ↓                                                          │
│ 필요한 Task 식별                                              │
│    ↓                                                          │
│ Task 분해 · Worker 배정                                       │
│    ↓                                                          │
│ 진행상황 · 의존성 관리                                        │
│    ↓                                                          │
│ 결과 통합                                                     │
│                                                               │
│                    Group Manager                              │
│                      NEXT TASK                                │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                        WORKER LOOP                            │
│                                                               │
│ Home → Desk → Task Board → Library → Desk Update             │
│                               │                               │
│                               ▼                               │
│                      NEXT ACTION                              │
│                               │                               │
│                      Security Office                          │
│                               │                               │
│          ┌────────────────────┼────────────────────┐          │
│          ▼                    ▼                    ▼          │
│      Workshop           Meeting Room          Library         │
│          │                    │                    │          │
│          └────────────────────┼────────────────────┘          │
│                               ▼                               │
│                         Result                                │
│                               ↓                               │
│                         Desk Update                            │
│                               ↓                               │
│                  Task / Library 필요 시 갱신                    │
│                               ↓                               │
│                    SESSION BUDGET CHECK                       │
│                       ↙             ↘                         │
│                  Continue            Rest                     │
│                     │                 │                       │
│                Next Action       Rest Room                    │
│                                       ↓                       │
│                                  Session Reset                │
│                                       ↓                       │
│                              Context Recovery ───────┐         │
│                                                     │         │
│                     Worker = NEXT ACTION  ◀──────────┘         │
└───────────────────────────────────────────────────────────────┘


             ┌────── PHASE COMPLETION ──────┐
             │                               │
             ▼                               │
┌──────────────────────────────┐             │
│       RED TEAM REVIEW        │             │
│                              │             │
│ 전제 공격                    │             │
│ 취약점 탐색                  │             │
│ 실패 시나리오                │             │
│ 반례 / 대안                  │             │
└───────────────┬──────────────┘             │
                │                            │
        ┌───────┼────────┐                   │
        ▼       ▼        ▼                   │
      Pass    Revise   Conflict              │
        │       │        │                   │
        │   추가 Task   Meeting Room          │
        │       │        │                   │
        └───────┴────────┘                   │
                │                            │
                ▼                            │
             NEXT PHASE ─────────────────────┘
```
### Runtime의 핵심 계층
```text
Human
  │
  ▼
Lead Manager
  └─ "다음 Phase는 무엇인가?"
             │
             ▼
Group Manager
  └─ "다음 Task는 무엇인가?"
             │
             ▼
Worker
  └─ "다음 Action은 무엇인가?"
             │
             ▼
Session Runtime
  └─ "계속할 것인가, Rest할 것인가?"
```
Nidus는 이 네 가지 판단 Loop가 서로 중첩되어 동작하는 구조다.

---
## 1. Project Loop
```text
Idea
  ↓
Project 기본 전제·철학
  ↓
Project 기획서
  ↓
MVP
  ↓
Feedback
  ↓
Update
  ↓
Deploy
  ↓
Feedback
  ↓
Update
  ↓
Project 결과 검토
  ↓
Knowledge Integration
  ↓
Project Close
```
Project는 하나의 거대한 Task가 아니라 여러 **Phase**의 연속으로 진행한다.
Project에는 전체 진행과 Phase를 책임지는 **Lead Manager**를 지정한다.  
Project를 처음 제안하거나 기획한 Group은 Origin으로 기록할 수 있지만, Origin Group과 Lead Manager의 소속 Group이 반드시 같을 필요는 없다.
Project의 성격이나 주요 업무 영역이 크게 변경되는 경우 Lead Manager는 변경될 수 있다. 
Lead Manager 변경은 Project의 중요한 운영 변화로 기록하며, 기존 Project Goal과 주요 Decision은 그대로 유지한다.
각 Phase에는 다음 두 요소를 명확히 한다.
- **Goal** — 이번 Phase에서 무엇을 달성하는가.
- **Exit Condition** — 어느 상태가 되어야 Phase가 완료되었다고 판단하는가.
하나의 Project에 여러 Group이 참여할 수 있다.
Lead Manager는 각 Group의 구체적인 작업 방식을 통제하지 않고 **Phase의 목표와 제약조건을 제공**한다.
각 Group은 그 범위 안에서 자율적으로 업무를 수행한다.

---
## 2. Lead Manager Loop
```text
현재 Project 확인
      ↓
현재 Phase 확인
      ↓
Goal / Exit Condition 확인
      ↓
필요한 Group 및 Task 파악
      ↓
Group별 업무 전달
      ↓
진행상황 확인
      ↓
Phase 결과 통합
      ↓
Exit Condition 판단
      ↓
Red Team Review
      ↓
다음 Phase / 수정
```
Lead Manager의 핵심 책임은 **Project를 앞으로 이동시키는 것**이다.
Lead Manager는 다음을 담당한다.
- Project의 전체 방향 유지
- Phase 정의
- Phase Goal 및 Exit Condition 관리
- 필요한 Group 결정
- Group 사이의 의존성 조정
- Feedback을 Decision 또는 Task로 변환
- Phase 완료 판단
- Red Team에 Project의 결정과 결과 방어
- 다음 Phase 진입 판단
즉 Lead Manager의 핵심 질문은 다음과 같다.
> **“현재 Project는 다음 Phase로 넘어갈 준비가 되었는가?”**

### Lead Manager Loop의 Stopping Condition
- Lead Manager는 현재 Phase의 **Exit Condition이 충족되기 전까지** 필요한 Group과 Task를 조정하며 Project를 계속 진행한다.
- Exit Condition이 충족되면 Red Team Review와 필요한 검증을 거쳐 다음 Phase로 이동할 수 있다.
- Project가 더 이상 진행될 수 없는 중대한 Blocker를 만나거나, 방향 변경 또는 중단에 대한 인간의 판단이 필요한 경우에는 Meeting Room으로 Escalation한다.
- 최종 Phase 이후 Project Closure 조건이 충족되면 Project Loop를 종료한다.

---
## 3. Group Manager Loop
```text
Phase Goal 확인
      ↓
필요한 Task 탐색
      ↓
Task Decomposition
      ↓
Worker 배정
      ↓
Task 진행상황 확인
      ↓
의존성 / Blocker 확인
      ↓
결과 수집
      ↓
필요 시 추가 Task
      ↓
Group 결과 전달
```
각 Group Manager는 Project 전체가 아니라 **자신의 전문 영역**을 책임진다.
예를 들어 하나의 투자 서비스 Project에서:
```text
Finance Group
→ 금융 논리와 투자 모델

Development Group
→ Production 수준 구현

Marketing Group
→ SNS · 콘텐츠 · 홍보
```
처럼 역할을 나눌 수 있다.
Group Manager는 Phase Goal을 자신의 영역에 맞는 Task로 분해하고 Worker에게 배정한다.
따라서 Group Manager의 핵심 질문은 다음과 같다.
> **“현재 Phase 목표를 달성하기 위해 우리 Group이 다음으로 수행해야 할 Task는 무엇인가?”**

### Group Manager Loop의 Stopping Condition
- Group Manager는 Phase Goal을 달성하기 위해 자신의 Group에서 수행해야 할 Task가 존재하는 동안 Task를 생성·조정한다.
- Group이 맡은 책임 범위의 결과가 충족되면 더 이상 불필요한 Task를 생성하지 않고 결과를 Lead Manager에게 전달한다.
- 필요한 Task를 더 이상 정의할 수 없지만 Group의 책임 결과가 충족되지 않은 경우에는 이를 완료로 간주하지 않고 **Blocked** 상태로 전환하거나 상위 판단을 요청한다.
- 다른 Group의 결과나 인간의 결정이 필요한 경우에는 해당 의존성이 해소될 때까지 Waiting 또는 Blocked 상태로 둔다.

---
## 4. Agent Context Recovery
Worker가 새로운 Task를 시작하거나 Session을 다시 시작할 때는 항상 Context를 복원한다.
> Context Recovery는 Desk의 내용을 단순히 다시 읽는 과정이 아니라, 현재 시스템 상태와 Desk의 작업 맥락을 다시 일치시키는 과정이다.
```text
Home
  ↓
Desk
  ↓
Task Board
  ↓
필요한 Library 탐색
  ↓
Desk Update
  ↓
Action Loop
```
### Home
Agent가 자신의 Identity, Role과 현재 작업 위치를 확인한다.
### Desk
마지막 Session까지의 작업 맥락과 현재 진행상황을 복구한다.
### Task Board
Task의 최신 상태, 담당 Agent, 의존성 등을 확인한다.
### Library
현재 Task에서 실제로 필요한 장기 지식만 탐색한다.
### Desk Update
새롭게 확보한 정보를 기존 작업 맥락에 반영한다.
이 과정을 끝낸 후에만 Agent가 실제 작업을 시작한다.
### Context Recovery Integrity
Desk가 참조하는 Task 상태, Decision, 파일 변경 등의 검증 가능한 정보는 Context Recovery 과정에서 해당 Source of Truth의 최신 상태와 대조한다.
현재 사고 과정, 미완성 가설, Next Action 등 Desk가 유일한 Source of Truth인 Native Working Context는 외부 사실과 완전히 검증할 수 없으므로, Checkpoint History와 Version History를 통해 손상과 유실을 방어한다.
다른 공간에 Source of Truth가 존재하는 사실에 충돌이 발생하면 해당 Source of Truth를 우선한다. Desk 고유의 Working Context는 최근 정상 Checkpoint를 기준으로 복구한다.

---
## 5. Worker Action Loop
Worker의 실제 업무는 다음 Loop를 반복한다.
```text
Desk
 ↓
Next Action
 ↓
Security Office
 ↓
Action 실행
 ↓
Result
 ↓
Desk Update
 ↓
Task / Library 필요 시 Update
 ↓
Session Budget Check
     │
 ┌───┴────┐
 │        │
Continue  Rest
 │        │
 ▼        ▼
Next    Rest Room
Action    ↓
       Session Reset
```
Worker는 항상 Desk의 최신 상태를 기준으로 **Next Action**을 판단한다.
실제 Action을 수행하기 전에는 Security Office의 Permission 정책을 확인한다.
작업 결과가 나오면 우선 Desk를 최신 상태로 만든다.
Task 수준의 상태가 의미 있게 바뀐 경우 Task Board를 갱신한다.
장기적·반복적으로 필요한 정보가 만들어졌다면 Library에도 기록한다.

### Worker Action Loop의 Stopping Condition
- Worker는 Task의 Completion Contract가 충족되기 전까지 유효한 Next Action을 계속 탐색하고 실행한다.
- 더 이상 의미 있는 Next Action을 찾지 못했다는 사실만으로 Task를 완료해서는 안 된다.
- Next Action이 없더라도 Acceptance Criteria가 충족되지 않았다면 **Blocked**, **Waiting**, 또는 **Escalation** 상태로 전환한다.
- 인간의 판단이 필요하면 Meeting Room으로 이동하고, 외부 의존성이나 다른 Task의 결과가 필요하면 해당 의존성이 해소될 때까지 실행을 멈춘다.
- Completion Contract의 Acceptance Criteria가 충족되고 Verification을 통과한 경우에만 Task Completion Loop로 이동한다.

---
## 6. Action Routing
Next Action의 종류에 따라 Agent가 사용하는 Office가 달라진다.
```text
Next Action
    │
    ├─ 코드 / 조사 / 분석 / 테스트
    │       └→ Workshop
    │
    ├─ 인간 판단 필요
    │       └→ Meeting Room
    │
    ├─ 장기 지식 탐색 / 기록
    │       └→ Library
    │
    ├─ Task 상태 변경
    │       └→ Task Board
    │
    └─ 새로운 Idea 발생
            └→ Idea Bank
```
따라서 Workshop만이 Agent의 작업 공간은 아니다.
Agent는 Action의 성격에 따라 Office의 여러 공간을 이동하며 Task를 수행한다.

---
## 7. Human Attention Loop
Agent가 스스로 판단해서는 안 되는 문제를 만나면 Meeting Room으로 이동한다.
```text
Issue 발견
   ↓
Meeting Room
   ↓
안건 작성
   ↓
Waiting
   ↓
Human Decision
   ↓
Desk Update
   ↓
Runtime Resume
```
Agent는 다음 내용을 정리하여 인간에게 전달한다.
- 안건
- 배경
- 판단 근거
- 가능한 선택지
- 각 선택지의 영향
인간의 결정이 내려지면 해당 내용을 Desk와 Task에 반영하고 작업을 재개한다.
장기적으로 중요한 Decision이라면 Library에도 기록한다.

### Human Attention Loop의 Stopping Condition
- Human Attention Loop는 필요한 Human Decision이 기록될 때까지 Waiting 상태를 유지한다.
- 인간의 결정이 내려지면 해당 Decision을 Desk와 Task 상태에 반영하고, 필요한 경우 새로운 Constraints 또는 Acceptance Criteria를 적용한 뒤 Runtime을 재개한다.
- 인간이 Task 또는 Project의 중단을 결정한 경우에는 Runtime을 재개하지 않고 해당 범위의 종료 절차로 이동한다.

---
## 8. Session / Rest Loop
Worker는 무한히 하나의 Session에서 작업하지 않는다.
```text
Working
   ↓
Session Budget 도달
   ↓
Desk Final Checkpoint
   ↓
Rest Room
   ↓
현재 Session의 Idea 추출
   ↓
Idea Bank
   ↓
다른 Idea 검토
   ↓
Comment / Connection
   ↓
Session Reset
   ↓
Context Recovery
   ↓
Task 재평가
   ↓
Working
```
Rest Room 진입은 Task 종료를 의미하지 않는다.
Task는 계속 **In Progress** 상태이며 Agent의 Session만 초기화된다.
Session 종료 전에 반드시 Desk를 최신 상태로 만들어 새로운 Session이 이전 작업을 복구할 수 있도록 한다.
초기 구현에서는 Session Budget을 Token Usage를 중심으로 판단할 수 있다.

### Session Loop의 Stopping Condition
- Session은 Session Budget에 도달하거나 명시적인 Reset이 필요할 때 종료한다.
- Session의 종료는 Task의 종료를 의미하지 않으며, Task가 완료되지 않았다면 Desk Final Checkpoint를 남긴 후 Context Recovery를 통해 다음 Session에서 이어서 수행한다.
- 복구가 불가능한 오류나 상태 불일치가 발생하면 자동으로 작업을 계속하지 않고 Blocked 또는 Escalation 상태로 전환한다.

---
## 9. Task Completion Loop
Task는 Worker가 작업을 멈췄거나 결과물을 생성했다는 이유만으로 완료되지 않는다.  
Task의 완료 여부는 **Completion Contract**를 기준으로 판단한다.

```text
Candidate Result
     ↓
Acceptance Criteria 확인
     ↓
Verification
     ↓
┌───────────────┐
│    Pass ?     │
└───────┬───────┘
        │
   ┌────┴────┐
   │         │
  No        Yes
   │         │
   ▼         ▼
Next Action  Desk Final Update
/ Blocked         ↓
/ Escalation  Task Result 기록
                 ↓
            Task Completed
                 ↓
            Task Archive
                 ↓
          장기 지식 추출
                 ↓
          Manager에게 결과 전달
```

### Completion Contract
각 Task의 Completion Contract는 최소한 다음 요소를 포함한다.

- **Goal** — 이 Task가 달성해야 하는 목적
- **Scope** — 이번 Task에서 다루는 범위
- **Constraints** — 작업 중 지켜야 할 조건과 제한
- **Acceptance Criteria** — 완료로 인정할 수 있는 관찰 가능한 조건
- **Verification** — Acceptance Criteria 충족 여부를 확인하는 방법
- **Result** — 실제 수행 결과, 검증 결과, 주요 변경사항과 남은 제한

Completion Contract는 상위 Agent가 하위 Agent의 세부 행동을 지시하기 위한 문서가 아니다.  
Manager는 **무엇을 달성해야 하며 어떤 상태가 되면 완료인지**를 정의하고, Worker는 그 범위 안에서 Next Action을 자율적으로 결정한다.

Acceptance Criteria가 충족되지 않았거나 Verification을 통과하지 못한 경우 Task를 Completed로 전환해서는 안 된다.  
추가로 수행할 수 있는 Action이 있다면 Worker Loop로 돌아가고, 유효한 Next Action이 없거나 외부 판단이 필요한 경우에는 **Blocked, Waiting, Escalation** 등 적절한 상태로 전환한다.

Task가 완료되면 활성 Task 목록에서는 제거하지만 기록 자체를 삭제하지 않는다.
Task Archive에는 최소한 다음 정보를 보존한다.
- Task Brief
- Completion Contract
- 최종 Result 및 Verification 결과
- 중요한 변경 이력
- 주요 Decision

Task 과정에서 얻은 모든 내용을 Library에 넣지는 않는다.
**장기적으로 또는 반복적으로 필요한 내용만 Library로 승격한다.**

---
## 10. Red Team Loop
Red Team은 모든 Task에 개입하지 않는다.
**각 Project Phase가 끝날 때** 기본적으로 Red Team Review가 시작된다.
```text
Phase Result
     ↓
Red Team
     ↓
┌───────────────┐
│ 전제 공격      │
│ 취약점 탐색    │
│ 실패 시나리오  │
│ 반례 탐색      │
│ 대안 제시      │
└───────┬───────┘
        ↓

   ┌────┼─────┐
   ▼    ▼     ▼

 Pass  Revise  Conflict
   │     │       │
   │   Task    Meeting
   │   생성     Room
   │     │       │
   └─────┴───────┘
         ↓
     Next Phase
```
Red Team의 역할은 결정을 내리는 것이 아니라 **결정이 현실의 공격을 견딜 수 있는지 검증하는 것**이다.
Manager는 Red Team의 비판이 틀렸다고 판단하면 근거를 들어 방어한다.
비판이 타당하다면 추가 Task를 만들어 수정한다.
중대한 판단 충돌은 인간에게 전달한다.

---
## 11. Project Closure & Knowledge Loop
최종 Phase가 끝났다고 Project가 바로 종료되는 것은 아니다.
```text
Final Phase
     ↓
Project Result Review
     ↓
Red Team
     ↓
Project Close
     ↓
Decision / Lesson / Result 정리
     ↓
Library
     ↓
Dream Sequence
```
Project 종료에서는 최소한 다음을 검토한다.
- 무엇을 만들었는가.
- 무엇이 성공했는가.
- 무엇이 실패했는가.
- 어떤 Decision이 중요했는가.
- 다시 수행한다면 무엇을 바꿀 것인가.
- 다른 Project에서도 사용할 수 있는 지식은 무엇인가.
이 결과는 Library의 장기 지식 체계에 통합된다.
따라서 Nidus에서 Project의 최종 단계는 단순한 **Completion**이 아니라 **Knowledge Integration**이다.

---
## Runtime Loop의 공통 종료 원칙

Nidus의 각 판단 Loop는 무한히 Next Phase, Next Task, Next Action을 생성하지 않는다.  
각 Loop는 자신의 책임 수준에 맞는 **계속 조건과 종료 조건**을 가져야 하며, 더 이상 진행할 수 없는 상태를 임의로 성공으로 해석해서는 안 된다.

| Loop | 계속하는 조건 | 종료·중단 조건 |
|---|---|---|
| Project / Lead Manager Loop | Project Goal을 향해 유효하게 진행 가능 | Project Closure 충족 / Human 중단 / 중대한 Escalation |
| Phase Loop | Exit Condition 미충족 | Exit Condition 충족 / Blocked / Human Direction 변경 |
| Group Manager Loop | Group 책임 범위에 필요한 Task 존재 | Group 결과 충족 / Blocked / Waiting |
| Task Loop | Completion Contract 미충족 | Verification 통과 / Cancelled / Escalated |
| Worker Action Loop | 유효한 Next Action 존재 | Task 완료 / Blocked / Waiting / Human 판단 필요 |
| Session Loop | Session Budget 이내 | Budget 도달 / Reset 필요 / 복구 불가능 오류 |
| Human Attention Loop | Human Decision 대기 | Decision 기록 / 중단 결정 |

특히 **“더 이상 할 일이 없다”는 사실만으로 Task나 Phase를 완료해서는 안 된다.**  
완료는 각 계층에 정의된 Exit Condition 또는 Completion Contract가 충족되었을 때만 성립한다.

## 핵심 원칙
```text
Lead Manager  → Next Phase
Group Manager → Next Task
Worker        → Next Action
Runtime       → Continue / Rest
Human         → Direction / Final Decision
```
Nidus의 Runtime은 이 서로 다른 수준의 판단이 반복적으로 연결되면서 동작한다.
상위 계층은 하위 계층의 세부 행동을 Micro-manage하지 않고 **목표·제약·상태를 전달한다.**
하위 계층은 주어진 범위 안에서 가능한 한 자율적으로 판단하고 실행한다.
그리고 중요한 전환점에서는 **Red Team과 Human Manager가 Project의 방향을 다시 검증한다.**