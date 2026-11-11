# Routing Decision Context v2 · Soft Budget

`ConnectivityEngine.buildRoutingDecisionContext(task: TaskContext)`는 모델 캐시·SQLite·로컬 자격 증명 존재 여부를 읽어 JSON을 생성합니다. JEV·Provider API를 호출하지 않으며 기존 Rule-based Router를 변경하지 않습니다. 타입과 Builder는 `src/routing-context.ts`, 계약은 [JSON Schema](../schemas/routing-decision-context.schema.json)에 있습니다.

```sh
nidus routing-context --difficulty normal
nidus soft-budget gemini --usd 5.00
nidus soft-budget gemini --delete
```

SwiftUI에서는 **사용량 및 비용 → Provider별 월간 목표 예산**에서 관리합니다. Dashboard 요청은 `{method: "routing-context", task: {...}}`, `{method: "soft-budget-set", provider, usd: string|null}`입니다.

## Context 계약

- `schemaVersion: 2`, 생성 시각·데이터 기준 시각·UTC 월·`scope: nidus-local-only`를 제공합니다. 객체의 임의 추가 필드는 스키마에서 거부합니다.
- Task는 유형, 난이도, 필요한 기능, 입력 문자 수·추정 토큰 수만 받습니다. 미확인은 null이며 프롬프트 원문을 받지 않습니다.
- 모델은 마지막 캐시 목록에서만 가져옵니다. Provider+ID 중복은 첫 항목을 쓰고 사라진 모델은 후보에서 제외하되 과거 Provider 사용량은 유지합니다.
- Tier는 사용자 배정 또는 기존 기본값이며 미분류는 0입니다. coding/reasoning의 근거가 없으면 unknown입니다. 벤치마크 점수를 만들지 않습니다.
- 현재 공식 가격과 요청별 과거 가격 버전을 구분합니다. 미검토 가격은 unknown·빈 요율이며 과거 비용을 현재 가격으로 다시 계산하지 않습니다.
- 캐시 나이·가격/Tier/Health 확인 시각을 표시합니다. 잘못되거나 미래인 캐시 시각의 age는 null이며 오래된 캐시를 임의로 최신이라고 표시하거나 삭제하지 않습니다.
- `connection: credential-present-unverified`는 키 존재만 뜻합니다. 저장소 접근 실패는 unknown, 권한 판단 불가는 null이며 Context 전체 생성을 막지 않습니다.
- Health의 `available`은 활성 모델/Provider cooldown이 없다는 뜻입니다. `verifiedAvailable`도 과거 관측이며 실시간 성공 보증이 아닙니다.
- `allowedModels`는 난이도의 허용 Tier 소속 목록입니다. `executableCandidates`는 키·현재 권한·Tier·cooldown·필수 기능·기존 Router 호환성을 반영한 참고 후보입니다. 필수 기능이 unknown이면 후보에서 제외하지만 모델 자체는 보존합니다. 요청 본문·출력 한도가 없으므로 후보를 비용으로 정렬하지 않습니다.

생성 중 Tier·계정 설정을 쓰거나, 승인 토큰을 소비하거나, 라우팅 로그·비용 예약을 만들지 않습니다. 캐시·자격 증명·SQLite 전체를 아우르는 원자적 스냅샷은 아니므로 실제 실행 때 권한을 다시 검사합니다. API Key, fingerprint, 계정 ID, 프롬프트·응답·오류 원문·model details는 내보내지 않습니다. 향후 외부 엔진용 `RoutingDecisionEngine`은 인터페이스만 있으며 연동 구현은 없습니다.

## Usage와 비용 완전성

월간 집계는 UTC 월의 전체 SQLite 요청을 사용하며 표시용 최근 200건에 제한되지 않습니다. 전송되지 않은 blocked 요청은 제외하고 pending·실패·취소는 포함합니다. 최근 성공률은 최근 30일 완료 요청(succeeded/failed/cancelled) 기준이며 표본이 없으면 null입니다.

| 필드 | 의미 |
|---|---|
| `estimatedUSD`, `confirmedUSD` | 각각 알려진 금액의 합계. 하나도 없으면 null이며 일부 요청만 포함할 수 있음 |
| `knownSpendUSD` | 요청별 confirmed ?? estimated의 합계. 이중 합산하지 않음 |
| `unknownCostRequests` | 추정·확인 비용이 모두 없는 요청 수 |
| `costCoverage` | `(requests - unknownCostRequests) / requests`. 0~1, 요청 0건이면 null |
| `estimatedRequests`, `confirmedRequests` | 추정·확인 비용이 기록된 요청 수 |
| `freeAttestedRequests` | 사용자 무료 계정 확인에 기반한 무료 요청 수 |
| `unknownTokenRequests` | 입력 또는 출력 토큰이 누락된 요청 수. 토큰 합계도 부분 집계일 수 있음 |

`costCoverage`는 **비용 값의 완전성이지 청구 정확도·신뢰도·검증률이 아닙니다.** 사용자 무료 선언에 따른 추정 0원도 알려진 값에 포함하지만 Provider가 확인한 비용으로 승격하지 않습니다. 확인 비용은 요청별 정산 증거가 있는 값입니다. 조직 보고서는 개별 요청에 배분하거나 로컬 합계에 추가하지 않습니다.

최근 오류는 마지막 Health와 자동 라우팅 이벤트에서 가져옵니다. `errorHistoryScope: automatic-route-events-only`이므로 모든 수동 오류나 외부 API 사용량을 포괄하지 않습니다.

## Soft Budget 상태

Provider별 목표는 SQLite schema 8의 `soft_budgets`에 정수 nano-USD로 저장합니다. 소수 9자리·최대 USD 1,000,000이며 null은 삭제입니다. 과거 `budgets`·예약을 자동 승계하지 않고 기존 기록을 보존합니다. 모든 상태에서 **`enforcement: none`**이며 호출·Fallback을 제한하지 않습니다.

`knownUtilizationPercent`는 알려진 지출만으로 계산한 참고값입니다. 비용 누락 시 `utilizationPercent`는 null입니다. 목표가 없거나 0이거나 알려진 지출이 없으면 두 비율 모두 null입니다. 추정값이 포함된 비율은 최종 청구 확정값이 아닙니다.

상태는 아래 순서로 결정합니다.

| 조건 | 상태 |
|---|---|
| 목표 미설정 | unset |
| 알려진 지출만으로 목표 초과 | exceeded |
| 알려진 지출 없음 또는 목표 0 | insufficient_data |
| 일부 요청 비용 누락 | incomplete |
| 나머지 | within |

0원 목표에 양수 지출은 exceeded이지만 비율은 null입니다. 알려진 무료 0원 기록과 양수 목표는 within·사용률 0%입니다.

v1의 엄격한 소비자는 추가 필드·상태를 위해 v2 스키마로 갱신해야 합니다. Swift는 costCoverage를 선택 필드로 읽어 이전 응답도 지원합니다. 검증 이력은 [VALIDATION](VALIDATION.md)에 통합했습니다.
