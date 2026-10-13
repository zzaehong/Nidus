# Native Provider Connection — Slice 1

Nidus is moving Provider connections toward direct APIs. The current connection UI supports **Google Gemini natively** and **Generic OpenAI-compatible API**. OmniRoute is optional: connect it, LM Studio, NVIDIA NIM, or another compatible endpoint through the generic entry. The Connection path does not require OmniRoute.

## 연결 방법

`python3 -m nidus --vault "$vault" gui`를 실행하고 **설정 → AI 연결 → Google Gemini**를 선택합니다. Google AI Studio에서 발급한 Gemini API Key를 입력하고 **연결 확인**을 누릅니다. Endpoint, model ID, route, policy, context length, JSON 설정은 입력하지 않습니다. Nidus가 모델 목록을 조회해 `generateContent`를 지원한다고 공식 metadata에 표시된 모델만 대상으로 최대 5개를 검사합니다. 일반 텍스트 응답과 JSON 응답이 모두 검증된 모델이 있으면 `READY`가 됩니다.

Probe는 계정에서 사용 가능한 모델에 실제 API 요청을 보내므로 Google의 요금·quota 정책이 적용될 수 있습니다. Nidus는 Gemini를 무료라고 표시하거나 가격/무료 quota를 추정하지 않습니다. 고정된 짧은 합성 문구만 전송하며 Vault의 사용자 자료는 전송하지 않습니다.

OpenAI-compatible Provider를 선택하면 기존처럼 호환 Endpoint와 Key를 입력합니다. 이 방식으로 로컬 서버, NVIDIA NIM 또는 필요에 따라 OmniRoute를 연결할 수 있습니다. Generic 호환 Adapter는 Chat Completions 규격과 discovery 동작을 사용합니다.

### 여러 모델을 노출하는 호환 게이트웨이

호환 Endpoint가 모델별 generation metadata를 제공하지 않으면 Generic Adapter는 이전 동작대로 이름순 앞의 최대 3개 모델만 검사합니다. OmniRoute와 같은 다중 API 게이트웨이의 연결이 실패하면 우선 실제로 사용할 수 있고 일반·JSON 응답을 지원하는 모델과 해당 upstream 연결만 허용한 Endpoint Key를 발급해 확인하세요. 이 설정은 Generic endpoint에서 첫 후보 검사를 예측 가능하게 하는 운영상 선택입니다. OmniRoute는 여전히 호환 API를 제공하는 선택지이며 Nidus의 필수 구성요소가 아닙니다.

2026-10-13에 보존된 [과거 OmniRoute 검증](evidence/connection-omniroute-live.json)은 모델 목록의 첫 항목들이 채팅 호출을 거부했지만 `gh/gpt-4o-mini`의 일반/구조화 응답은 통과했던 사례입니다. 그때의 first-three 제한은 이제 Gemini metadata 기반 후보 선택에는 적용되지 않습니다. 과거 evidence는 역사 자료로 보존합니다.

## 상태와 모델 Catalog

Connection 상태는 `configured`, `probing`, `ready`, `degraded`, `blocked`입니다. `ready`는 적어도 하나의 발견 모델에서 일반 응답과 구조화 JSON 응답을 실제로 확인했음을 뜻합니다. 일반 응답만 가능한 모델은 Catalog에 `available`로 남을 수 있지만, 구조화 probe가 실패하면 다음 Gemini 후보를 계속 검사합니다. 이후 후보가 둘 다 통과하면 그 모델을 선택하고 연결을 `ready`로 만듭니다. 후보 전체가 성공하지 않으면 연결은 `degraded` 또는 오류 유형에 따라 `blocked`입니다.

Gemini discovery는 공식 `models.list`의 `supportedGenerationMethods`에서 `generateContent`를 찾습니다. API가 반환한 순서를 유지하고 최대 5개만 probe하므로 고정 모델 이름이나 오래된 별칭을 기본값으로 하드코딩하지 않습니다. embedding·이미지 등 `generateContent`를 지원하지 않는 모델은 후보 및 Catalog에 넣지 않습니다. Generic compatibility 연결은 모델 metadata가 없는 경우를 위해 이름순 최대 3개라는 별도 제한을 유지합니다.

