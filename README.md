# Nidus

TypeScript 기반 **Multi-Provider API Connectivity 엔진**과 **SwiftUI macOS 대시보드**입니다. Provider와 API Key로 모델을 자동 탐색하고, 선택한 모델에 텍스트 요청을 보내며 사용량을 공통 포맷으로 반환합니다. 기존 CLI도 그대로 사용할 수 있습니다.

OpenAI(GPT), Anthropic(Claude), Google Gemini, DeepSeek를 지원합니다. 작업 난이도 기반 자동 라우팅과 수동 선택을 지원합니다. Agent Loop, Tool 실행, Docker, Vault, Workflow는 구현 범위에 포함하지 않습니다.

## Phase 3: 사용량 및 예산

새로운 유료 채팅·모델 검사는 **전체 월간 예산과 단일 요청 예산을 설정한 뒤** 사용할 수 있습니다.
SwiftUI 툴바의 **사용량 및 예산** 또는 아래 CLI를 사용하세요.

```sh
nidus budget total --usd 20
nidus budget request --usd 5
nidus budget openai --usd 10
nidus usage
```

모든 추론은 공통 SQLite 예약·정산 경로를 거칩니다. 가격/안전한 상한 미확인은 차단하고,
실패·취소·사용량 누락의 비용은 0으로 간주하지 않습니다. 입력 용량 전체를 예약하므로
예약액은 실제 예상 비용보다 클 수 있습니다. 무료 티어 표시도 무료 잔량을 의미하지 않습니다.
예산과 기록은 UTC 월, USD 정수 nano 단위로 보존합니다.

대시보드는 로컬 추정·확인·미확인·예약·잔여 예산을 구분합니다. 선택적 조직 조회는 별도
관리자 세션 키를 사용하며 외부 사용이 섞인 조직 비용을 로컬 예산에 합산하지 않습니다.
**이 기능은 제공업체 청구액의 절대 한도를 보장하지 않습니다.**

설정, 공식 가격 검증 출처, 관리자 키 정책, 테스트와 제한은
[Phase 3 설계·검증 문서](docs/Phase3_Usage_Budget.md)를 참고하세요.

## Phase 4.1: 사용자 설정 Tier 라우팅

채팅방에서 **자동 라우팅**을 켜고 Simple / Normal(기본) / Complex를 선택할 수 있습니다.
**후보·예산 확인**은 로컬 조회만 실행합니다. 실제 선택 모델과 전환 사유, 예약 상한·추정 비용을 표시하며
모든 호출은 Phase 3 Budget Guard를 거칩니다. CLI는 `nidus chat --auto --difficulty normal`입니다.

툴바 **Tier 및 라우팅**에서 모델 Tier와 난이도별 순서를 변경합니다. 기본 순서는 Simple 1→2,
Normal 2→1, Complex 3→2이며, Tier 순서는 비용보다 우선합니다. 허용하지 않은 Tier로 전환하지 않습니다.

**자동 유료 API 사용 허용**은 초기 꺼짐입니다. 전체 유료 호출을 허용하거나, 무료 티어 지원 모델에
대해서만 과금 가능성을 확인하고 별도로 호출을 승인할 수 있습니다. 어느 경우에도 기존 예산을 검사하고
유료 상한을 예약하며, 승인이 비용을 0으로 바꾸지는 않습니다. Provider별 예산을 우선 표시하며
전체·단일 요청 예산은 고급 설정에 있습니다.
가격 또는 Tier 미확인은 자동 선택에서 제외합니다.
타임아웃·네트워크 오류에서는 자동 전환을 중단합니다. 무료 티어만으로 무료 사용을 가정하지 않습니다.
현재 설정·정책·마이그레이션은 [Phase 4.1 문서](docs/Phase4_1_Tier_Router.md), 기존 검증 이력과
공식 출처는 [Phase 4 문서](docs/Phase4_Model_Router.md)에 정리했습니다.
모델 Tier의 실행 직전 재검증, 무료 상태·계정별 승인, Tier 순서 드래그는
[Phase 4.1 추가 개선 문서](docs/Phase4_1_Free_Use.md)를 참고하세요.

