# Phase 4.2 — Provider 확장 및 연결 UX

2026-10-25. 작업 브랜치: `feature/usage-ledger-budget-guard`.
기존 Gemini 프로젝트 무료 정책, Tier 드래그 순서, 실행 직전 Tier 재검증과 예산 예약 구조를 유지한다. OpenRouter는 추가하지 않는다.

## 연결과 실행

| Provider | 모델 조회 | 텍스트 채팅 | 자격 증명 |
|---|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1/models` | `/v1/chat/completions` | Bearer API Key |
| Groq | `https://api.groq.com/openai/v1/models` | `/openai/v1/chat/completions` | Bearer API Key |
| Mistral | `https://api.mistral.ai/v1/models` | `/v1/chat/completions` | Bearer API Key |
| Cloudflare | `/client/v4/accounts/{account}/ai/models/search` (페이지 조회) | `/client/v4/accounts/{account}/ai/v1/chat/completions` | Bearer Token + Account ID |

Cloudflare의 공식 텍스트 호환 엔드포인트를 사용해 모델별 native run 스키마를 임의로 통합하지 않는다. 비텍스트 task는 텍스트 채팅 대상에서 제외한다. Cloudflare/NVIDIA의 조회 결과는 카탈로그이며 각 모델의 실행 권한이나 현재 가용성을 보장하지 않는다. NVIDIA는 공개 카탈로그 접근만으로 API 키 인증을 보증할 수 없어 `catalog-access-only` 및 키 실행 권한 미확인으로 표시한다. 별도 무과금 키 검증 API는 연결하지 않았다. Mistral capabilities와 Groq active/context metadata를 반영한다. 추가 추론으로 연결을 검사하지 않는다.

공통 BaseAdapter/HttpClient와 응답 정규화를 재사용한다. Groq는 `max_completion_tokens`, on-demand tier, Mistral은 `max_tokens`, standard-only tier를 지정한다. 토큰·캐시·추론 사용량은 반환된 필드만 정규화한다. 누락은 null이다. HTTP 401/403/429 및 Retry-After를 기존 정책으로 처리하며 응답 오류 본문은 노출하지 않는다. 타임아웃/네트워크 오류는 재실행하지 않는다.

Cloudflare Account ID는 32자리 hex로 검증하고 토큰과 하나의 Keychain 항목에 저장한다. 연결 실패 시 이전 키/캐시를 유지하며 캐시 저장 실패 시 키를 복구한다. 키나 Account ID 변경은 무료 승인 해시와 불일치해 실행 전 차단한다. 재연결/해제는 계정 무료 설정과 모델 승인 모두 초기화하고, 단순 모델 새로고침은 Tier와 승인을 보존한다. 환경 자격 증명은 별도 계정 ID 환경 변수와 결합한다.

## 무료/유료 정책

신규 Provider 계정 상태는 `free / paid / unknown`이며 초기값은 unknown이다. 무료 실행에는 아래 조건이 모두 필요하다.

1. 현재 키/계정이 무료 플랜이며 유료 초과 과금이 활성화되지 않았다고 사용자가 확인하고 위험 안내에 동의한다.
2. 모델 ID가 검토된 무료 지원 목록에 포함된다.
3. 해당 모델을 `verified`로 직접 확인하고 호출을 승인한다.
4. 자동 라우팅에서는 사용자 지정 Tier/난이도 정책도 충족한다.

검토 목록은 모델 목록을 생성하지 않는다. API에서 실제 조회된 모델만 UI에 나타난다. 모델의 초기 Tier는 모두 Unclassified이며 사용자가 배정한다. 무료 지원/가격 정보는 Tier와 독립적이다.

| Provider | 이번 무료 지원 검토 ID | 조건 |
|---|---|---|
| NVIDIA | `meta/llama-3.1-8b-instruct` | Hosted developer trial, 모델 접근 허용, 개발/평가 조건 |
| Groq | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | GroqCloud Free plan 및 조직·모델별 제한 |
| Mistral | `mistral-small-2603` | Studio Free/Experiment 모드 및 계정별 모델 허용 |
| Cloudflare | `@cf/meta/llama-3.1-8b-instruct` | Workers Free, 계정 전체 일일 무료 Neurons 공유 |

Cloudflare 공식 무료 할당량은 일일 10,000 Neurons이며, 이는 **현재 잔량이 아니다**. 유료 플랜 초과 사용과 유료 전용 모델을 무료로 간주하지 않는다. Groq 응답의 remaining headers 역시 제한 시간창의 용량이지 무료 크레딧이 아니다. 이 Phase는 별도의 청구 조회 권한을 요청하지 않으며 남은 무료 할당량은 null로 유지한다.

