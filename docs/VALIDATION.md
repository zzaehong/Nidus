# 검증 이력과 구현 상태

이 문서는 기존 단계별 기록을 2026-10-30에 통합한 것입니다. **단계별 결과 표는 당시 실행 기록입니다. 이후 재검증은 별도 날짜 섹션에 기록합니다.** 전체 상세 기록은 Git의 `fd3efae` 시점과 이전 커밋에 남아 있습니다.

## 2026-11-01 설계 갱신 안내

현재 설계는 Vault 소유 VM Environment/Instance, Host·VM·Provider Gateway, 단일 Agent의 순차 Step으로 갱신했다. VM 브라우저 검색/탐색은 필수이며 검색 API는 도입하지 않는다. 이 변경은 문서 작업으로 신규 실행/검증 결과가 아니다. M0 잔여 검증·Manager 사망 후 추가 복구 개발은 후속 과제로 두며, 미검증 조건을 우회해 Shell/browser를 활성화하지 않는다.

이하 「현재 기준」 및 날짜별 기록은 당시 상태를 보존한다. 새 Session 정리·VM 재사용·이미지 API·공유 VM 격리는 아직 검증되지 않았다. 최신 설계는 [Phase 5–6 문서](Phase5_6_Agent_Runtime_Vault_Sandbox.md) 앞부분을 따른다.

## 현재 기준

- Phase 4.4까지의 API 연결·Tier Router·계정 권한·Usage Ledger·Soft Budget 구현은 develop `81ecb88`에 통합됐습니다.
- Phase 5–6은 설계·M0 진단 단계입니다. **M0 종료 안전성 FAIL**로 Shell backend를 채택하지 않았으며 M1–M6 제품 기능은 미구현입니다.
- 최근 기록(2026-10-28): Node 171개 PASS, Swift 42개 PASS, 기존 macOS 앱 빌드 PASS. 이 결과를 Agent E2E나 실제 Provider 성공으로 해석하지 않습니다.
- 실제 무료·유료 Provider 인증·추론·청구 확인은 아래 개발 검증에서 NOT RUN입니다. 캐시 표시·분류 평가는 라이브 연결 검증이 아닙니다.

## M0 생명주기 재검증 (2026-10-30)