Catalog는 발견한 모델 ID와 Provider 반환 순서, 검증된 chat/structured capability, 실제 응답의 model version, latency와 API가 제공한 token metadata를 기록합니다. 가격, context length, 무료 quota를 추측하지 않으며 이 값들은 알 수 없는 상태로 남습니다. 기존 Task/Plan policy는 계속 별도로 동작하며 이 Connection/Catalog를 자동으로 사용하지 않습니다. Role별 라우팅과 Route Broker는 후속 Slice입니다.

## 설계와 보안 경계

Manifest는 Provider 표시 이름, auth 유형, 기본 endpoint, endpoint 수정 가능 여부, credential label, API key 필요 여부, adapter ID, model discovery 여부만 가집니다. Registry는 manifest의 adapter ID를 adapter lookup으로 해석합니다. `ConnectionRegistry`는 공통 discovery/generate/probe 계약만 호출하며 OpenAI Chat Completions wire format을 직접 알지 않습니다. 구현은 작은 `ProviderAdapter` 계약으로 제한하며 별도의 plugin framework는 없습니다.

현재 연결 경로는 다음과 같습니다.

```text
Google Gemini → GeminiAdapter → Gemini GenerateContent REST API
OpenAI-compatible API → OpenAICompatibleAdapter → Chat Completions
```

Gemini API Key와 호환 API Key는 기존 macOS `Security.framework` Keychain `CredentialStore`에 저장합니다. SQLite와 Model Catalog에는 무작위 `cred_…` reference만 남습니다. Gemini 요청은 Key를 URL query가 아니라 `x-goog-api-key` header로 전달합니다. API 응답 오류 body를 읽거나 저장하지 않으며 endpoint/모델 응답에 Key가 반향되면 연결을 거부합니다. GUI는 기존 Key를 다시 표시하지 않고 API 응답에 credential을 넣지 않습니다.

이전 버전에서 저장한 `omniroute` Provider 연결이 있으면 Registry 시작 시 Provider ID만 `openai-compatible`로 바꿉니다. 사용자의 Endpoint, connection 이름, Keychain reference, Catalog와 Probe 기록은 유지되므로 기존 연결을 generic compatibility 경로로 계속 관리할 수 있습니다. 새 OmniRoute manifest는 목록에 노출하지 않습니다.

SQLite에는 connection metadata와 model observations만 저장됩니다. 기존 Keychain 경계, Host/Origin/session token 검증, Task/Plan transmission 승인과 policy 동작은 유지됩니다. 연결 검사는 Task/Plan을 생성하거나 실행하지 않습니다.

## 현재 범위와 다음 확장

지원 상태:

- **Native:** Google Gemini API Key, `models.list`, generation 후보 필터, `generateContent`, 실제 일반 및 JSON probe.
- **Compatibility:** 임의 OpenAI-compatible Chat Completions endpoint. OmniRoute도 이 방식으로 선택해 연결할 수 있습니다.
- **Not implemented:** OpenAI native, Anthropic, Groq, Cloudflare, NVIDIA native, OAuth, 무료 Provider catalog, Route Broker, 자동 Provider 선택.

향후 connection type은 API Key, OAuth, Local, 공식 Session Connector 등으로 확장할 수 있습니다. Session Connector는 Provider가 문서화하고 자동화를 허용하는 공식 OAuth/session API가 있을 때만 추가합니다. 비공식 Web cookie scraping은 지원하지 않습니다. 추가 Provider는 공식 API·metadata·약관을 확인하고 한 번에 하나씩 구현·검증합니다.

## 검증 자료

- [Synthetic Gemini fixture evidence](evidence/gemini-native-synthetic.json): deterministic local HTTP fixture, 실제 Google API 검증이 아님.
- [실제 Gemini probe](evidence/gemini-native-live.json): 로컬 API credential이 준비되지 않아 `NOT RUN`으로 기록.
- [과거 OmniRoute live evidence](evidence/connection-omniroute-live.json): 유지된 historical record.
- [기존 Keychain evidence](evidence/connection-keychain.json)와 [GUI fixture review](evidence/connection-gui-review.json).

검증 상태와 재현 명령은 [VALIDATION](VALIDATION.md)에 기록합니다.
