# Gemini 프로젝트 Free Tier와 Budget Guard

2026-10-25 / `feature/usage-ledger-budget-guard`

실제 로컬 장부를 읽기 전용으로 조사한 결과, Gemini probe 24건 중 가격이 등록된 2건은 `budget_not_configured`, 나머지 22건은 `unknown_price_or_bound`로 차단됐다. 예산 설정은 없었다. 기존 경로는 프로젝트 결제 상태 없이 유료 가격으로 최대 컨텍스트 비용을 예약했다. 모델별 무료 사용 승인은 과금 동의이며 무료 비용을 뜻하지 않았다.

## 사용 방법

Model Tier 및 Routing Policy → **Gemini 프로젝트 결제 상태 설정**에서 현재 API 키에 해당하는 Google 프로젝트 ID와 `free`, `paid`, `unknown`을 설정한다. Free 선택에는 실제 프로젝트 상태 확인과 과금 위험 안내 동의가 모두 필요하다. 이 설정은 사용자 확인이며 Google Billing API 검증이 아니다. 테스트 과정에서 사용자 계정 설정을 대신 변경하지 않았다.

- Free: 공식 검토된 무료 지원 모델의 표준 텍스트 요청만 예약 0 USD로 실행한다. 현재 정확한 지원 ID는 `gemini-2.5-flash`, `gemini-3.5-flash-lite`다. 다른 ID/별칭은 추측하지 않는다. 가격 자료가 30일을 초과하면 재검토 전 차단한다.
- Paid / Unknown: 기존 전체·Provider·요청 예산 및 자동 유료 승인 정책을 유지한다.
- Free에서 무료 지원 미확인 모델 또는 사용 불가로 기록한 모델은 차단한다. 수동 예산 예외로 우회할 수 없다.
- API 키 해시와 프로젝트 확인을 연결하고, 키 변경 시 실행 직전에 차단한다. 재연결/연결 해제는 Unknown으로 초기화한다. 모델 목록 새로고침과 앱 재시작은 설정을 보존한다.
- Google에서 같은 키의 프로젝트 결제를 활성화하는 변경은 자동 감지하지 못한다. 즉시 Paid 또는 Unknown으로 변경해야 한다. 잘못된 Free 설정은 **로컬 예산 외 실제 과금**을 일으킬 수 있다.

## 실행과 기록

`quote → reserve(BEGIN IMMEDIATE) → GeminiAdapter → settle` 공통 경로를 사용한다. reserve에서 현재 프로젝트/자격 증명, 모델 무료 지원, Tier/revision 및 기존 예산 정책을 검증한다. 무료로 시작한 자동 요청은 Fallback에서도 유료 후보로 전환하지 않는다. Gemini HTTP 429 `RESOURCE_EXHAUSTED`는 기존 `rate_limit` 분류와 모델 cooldown을 유지하며 잔액 부족으로 바꾸지 않는다. 타임아웃/네트워크 오류는 자동 재시도하지 않는다.

SQLite schema 5는 `gemini_project`, `request_billing`을 추가한다. 기존 요청·예약·정책·예산은 수정하지 않고 기존 요청은 유료 정책으로 해석한다. 요청 시점 billing mode와 사용자 확인 근거를 저장해 이후 설정 변경이 과거 정산을 바꾸지 못하게 한다. 무료 성공은 토큰과 추정 비용 0을 기록하지만 Provider 확인 비용으로 주장하지 않는다. 사용량 없는 실패는 비용 미확인으로 남긴다. Provider 증거가 나중에 실제 비용을 확인하면 기존 reconcile을 사용할 수 있다.

Usage & Budget 요청 목록에 무료 프로젝트/유료 정책을 표시한다. 차단 오류 JSON의 `reason`, 메시지와 장부 `blockReason`에서 세부 사유를 확인한다. API 키, 프롬프트, 응답 본문은 저장하지 않는다. 남은 무료 할당량은 `null`이며 생성하거나 추정하지 않는다.

## 공식 근거

2026-10-25 확인: [Gemini Billing](https://ai.google.dev/gemini-api/docs/billing), [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting). 프로젝트 결제 계층과 모델별 표준 무료 지원을 구분한다. 일반 추론 키로 실제 프로젝트 결제 상태/남은 무료 할당량을 자동 조회하는 기능은 구현하지 않았다.

## 검증

- Node Mock/회귀: 112 PASS (무료/유료/미확인, 미검토 모델, 429, 유료 승격 차단, 키 변경, 설정 경쟁, SQLite 4→5 및 재시작 포함).
- Swift 테스트: 31 PASS. 프로젝트 설정 bridge/디코딩과 기존 UI 모델 회귀 포함.
- 실제 무료·유료 API: NOT RUN. 실제 Google Billing 확인: NOT RUN.
- UI 화면 수동 조작: NOT RUN. 앱 빌드로 컴파일/패키징 검증.
- develop/main 및 원격 변경 없음. 최종 청구 제한을 보장하지 않는다.