## 설치와 시작

Node.js 22.13 이상(검증: 24.21.0), npm이 필요합니다. macOS Keychain 사용에는 Xcode Command Line Tools의 `swiftc`가 필요합니다. 대시보드는 macOS 13 이상을 대상으로 하며 Swift 5.9 이상으로 빌드합니다. API 연결 엔진과 CLI는 TypeScript이고, UI는 SwiftUI/AppKit입니다. 외부 npm 런타임 라이브러리는 없습니다.

## macOS 대시보드

```sh
npm ci
npm run build
npm run build:keychain
swift run NidusNativeApp
```

1. 왼쪽에서 OpenAI, Claude, Gemini, DeepSeek 중 서비스를 선택합니다.
2. **API Key 등록 / 변경**에서 해당 업체의 API 키를 입력합니다. 별도 Endpoint 설정은 필요 없습니다.
3. **연결 및 모델 조회**를 누르면 공식 Models API의 전체 페이지를 조회하고, 성공한 키는 Keychain에 저장합니다. 반환된 모델 목록은 즉시 표시됩니다.
4. 모델을 검색·선택해 기능, 가격과 출처를 확인합니다. **모델 새로고침**은 API를 다시 조회합니다.
5. **응답 테스트**에서 시스템 프롬프트, 메시지와 출력 한도를 입력하여 실제 요청을 보냅니다. 응답과 입력·출력 토큰 수가 표시되며 비용이 발생할 수 있습니다.
6. 더 보기 메뉴에서 전체 가격 데이터를 보거나 키와 모델 캐시를 삭제할 수 있습니다. 삭제는 확인 후 실행됩니다.

기존 CLI의 Keychain과 모델 캐시를 공유합니다. 앱을 열 때는 비밀키를 읽거나 API를 호출하지 않고 캐시만 표시합니다. **저장된 목록 · 재확인 필요**는 인증 성공 표시가 아닙니다. 연결 또는 새로고침 성공 시에만 **연결 확인됨 · Models API**로 바뀝니다. Models API 성공도 모든 모델의 채팅·과금 권한을 보장하지 않습니다. 기능이 불확실하면 `미확인`으로 표시합니다.

키 입력은 AppKit의 마스킹 필드이며 credential content type과 텍스트 자동완성을 지정하지 않습니다. 시스템의 Keychain 접근 허용 창은 정상적인 보안 확인이며 비밀번호 자동완성 팝업과 별개입니다. OS별 비밀번호 제안 억제 동작은 수동 추가 검증이 필요합니다. 대시보드는 환경변수 API 키 대신 Keychain만 사용하므로 CLI의 `--env` 계정이 앱에 암묵적으로 적용되지 않습니다.

### Finder에서 실행할 로컬 앱

```sh
npm run build:app
open dist/Nidus.app
```

현재 머신의 Node 실행 파일, 컴파일한 Runtime과 Keychain helper를 포함합니다. 로컬 `.app` 실행과 엔진 준비 상태를 확인했습니다. **배포용 서명·공증 및 다른 Mac에서의 실행은 검증하지 않았습니다.** 앱 아키텍처와 포함한 Node의 macOS 요구사항은 빌드 머신에 따릅니다. Node를 갱신하면 앱도 다시 빌드하세요.

개발 실행에서 경로를 못 찾으면 `command -v node`로 실행 파일을 확인합니다. Node가 활성화된 터미널에서 `swift run`을 실행하거나 `NIDUS_NODE_PATH`에 그 절대 경로를 지정하세요. `NIDUS_RUNTIME_ROOT`는 `dist/dashboard.js`가 있는 저장소 루트입니다. 탐색 순서는 명시적 설정 → 앱 리소스 → 현재 디렉터리 → 컴파일 시 소스 루트이며, Node는 명시적 설정 → 번들 → PATH → 표준 설치 위치입니다. 누락된 파일은 원인과 빌드 명령을 화면에 표시합니다.

### 모델 분류와 일괄 동작 검사