- 기존 setsid 종료 실패 재현. 독립 Supervisor prototype도 setsid·이중 fork·추가 자손·Supervisor SIGKILL에서 FAIL. 제품 backend는 미채택, M1–M6는 계속 보류합니다.
- Node 전체 회귀 174개 PASS, 진단 판정 단위 테스트 3개 PASS. Swift·앱 빌드·실제 Provider API는 NOT_RUN(제품 코드 변경 없음).
- 파일 쓰기와 외부 loopback listener로 실제 활동을 관측했습니다. fixture의 자체 수명 종료, PID 존재 확인, 신호 전송만으로 생명주기 PASS를 부여하지 않습니다.
- [상세 대안·재현 절차](Phase5_6_Agent_Runtime_Vault_Sandbox.md#m0-생명주기-재검증--2026-10-30), [실측 JSON·소스 해시](evidence/Phase5_6_M0_Lifecycle.json). 원본 M0 evidence와 과거 FAIL 기록은 보존합니다.

## Ponytail 원칙 적용 점검 (2026-10-30)

- Provider Adapter, 실행·라우팅 경로, Ledger/Context, SwiftUI 연결 구조를 검토하고 변경은 중복 제거와 입력 검증 보완에 한정했습니다. 전면 재작성이나 전체 보안 감사는 아닙니다.
- 모델 ID 검증을 공통 함수로 통합하고 Cloudflare 조회에도 적용했습니다. DeepSeek 요청 구성은 기존 호환 API helper를 재사용하되 Provider별 사용량 해석은 유지했습니다.
- Cloudflare 자격 증명 검증의 JSON 재직렬화·재파싱과 라우팅 제외 후보의 중복 정책 계산을 제거했습니다. 신규 의존성, DB 마이그레이션, 권한·예산 정책 변경은 없습니다.
- PASS: Node 173개, Swift 42개, macOS unsigned 앱 빌드, `git diff --check`. 추가 Mock은 잘못된 모델 ID·저장 자격 증명의 네트워크 전송 차단과 정상 조회/미발견 처리를 검증합니다.
- 최초 제한 환경의 Node 실행은 localhost 바인딩 EPERM으로 실패했고, 로컬 Mock 서버 실행 권한을 부여한 전체 재실행은 통과했습니다.
- NOT RUN: 실제 Provider API, 수동 GUI 검증, M0 재진단. 기존 M0 종료 안전성 FAIL과 backend 미채택 상태는 그대로입니다.

## 단계별 결과

Node는 `npm test`, Swift는 `swift test` 또는 당시 임시 scratch 경로를 사용했습니다. 앱 빌드는 표시된 각 단계에서 로컬 unsigned 번들 기준 PASS이며, API Connectivity MVP 행은 앱 도입 전입니다.

| 단계 | Node PASS | Swift PASS | 별도 검증·주요 변경 |
|---|---:|---:|---|
| Connectivity MVP, 10/23 | 42 | — | synthetic Keychain 1, 숨김 키 PTY·CLI PASS; 실제 API 8 NOT RUN |
| macOS Dashboard, 10/23 | 45 | 7 | synthetic Keychain 1; 앱 초기 화면·엔진 준비·Gemini 캐시 표시 수동 확인 |
| 모델 분류·검사, 10/24 | 52 | 13 | 비지원 제외·동의·사용량·순차 검사 |
| 검사 실패 후 진행, 10/24 | 52 | 15 | 첫 429 후에도 다른 모델 검사, 같은 모델 재시도 없음 |
| 검사 기록 보존, 10/24 | 52 | 19 | 임시 파일로 재시작 복원·재검사·손상 보존 검증 |
| Phase 3, 10/24 | 68 | 21 | 당시 예산·동시 예약·정산·관리자 키 분리; 초기 예산 화면 수동 확인 |
| Phase 4 Router | 80 | 24 | 난이도·모델 선택·안전한 Fallback |
| Phase 4.1 Tier 설정 | 91 | 27 | 사용자 순서·Tier 유지·SQLite 경쟁 상태 |
| Phase 4.1 무료 상태·드래그 | 102 | 30 | 실행 직전 Tier 재검사·무료 승인·마이그레이션 |
| Gemini 무료 프로젝트 | 112 | 31 | 과금 상태·429·무료 토큰·유료 승격 차단 |
| Phase 4.2, 10/25 | 129 | 33 | Provider 4종 추가; synthetic Keychain 5 PASS |
| NVIDIA 분류, 10/25 | 133 | 33 | 로컬 캐시 85개에서 미분류 77→5; API 호출 없음 |
| NVIDIA 무료 설정, 10/25 | 137 | 34 | 선택 모델 승인·미검토 모델 거절·키 변경·429 |
| Budget Guard 제거, 10/26 | 137 | 34 | 금액 차단·신규 예약 제거, 과거 데이터 유지 |
| Phase 4.3 계정 권한, 10/26 | 157 | 39 | 과금 유형·Provider 유료 승인·일회용 동의 |
| 설정 UI 정리, 10/26 | 157 | 40 | 메뉴 분리·무료 전체 선택·부분 실패 재시도 |
| 목록 크기·Gemini 화면, 10/26–27 | 재실행 안 함 | 40 | 실제 Gemini 캐시 60개 초기 표시·스크롤 확인 |
| Phase 4.4 Context | 168 | 41 | 집계·가격 버전·스키마·비밀정보 제외·Soft Budget |
| Context v2 보완·develop 병합, 10/27–28 | 169 | 42 | coverage·insufficient_data; 병합·원격 이력 통합 후 회귀 PASS |
| Phase 5–6 M0, 10/28 | 171 | 42 | 기존 앱 빌드 PASS, 별도 보안 게이트 FAIL |

## 실패와 수정 이력

성공 결과만 남기지 않도록 원인을 함께 보존합니다.

- 초기 설치·CLI 실행: Sandbox DNS(ENOTFOUND)·npm 캐시 쓰기 제한. 필요한 권한으로 재실행 후 성공.
- 초기 Mock: quota fixture의 헤더 중복 설정으로 38 PASS/1 FAIL. fixture 수정 후 전체 통과.
- 모델 검사·Phase 3 등: localhost listen EPERM 및 Swift 캐시 접근 제한으로 최초 실행 실패. 권한을 갖춘 동일 테스트 재실행 후 PASS.
- Phase 4.1: 89 PASS/1 FAIL. 모델 등급만 바꾸고 독립 Tier 값을 유지한 fixture를 수정해 통과.
- Budget Guard 제거: 이전 차단 정책을 기대한 테스트 실패. 새 호출·미확인 비용·예약 없음 정책에 맞춰 갱신 후 통과.
- 설정 UI: Swift 컴파일·새 fixture 오류 수정 후 통과. 초기 Model Tier 화면 조정만으로 Gemini Provider 레이아웃 문제는 해결되지 않았고, 후속 NavigationSplitView 상세·HSplitView 크기 제한으로 재현 화면을 확인.
- Context: 모델 배열 순서를 가정한 신규 fixture 3건 수정 후 통과. v2에서는 아주 작은 사용률이 소수 둘째 자리 절삭으로 0이 되는 동작에 맞춰 테스트 수정 후 통과.
- M0: 중첩 Sandbox 적용 거부와 최소 프로필 SIGABRT를 구분. 루트 디렉터리 조회 권한 추가로 시작 성공. curl 실패를 네트워크 차단 성공으로 취급하지 않고 socket fixture로 EPERM/EACCES를 재검증.

## M0 보안 게이트: 미통과

[원본 JSON evidence](evidence/Phase5_6_M0_Sandbox.json)는 변경 없이 보존합니다. [설계와 다음 검증안](Phase5_6_Agent_Runtime_Vault_Sandbox.md)을 참고하세요.

- PASS: 최소 실행, Vault 내부 읽기·쓰기, 외부 파일 읽기·쓰기 거부, `.nidus`·`.env` 보호, 외부 symlink 거부, localhost socket 권한 거부.
- FAIL: process group 종료 뒤 `setsid()`로 분리된 자식이 heartbeat 파일 쓰기를 계속함. 별도 SIGKILL 및 fixture 자체 10초 수명 제한으로 정리.
- NOT RUN: 격리 내부 Swift/Xcode 빌드, 전용 브라우저, 완전한 descendant supervisor, 승인 프로토콜·M1–M6 E2E, 실제 웹 검색.
- 단순 PID/프로세스 그룹 종료가 부족하다는 재현이며 sandbox-exec의 모든 구현이 불가능하다는 증명은 아님. XPC도 종료 안전성을 자동 보장한다고 가정하지 않음.

재현 명령 `node scripts/agent-sandbox/probe.mjs`는 임시 fixture와 loopback만 사용합니다. 미자격 상태이므로 exit 1이며 일반 회귀 테스트 PASS와 별개입니다. 제품 backend를 활성화하지 않습니다.

## 남은 검증과 재실행

```sh
npm test
swift test
npm run build:app
npm run test:keychain
npm run test:live
```

실제 API 테스트는 명시적 opt-in이 필요합니다. 모델 조회는 `NIDUS_LIVE=1`, 채팅은 추가로 `NIDUS_LIVE_CHAT=1` 및 `NIDUS_<PROVIDER>_MODEL`을 설정합니다. 자격 증명은 외부 환경에서 주입하며 테스트가 기존 Keychain 키를 자동 사용하지 않습니다. 실제 호출은 과금될 수 있습니다.

미검증: 실제 Billing/무료 잔량, Provider 전체 라이브 연결, 신규 화면 대부분의 수동 조작, 비밀번호 제안 억제, 장시간 부하·동시 키 교체, Intel·최소 OS·다른 Mac, 정식 서명·공증. Gemini 60개 모델 화면 확인을 모든 창 크기·다중 모니터 검증으로 확대하지 않습니다.

## 통합한 문서

현재 사용법은 [사용 가이드](USER_GUIDE.md), 데이터·호출 구조는 [아키텍처](API_CONNECTIVITY.md), JSON 계약은 [Routing Context](Phase4_4_Routing_Context.md)에 모았습니다.

삭제한 중복 문서: `CONNECTIVITY_VALIDATION.md`, `DASHBOARD_VALIDATION.md`, `MODEL_HEALTH.md`, `Phase3_Usage_Budget.md`, `Phase4_Model_Router.md`, `Phase4_1_Tier_Router.md`, `Phase4_1_Free_Use.md`, `Gemini_Free_Tier_Fix.md`, `Phase4_2_Provider_Expansion.md`, `NVIDIA_Model_Classification.md`, `NVIDIA_Free_Setup_Fix.md`, `Budget_Guard_Removal.md`, `Phase4_3_Account_Permissions.md`, `Settings_UI_Refinement.md`.

특히 과거 예산 예약·80/90/100% 차단·무조건 호출 허용·Provider Plan만의 실행 승인 정책은 현행 안내에서 제거했습니다. 현재는 계정 권한 검사와 참고용 Soft Budget을 사용합니다. 상세 원문은 `git show fd3efae:docs/<이전 파일명>`으로 조회할 수 있습니다. `AGENTS.md`, `CONCEPT.md`, `Git_Flow.md`는 이 정리에서 수정하지 않았습니다.


## VM M0 추가 검증 (2026-10-30)

Apple Virtualization + Linux ARM64 별도 prototype 실제 실행: 시나리오 **9 PASS / 1 NOT_RUN**, 제한된 보안 검사 **7 PASS**. Worker SIGKILL 이후 활동은 멈췄지만 실제 VM 정지는 확인하지 못하여 전체 자격은 미통과다. M1~M6/제품 Shell은 비활성 상태로 유지한다. 기존 native 실패 Evidence는 보존한다.

Node 174개, Swift 42개, workspace 6개 PASS. 제품 앱 packaging·실제 API·실제 SwiftUI crash는 NOT_RUN. 환경, 초기 실패, 재현 명령, 파일·네트워크 범위 및 정리 보류 항목은 [설계 기록](Phase5_6_Agent_Runtime_Vault_Sandbox.md#vm-기반-m0-재검증--2026-10-30)과 [VM Evidence](evidence/Phase5_6_M0_VM.json)를 참조한다.

## 독립 VM Manager M0 (2026-10-31)

작업 Worker와 VM 소유 Manager를 분리한 실제 VM 검증은 8 PASS / 1 NOT_RUN이다. Worker SIGKILL·연결 단절·heartbeat 만료·timeout 후 Manager가 VM 종료를 확인했다. Manager 자체 SIGKILL은 종료 미확인으로 남고 신규 실행을 차단한다. M0 전체 자격 및 M1~M6 보류는 유지한다.

Node 174, Swift 42, workspace 6, Manager 정책 4개 PASS. 기존 VM 모드 회귀는 9 PASS / 1 NOT_RUN, 보안 검사 7 PASS. 최초 Node 실행의 localhost EPERM은 환경 제한으로 기록하고 권한 허용 후 재검증했다. 상세 제한과 원시 이벤트는 [Manager Evidence](evidence/Phase5_6_M0_VM_Manager.json)를 참조한다. 기존 실패 Evidence는 수정하지 않았다.

## VM Lifecycle Recovery (2026-10-31)

실제 Manager SIGKILL 5회: 5초간 파일·로컬 패킷 추가 활동 없음, 관측된 Virtualization 서비스 소멸. 활동 관측은 모두 PASS지만 권위 있는 종료 근거는 **5 UNCONFIRMED**다. 정상 취소/중복 종료, 중복 시작 차단, Worker 종료, Supervisor 종료, 합성 앱 연결 상실은 **5 PASS**. 종료 오류·완료 미도착 주입 2건은 종료 증명 NOT_RUN, 미확인 처리·재실행 차단 정책은 PASS다. 실제 framework 내부 오류와 실제 SwiftUI crash로 확대 해석하지 않는다.

Node 174, Swift 42, workspace 6, Manager 4, lifecycle 4개 PASS. 상태 불일치는 단위 테스트에서 현재 상태를 주입해 검증한다. launchd는 공식 기능을 검토했으며 설치하지 않았다. M0 전체 미통과 및 M1~M6 보류를 유지한다. [Recovery Evidence](evidence/Phase5_6_M0_VM_Recovery.json)에 원시 관측과 판정 근거를 보존한다.

## M0 사용자 복구 UI (2026-10-31)

실제 VM 복구 bridge: 안전 종료와 Worker 종료 2 PASS, Manager 사망의 종료 증명 1 UNCONFIRMED. 장애 차단/채널 비활성 정책은 PASS. Swift 46개(복구 Mock 4개), Python 21개, Node 174개 PASS. macOS release 앱 packaging PASS.

부팅 UUID 조회는 확인했으나 실제 호스트 재부팅·실제 앱 crash·수동 UI E2E는 NOT_RUN이다. headless 캡처는 텍스트 표시가 확인되지 않아 시각 QA PASS로 계산하지 않는다. 새 [사용자 복구 Evidence](evidence/Phase5_6_M0_VM_User_Recovery.json)와 [설계 문서](Phase5_6_Agent_Runtime_Vault_Sandbox.md)에 제한을 기록했다. M0 전체 통과가 아니며 M1~M6는 보류한다.
