# Phase 4.3 — API 계정 과금 유형과 Provider 실행 권한

2026-10-26, `feature/usage-ledger-budget-guard`.

## 확정한 정책

기존 계정은 최초 한 번 재확인한다. 기존 Gemini 프로젝트·NVIDIA Free 설정·Provider Plan은 참고 정보로 보존하지만 실행 권한으로 자동 승계하지 않는다. 유료 승인은 **Provider 전체의 현재·향후 모델**에 적용하며 모델별 유료 승인 기능은 제공하지 않는다. 신규 관리자 자격 증명/OAuth/IAM 연결은 범위 밖이다.

| 상태 | 실행 정책 |
|---|---|
| Free Only | 사용자 확인된 무료 전용 계정 + 공식 무료 지원 모델만 허용. 유료 전용/미확인 모델은 수동도 차단. 무료 소진을 기록한 모델은 제외. |
| Hybrid | 무료 티어가 있어도 자동 과금 전환 가능 요청은 유료로 판단. Provider 유료 승인 필요. 현재 어댑터에는 요청별 과금 불가능을 확정하는 별도 무료 전용 전송 옵션이 없어 무료로 추측하지 않음. |
| Paid Only | Provider 유료 승인이 있어야 호출. |
| Unknown | 자동 호출 차단. 수동 채팅·단일 검사는 요청별 위험 승인으로만 실행. 일괄 검사는 skipped 처리. |

Free Only에서 시작한 자동 실행은 유료 승인 여부와 관계없이 무료 후보로만 Fallback한다. Hybrid/Paid Only는 각 대상 Provider의 승인을 확인한다. 사용자 Tier 순서와 동일 Tier 우선순위를 유지한다. 타임아웃·네트워크 오류는 중복 처리 가능성이 있어 Fallback하지 않는다.

**금액 예산, 지출 한도, 비용 예약은 도입하지 않았다.** 유료 승인된 모델은 가격 미확인이라도 실행할 수 있으며 비용을 미확인으로 기록한다. 실패·사용량 누락을 확인된 0원으로 바꾸지 않는다.

## 연결과 UI

공통 Key 등록 화면에서 네 가지 과금 유형을 선택한다. Unknown으로 모델 조회만 완료할 수 있다. 연결 카드와 Tier 화면의 **과금 유형 / 실행 권한 설정**에서 연결 후에도 수정할 수 있다. Free Only에는 무료 전용 계정 확인과 과금 위험 고지를, Hybrid/Paid Only에는 기본 꺼짐인 Provider 전체 유료 승인 토글을 제공한다. 과금 유형 변경 시 UI의 유료 승인 토글은 초기화된다.

계정 정보는 키 fingerprint에 묶으며 Cloudflare의 키 표현에는 Account ID도 포함된다. 키 교체·연결 해제·관측된 환경 키 변경 시 승인을 무효화한다. 기존 키로 돌아와도 자동 복원하지 않는다. 모델 새로고침은 승인을 유지한다. 계정 설정 화면을 연 뒤 키 또는 권한이 바뀌면 revision 검사로 오래된 저장 요청을 거부한다.

계정 유형은 `user-declared` 또는 `unverified`로 표시하고 확인 시각과 공식 조건 출처를 별도로 제공한다. 이전 무료 설정은 재확인용 힌트다. 공식 요금 문서는 사용자 계정의 실제 Billing 검증 결과가 아니다. 모델별 무료 상태 편집은 가용성 정보이며 유료 승인을 대신하지 않는다.

Unknown 수동 요청은 차단 응답을 받은 뒤 과금 위험 확인창을 표시한다. 사용자가 동의하면 해당 Provider·모델·작업·키·계정 revision에 한정된 5분 유효 일회용 토큰으로 다시 전송한다. 최초 차단에서는 API를 호출하지 않는다. 단일 검사 응답에 담긴 권한 오류도 같은 흐름으로 처리하며, 자동 라우팅·일괄 검사에서는 확인창을 띄워 우회하지 않는다.