모델 목록의 **용도** 필터로 텍스트, 이미지 생성, 영상 생성, 라이브, 음성/음악, 임베딩, 모더레이션, 기타/미확인을 나눠 볼 수 있습니다. API 메타데이터가 우선이며 이름 기반 판단은 **추정**으로 표시합니다. 이미지 입력을 읽는 텍스트 모델을 이미지 생성 모델로 분류하지 않습니다. 기존 캐시도 읽을 때 다시 분류하므로 이 기능을 위해 유료 요청을 보낼 필요는 없습니다.

상단 **모델 일괄 검사**에서 현재 Provider 또는 전체 Provider의 저장된 목록을 검사합니다.

- 실행 전 예정 요청 수와 제외 사유를 확인하고 과금 가능성에 동의해야 시작합니다.
- 기본 최대 20회, 최대 500회까지 설정 가능하며 Provider 순서·모델 ID 순으로 실행합니다. 한도 밖 모델은 미검사로 남습니다.
- OpenAI/Gemini처럼 텍스트 호환성이 확정되지 않은 경우 **이름으로 추정한 텍스트 모델도 포함**을 켜야 검사합니다. 완전히 미확인인 모델은 자동 호출하지 않습니다.
- 각 요청은 `Reply with OK.`, 최대 출력 256토큰, HTTP 제한 30초이며 순차 실행·요청 간 1초 간격입니다. Keychain 접근 시간은 별도이며 앱의 기존 프로세스 watchdog도 유지됩니다. 자동 재시도는 없습니다.
- 진행률, 모델별 결과·시각·응답 시간·보고된 토큰 사용량을 표시합니다. 결과 상태별 필터와 모델 검색을 지원합니다. **중지**는 현재 요청을 완료한 뒤 다음 호출을 막습니다. 이미 전송한 요청의 과금 취소를 보장하지 않습니다.
- 429(Rate Limit), 인증/권한/키 저장소/쿼터 오류나 전달·응답 해석 오류는 해당 모델의 실패로 기록하고 다음 모델을 계속 검사합니다. 같은 모델을 자동 재시도하지 않습니다. 계정 전체 제한이라면 이후 요청도 실패할 수 있으므로 반복 오류가 보이면 **중지**하세요.
- 검사 버튼에 마우스를 올리면 대상 범위·실패 후 진행·과금 안내가 표시됩니다. 검사 창에도 실행 방식 설명을 항상 표시합니다.
- 성공·실패 결과는 모델별 최신 기록으로 자동 저장하고 재실행 시 복원합니다. **미검사 모델만 검사**가 기본으로 켜져 있어 저장된 성공·실패 모델은 요청 한도를 소비하지 않습니다. 끄면 기존 모델도 재검사하여 결과를 갱신합니다. 중지·미지원·한도 제외 모델은 검사 완료로 저장하지 않습니다.
- 모델 새로고침은 기록을 유지합니다. 앱에서 키 등록/변경/삭제를 시도하면 해당 Provider 기록을 초기화합니다(실패한 변경 시도도 포함). 과거 결과는 현재의 권한·할당량·모델 상태를 보장하지 않습니다.
- 저장 위치는 `~/Library/Application Support/Nidus/model-health.json`이며 검사 시각·상태·안전한 오류·응답 시간·입출력 토큰 수만 모델 정보와 함께 저장합니다. API 키·프롬프트·생성 본문은 저장하지 않습니다. 저장 실패는 검사 창에 표시됩니다. 이전 버전에서 종료된 세션의 결과는 복원할 수 없습니다.

**이번 버전은 텍스트 응답 검사기만 제공합니다.** 이미지·영상 생성, 라이브 세션, 음성, 임베딩 등은 분류와 제외 사유를 제공하지만 실제 전용 호출을 하지 않습니다. `미검사`는 정상도 실패도 아닙니다. `텍스트 응답 확인`도 모든 기능의 정상 작동을 의미하지 않습니다. 출력 예산을 사고 토큰에 쓰는 모델, 권한/버전/엔드포인트 호환성 문제는 `요청 실패/판정 보류`가 될 수 있습니다. 가격 미확인 모델의 비용을 0으로 계산하지 않으며 금액 상한도 보장하지 않습니다.

