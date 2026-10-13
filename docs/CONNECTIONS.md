# Nidus AI Connections

Nidus manages Direct, Gateway, Compatible, and reserved Local connections through one Connection Registry, Credential Store, and Model Catalog. Users may register Gemini, OmniRoute, and a Generic OpenAI-compatible endpoint at the same time. OmniRoute is an officially supported gateway option and is not a Nidus dependency. Adding a Connection does not change legacy Task/Plan routing.

| Connection kind | Provider identity | Adapter |
|---|---|---|
| direct | Google Gemini (`gemini`) | `GeminiAdapter` |
| gateway | OmniRoute (`omniroute`) | `OpenAICompatibleAdapter` |
| compatible | OpenAI-compatible API (`openai-compatible`) | `OpenAICompatibleAdapter` |
| local | reserved for later | not implemented |

## 연결 방법

`python3 -m nidus --vault "$vault" gui`를 실행하고 **설정 → AI 연결 → Google Gemini**를 선택합니다. Google AI Studio에서 발급한 Gemini API Key를 입력하고 **연결 확인**을 누릅니다. Endpoint, model ID, route, policy, context length, JSON 설정은 입력하지 않습니다. Nidus가 모델 목록을 조회해 `generateContent`를 지원한다고 공식 metadata에 표시된 모델만 대상으로 최대 5개를 검사합니다. 일반 텍스트 응답과 JSON 응답이 모두 검증된 모델이 있으면 `READY`가 됩니다.

Probe는 계정에서 사용 가능한 모델에 실제 API 요청을 보내므로 Google의 요금·quota 정책이 적용될 수 있습니다. Nidus는 Gemini를 무료라고 표시하거나 가격/무료 quota를 추정하지 않습니다. 고정된 짧은 합성 문구만 전송하며 Vault의 사용자 자료는 전송하지 않습니다.

**통합 Gateway → OmniRoute**를 선택하면 기본 Endpoint `http://127.0.0.1:20128/v1`과 Endpoint Key를 입력합니다. 모델 ID를 받지 않으며 Chat Completions discovery/probe/generation은 기존 `OpenAICompatibleAdapter`가 수행합니다.

**호환 API → OpenAI-compatible API**는 표시 이름(선택), Base URL, API Key를 받습니다. API Key가 필요 없는 호환 local endpoint도 지원합니다. 이 항목은 OmniRoute와 분리된 identity를 유지합니다.

### 여러 모델을 노출하는 호환 게이트웨이

호환 Endpoint가 모델별 generation metadata를 제공하지 않으면 Adapter는 이름순 앞의 최대 3개 모델만 검사합니다. OmniRoute의 Endpoint Key가 허용한 모델 중 이 제한 안에 있는 후보가 적어도 하나는 일반·JSON 응답을 모두 지원해야 연결이 `ready`가 됩니다. 사용할 모델만 허용한 제한적 OmniRoute Key를 발급하면 이 조건을 예측 가능하게 만들 수 있습니다. Probe의 후보 제한은 연결 확인을 위한 것이며 이후 Runtime 자동 라우팅 기능은 아닙니다.

2026-10-13에 보존된 [과거 OmniRoute 검증](evidence/connection-omniroute-live.json)은 모델 목록의 첫 항목들이 채팅 호출을 거부했지만 `gh/gpt-4o-mini`의 일반/구조화 응답은 통과했던 사례입니다. 그때의 first-three 제한은 이제 Gemini metadata 기반 후보 선택에는 적용되지 않습니다. 과거 evidence는 역사 자료로 보존합니다.

## 상태와 모델 Catalog

Connection 상태는 `configured`, `probing`, `ready`, `degraded`, `blocked`입니다. `ready`는 적어도 하나의 발견 모델에서 일반 응답과 구조화 JSON 응답을 실제로 확인했음을 뜻합니다. 일반 응답만 가능한 모델은 Catalog에 `available`로 남을 수 있지만, 구조화 probe가 실패하면 다음 Gemini 후보를 계속 검사합니다. 이후 후보가 둘 다 통과하면 그 모델을 선택하고 연결을 `ready`로 만듭니다. 후보 전체가 성공하지 않으면 연결은 `degraded` 또는 오류 유형에 따라 `blocked`입니다.

Gemini discovery는 공식 `models.list`의 `supportedGenerationMethods`에서 `generateContent`를 찾습니다. API가 반환한 순서를 유지하고 최대 5개만 probe하므로 고정 모델 이름이나 오래된 별칭을 기본값으로 하드코딩하지 않습니다. embedding·이미지 등 `generateContent`를 지원하지 않는 모델은 후보 및 Catalog에 넣지 않습니다. Generic compatibility 연결은 모델 metadata가 없는 경우를 위해 이름순 최대 3개라는 별도 제한을 유지합니다.

Catalog는 발견한 모델 ID와 Provider 반환 순서, 검증된 chat/structured capability, 실제 응답의 model version, latency와 API가 제공한 token metadata를 기록합니다. 가격, context length, 무료 quota를 추측하지 않으며 이 값들은 알 수 없는 상태로 남습니다. 기존에 저장된 Task/Plan policy는 연결 추가만으로 바뀌지 않습니다. GUI에서 새 Plan을 구성할 때는 현재 `ready` 상태이고 일반/구조화 응답 검증을 통과한 Catalog 모델을 추천하며, 선택한 연결을 포함한 Planning policy를 생성합니다. 현재는 같은 선택 모델 정책을 Worker/Review/Final에도 상속합니다. 역할별 모델을 자동 배정하는 Route Broker는 구현하지 않았습니다.

