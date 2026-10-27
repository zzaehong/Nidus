# Phase 4.4 — Routing Decision Context

## 구현 경계

`ConnectivityEngine.buildRoutingDecisionContext(task: TaskContext)`는 모델 캐시·SQLite·로컬 자격 증명 존재 여부를 읽어 JSON DTO를 만든다. `src/routing-context.ts`에는 버전 2 타입, 순수 조합 함수, 향후 외부 엔진용 `RoutingDecisionEngine` 인터페이스가 있다. JEV·HTTP·추론 호출 구현은 없다. 기존 `routePlan`/`autoChat`의 선택, 정렬, 권한 및 Fallback 동작은 수정하지 않았다.

컨텍스트는 권한 미확인·비용 미확인·연결 해제 모델도 보존한다. 실행 후보 계산에만 기존 권한 결과를 읽기 전용으로 주입한다. 생성 중 `observeCredential`, Tier 저장, 동의 소비, 라우팅 로그 기록, 비용 예약을 하지 않는다. 잠긴 자격 증명 저장소는 `connection: unknown`, `permission.allowed: null`로 표현한다. 연결 상태 `credential-present-unverified`는 키 존재만 의미하며 인증 성공을 보증하지 않는다.

## 데이터 계약

- `schemaVersion: 2`. JSON Schema는 `schemas/routing-decision-context.schema.json`이며 Ajv로 테스트한다. 모든 객체는 추가 필드를 거부한다.
- 작업은 정해진 유형·난이도·필요 기능, 입력 문자 수 및 추정 토큰 수만 받는다. 크기 미확인은 `null`. 프롬프트나 임의 추가 필드를 받지 않는다.
- 모델은 Provider의 마지막 저장 목록에서만 가져온다. 동일 Provider/ID 중복은 첫 항목만 사용하며 목록 갱신으로 사라진 모델은 후보에서 제외한다. 과거 사용 기록은 Provider 집계에 남는다.
- 현재 가격 스냅샷과 과거 요청의 가격 버전을 구분한다. 현재 가격으로 과거 비용을 재계산하지 않는다. 검토되지 않은 모델은 가격 `unknown`, 요율 목록은 비어 있다.
- Tier는 저장된 사용자 설정 또는 기존 공식 계열 기본값을 사용한다. 미분류는 0. `coding`/`reasoning`의 근거가 없으면 `unknown`이며 성능 점수를 만들지 않는다.
- `catalogFetchedAt`/`catalogAgeSeconds`, 가격·Tier·Health 확인 시각, `generatedAt`, `dataAsOf`를 제공한다. 캐시를 최신 실시간 가용성으로 간주하거나 오래됐다는 이유로 임의 삭제하지 않는다. 미래/잘못된 캐시 시각의 age는 `null`이다.
- Health는 마지막 저장 관측이다. `available`은 활성 모델/Provider cooldown이 없다는 뜻이며 성공 보증이 아니다. `verifiedAvailable`도 마지막 관측 기반이며 실시간 검사 결과가 아니다.
- `allowedModels`는 해당 난이도의 허용 Tier 소속 모델 목록이다. 별도 모델 allowlist가 현재 제품에 존재한다고 가정하지 않는다.
- `executableCandidates`는 키 존재, 현재 권한, 허용 Tier, cooldown, 알려진 필수 기능과 기존 라우터 호환 조건을 만족하는 후보 목록이다. 선택 결과나 다음 호출의 보증이 아니다. 요청 본문/최대 출력 크기가 없으므로 비용으로 정렬하지 않는다. 필요한 기능이 `unknown`이면 보수적으로 후보에서 제외하지만 모델 자체는 컨텍스트에 남는다.
- 실행 시에는 기존 공통 경로에서 권한/Tier를 재검사한다. 파일 캐시와 자격 증명과 SQLite를 아우르는 단일 원자적 스냅샷은 아니다.

## 집계 및 비용 의미

