# Nidus

TypeScript 기반 **Multi-Provider API Connectivity MVP**입니다. Provider와 API Key로 모델을 자동 탐색하고, 선택한 모델에 텍스트 요청을 보내며 사용량을 공통 포맷으로 반환합니다.

OpenAI(GPT), Anthropic(Claude), Google Gemini, DeepSeek를 지원합니다. SwiftUI, 자동 라우팅, Agent Loop, Tool 실행, Docker, Vault, Workflow는 구현 범위에 포함하지 않습니다.

## 설치와 시작

Node.js 22 이상(검증: 24.21.0), npm이 필요합니다. macOS Keychain 사용에는 Xcode Command Line Tools의 `swiftc`가 필요합니다. Swift 파일은 Security.framework를 호출하는 작은 저장소 helper이며 앱/UI가 아닙니다. API 연결 엔진과 CLI는 모두 TypeScript입니다. 외부 런타임 의존성은 없습니다.

```sh
npm ci
npm run build
npm run build:keychain  # macOS, 최초 설치 및 helper 변경 시

# 전역 설치 없이 저장소에서 실행
npm exec --offline -- nidus providers
npm exec --offline -- nidus connect gemini
npm exec --offline -- nidus models gemini
```

짧은 명령을 사용하려면 저장소에서 `npm link`를 한 번 실행합니다. 이후:

```sh
nidus providers
nidus connect openai
nidus connect anthropic
nidus connect gemini
nidus connect deepseek

nidus models gemini
nidus models gemini --refresh
nidus models gemini --detail '<조회된 모델 ID>'
nidus pricing gemini
nidus chat --provider gemini --model '<조회된 모델 ID>'
printf '짧게 인사해 주세요.' | nidus chat --provider gemini --model '<조회된 모델 ID>'
nidus disconnect gemini
```

`connect`에서 키를 숨김 입력하면 Models API로 인증과 전체 모델 조회를 수행하고, 성공한 뒤 Keychain과 모델 캐시에 등록합니다. 잘못된 키나 조회 실패는 기존 연결을 덮어쓰지 않습니다. 캐시 저장 실패 시 키 교체를 롤백합니다. `connect`를 다시 실행하면 키를 변경할 수 있습니다. `disconnect`는 해당 Provider의 키와 캐시를 삭제합니다.

`models`는 저장된 목록과 `fetchedAt`, `source: cache`를 반환합니다. `--refresh`는 네트워크에서 전체 목록을 다시 조회하여 성공 시 원자적으로 교체합니다. 실패 시 이전 캐시를 보존하고 오류를 반환합니다. 캐시가 없으면 자동 조회합니다. `--detail`은 단일 모델 상세정보를 조회합니다.

`chat`은 단일 요청입니다. stdin 또는 대화형 메시지 입력을 사용합니다. 라이브러리의 `ChatRequest`는 `system`과 여러 `user`/`assistant` 메시지를 지원합니다. 기본 최대 출력은 1,024토큰이며 `--max-output-tokens 4096`처럼 변경할 수 있습니다. 추론 모델은 출력 예산을 사고 토큰에 사용할 수 있습니다.

## 키와 로컬 저장

- macOS Keychain service: `com.nidus.connectivity`, account: Provider ID. 기기 전용·잠금 해제 시 접근하며 동기화하지 않습니다.
- 키 입력은 터미널에 표시하지 않습니다. 키를 CLI 인자, Git, 로그, 일반 설정 파일에 저장하지 않습니다.
- helper는 stdin/stdout 전용 Pipe로 키를 전달하며 키 값을 프로세스 인자에 넣지 않습니다. helper가 없으면 평문 저장으로 우회하지 않고 오류를 반환합니다.
- 캐시: `~/.local/share/nidus/<provider>.json`. 모델 메타데이터만 저장하며 파일 권한은 `0600`, 생성 디렉터리는 `0700`입니다. 프롬프트·응답·사용량은 디스크에 저장하지 않습니다.
- 키는 요청 중 프로세스 메모리에 존재합니다. JavaScript 문자열의 완전한 메모리 소거는 보장하지 않습니다.