분류 근거·검사 범위·공식 출처와 검증 기록은 [MODEL_HEALTH.md](docs/MODEL_HEALTH.md)를 참고하세요.

### Provider를 바꿔가며 이어가는 채팅방

상단 **채팅방**에서 방을 만들고 Provider와 모델을 선택해 메시지를 보냅니다. 선택지에는 텍스트 채팅용으로 분류되고 최근 동작 검사를 통과한 모델만 표시합니다. 검사 실패·미검사·미확인·미지원·이미지·영상·라이브 모델은 제외합니다. AI 답변은 원본 줄바꿈을 보존하며 제목, 문단, 인라인 강조·링크, 순서/비순서 목록, 인용, 구분선, 표, fenced code block을 Markdown 미리보기로 렌더링합니다. 각 답변의 **원문/미리보기** 버튼으로 전환할 수 있습니다. 같은 방에서 Provider/모델을 바꾸면 최근 최대 100개의 성공한 대화 메시지를 선택한 API에 문맥으로 전달합니다. 각 메시지에는 사용한 Provider·모델이 표시되고, 방 제목·system prompt·대화는 로컬에 저장되어 앱을 다시 실행해도 이어집니다. 방은 왼쪽 목록에서 만들거나 삭제할 수 있습니다.

채팅 데이터는 `~/Library/Application Support/Nidus/chat-rooms.json`에 저장하며 파일 권한은 0600입니다. API Key, 실패한 사용자 발화는 전송 문맥에서 제외하고, 서버 응답 본문과 system prompt/사용자 대화는 로컬 대화 기록에 저장됩니다. API 요청에는 실제 비용이 발생할 수 있습니다. 각 호출은 현재 선택한 Provider 키와 모델을 사용합니다.

### CLI 사용

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
- 캐시: `~/.local/share/nidus/<provider>.json`. 모델 메타데이터만 저장하며 파일 권한은 `0600`, 생성 디렉터리는 `0700`입니다. 모델 캐시에는 프롬프트·응답·사용량을 저장하지 않습니다. 채팅 기록과 사용량 장부는 위에 설명한 별도 저장소를 사용합니다.
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

`--timeout-ms` 기본값은 모델 조회 30초, 채팅 120초이며 본문 읽기와 전체 페이지 조회에도 적용합니다. Ctrl-C로 요청을 취소합니다. HTTP 리다이렉트를 따라 인증정보를 전달하지 않습니다. 수동 요청은 자동 재시도하지 않습니다. 자동 라우팅은 명시적 거절 오류에서만 다른 후보를 시도하며, 타임아웃·네트워크 오류는 중단합니다. 가격 계산과 선택적 계정 조회는 Phase 3 문서를 참고하세요.

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
swift test               # 앱 상태, 경로 탐색, Pipe 분리, 종료 및 타임아웃
```

실제 모델 조회 테스트는 Secret Manager 등에서 해당 환경 키를 주입한 후 `NIDUS_LIVE=1 npm run test:live`로 실행합니다. 실제 채팅에는 추가로 `NIDUS_LIVE_CHAT=1` 및 `NIDUS_<PROVIDER>_MODEL`에 조회된 모델 ID를 지정해야 합니다. 실제 요청에는 과금이 발생할 수 있습니다. 테스트는 사용자의 기존 Keychain API 키를 자동으로 읽지 않습니다.

Connectivity MVP 당시 검증: Mock/CLI/engine **42 PASS**, macOS Keychain synthetic **1 PASS**, 실제 터미널 숨김 입력 **PASS**, 실제 Provider 모델 조회·채팅 **8 NOT RUN**. 인증정보가 제공되지 않은 Provider는 실제 검증 완료로 표시하지 않습니다. 자세한 결과는 [검증 기록](docs/CONNECTIVITY_VALIDATION.md), 모듈 경계는 [아키텍처](docs/API_CONNECTIVITY.md)를 참고하세요.