Paid/Unknown은 기존 Budget Guard를 따른다. 신규 유료 가격은 Groq `openai/gpt-oss-120b`의 표준 입력 $0.15/출력 $0.60 per million만 검토했다. 캐시 할인은 미확인으로 보수적으로 입력 단가를 적용하고, 추론 포함 출력 상한 전체를 예약한다. 나머지 신규 유료 단가/안전한 상한은 미확인으로 차단한다. 무료 플랜 표시는 유료 가격 0을 뜻하지 않는다.

무료 실행이 시작된 자동 요청은 이후 유료 후보로 전환하지 않는다. 승인된 다른 무료 Provider로의 Fallback은 기존 Tier 순서를 따른다. 유료 자동 호출 기본값은 계속 비활성이다. 기존 모델별 과금 동의 예외도 그대로 보존한다.

사용자 확인은 Provider Billing API 검증이 아니다. 같은 키의 계정이 유료로 전환되면 자동 감지할 수 없다. 즉시 설정을 변경해야 하며 잘못된 무료 설정은 로컬 예산 밖의 청구를 일으킬 수 있다. 공식 무료 지원 자료는 30일이 지나면 재검토 전 차단한다.

## 저장 및 UI

SQLite schema 6은 `provider_plans` 테이블만 추가한다. 기존 Gemini 상태, 모델 승인, 정책, 사용량, 예약, 라우팅 로그를 삭제하지 않는다. 예약 트랜잭션에서 현재 플랜/키/모델 승인과 Tier·revision을 검사한다. 요청별 무료/유료 및 확인 근거는 기존 request_billing에 보존하며, 토큰이 없는 실패 비용은 임의로 확인된 0원으로 바꾸지 않는다.

SwiftUI는 Provider enum 메타데이터로 공통 연결 카드·키 발급 링크·추가 입력 필드를 구성한다. Cloudflare에만 Account ID 입력을 표시한다. Tier 설정의 신규 Provider 플랜 편집기도 공통 화면을 사용한다. 이전 Tier drag-and-drop과 Gemini 전용 프로젝트 편집은 유지한다.

## 공식 자료 (2026-10-25 확인)

- NVIDIA [모델 조회 엔드포인트](https://docs.nvidia.com/nim-operator/3.0.2/guardrail.html), [API Catalog Quickstart](https://docs.api.nvidia.com/nim/re/docs/api-quickstart), [개발/서비스 조건](https://docs.api.nvidia.com/nim/docs/product), [Llama 요청 사양](https://docs.api.nvidia.com/nim/reference/meta-llama-3_1-8b-infer)
- Groq [Models/가격/상한](https://console.groq.com/docs/models), [API Reference](https://console.groq.com/docs/api-reference), [Free/Developer 및 제한 헤더](https://console.groq.com/docs/rate-limits)
- Mistral [Free 모드와 API Key](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key), [모델 조회](https://docs.mistral.ai/api/endpoint/models), [Chat API](https://docs.mistral.ai/api/endpoint/chat), [Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03)
- Cloudflare [REST 인증](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), [모델 카탈로그](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/), [텍스트 호환 API](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/), [요금과 무료 조건](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## 변경 파일

- `src/providers.ts`, `src/types.ts`: Provider 메타데이터 및 정확한 무료 지원 ID.
- `src/adapters/{compatible,cloudflare,index}.ts`: 신규 Adapter 및 등록.
- `src/{credentials,engine,dashboard,cli}.ts`, `native/keychain.swift`: 연결, 추가 정보, Keychain/환경 자격 증명, 공통 호출.
- `src/{ledger,pricing,provider-usage}.ts`: 플랜 저장·검사, 가격/무료 지원 정보, 조회 가능 범위.
- `Sources/NidusNativeApp/{App,Models,RoutingSettingsView}.swift`: 공통 연결 카드 및 플랜 편집.
- `tests/provider-expansion.test.mjs`, `tests/cli.test.mjs`, `tests/keychain/keychain.test.mjs`, `tests/NidusNativeAppTests/{DashboardTests,ProviderExpansionTests}.swift`: Mock·UI 모델·합성 Keychain 검증.
- `README.md`, 이 문서: 사용법·지원 범위·검증 결과.

## 검증 및 한계

- Node Mock/회귀: 129 PASS.
- Swift/UI 모델: 33 PASS.
- 테스트 전용 Keychain 합성 키 저장/갱신/삭제: 5 PASS (실제 API 키 사용 없음).
- macOS 앱 빌드: PASS. 로컬 unsigned `dist/Nidus.app`.
- 실제 무료/유료 API 인증·추론: NOT RUN. 사용자의 실제 계정 무료 조건은 확인하지 않았다.
- UI 수동 클릭/시각 검증: NOT RUN.
- API 카탈로그의 모든 모델이 채팅 호환이거나 무료라는 주장은 하지 않는다. 검토 목록 밖의 모델/요금은 미확인으로 유지하며 후속 공식 검토가 필요하다.
- develop 시작/종료: `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b`. main 시작/종료: `723c03b59dcecaae27d9fe0a9f97b464c785d706`. 병합·원격 반영 없음. 병합은 별도 명시적 승인 대기.