CI 또는 macOS 외 환경에서는 `NIDUS_OPENAI_API_KEY`, `NIDUS_ANTHROPIC_API_KEY`, `NIDUS_GEMINI_API_KEY`, `NIDUS_DEEPSEEK_API_KEY`를 외부 Secret Manager에서 환경변수로 주입하고 `nidus connect <provider> --env`를 사용할 수 있습니다. 이 모드는 키를 영구 저장하지 않습니다. 환경변수는 Keychain보다 우선하며, 해당 환경에서 `models`는 다른 계정 캐시 사용을 피하기 위해 API를 다시 조회합니다. 키를 셸 명령에 직접 적으면 history에 남을 수 있으므로 피합니다.

## 모델 탐색과 기능 분류

모델 카탈로그를 하드코딩하지 않습니다. 공급자가 반환한 ID를 보존하며 최신 모델 이름을 추측하거나 임의 별칭으로 바꾸지 않습니다. 특히 Gemini는 `name: models/<id>`에서 접두사만 제거하고 `baseModelId`로 치환하지 않습니다.

| Provider | 모델 목록 / 상세 | 요청 API | 확인되는 기능과 제약 |
| --- | --- | --- | --- |
| OpenAI | `/v1/models`, `/v1/models/{id}` | `/v1/responses` | 목록은 기능·엔드포인트 호환성을 제공하지 않아 `unknown`. `store: false` 사용 |
| Anthropic | `/v1/models`, `/v1/models/{id}` | `/v1/messages` | `has_more`, `last_id`, `after_id` 전체 페이지 처리. 제공되는 capabilities·한도 보존 |
| Gemini | `/v1beta/models`, `/v1beta/models/{id}` | `:generateContent` | `nextPageToken`/`pageToken` 전체 페이지 처리. 생성 메서드·토큰 한도 보존 |
| DeepSeek | `/models`; 상세는 목록에서 선택 | `/chat/completions` | 별도 상세 API는 확인되지 않음. 반환되는 modality·context·output 한도 보존 |

`capabilities`는 `supported`, `unsupported`, `unknown`을 사용합니다. Gemini의 `generateContent` 지원만으로 일반 텍스트 채팅 호환성을 확정하지 않으므로 해당 모델의 `chat`은 `unknown`입니다. `generateContent`를 지원하지 않는 모델은 `unsupported`입니다. 모델명 접두사로 이미지/음성/채팅 모델을 임의 판정하지 않습니다. 지원하지 않는 모델은 채팅을 거부하고, 미확인 모델은 사용자가 선택하면 요청하며 공급자의 오류를 반환합니다. 기능 메타데이터가 있어도 이번 MVP는 비스트리밍 텍스트 요청만 실행합니다.

연결 성공은 `authentication: models-api-verified`, `chatVerification: not-run`으로 표시합니다. 모델 목록에 나타나는 것은 특정 엔드포인트 사용 권한, 잔액, 실 채팅 성공을 보장하지 않습니다.

## Pricing Registry

`src/pricing.ts`는 공식 가격표를 검토한 수동 스냅샷입니다. **모델 ID 등록과 가격 레코드는 분리**되어 있으며 가격표가 모델을 탐색 목록에 추가하지 않습니다. 정확한 Provider+모델 ID로만 매칭합니다.

레코드는 입력·출력·캐시 입력 가격(USD/백만 토큰), 무료 티어 상태, 출처 URL, 마지막 확인 시각, 요금 조건을 포함합니다. 현재 스냅샷은 8개 정확한 ID를 포함합니다. 전체 공급자 가격표를 복제하지 않으며 미검토 모델은 `status: unknown`, `rates: []`, `checkedAt: null`로 반환합니다. 미확인은 무료나 0원이 아닙니다. `pricing`은 연결 후에는 탐색된 모델에 가격을 붙이고, 연결 전에는 검토된 레코드를 보여줍니다.

- 기준: 직접 API의 표준 텍스트 요금. 캐시 쓰기·저장·도구·Batch·지역/계약별 과금은 별도입니다.
- DeepSeek는 피크·비피크를 모두 표시합니다. 중국 공휴일을 추측해서 요금을 자동 선택하지 않습니다.
- 무료 티어 표시는 계정의 실제 무료 할당량을 조회한 결과가 아닙니다.
- 가격 자동 갱신 API를 확인하지 못했으므로 자동 스크래핑/갱신을 구현하지 않습니다. `models --refresh`는 모델만 갱신합니다.
- 갱신 절차: 공식 URL 확인 → 정확한 ID·단위·조건 검토 → 가격 레코드와 `checkedAt` 갱신 → 테스트 → 커밋. 가격 기록의 확인 시각을 유지하며 실시간 가격이라고 표시하지 않습니다.

## 공통 응답과 오류

