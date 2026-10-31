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

## 실행 환경과 단계별 범위

Vault는 VM Environment의 소유 단위다. 하나의 Vault에 활성 VM Instance는 최대 1개이며 필요할 때 시작하고 유휴 시 종료할 수 있다. VM은 Worker나 Task에 귀속되지 않으며, 향후 여러 AI Employee가 공유할 수 있다. 초기에는 단일 Agent와 VM Execution Session 1개만 실행한다.

실행 자원은 Host File Gateway(허용된 파일 읽기·승인된 변경), Vault VM Gateway(Shell·코드·테스트·실제 브라우저 검색/탐색), Provider Tool Gateway(이미지 생성 등 API)로 분리한다. 모델은 공통 Tool을 호출하며 실행 환경·권한은 Nidus가 결정한다. 웹 검색 API는 사용하지 않는다. VM은 원본 Vault를 직접 수정하지 않고 승인된 Workspace와 Host의 검토·반영 절차를 사용한다.

Task는 Step으로 나누고 VM이 필요한 Step만 VM slot을 점유한다. Host 읽기·LLM 추론·이미지 API는 slot을 사용하지 않는다. 모델 선택과 도구 실행 환경은 독립적이다. VM 재사용은 이전 Session의 프로세스·쿠키·네트워크 권한을 승계한다는 뜻이 아니다.

아래 AI Office와 세션 복구는 장기 개념이다. **Phase 5–6은 단일 Agent의 순차 Step 및 실행 감사**, **Phase 7은 Home/Desk/Library·Memory·Persistent Task Context**, **Phase 8은 Multi-Agent·Task Board·Worker 조정**으로 구분한다. Phase 5–6에서 앱 재실행 후 Task를 자동 재개하지 않는다. 구체 계약과 미검증 조건은 [Phase 5–6 설계](Phase5_6_Agent_Runtime_Vault_Sandbox.md)를 따른다.

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
그리고 중요한 전환점에서는 **Red Team과 Human Manager가 Project의 방향을 다시 검증한다.**