# Nidus Conceptual System Design v2 — v1 대비 변경 요약

## Added
- **Local Agent Host**: 장시간 켜져 있는 개인 컴퓨터를 주요 운영 환경 중 하나로 명시하고, Agent Vault·Nidus Runtime·AI Employees·Workshop 실행 환경·Git·격리 수단·외부 Model/API 연결의 개념적 배치를 설명했다. Mac mini는 예시이며 필수 하드웨어가 아니다.
- **Intelligence Layer**: Deterministic Layer / Decision Engine / Generative / Reasoning Model의 책임을 구분했다.
- **Decision Engine**: 제품에 독립적인 선택·평가 구성요소로 정의했다. JEV는 유력한 candidate implementation의 예시이며 필수 종속성이 아니다.
- Next Action 후보 선택, Task/Action Routing, Tool/Model Selection, Risk Classification, Permission 보조, 관련성 평가, 검색 reranking, Verification/Guardrail 보조를 활용 가능 영역으로 제시했다. 모두 확정 기능으로 간주하지 않는다.
- Intelligence Layer와 Runtime 책임 계층의 관계를 별도 개념 다이어그램으로 추가했다.
- 미확정 구현 선택을 Technical Design 절로 모았다.

## Modified
- 문서 시작의 구성요소 목록에 Local Agent Host와 Intelligence Layer를 추가했다.
- Agent Vault 절의 축약된 작업 계층 표기를 **Agent Vault > Project > Phase > Task > Action**으로 명시했다. 기존 Runtime의 Phase와 Action 개념을 반영한 표기 보완이며 Standalone Task는 유지했다.
- Home의 Model Assignment 설명에 새 Intelligence Layer 절의 연결을 추가했다.
- Workshop에 Local Agent Host와의 실행 환경 관계를 추가하고 Docker의 구체적 적용 범위가 미확정임을 명시했다.
- 기존 Model Assignment를 Execution Model 선택과 연결하고 **Employee Identity / Decision Engine / Execution Model**을 분리했다.

## Unchanged
- v1 원본 파일을 유지했으며, 기존 본문은 위 연결·표기 보완 외에 유지했다.
- Agent Vault의 파일시스템 경계, 사용자 Library와 `.nidus/`의 분리, Secret 분리, 이동·복사·백업 원칙.
- AI Office의 11개 공간과 Home / Library / Desk / Task Board / Workshop의 역할 및 Source of Truth 구분.
- Completion Contract, Project → Phase → Task → Action 계층, Standalone Task.
- Lead Manager → Group Manager → Worker → Runtime 판단 책임 계층.
- Context Recovery와 Integrity, Session / Rest Loop, Human Attention Loop, Red Team.
- 각 Runtime Loop의 Stopping Condition과 기존 전체 Runtime Flow 다이어그램.
- Project Closure와 Knowledge Integration의 기존 흐름.
- AI Employee와 Model의 분리 및 Manager / Worker 모델 배치 원칙.
- Security Office의 Permission, Human Approval, Git 기반 변경 추적 원칙. Decision Engine은 이 정책과 완료 조건을 우회하거나 대체하지 않는다.

## 아직 Technical Design에서 결정해야 할 사항
- DB 종류와 저장 방식.
- Queue 구조와 작업 스케줄링 구현.
- Process architecture, Runtime framework.
- vector DB 및 agent framework의 사용 여부와 제품 선택.
- 특정 model provider와 외부 Model/API 연결 구현.
- Docker 사용 범위와 sandbox·브라우저 격리 방식.
- Local Agent Host의 daemon/service 방식과 실행 수명주기.
- Decision Engine 구현(JEV 포함), 연계 인터페이스, 적용 범위.
- Intelligence Layer의 수단 선택 기준 및 판단 불가·실패 시 처리 방식.

이번 수정은 개념적 책임과 실행 환경의 위치를 동기화하며, 위 기술 선택이나 활용 가능 영역을 구현 완료 또는 확정 기능으로 선언하지 않는다.