성공 시 stdout은 JSON입니다. `chat`은 `{provider, model, text, finishReason, usage}`를 반환합니다. `usage`에는 입력·출력·총량·캐시 읽기/쓰기·추론 토큰과 공급자의 숫자 사용량 필드가 있습니다. 누락된 값은 `null`입니다. Anthropic 입력은 uncached+cache read+cache write를 합산하며, Gemini 출력은 후보+thinking 토큰을 합산합니다. 원래 숫자 필드는 `providerUsage`에 보존합니다.

오류는 stderr에 `{error: {code, message, status, retryAfter}}`로 출력하고 종료 코드 1(취소 130)을 반환합니다. 인증, 권한, 잔액/한도, Rate Limit, 네트워크, 타임아웃, 취소, 잘못된 응답을 구분합니다. Gemini `API_KEY_INVALID`와 OpenAI `insufficient_quota`도 공통 코드로 변환합니다. 키·프롬프트가 포함될 수 있는 공급자 원문 오류와 stack trace는 출력하지 않습니다.

`--timeout-ms` 기본값은 모델 조회 30초, 채팅 120초이며 본문 읽기와 전체 페이지 조회에도 적용합니다. Ctrl-C로 요청을 취소합니다. HTTP 리다이렉트를 따라 인증정보를 전달하지 않습니다. 자동 재시도는 없으므로 채팅 중복 과금을 유발하지 않습니다. 가격 계산·결제 내역 수집은 이번 범위가 아닙니다.

## 공식 자료와 확인 시점

문서 확인: **2026-10-23 UTC**. API 버전과 요금은 공급자 변경 시 재검토해야 합니다.

| Provider | 모델·요청 문서 | 가격 문서 |
| --- | --- | --- |
| OpenAI | [Models](https://developers.openai.com/api/reference/resources/models/methods/list), [Responses 텍스트 요청](https://developers.openai.com/api/docs/guides/text) | [가격표](https://developers.openai.com/api/docs/pricing), [GPT-4.1 Mini 개별 요금](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
| Anthropic | [Models](https://platform.claude.com/docs/en/api/models/list), [Messages](https://platform.claude.com/docs/en/api/messages/create), [버전](https://platform.claude.com/docs/en/api/versioning) | [가격표](https://platform.claude.com/docs/en/about-claude/pricing) |
| Gemini | [Models](https://ai.google.dev/api/models), [generateContent](https://ai.google.dev/api/generate-content) | [가격표](https://ai.google.dev/gemini-api/docs/pricing) |
| DeepSeek | [Models](https://api-docs.deepseek.com/api/list-models/), [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) | [가격표](https://api-docs.deepseek.com/quick_start/pricing/) |

OpenAI·DeepSeek는 Bearer 인증, Gemini는 `x-goog-api-key`를 사용합니다. Anthropic은 확인한 공식 문서의 Bearer 인증과 `anthropic-version: 2026-10-21`을 사용합니다. 일부 Provider/키/지역이 문서의 최신 버전을 지원하는지는 실제 인증정보로 별도 확인해야 합니다.

## 테스트

```sh
npm test                 # strict TypeScript build + localhost Mock / CLI / engine 테스트
npm run test:keychain    # macOS: 별도 UUID 서비스의 가짜 키만 생성·조회·교체·삭제
npm run test:live        # opt-in 없으면 실제 API 테스트는 NOT RUN / skip
```

실제 모델 조회 테스트는 Secret Manager 등에서 해당 환경 키를 주입한 후 `NIDUS_LIVE=1 npm run test:live`로 실행합니다. 실제 채팅에는 추가로 `NIDUS_LIVE_CHAT=1` 및 `NIDUS_<PROVIDER>_MODEL`에 조회된 모델 ID를 지정해야 합니다. 실제 요청에는 과금이 발생할 수 있습니다. 테스트는 사용자의 기존 Keychain API 키를 자동으로 읽지 않습니다.

현재 검증: Mock/CLI/engine **42 PASS**, macOS Keychain synthetic **1 PASS**, 실제 터미널 숨김 입력 **PASS**, 실제 Provider 모델 조회·채팅 **8 NOT RUN**. 인증정보가 제공되지 않은 Provider는 실제 검증 완료로 표시하지 않습니다. 자세한 결과는 [검증 기록](docs/CONNECTIVITY_VALIDATION.md), 모듈 경계는 [아키텍처](docs/API_CONNECTIVITY.md)를 참고하세요.
