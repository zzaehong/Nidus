# 현재 계획 / Current plan

2026-10-13: Provider Connection Foundation v1을 로컬 develop에 통합한다. Provider Manifest, macOS Keychain CredentialStore, Connection Registry/Probe, 영속 Model Catalog, 최소 AI 연결 설정 UI 구현과 실제 OmniRoute/Keychain 검증을 마쳤다. 기존 Task/Plan policy·Runtime은 유지하며 Route Broker, GUI v2, Dynamic Organization은 후속 범위다.

시작 로컬 develop: `7ef6a4d` (원격 develop `11a36f39df42c7e9272c68237a1061bfe00d737a` 포함). main 기준 `d9bd9d0069cef5157a283bea2a0af365c99d44b6`. 시작 시 수정된 사용자 지시문 `doc/prompt.md`를 `61490cc`로 보존했다.

| 기능 브랜치 | 기능 commit | develop merge / 회귀 |
|---|---|---|
| feature/provider-foundation | `b3f2e4f` Registry/Keychain/discovery/probe/catalog + 보안/fake HTTP | `07afc91`, 129 PASS |
| feature/provider-settings-ui | `2566793` 연결 설정/관리, GUI API 보안, key 손실 복구 | `7026e6a`, 133 PASS |
| feature/connection-evidence | 설정 변경 시 Probe 표시 초기화, 실제 증거·재현 harness·문서 | 최종 통합 HEAD는 완료 응답 및 Git 이력 참조 |

각 기능은 관련 테스트 후 commit → develop merge → 전체 회귀 뒤 다음 브랜치를 생성했다. 한글 commit/merge 메시지를 사용하며 사후 이력 재작성, main 변경, release/hotfix, push, PR은 하지 않는다.

검증: discovery 133 + 기존 HTTP 7 + frontend 10. 실제 Keychain CRUD PASS. 실제 OmniRoute는 모델 2개 발견 후 `gh/gpt-4o-mini`(actual `gpt-4o-mini`)의 일반/구조화 응답 PASS. 브라우저는 합성 fixture로 재검사와 관리 표시를 확인했다. 개인 Vault 자료를 전송하지 않았다.

[연결 사용법/설계/한계](../CONNECTIONS.md), [검증 이력](../VALIDATION.md), [실제 Probe](../evidence/connection-omniroute-live.json), [Keychain](../evidence/connection-keychain.json), [GUI](../evidence/connection-gui-review.json).

다음 권장 단계: 현재 검증된 Connection/Catalog를 소비하는 제한적인 Route Broker를 정의한다. 역할별 capability 요구와 기존 policy 호환 경계를 먼저 정하고, 그 이후 업무별 모델/정책 입력을 줄이는 GUI를 진행한다.

2026-10-13 사용 중 확인한 운영 조건: 다중 API 게이트웨이는 실제 사용 가능한 채팅 모델·Provider 연결만 허용한 제한 키로 연결한다. 모든 모델 키에서 735개가 발견되어도 현재 이름순 3개 검사로는 적합한 후보를 고르지 못해 HTTP 400으로 실패할 수 있다. 후속 Route Broker 작업 전에 capability/가용성 기반 Probe 후보 선택과 구체적인 GUI 실패 설명을 보완한다. 이는 현재 Nidus의 제약이며 게이트웨이 자체의 필수 제약으로 일반화하지 않는다.
