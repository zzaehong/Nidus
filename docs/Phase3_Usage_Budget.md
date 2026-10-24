# Phase 3 — Usage Ledger & Budget Guard

## 범위와 데이터 흐름

기준: `develop` `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b`.
`feature/code-review-improvements`의 미병합 변경은 포함하지 않았다.
기존 develop에는 가격표와 토큰 정규화만 있었고 영속 예산 통제는 없었다.

`CLI / SwiftUI Runtime → ConnectivityEngine.execute → SQLite 예약 → Adapter → SQLite 정산`

채팅, 단일 검사, 일괄 검사의 각 추론 요청 및 opt-in live 채팅 테스트가 이 경로를 사용한다.
모델 목록/상세/인증 조회에는 추론 예약을 적용하지 않는다. Adapter는 저수준 HTTP
컴포넌트이므로 앱 기능은 직접 호출하지 말고 Engine을 사용해야 한다.
자동 라우팅, 품질 평가, agent/tool loop, 자동 충전은 추가하지 않았다.

## 설정 및 사용

Node.js **22.13 이상** (`node:sqlite`, 검증 버전 24.21.0).
SwiftUI 툴바의 **사용량 및 예산**에서 전체 월간·단일 요청·Provider별 예산을 설정한다.
아래 명령은 설정만 변경하며 API 추론을 실행하지 않는다.

```sh
nidus budget total --usd 20
nidus budget request --usd 5
nidus budget openai --usd 10
nidus usage
```

금액은 문자열 USD이고 소수점 9자리까지 허용한다. 단일 설정 최대값은 USD 1,000,000이다.
전체와 단일 요청 한도를 설정하기 전에는 유료 요청을 차단한다. Provider 한도는 선택 사항이다.
0은 차단이며, 한도 변경은 기존 사용액·예약을 초기화하지 않는다. 모든 변경은 DB에 이력을 남긴다.

한 번의 명시적 예외가 꼭 필요한 경우 CLI chat에 `--approve-budget-exception`을 지정할 수 있다.
이 플래그는 해당 한 요청의 예산 초과만 승인하며 요청 행에 별도로 기록된다. 이후 요청에는
적용되지 않고 기본 예산도 변경하지 않는다. **가격·상한 미확인 요청은 예외 플래그로도 승인하지 않는다.**
SwiftUI에는 묵시적 예외/자동 승인 기능이 없다.

## 상한과 가격 정책

가격은 `src/pricing.ts`의 exact-ID 공식 스냅샷을 사용한다. 등록 가격 8개와 문서상 용량을
2026-10-24에 재검증했다. 모델 목록은 계속 API에서 조회한다. 가격표에 있다는 이유로 사용 가능
모델을 만들거나, 이름이 비슷한 새 모델의 가격을 추측하지 않는다.

문자 수 휴리스틱을 안전한 토큰 상한으로 취급하지 않는다. 현재는 **문서상 전체 입력 용량**을
예약하고 OpenAI/Anthropic은 요청의 출력 한도를 더한다. Gemini/DeepSeek는 숨은 추론과 출력
한도 의미의 차이를 보수적으로 처리하기 위해 문서상 전체 출력 용량까지 예약한다.
짧은 인사도 큰 예약이 필요할 수 있다. 향후 검증된 토큰 카운터로 예약을 줄일 수 있다.

예: GPT-4.1 mini 입력 1,047,576 토큰, 출력 요청 1,024 토큰이면 예약은 약 $0.421이다.
이는 실제 예상 응답 비용이 아니라 승인용 보수적 상한이다. 입력 캐시 할인은 예약에 적용하지 않는다.
가격이나 용량이 없거나 가격 검증 후 30일이 지나면 자동 승인을 차단한다. 검증일만 자동 갱신하지 않는다.