## 공통 실행 경로와 API

`ConnectivityEngine.execute()` 직전의 SQLite `BEGIN IMMEDIATE` 트랜잭션에서 현재 계정·승인·모델 무료 지원·Tier를 확인하고 요청 기록 및 일회용 토큰 소비를 원자적으로 처리한다. 자동 요청은 선택 시의 계정 revision과 무료/유료 구분도 비교한다. 권한 철회가 이 트랜잭션보다 먼저 확정되면 전송하지 않는다. 이미 실행 승인되어 전송된 요청을 소급 취소하거나 Provider의 청구를 차단한다고 보장하지 않는다.

로컬 권한 거절은 `execution_permission`이며 `account_unknown`, `provider_paid_not_approved`, `free_model_unverified`, `free_unavailable`, `account_changed` 등의 사유를 반환한다. HTTP 인증 오류와 구분하여 로컬 거절 때문에 Provider를 인증 실패로 제외하지 않는다. 요청별 적용한 계정 정보·권한 근거와 차단 사유를 기록한다. 라우팅 로그는 제외 사유도 보존한다.

Dashboard 인터페이스:

- `account-permission`: 현재 키의 계정 상태, 승인, revision, 출처 및 확인 정보.
- `account-permission-set`: state, paidAllowed, confirmed, riskAccepted, 선택 accountId와 expectedRevision.
- `request-consent`: provider, model, task(chat/probe), riskAccepted. 응답 token을 단일 수동 요청의 consentToken에 전달.
- `connect`: 선택 billing 객체(state/paidAllowed/confirmed/riskAccepted). 잘못된 설정은 모델 조회 및 키 저장 전에 거절.

기존 `gemini-billing-set`, `provider-plan-set`, `nvidia-free-setup`의 명시적 무료 확인은 새 Free Only 상태도 설정한다. 구형 paid 값만으로 유료 승인을 부여하지 않으며 재확인을 요구한다. 과거 모델별 승인과 `allowPaid`는 새 Provider 권한의 근거가 아니다.

CLI는 `billing`, `billing-set`, 연결 시 `--billing-type`, `--allow-paid`, `--confirm-billing`, `--accept-charge-risk`를 제공한다. Unknown의 수동 chat은 `--approve-once`로 한 번 승인한다. 자동 모드와 함께 사용할 수 없다. 구체적 예시는 README에 있다.

## SQLite 및 데이터 보호

schema 7은 `account_permissions`, `execution_consents`, `permission_events`를 추가한다. schema 6 및 이전 사용량·예산·예약·계정 메타데이터·Tier·라우팅 기록은 삭제하지 않는다. 계정 설정 및 승인 철회는 revision을 증가시키고 남은 일회용 토큰을 무효화한다.

키 원문은 Keychain/환경 자격 증명에만 둔다. SQLite의 fingerprint는 계정 연결 판단에만 사용하고 UI/공개 응답/라우팅 로그에 노출하지 않는다. 프롬프트·응답 본문은 Ledger에 저장하지 않는다. 신규 요청은 계속 `reserved=0`, `bound=NULL`이며 과거 예약은 역사적 기록으로 보존한다.

## 공식 문서 확인과 조회 범위

이번 검토에서 현재 Nidus 추론 연결로 계정의 네 가지 과금 유형을 확정할 수 있는 조회는 연결하지 않았다. 모든 계정 확인을 사용자 선언으로 표시하며 `officialVerification=not-connected`와 조회 제한을 반환한다. 잔액이나 모델 목록 조회 성공을 무료 전용의 증거로 사용하지 않는다. 별도 권한이 필요한 Billing 연결을 임의로 추가하지 않았다.

확인한 공식 근거:

