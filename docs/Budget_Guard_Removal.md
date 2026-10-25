# Budget Guard 제거 — 2026-10-26

사용자 요청에 따라 현재 `feature/usage-ledger-budget-guard`에서 비용 제한 기능을 제거했다. 과거 Phase 3·4·4.1·4.2 문서의 예산 차단, 비용 예약, 자동 유료 허용 및 무료 모델별 호출 승인 규칙은 현재 실행 정책이 아니다. 기존 문서는 구현·검증 이력으로 보존한다.

## 변경 동작

- 채팅, CLI, SwiftUI, 단일·일괄 모델 검사는 동일한 기록 경로를 사용한다. 예산 미설정, 0원 한도, 소진된 예산, 미확인 가격/상한, 무료 승인 미설정으로 호출을 차단하지 않는다.
- `UsageLedger.reserve()` 및 예산 검사 코드를 제거하고 `recordRequest()`로 요청 시작을 기록한다. 신규 요청은 `reserved=0`, `bound=NULL`, `settlement=tracking`이며 실제 사용량을 받아 비용을 정산한다. 사용량이나 가격을 모르면 `estimated=NULL`, `costStatus=unknown`이다.
- 자동 라우팅의 유료 허용 및 무료 전용 Fallback 제한을 제거했다. 가격 미확인도 Tier와 텍스트 호환성 조건을 충족하면 후보가 된다. Tier 순서가 비용보다 우선한다. 같은 Tier에서 알려진 참고 비용을 비교하고 미확인 비용은 뒤에 배치한다.
- 허용 Tier·실제 모델 배정·설정 revision은 요청 기록과 동일 SQLite 트랜잭션에서 계속 검증한다. Unclassified, 텍스트 비호환, 쿨다운은 계속 자동 선택에서 제외한다.
- Rate Limit 및 인증 오류의 기존 Fallback, 타임아웃·네트워크 오류 후 중복 요청 방지, Keychain 및 모델 탐색을 유지한다.
- 무료 계정/모델 설정은 선택적인 비용 추정 자료다. 계정·키 조건이 맞지 않거나 무료 조건이 미확인이면 유료 단가 또는 비용 미확인으로 기록하며 호출은 막지 않는다. 무료 설정 자체가 실제 과금을 보증하지 않는다.
- UI의 예산 편집, 경고 및 자동 유료 허용 토글을 제거했다. `사용량 및 비용`에서 토큰·추정/확인/미확인 비용과 이전 예약 기록을 표시한다.
- CLI의 `budget`, `automatic-paid`, `--approve-budget-exception`을 제거했다. 이전 dashboard의 `budget-set`, `automatic-paid-set`은 `unsupported`를 반환한다.

## 데이터 호환성

SQLite schema 6을 그대로 사용하며 삭제·초기화·파괴적 마이그레이션을 하지 않는다. 기존 예산, 예산 변경 이력, 예약, 사용량, 전환 기록, Tier, 계정 메타데이터를 보존한다. 기존 예약은 과거 기록이며 새 호출 가능 여부에 영향을 주지 않는다. 미정산 과거 기록을 임의로 0으로 바꾸지 않는다.

`usage` 응답은 `budgetGuardEnabled: false`를 제공한다. 호환성을 위해 남긴 `budgetUSD`, `remainingUSD`, `level`, `requestBudgetUSD`, `allowPaid`는 과거 설정/집계이며 실행 정책이 아니다. 채팅 및 라우팅 응답의 예산 level은 `disabled`다. 내부 legacy 예산 저장 메서드는 데이터 호환성과 마이그레이션 검증에만 남아 있다.

프롬프트, 응답 본문, API Key를 Usage Ledger에 저장하지 않는다. 실제 사용자 데이터베이스나 계정 설정을 테스트 중 수정하지 않았다.

## 변경 파일

- `src/ledger.ts`: 예산 검사·예약 제거, 기록/정산과 과거 데이터 유지.
- `src/engine.ts`, `src/router.ts`: 공통 실행 경로, 자동 라우팅, 가격 미확인 후보 및 Fallback 정책.
- `src/cli.ts`, `src/types.ts`: 예산 명령과 예외 옵션 제거.
- `Sources/NidusNativeApp/{App,ChatRooms,Models,UsageBudgetView,RoutingSettingsView,NvidiaFreeSetupView}.swift`: 비용 기록 UI, 라우팅 결과, 선택적 무료 비용 설정 안내.
- `tests/{engine,ledger,router,tier-router,free-use,gemini-billing,nvidia-classification,nvidia-free-setup,provider-expansion}.test.mjs`: 기존 차단 정책 테스트를 제거 후 동작으로 변경하고 어댑터·기록·Tier·경쟁 상태·마이그레이션 회귀 검증 유지.
- `tests/NidusNativeAppTests/{UsageBudgetTests,TierSettingsTests}.swift`: 사용량 조회 및 Tier 설정 transport 검증.
- `README.md`: 현재 사용법 갱신.

## 검증

- PASS: `npm test` — strict TypeScript 빌드 및 Node Mock/CLI/어댑터/엔진 테스트 137개, 실패 0.
- PASS: `swift test --scratch-path /tmp/nidus-phase42-build` — 34개, 실패 0.
- PASS: `npm run build:app` — Swift release 앱, TypeScript 런타임, Keychain helper 빌드. 결과 `dist/Nidus.app` (로컬 unsigned 개발 번들).
- PASS: `git diff --check`.
- NOT RUN: 실제 Provider 연결·모델 조회·무료/유료 추론, 실제 청구 확인. 모두 Mock으로 검증했다.
- NOT RUN: 실제 Keychain 쓰기 테스트 및 앱 화면 수동 조작. 기존 어댑터/보관 코드 변경 없음, Swift 상태 및 빌드 검증 수행.

최초 회귀 실행에서는 이전 예산 차단을 기대하던 테스트가 실패했다. 제거된 정책의 테스트를 호출 허용·미확인 비용 보존·신규 예약 없음으로 수정한 후 위 결과를 얻었다.

## 한계 및 과금 동작

앱 내부의 지출 제한은 더 이상 없다. 수동 요청과 자동 라우팅/Fallback 모두 실제 비용이 발생할 수 있다. 무료 설정은 공식 Billing 조회 결과가 아니며 남은 무료 할당량도 추정해서 만들지 않는다. 비용 추정은 실제 청구액과 다를 수 있다. 참고 비용 상한은 과거 가격 계산 자료를 사용하며 예약이나 지출 제한이 아니다.

Tier가 없는 모델은 여전히 자동 선택하지 않는다. 수동 선택은 텍스트 엔드포인트 호환성 검사를 유지한다. 기존 Provider의 실제 접근 권한과 Rate Limit까지 제거하는 변경은 아니다.

## Git 상태

구현·회귀 테스트 커밋: `5687fa6` — 정리: Budget Guard 차단과 예약 제거 및 사용량 기록 유지.
작업 브랜치: `feature/usage-ledger-budget-guard`.
시작/종료 develop: `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b` (변경 없음).
main: `723c03b59dcecaae27d9fe0a9f97b464c785d706` (변경 없음).
develop 병합, 원격 push, PR 생성은 수행하지 않았다. feature 브랜치에 보존한다.
