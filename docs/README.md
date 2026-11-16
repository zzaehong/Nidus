# 문서 목차

처음 사용하는 경우 [설치와 실행](../README.md) → [사용 가이드](guides/USER_GUIDE.md) 순서로 읽으세요. 개발 작업은 [작업 지침](AGENTS.md)과 [Git Flow](Git_Flow.md)를 따릅니다.

사용 방법은 사용 가이드를 기준으로 확인하고, 아래 단계별 문서는 설계 결정과 당시 검증 범위를 확인할 때 사용합니다. 과거 문서의 PASS 수치나 완료 범위는 현재 전체 제품의 검증 결과를 뜻하지 않습니다. 제품 구상과 개발 계획 역시 구현 완료 목록이 아닙니다.

## 사용 안내

- [사용 가이드](guides/USER_GUIDE.md)
- [모델 분류와 일괄 검사](guides/MODEL_HEALTH.md)
- [설정 UI 개선 (2026-10-26)](guides/Settings_UI_Refinement.md)

## 설계와 제품 구상

- [API Connectivity MVP 아키텍처](architecture/API_CONNECTIVITY.md)
- [Agent Vault](architecture/CONCEPT.md)
- [1단계 설계 — Model Gateway와 Model Assignment](architecture/STAGE1_MODEL_GATEWAY.md)
- [2단계 설계 — Agent Workspace](architecture/STAGE2_AGENT_WORKSPACE.md)
- [3단계 설계 — AI Office](architecture/STAGE3_AI_OFFICE.md)

## Provider 연결과 모델 분류

- [Phase 4.2 — Provider 확장 및 연결 UX](providers/Phase4_2_Provider_Expansion.md)
- [NVIDIA NIM 용도 분류 개선](providers/NVIDIA_Model_Classification.md)
- [모델 동작 검사 free_model_unverified 수정](providers/Model_Probe_Consent_Fix.md)

## 라우팅과 계정·비용 정책

- [Phase 4 — Task-Aware Model Router](routing/Phase4_Model_Router.md)
- [Phase 4.1 — 사용자 설정 Tier Router](routing/Phase4_1_Tier_Router.md)
- [Phase 4.1 추가 개선 — Tier 재검증, 무료 사용 상태, 드래그 순서](routing/Phase4_1_Free_Use.md)
- [Phase 4.3 — API 계정 과금 유형과 Provider 실행 권한](routing/Phase4_3_Account_Permissions.md)
- [Phase 4.4 — Routing Decision Context](routing/Phase4_4_Routing_Context.md)

## Vault와 Agent Runtime

- [Phase 5–6: Agent Runtime · Vault VM · Unified Tools](vault/Phase5_6_Agent_Runtime_Vault_Sandbox.md)
- [M1a — Vault Registration & Identity Foundation](vault/Vault_M1a_Registration.md)
- [M1b — Vault Environment & Execution Admission](vault/Vault_M1b_Environment_Admission.md)
- [M2 + M3 — Unified Tools and Single-Agent Runtime](vault/Vault_M2_M3_Tool_Agent_Runtime.md)
- [M4 Vault 영속 디스크와 패키지 캐시](vault/Vault_M4_Persistent_Cache.md)
- [M2/M3 보완 및 M4 Shared VM Runtime — 개발 검토 결과](vault/Vault_M4_Shared_VM_Runtime.md)
- [Vault와 캐시의 장치 번호 변경 복구](vault/Vault_Device_Identity.md)
- [VM 관리 서비스 유실 복구](vault/Vault_M4_VM_Recovery.md)
- [Vault Runtime 모델 선택·VM 상태 개선](vault/Vault_Runtime_Model_Status_Review.md)
- [Vault Runtime v2 개발 기준과 M1~M6 계획](vault/Vault_Runtime_v2_Plan.md)

## 브라우저

- [격리 브라우저 DOM 조작 개선](vault/browser/Vault_Browser_DOM.md)

- [브라우저 신뢰성 P0–P2](vault/browser/Vault_M4_Browser_Reliability.md)
- [브라우저 후속 모델 응답 실패 진단 및 초기 승인 개선](vault/browser/Vault_M4_Browser_Response_Fix.md)
- [Google 기본 검색과 브라우저 실시간 보기](vault/browser/Vault_M4_Browser_Screen.md)
- [M4 개발 환경·Workspace·Browser·Network](vault/browser/Vault_M4_Development_Browser_Network.md)
- [M4 대화형 브라우저](vault/browser/Vault_M4_Interactive_Browser.md)
- [M4 제한적 인터넷과 읽기 전용 브라우저](vault/browser/Vault_M4_Read_Only_Browser.md)
- [Vault Runtime 검사 통과 모델 필터와 웹 검색 상태](vault/browser/Vault_Runtime_Health_Filter_Web_Status.md)

## 검증 이력

- [검증 이력과 구현 상태](validation/VALIDATION.md)
- [API Connectivity MVP 검증 기록](validation/CONNECTIVITY_VALIDATION.md)
- [macOS API Dashboard 검증](validation/DASHBOARD_VALIDATION.md)

## 과거 정책과 수정 이력

Budget Guard 등 이전 정책을 설명하는 기록입니다. 현재 계정 실행 권한은 [Phase 4.3](routing/Phase4_3_Account_Permissions.md), Soft Budget은 [Phase 4.4](routing/Phase4_4_Routing_Context.md)를 참고하세요.

- [Phase 3 — Usage Ledger & Budget Guard](history/Phase3_Usage_Budget.md)
- [Budget Guard 제거 — 2026-10-26](history/Budget_Guard_Removal.md)
- [Gemini 프로젝트 Free Tier와 Budget Guard](history/Gemini_Free_Tier_Fix.md)
- [NVIDIA Budget Guard 차단과 무료 설정 보완](history/NVIDIA_Free_Setup_Fix.md)

## 검증 원본과 문서 관리

[evidence/](evidence/)에는 실제 실행 결과와 실패 기록을 보존합니다. 기존 증거 파일의 이름·내용·경로는 문서 정리를 위해 변경하지 않습니다.

새 문서는 해당 주제 폴더에 추가하고 이 목차에 연결합니다. 사용 절차는 사용 가이드에 모으고, 구현 문서에는 변경 이유·제약·검증 근거를 남깁니다. 정책이 대체된 문서는 삭제하지 않고 이력으로 구분하며 현재 문서로 연결합니다.