실행 후보의 identity는 global `model_id`가 아니라 `(connection_id, model_id)`입니다. 같은 모델명이 Gemini direct와 OmniRoute gateway 양쪽에서 발견되면 인증·quota·장애 상태·upstream이 다른 별도 후보로 Catalog에 남습니다. 이번 Slice는 global model deduplication이나 Route Broker를 구현하지 않습니다.

### 향후 OmniRoute 사용 모드

이번 Slice에서는 다음 두 라우팅 모드를 구현하지 않습니다.

**Transparent Gateway:** Nidus가 특정 OmniRoute model ID를 고르고 OmniRoute는 그 요청을 upstream에 전달합니다. 이후 Route Broker를 만들 때 기본 권장 모드로 삼을 수 있습니다.

**Managed Gateway:** Nidus가 OmniRoute Combo 또는 managed model을 고르면 실제 upstream 모델은 OmniRoute가 선택합니다. 향후 Nidus는 응답의 actual model과 execution evidence를 기록해야 합니다.

두 모드는 현재 GUI Connection 등록/probe와 기존 `/models` discovery에 영향을 주지 않습니다.

### Legacy Plan/Task routing boundary

`nidus/gateway.py`의 기존 `default_policy()`와 이미 저장된 Plan/Task route 정책은 legacy 경로로 유지됩니다. 새 Direct/Gateway/Compatible Connection을 등록해도 기존 업무의 policy는 바뀌지 않습니다. 자연어 Plan 구성은 검증된 Connection Catalog에서 모델을 선택해 그 Plan 전용 정책을 생성합니다. 기존 CLI 정책의 Connection Registry 전환과 역할별 자동 배정은 별도 범위입니다.

## 설계와 보안 경계

Manifest는 Provider 표시 이름, `connection_kind`, auth 유형, 기본 endpoint, endpoint 수정 가능 여부, credential label, API key 필요 여부, adapter ID, model discovery 여부를 가집니다. Provider identity와 protocol implementation은 별개입니다. Registry는 manifest adapter ID를 lookup하며 `ConnectionRegistry`는 공통 discovery/generate/probe 계약만 호출합니다. 별도의 OmniRoute adapter는 없습니다.

현재 연결 경로는 다음과 같습니다.

```text
Google Gemini (direct) → GeminiAdapter → Gemini GenerateContent REST API
OmniRoute (gateway) ─────┐
                         ├→ OpenAICompatibleAdapter → Chat Completions
Generic (compatible) ────┘
```

Gemini API Key와 호환 API Key는 기존 macOS `Security.framework` Keychain `CredentialStore`에 저장합니다. SQLite와 Model Catalog에는 무작위 `cred_…` reference만 남습니다. Gemini 요청은 Key를 URL query가 아니라 `x-goog-api-key` header로 전달합니다. API 응답 오류 body를 읽거나 저장하지 않으며 endpoint/모델 응답에 Key가 반향되면 연결을 거부합니다. GUI는 기존 Key를 다시 표시하지 않고 API 응답에 credential을 넣지 않습니다.

기존 record에서 `connection_kind`가 없으면 Provider ID를 기준으로만 채웁니다: `gemini→direct`, `omniroute→gateway`, `openai-compatible→compatible`. migration은 재시작해도 결과가 같고 endpoint URL로 Provider를 추측하지 않습니다. 이미 `openai-compatible`로 변환된 과거 record는 compatible로 남습니다. Manifest와 record의 kind가 모순되면 probe가 `connection_kind_mismatch`로 거부합니다.

SQLite에는 connection metadata와 model observations만 저장됩니다. 기존 Keychain 경계, Host/Origin/session token 검증, Task/Plan transmission 승인과 policy 동작은 유지됩니다. 연결 검사는 Task/Plan을 생성하거나 실행하지 않습니다.

## 현재 범위와 다음 확장

지원 상태:

- **Direct:** Google Gemini API Key, `models.list`, generation 후보 필터, `generateContent`, 일반 및 JSON probe.
- **Gateway:** OmniRoute Endpoint Key와 수정 가능한 endpoint, `/models`, generation, structured probe.
- **Compatible:** 임의 OpenAI-compatible Chat Completions endpoint. 인증 없는 호환 endpoint도 허용합니다.
- **Not implemented:** OpenAI native, Anthropic, Groq, Cloudflare, NVIDIA native, OAuth, 무료 Provider catalog, Route Broker, 자동 Provider 선택.

향후 connection type은 API Key, OAuth, Local, 공식 Session Connector 등으로 확장할 수 있습니다. Session Connector는 Provider가 문서화하고 자동화를 허용하는 공식 OAuth/session API가 있을 때만 추가합니다. 비공식 Web cookie scraping은 지원하지 않습니다. 추가 Provider는 공식 API·metadata·약관을 확인하고 한 번에 하나씩 구현·검증합니다.

## 검증 자료

- [Synthetic Gemini fixture evidence](evidence/gemini-native-synthetic.json): deterministic local HTTP fixture, 실제 Google API 검증이 아님.
- [실제 Gemini probe](evidence/gemini-native-live.json): 로컬 API credential이 준비되지 않아 `NOT RUN`으로 기록.
- [과거 OmniRoute live evidence](evidence/connection-omniroute-live.json): 유지된 historical record.
- [기존 Keychain evidence](evidence/connection-keychain.json)와 [GUI fixture review](evidence/connection-gui-review.json).

OmniRoute connection을 등록하고 probe한 이번 Slice는 합성 OpenAI-compatible loopback fixture로 검증합니다. 실제 OmniRoute live probe는 새로 실행하지 않았습니다. 기존 [historical live evidence](evidence/connection-omniroute-live.json)는 과거 동작을 기록하며 현재 구현의 검증 결과로 간주하지 않습니다.

검증 상태와 재현 명령은 [VALIDATION](VALIDATION.md)에 기록합니다.