UTC 월을 기준으로 SQLite 전체 요청에서 집계한다. 표시용 최근 200건에 의존하지 않는다. 차단되어 전송되지 않은 요청은 제외하고 진행 중·실패·취소는 사용량 집계에 포함한다. 최근 성공률은 최근 30일의 완료 요청(`succeeded`/`failed`/`cancelled`)을 분모로 하며 표본이 없으면 `null`이다. 월간 데이터와 최근 30일 데이터를 혼동하지 않도록 기준 시각을 제공한다.

`estimatedUSD`/`confirmedUSD`는 각각 알려진 금액 합계이다. 정보가 하나도 없으면 0을 생성하지 않고 `null`이다. 일부 요청만 알려진 합계일 수 있으므로 `unknownCostRequests`, `estimatedRequests`, `confirmedRequests`를 함께 제공한다. `knownSpendUSD`는 요청별 `confirmed ?? estimated`의 합계로 정산 금액을 이중 합산하지 않는다. 토큰도 보고된 값의 부분 합계이며 `unknownTokenRequests`를 함께 표시한다.

`freeAttestedRequests`는 사용자 무료 계정 확인을 기반으로 기록된 무료 요청 수이다. 이때 기록된 0원은 Provider 청구 확인을 뜻하지 않는다. 추정 근거는 저장된 요청 가격과 보고 토큰, 무료 계정 사용자 확인이며 객관적 확률 점수를 만들지 않는다. 확인 비용은 기존 reconcile의 요청별 증거가 있는 값이다. 조직 집계 보고서는 개별 요청에 배분하거나 로컬 합계에 더하지 않는다.

최근 오류 코드는 마지막 Health에서 가져오며 자동 라우팅 실패/Rate Limit 횟수는 저장된 route_events만 집계한다. `errorHistoryScope: automatic-route-events-only`이므로 수동 요청의 모든 오류나 외부 API 사용량을 포괄하지 않는다. 오류 원문·응답·프롬프트·모델 details·자격 증명·fingerprint·계정 식별자는 내보내지 않는다.

## Soft Budget와 마이그레이션

SQLite schema 8에서 `soft_budgets(provider, amount, updated_at)`만 추가한다. `amount`는 기존 money 유틸의 정수 nano-USD(소수 9자리, 최대 USD 1,000,000)이며 JSON은 소수 문자열이다. 기존 `budgets`, 예약, 요청, 권한, Tier, 라우팅 이력을 보존하며 예전 한도를 새 목표로 자동 승계하지 않는다. 삭제는 해당 Soft Budget만 제거한다.

`targetUSD: null`은 미설정이다. 0 목표는 유효하지만 0으로 나눈 사용률은 `null`이다. 비용이 누락된 경우 `utilizationPercent: null`, `knownUtilizationPercent`는 알려진 사용액으로만 계산한 참고치다. 기록이 없을 때도 미확인 금액을 0으로 만들지 않아 비율은 `null`이다. 추정값이 포함된 사용률은 최종 청구 확정값이 아니다. 이미 알려진 사용액만으로 목표를 넘으면 `exceeded`, 그렇지 않고 알려진 비용이 없거나 목표가 0이면 `insufficient_data`, 일부 비용 누락이 있으면 `incomplete`다. 상태와 관계없이 `enforcement: none`이다.

화면: **사용량 및 비용 → Provider별 월간 목표 예산**. 기존 사용량 및 과거 예약 정보는 별도 펼침 영역에서 확인할 수 있다. 저장·삭제는 공통 dashboard의 `soft-budget-set`을 사용한다.

CLI:

```sh
nidus routing-context --difficulty normal
nidus soft-budget gemini --usd 5.00
nidus soft-budget gemini --delete
```

SwiftUI/향후 클라이언트용 dashboard 메서드: `{method: "routing-context", task: {...}}`. 키·내용 원문을 전달할 필요가 없다.

## 검증

결과는 작업 종료 검증 후 아래에 기록한다. 실제 무료/유료 API 호출은 실행하지 않는다.