단가는 JSON의 기존 숫자 형식을 유지하되 계산 전에 decimal 문자열에서 BigInt로 변환한다.
DB 금액은 **정수 nano-USD (1 USD = 1,000,000,000)**, 외부 JSON은 decimal 문자열이다.
각 계산은 nano-USD 경계에서 올림한다. 사용량의 캐시 읽기 토큰을 입력에서 빼고 별도 단가를 적용한다.
출력에 포함된 추론 토큰은 다시 더하지 않는다. 캐시 쓰기 TTL을 알 수 없는 경우 비용을 미확인으로
유지한다. 현재 Adapter는 명시적 캐시 생성/저장 요청을 보내지 않는다.
DeepSeek 시간/공휴일 조건은 최고 단가의 **추정값**을 사용하고 원래 tier와 조건을 보존한다.
실제 청구 확인으로 표시하지 않는다. 무료 티어 제공 여부와 실제 계정의 잔여 무료 할당량은 다르며,
이 버전은 무료 잔량을 알지 못하므로 유료 단가로 예약한다.

공식 재검증 출처:

- [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini): 입력 $0.40, 출력 $1.60, 캐시 입력 $0.10 / 1M.
- [Anthropic 가격](https://platform.claude.com/docs/en/about-claude/pricing): Sonnet 4.6 3/15/0.3, Opus 4.6 5/25/0.5; 캐시 쓰기 TTL별 별도 비용.
- [Anthropic context](https://platform.claude.com/docs/en/build-with-claude/context-windows): 해당 모델의 1M context와 최대 출력.
- [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing): 2.5 Flash 및 3.5 Flash-Lite의 표준 텍스트 단가 0.3/2.5/0.03. 캐시 저장·검색 등의 별도 비용 제외.
- [Gemini 2.5 Flash 용량](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash), [3.5 Flash-Lite 용량](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).
- [DeepSeek 가격·용량](https://api-docs.deepseek.com/quick_start/pricing/): Flash와 V4 Pro의 peak/off-peak를 분리하여 보존.

## 예약·정산·재실행

기본 DB는 `~/.local/share/nidus/usage.sqlite`이며 디렉터리 0700, DB 0600으로 생성한다.
WAL, `synchronous=FULL`, 5초 busy timeout, `BEGIN IMMEDIATE`를 사용한다. 별도 CLI/SwiftUI
child 프로세스에서도 읽기·예산 검사·예약 삽입을 하나의 write transaction으로 처리한다.
잠금/디스크 오류가 발생하면 네트워크 전송을 승인하지 않는다. 읽기 대시보드도 일관된 트랜잭션을 사용한다.

월은 요청 시작 시각 기준 **UTC calendar month**다.
`현재 월 추정 또는 확인 비용 + 미해결 예약(이전 달 포함) + 신규 예약`으로 검사한다.
80%는 warning, 90%는 saving, 100%는 blocked 상태다. 절약 모드는 상태 표시이며 자동 Provider 전환이 아니다.

| 요청 상태 | 비용 상태 | 정산 상태 | 예산 반영 |
|---|---|---|---|
| blocked | unknown | not_sent | 예약 없음, 차단 이유 기록 |
| pending | unknown | reserved | 상한 전액 예약 |
| succeeded/failed/cancelled, 토큰 보고 | estimated | estimated | 토큰 기반 추정액으로 대체 |
| succeeded/failed/cancelled, 사용량 누락 | unknown | unresolved | 기존 예약 유지 |
| 요청에 매칭된 청구 evidence | confirmed | reconciled | 확인 금액으로 대체 |

응답 본문이 비어 있어도 사용량이 보고되면 오류 객체의 정규화 사용량을 정산한다.
타임아웃/취소/네트워크 오류를 0원으로 만들지 않는다. 앱/child가 강제 종료되면 pending 예약이
DB에 남으며 재시작이나 월 변경으로 해제되지 않는다. 종료된 요청인지 단정할 수 없으므로 자동
만료·자동 재시도·0원 처리 기능을 제공하지 않는다. 진행 중과 프로세스 중단은 pending 화면에서
구별할 수 없는 제한이 있다.

요청 ID/시각/provider/model/task/토큰/상태/가격 스냅샷·해시/비용/예외 승인 여부와 허용된 rate-limit
헤더만 기록한다. 키, 프롬프트, 응답 텍스트, 원본 provider payload와 임의 오류 문자열은 저장하지 않는다.
가격 스냅샷을 요청별로 보존하므로 나중의 가격 변경이 과거 추정액을 바꾸지 않는다.
기록 전체는 SQLite에 보관하며 UI는 최근 200건, 모델 합계는 해당 월 전체를 표시한다.

## Provider usage integration

| Provider | 요청 사용량 | 별도 조직 조회 | 크레딧/청구 제한 |
|---|---|---|---|
| OpenAI | input/output/cache/reasoning | Usage Completions + Costs API | 별도 Admin 키, 조직 집계만 표시 |
| Anthropic | uncached + cache read/write, output | Messages Usage + Cost Report | 별도 Admin 권한, cents→USD 정수 변환, Priority Tier 비용 제외 |
| Gemini | prompt/output/thinking/cache | Cloud Billing 미연결 | 무료 잔량·크레딧을 추측하지 않음 |
| DeepSeek | prompt/completion/cache/reasoning | 로컬 기록 | 공식 User Balance API의 USD만 표시; CNY 환산 없음 |

```sh
nidus balance deepseek
nidus account openai
nidus account anthropic
```

위 조회는 사용자가 명시적으로 실행할 때만 수행한다. 관리자 조회는
`NIDUS_OPENAI_ADMIN_API_KEY`, `NIDUS_ANTHROPIC_ADMIN_API_KEY`만 읽는다. 추론 키나 기존
Keychain으로 fallback하지 않는다. 이 버전의 관리자 키 저장 정책은 **세션 환경변수 전용,
영속 저장 없음**이다. 별도 최소 권한 자격 증명을 발급하고 신뢰하는 프로세스에서만 해당 환경을
사용해야 한다. SwiftUI도 같은 환경을 상속받아야 관리자 조회가 가능하다. 자동 조회하지 않는다.

응답 페이지를 끝까지 검증한 후 조직 합계·기간·출처·조회시각만 저장한다. 조회 실패 시 과거 성공
스냅샷을 유지한다. 빈 결과는 0이 아니라 미확인이다. 조직 집계는 외부 요청 및 지연을 포함할 수
있으므로 로컬 예산에 합산하지 않는다. 개별 요청 비용으로 임의 배분하지 않는다.
`UsageLedger.reconcile`은 향후 요청 단위의 신뢰 가능한 청구 evidence를 받는 확장 지점이다.
현재 집계 API는 이 메서드를 호출하지 않으므로 로컬 요청의 확인 비용은 대개 미확인으로 보인다.

공식 조회/권한 출처:

- [OpenAI Costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs), [Usage와 Admin 키 예제](https://developers.openai.com/cookbook/examples/completions_usage_api), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits).
- [Anthropic Usage/Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), [Cost Report](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve), [Messages Usage](https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages).
- [Gemini billing](https://ai.google.dev/gemini-api/docs/billing).
- [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance/).

## 검증과 한계

- TypeScript Mock/회귀: `npm test` — PASS 68개 (localhost HTTP Mock 포함).
- SwiftUI 모델/브리지·기존 앱: `swift test --scratch-path /tmp/nidus-phase3-build` — PASS 21개.
- 검증 범위: 가격 계산/미확인/무료 티어, 80/90/100%, 잔여 부족, 8개 별도 프로세스의 동시 예약,
  실패/타임아웃/취소/응답 누락, 재실행, 월 경계, 정산 idempotency, CLI/SwiftUI/probe 일치,
  민감 내용 미저장, 관리자 키 분리, pagination, cents/USD, 빈 조직 결과.
- 최초 sandbox 테스트에서는 localhost listen과 Swift module cache 쓰기가 거부되어 FAIL.
  동일 테스트를 필요한 권한으로 재실행하여 위 PASS 결과를 확인했다.
- 실제 유료 추론/실제 관리자·잔액 조회: **NOT RUN**. 자격 증명과 유료 호출 승인을 사용하지 않았다.
- macOS 앱 번들: `npm run build:app` — PASS. 별도 검증용 앱에서 사용량/예산 초기 화면을 열어 레이아웃과 미설정·미확인 표시 확인. 사용자 예산 변경이나 API 전송 없이 확인했고 기존 앱은 종료하지 않았다.
- 서명·공증·다른 Mac 배포: **NOT RUN**.
- Budget Guard는 로컬 요청 통제이며 Provider의 실제 청구 금액을 절대 제한하지 않는다.
  외부 사용, 미보고 비용, 요금 변경, 제공업체 동작 차이, 청구 지연이 존재한다.