- [Gemini Billing](https://ai.google.dev/gemini-api/docs/billing): 프로젝트 Billing과 무료/유료 사용 조건. API key가 Cloud Billing IAM 인증을 대신한다고 가정하지 않는다.
- [NVIDIA NIM FAQ](https://docs.api.nvidia.com/nim/docs/product): Developer Program의 호스팅 API 평가 접근. 자체 호스팅·상용 구독과 구분한다.
- [Groq Billing FAQ](https://console.groq.com/docs/billing-faqs): Free/Developer 플랜과 결제 설정. Rate Limit 헤더를 무료 잔량으로 사용하지 않는다.
- [Mistral Usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits): Free 모드와 조직별 사용 조건. 조직의 실제 모드를 모델 ID에서 추론하지 않는다.
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/): Free/Paid와 무료 할당량 이후 과금 조건. [일부 모델의 Paid 제한](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)도 모델별로 구분한다.
- [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance/): 잔액·사용 가능 여부 조회이며 무료 전용 계정 유형을 증명하지 않는다.
- 기존 OpenAI/Anthropic 조직 사용량 조회는 별도 관리자 인증 경로로 유지하며 추론 키를 재사용하지 않는다. 조직 보고 금액만으로 계정의 과금 유형을 자동 확정하지 않는다.

모델별 무료 지원은 기존 Pricing/Provider의 검토된 자료를 사용한다. 공식 무료 지원 미확인 모델을 임의로 무료 처리하지 않으며 남은 무료 요청 수를 생성하지 않는다.

## 검증 결과

- PASS — `npm test`: TypeScript strict build 및 Node Mock 테스트 **157개**, 실패 0. 새 계정 정책 전용 20개 포함.
- PASS — `swift test --scratch-path /tmp/nidus-phase43`: Swift 테스트 **39개**, 실패 0. 계정 정보 표시와 수동 승인·취소·단일 검사 transport 테스트 5개 추가.
- PASS — `npm run build:app`: `dist/Nidus.app` 로컬 unsigned 개발 번들 빌드.
- PASS — `git diff --check`.
- NOT RUN — 실제 Provider 인증/모델 조회/무료·유료 추론, 실제 청구 검증, 실제 계정 Billing 조회 및 화면 수동 조작.

주요 검증: Gemini/NVIDIA 무료 전용 연결, 미확인·유료 모델 차단, Hybrid/Paid Only 승인과 철회, Provider 간 무료 Fallback, 미승인 유료 Fallback 차단, Unknown 일회용 승인·만료·재사용·키/모델/작업 범위, 동시 토큰 소비, 별도 SQLite 연결의 승인 철회, 선택 후 무료→유료 상태 변경, 키 교체 후 재확인, 오래된 설정 화면 저장 거절, schema 6 재확인 마이그레이션 및 schema 7 재시작 복원, CLI/SwiftUI 정책 일치. 기존 금액 예산이 0이어도 승인된 요청이 실행되고 신규 예약이 생기지 않는 것을 유지했다.

## 변경 파일과 한계

실행·저장은 `src/ledger.ts`, `engine.ts`, `dashboard.ts`, `cli.ts`, `errors.ts`, `health.ts`, `types.ts`를 수정했다. SwiftUI는 새 `AccountPermissions.swift`와 기존 App/ChatRooms/Models/RoutingSettingsView/NvidiaFreeSetupView를 수정했다. 새 Node·Swift 권한 테스트 및 기존 엔진·라우팅·마이그레이션 테스트를 갱신했다.

사용자 선언이 실제 결제 상태와 다르면 비용이 발생할 수 있다. 외부 콘솔에서 Billing을 변경한 사실을 Nidus가 자동으로 알지 못한다. 승인된 유료 사용에 금액 한도는 없으며 로컬 비용 추정과 최종 청구는 다를 수 있다. Free Only에서도 무료 잔량과 실제 계정 권한은 Provider 응답으로 최종 결정된다.

시작/종료 develop HEAD: `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b`.
main HEAD: `723c03b59dcecaae27d9fe0a9f97b464c785d706` (변경 없음).
구현 커밋: `a0bfe0d` — 기능: 계정 과금 유형과 Provider 실행 권한 적용.
현재 feature 브랜치에서만 작업하며 develop 병합, 원격 push 및 PR 생성은 수행하지 않는다.