- PASS: `npm test` — 168개 (신규 Context 테스트 11개 포함). 스키마, 민감 정보 제외, 205건 이상 집계, 월 경계, 비용 누락, 정산 중복 제외, 가격 버전 보존, 정책/Tier/모델 갱신, cooldown, 예산 초과에도 라우팅 유지, DB 마이그레이션·재시작을 검증했다.
- PASS: `swift test --scratch-path /tmp/nidus-phase43` — 41개. Soft Budget 저장/삭제 bridge와 불완전 비용 사용률 디코딩 테스트 포함.
- PASS: `npm run build:app` — 로컬 `dist/Nidus.app` 빌드.
- PASS: `git diff --check`.
- NOT RUN: 실제 무료/유료 Provider API 호출, JEV 호출, 이번 Soft Budget 화면의 수동 시각 검증. 앱 빌드 및 Swift 데이터/bridge 테스트로 검증했다.
- 초기 신규 테스트 3건은 모델 배열 순서를 잘못 가정한 fixture 접근을 수정하고 재실행하여 통과했다. 실패 이력을 성공으로 간주하지 않았다.

변경 파일: `src/routing-context.ts`, `src/ledger.ts`, `src/engine.ts`, `src/cli.ts`, `src/dashboard.ts`, `src/index.ts`, `schemas/routing-decision-context.schema.json`, `Sources/NidusNativeApp/UsageBudgetView.swift`, `tests/routing-context.test.mjs`, `tests/NidusNativeAppTests/UsageBudgetTests.swift`, `package.json`, `package-lock.json`, `README.md`, 이 문서. Ajv는 테스트 전용 개발 의존성이며 앱 런타임 의존성은 아니다.

작업 브랜치: `feature/usage-ledger-budget-guard`. develop 시작/종료: `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b`. main: `723c03b59dcecaae27d9fe0a9f97b464c785d706` (변경 없음). develop 병합 및 원격 push/PR은 수행하지 않는다.


## 비용 데이터 완전성 보완

Context v2는 Provider·모델의 UsageContext에 필수 nullable 필드 costCoverage를 추가한다. (requests - unknownCostRequests) / requests이며 0~1, 요청이 없으면 null이다. 이는 비용 값의 완전성일 뿐 청구 정확도·신뢰도·검증률이 아니다. 사용자 무료 선언에 따른 추정 0원도 알려진 값에 포함하지만 freeAttestedRequests로 구분하며 confirmedRequests 또는 확인된 비용으로 승격하지 않는다.

목표 미설정은 unset, 알려진 비용만으로 목표 초과는 exceeded, 알려진 비용이 전혀 없거나 목표가 0이라 비율 계산이 불가능하면 insufficient_data, 일부 비용이 누락되면 incomplete, 나머지는 within이다. 0원 목표에 양수 지출이 있으면 비율은 null이지만 초과 사실은 알려져 있으므로 exceeded다. 알려진 무료 0원 기록과 양수 목표는 사용률 0%, within이다. knownUtilizationPercent는 알려진 비용만의 참고값이며 비용 누락 시 utilizationPercent는 항상 null이다.

기존 v1 스키마는 추가 필드와 신규 enum을 거부하므로 schemaVersion을 2로 올렸다. 외부의 엄격한 v1 소비자는 v2 스키마로 갱신해야 한다. 현재 Swift 클라이언트는 상태를 문자열로 읽으며 costCoverage를 선택 필드로 디코딩해 이전 응답도 지원한다. DB schema 8 및 기존 데이터는 변경하지 않는다. Budget Guard, 비용 차단, Router·Provider·Tier·Fallback 변경은 없다.

보완 검증 결과: npm test 169개 PASS, Swift 테스트 42개 PASS. 최초 신규 테스트의 아주 작은 사용률이 0보다 커야 한다는 가정은 기존 소수 둘째 자리 절삭 표현과 맞지 않아, 알려진 참고값이 숫자로 제공되는지 확인하도록 수정 후 전체 재실행했다. 실제 Provider API 호출과 수동 UI 시각 검증은 NOT RUN이다.

보완 macOS 앱 빌드: npm run build:app PASS (dist/Nidus.app). git diff --check PASS.
