# Nidus

TypeScript 엔진과 SwiftUI macOS 앱입니다. 폴더 하나를 Vault로 열면 그 Vault를 위한 AI 팀(Main·Manager·Worker)이 생기고, Worker는 격리된 VM과 승인제 네트워크 안에서 일합니다. Provider와 API Key로 모델을 자동 탐색하고, 역할·난이도별로 배정한 모델에 요청을 보내며 사용량을 기록합니다.

OpenAI, Anthropic, Gemini(Free·Paid), DeepSeek, NVIDIA NIM, Groq, Mistral, Cloudflare Workers AI를 지원합니다. Vault와 Agent Runtime의 개발 범위 및 제한은 [문서 목차](docs/README.md#vault와-agent-runtime)에서 확인할 수 있습니다.

## 문서 안내

- [전체 문서 목차](docs/README.md): 주제별 설계·구현·검증 기록
- [변경 기록](CHANGELOG.md): 판마다 들어간 것과 알려진 한계
- [Vault 및 브라우저 문서](docs/README.md#vault와-agent-runtime): Agent Runtime, VM, 브라우저 기능과 검증 범위
- [개발 규칙](docs/Git_Flow.md): 브랜치, 검증, 커밋 및 병합 절차

## 설치와 시작

Node.js 22.13 이상(검증: 24.21.0), npm이 필요합니다. macOS Keychain 사용에는 Xcode Command Line Tools의 `swiftc`가 필요합니다. 앱은 macOS 13 이상을 대상으로 하며 Swift 5.9 이상으로 빌드합니다. 엔진은 TypeScript이고, UI는 SwiftUI/AppKit입니다. 외부 npm 런타임 라이브러리는 없습니다.

## Nidus 앱 (Vault 기반)

```sh
npm ci
npm run build:app
open dist/Nidus.app
```

폴더 하나(Obsidian Vault 같은 문서 폴더나 Git 저장소)를 Agent Vault로 열면, 그 Vault를 위한 AI 팀이 생깁니다. 개발 중에는 `npm run build && npm run build:keychain && swift run Nidus`로도 실행할 수 있습니다. 버전 0.2.0의 범위는 [CHANGELOG.md](CHANGELOG.md)에 있습니다.

- **Main**: AI 팀의 리더와 직접 대화합니다. 묻는 말에는 바로 답하고, 일을 맡기면 팀을 짜고 계획을 세워 보여 줍니다. 계획을 승인하면 팀이 일하고, 끝나면 Main이 결과를 바탕으로 답하며 결과 파일 링크를 붙입니다. "Library 정리"(Dream Sequence)와 "문서 연결 제안"도 여기서 시작합니다.
- **작업**: 진행 기록, Worker의 브라우저(화면을 보고 넘겨받을 수 있음), 네트워크 승인, 결과(브랜치) 검토. VM이 필요한 Task만 VM을 켭니다.
- **Library**: Vault의 문서를 읽기 전용으로 봅니다(Markdown·HTML 미리보기, 내용 검색). AI 팀이 쓴 문서는 `Nidus/` 폴더에 모입니다. 고치기는 Obsidian에서.
- **직원**: Vault의 상설 팀과 직원(Home). Main이 제안한 직원을 승인해 둡니다.
- **모델 배정**: 역할(Main·Lead Manager·Manager)과 Worker 난이도(단순·보통·복잡)마다 모델 후보를 우선순위 순서로 정합니다. "자동 채우기"가 검사 통과 모델로 채워 주고, 마음에 안 드는 모델은 작업 기록에서 바로 뺄 수 있습니다. 설정은 `.nidus/models.json`에 저장됩니다.
- **Provider**: API 키를 등록하고 모델 목록을 조회·검사합니다(실제 호출이라 요금이 들 수 있음). 키는 이 Mac의 Keychain에 저장되며 모든 Vault가 함께 씁니다. Gemini는 Free와 Paid가 별개 Provider이고, 모델별 할당량을 볼 수 있습니다.
- **사용량**: 이번 달 호출을 역할·난이도·모델별로 집계합니다. 기록은 `.nidus/local/usage.sqlite`에 있고 Git에서 제외됩니다. 월 예산을 넘어도 호출을 막지 않고 경고만 합니다.

설계는 [docs/architecture/](docs/architecture/)의 CONCEPT와 STAGE1·2·3 문서를 참고하세요. 로컬 개발용 서명 없는 번들이며 배포용 서명·공증은 하지 않았습니다. 예전 Provider 대시보드(Nidus Base)와 `nidus` CLI는 0.2.0 뒤에 지웠습니다.

## 키와 로컬 저장

- macOS Keychain service: `com.nidus.connectivity`, account: Provider ID. 기기 전용·잠금 해제 시 접근하며 동기화하지 않습니다.
- 키를 프로세스 인자, Git, 로그, 일반 설정 파일에 저장하지 않습니다.
- helper는 stdin/stdout 전용 Pipe로 키를 전달하며 키 값을 프로세스 인자에 넣지 않습니다. helper가 없으면 평문 저장으로 우회하지 않고 오류를 반환합니다.
- 캐시: `~/.local/share/nidus/<provider>.json`. 모델 메타데이터만 저장하며 파일 권한은 `0600`, 생성 디렉터리는 `0700`입니다. 모델 캐시에는 프롬프트·응답·사용량을 저장하지 않습니다. 채팅 기록과 사용량 장부는 위에 설명한 별도 저장소를 사용합니다.
- 키는 요청 중 프로세스 메모리에 존재합니다. JavaScript 문자열의 완전한 메모리 소거는 보장하지 않습니다.

CI 또는 macOS 외 환경에서는 `NIDUS_<PROVIDER>_API_KEY`(예: `NIDUS_OPENAI_API_KEY`)를 외부 Secret Manager에서 환경변수로 주입할 수 있습니다. 환경변수는 Keychain보다 우선하며 키를 영구 저장하지 않습니다. 키를 셸 명령에 직접 적으면 history에 남을 수 있으므로 피합니다.

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

레코드는 입력·출력·캐시 입력 가격(USD/백만 토큰), 무료 티어 상태, 출처 URL, 마지막 확인 시각, 요금 조건을 포함합니다. 현재 유료 가격 스냅샷은 9개 정확한 ID를 포함합니다. 신규 Provider의 별도 무료 지원 검토 목록은 유료 가격 확인과 독립적입니다. 전체 공급자 가격표를 복제하지 않으며 미검토 모델은 `status: unknown`, `rates: []`, `checkedAt: null`로 반환합니다. 미확인은 무료나 0원이 아닙니다. 앱은 탐색된 모델에 이 가격을 붙여 보여 줍니다.

- 기준: 직접 API의 표준 텍스트 요금. 캐시 쓰기·저장·도구·Batch·지역/계약별 과금은 별도입니다.
- DeepSeek는 피크·비피크를 모두 표시합니다. 중국 공휴일을 추측해서 요금을 자동 선택하지 않습니다.
- 무료 티어 표시는 계정의 실제 무료 할당량을 조회한 결과가 아닙니다.
- 가격 자동 갱신 API를 확인하지 못했으므로 자동 스크래핑/갱신을 구현하지 않습니다. 모델 새로고침은 모델 목록만 갱신합니다.
- 갱신 절차: 공식 URL 확인 → 정확한 ID·단위·조건 검토 → 가격 레코드와 `checkedAt` 갱신 → 테스트 → 커밋. 가격 기록의 확인 시각을 유지하며 실시간 가격이라고 표시하지 않습니다.

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
npm test                 # strict TypeScript build + Mock 기반 엔진·Office·작업장 테스트
npm run test:keychain    # macOS: 별도 UUID 서비스의 가짜 키만 생성·조회·교체·삭제
npm run test:live        # opt-in 없으면 실제 API 테스트는 NOT RUN / skip
swift test               # 앱 상태, 엔진 경로 탐색, Markdown 미리보기
```

실제 모델 조회 테스트는 Secret Manager 등에서 해당 환경 키를 주입한 후 `NIDUS_LIVE=1 npm run test:live`로 실행합니다. 실제 채팅에는 추가로 `NIDUS_LIVE_CHAT=1` 및 `NIDUS_<PROVIDER>_MODEL`에 조회된 모델 ID를 지정해야 합니다. 실제 요청에는 과금이 발생할 수 있습니다. 테스트는 사용자의 기존 Keychain API 키를 자동으로 읽지 않습니다.

인증정보가 제공되지 않은 Provider는 실제 검증 완료로 표시하지 않습니다. 과거 검증 결과는 [검증 기록](docs/validation/CONNECTIVITY_VALIDATION.md)에 있습니다.

### Provider별 설정과 지원 범위

계정 과금 유형과 실행 권한 설정은 [사용 가이드](docs/guides/USER_GUIDE.md)를 참고하세요. NVIDIA NIM, Groq, Mistral AI, Cloudflare Workers AI의 연결 방법과 검증 범위는 [Provider 확장](docs/providers/Phase4_2_Provider_Expansion.md), NVIDIA 모델 분류는 [분류 개선 기록](docs/providers/NVIDIA_Model_Classification.md)에 정리되어 있습니다.
