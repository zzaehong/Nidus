# Nidus — API 연결 최적화

## 목표

현재 `develop`을 기준으로 Nidus의 AI 연결 모델을 다음 구조로 정리하라.

```text
Nidus Connections
│
├─ Direct API
│   ├─ Google Gemini
│   ├─ 향후 OpenAI
│   ├─ 향후 Anthropic
│   └─ 향후 무료 API Provider
│
├─ Gateway
│   └─ OmniRoute
│       ├─ 여러 Provider
│       ├─ 여러 계정
│       └─ 여러 모델
│
├─ Compatible API
│   └─ Generic OpenAI-compatible
│
└─ Local
    └─ 향후 Ollama / LM Studio
```

이번 작업에서는 Gemini, OmniRoute, Generic OpenAI-compatible 세 연결만 실제 대상으로 한다.

핵심 원칙은 다음과 같다.

> Nidus는 Provider API를 직접 연결할 수도 있고, OmniRoute 같은 Gateway를 통해 연결할 수도 있다. 모든 연결은 동일한 Connection 계층에서 관리하며, 사용자는 API Key를 한 번 등록한 뒤 업무 수행 과정에서 Provider/Gateway 내부 복잡성을 다시 다루지 않는다.

---

# 1. 현재 상태를 먼저 감사하라

작업 시작 시 반드시 실제 저장소를 확인한다.

```bash
git status
git branch --show-current
git fetch
git checkout develop
git pull --ff-only
git log -1 --oneline
```

현재 원격 기준으로 확인된 `develop` HEAD는:

```text
c17832c5959648826f1e731173c719a54cc0d8db
```

이지만 실제 작업 시점의 최신 `develop`을 source of truth로 사용한다.

미커밋 변경이 있으면 임의 reset, checkout 복원, stash drop 등을 하지 말고 먼저 상태를 보존한다.

---

# 2. 현재 구현은 유지한다

다음은 다시 만들지 않는다.

```text
CredentialStore
MacOSKeychainCredentialStore
ConnectionRegistry
Model Catalog
ProviderAdapter
GeminiAdapter
OpenAICompatibleAdapter
Connection Probe
Connection GUI
ModelError taxonomy
```

현재 Gemini native connection은 유지한다.

현재 Generic OpenAI-compatible connection도 유지한다.

이번 작업은 Connection Foundation을 재작성하는 것이 아니라 **Connection의 의미와 분류를 정리하는 작업**이다.

---

# 3. Connection Kind 추가

Provider Manifest에 최소한 다음 분류를 추가한다.

```text
connection_kind

direct
gateway
compatible
local
```

이번 Slice에서 실제 사용하는 값은:

```text
Gemini
→ direct

OmniRoute
→ gateway

OpenAI-compatible
→ compatible
```

`local`은 미래 확장을 위해 enum/schema에는 허용할 수 있지만 이번 Slice에서 Local Provider를 새로 구현하지 않는다.

---

# 4. Provider와 Protocol을 분리한다

중요한 원칙:

```text
Provider identity
≠
Protocol implementation
```

예를 들어:

```text
Google Gemini
provider = gemini
connection_kind = direct
adapter = gemini
```

```text
OmniRoute
provider = omniroute
connection_kind = gateway
adapter = openai-compatible
```

```text
Generic OpenAI-compatible
provider = openai-compatible
connection_kind = compatible
adapter = openai-compatible
```

즉 OmniRoute를 다시 first-class Provider로 취급하되, wire protocol 구현은 기존 `OpenAICompatibleAdapter`를 재사용한다.

불필요한 `OmniRouteAdapter` 복제 클래스를 만들지 마라.

정말 OmniRoute 전용 동작이 필요해지기 전까지:

```text
OmniRoute Manifest
        ↓
OpenAICompatibleAdapter
```

이면 충분하다.

---

# 5. OmniRoute를 first-class Gateway로 복원

현재 구현은 저장된:

```text
provider = omniroute
```

Connection을 시작 시:

```text
provider = openai-compatible
```

로 바꾸고 있다.

이 동작을 제거한다.

앞으로 OmniRoute의 identity를 보존한다.

즉:

```text
provider = omniroute
connection_kind = gateway
```

로 존재해야 한다.

OmniRoute는 Nidus의 필수 의존성이 아니지만, **공식적으로 지원하는 Gateway Connection 중 하나**다.

---

# 6. 기존 데이터 migration

현재 저장된 Connection과 과거 버전 데이터를 안전하게 처리한다.

확실하게 판별 가능한 경우만 migration한다.

예:

```text
provider = gemini
→ connection_kind = direct

provider = openai-compatible
→ connection_kind = compatible

provider = omniroute
→ connection_kind = gateway
```

중요:

현재 이미 `openai-compatible`로 저장된 Connection을 endpoint가 `127.0.0.1:20128`이라는 이유만으로 OmniRoute라고 추측해 다시 바꾸지 마라.

```text
Generic Connection
→ OmniRoute라고 추측
```

하는 migration은 금지한다.

이미 과거 migration으로 identity가 사라진 Connection은 그대로 compatible로 유지한다.

사용자가 원하면 새 OmniRoute Connection을 추가할 수 있다.

Migration은:

```text
idempotent
restart-safe
history-preserving
```

이어야 한다.

---

# 7. Canonical Connection state

가능하면 Connection record 자체에도 생성 당시의 `connection_kind`를 저장한다.

개념:

```json
{
  "id": "conn_...",
  "provider": "gemini",
  "connection_kind": "direct",
  "credential_ref": "cred_...",
  "status": "ready"
}
```

Manifest와 record가 서로 모순되면 Runtime이 무시하지 말고 검증 실패시킨다.

기존 Connection에는 위 migration을 통해 값을 채운다.

---

# 8. Connection identity

앞으로 모델 후보의 identity를 단순 `model_id`만으로 생각하지 않는다.

Nidus에서 실제 실행 후보는:

```text
(connection_id, model_id)
```

의 조합이다.

예:

```text
(conn_gemini, gemini-model-X)

(conn_omniroute, gemini-model-X)
```

는 서로 다른 실행 경로다.

같은 underlying model이라도 다음이 다를 수 있기 때문이다.

```text
인증
quota
latency
가격
장애 상태
Gateway 정책
실제 upstream
```

현재 Model Catalog의 `(connection_id, model_id)` 구조는 이 원칙과 이미 잘 맞으므로 유지한다.

이번 Slice에서 global model deduplication을 구현하지 않는다.

---

# 9. API Key 중심 UX

이번 작업의 가장 중요한 UX 원칙이다.

사용자는 기본적으로:

```text
연결 방식 선택
↓
API Key 입력
↓
연결 확인
↓
완료
```

이면 된다.

Provider마다 내부 구현은 달라도 연결 경험은 최대한 같아야 한다.

---

# 10. GUI Provider 분류

현재 `설정 → AI 연결`을 크게 재설계하지 않는다.

Manifest의 `connection_kind`를 이용해 최소한 다음처럼 구분한다.

```text
AI 연결

직접 API
────────────────
Google Gemini

통합 Gateway
────────────────
OmniRoute

호환 API
────────────────
OpenAI-compatible API
```

현재 지원하지 않는 OpenAI, Anthropic, Groq 등을 동작하는 버튼처럼 표시하지 않는다.

---

# 11. Gemini UX

기존 동작을 유지한다.

```text
Google Gemini

API Key
[••••••••••••]

[연결 확인]
```

사용자가 다음을 입력하지 않는다.

```text
Endpoint
Model ID
Route
Policy JSON
Structured Output 설정
```

---

# 12. OmniRoute UX

OmniRoute는 별도 Gateway 항목으로 표시한다.

```text
OmniRoute

Endpoint
[ http://127.0.0.1:20128/v1 ]

Endpoint Key
[••••••••••••]

[연결 확인]
```

기본 endpoint는 제공하되 수정할 수 있다.

모델 ID를 입력받지 않는다.

현재 Generic OpenAI-compatible discovery/probe를 재사용한다.

---

# 13. Generic OpenAI-compatible UX

```text
OpenAI-compatible API

이름
[ optional ]

Base URL
[ https://.../v1 ]

API Key
[••••••••••••]

[연결 확인]
```

API Key가 필요 없는 로컬 호환 endpoint는 기존 동작을 유지할 수 있다.

---

# 14. 여러 Connection 동시 등록

다음을 허용해야 한다.

```text
Gemini direct        READY
OmniRoute            READY
OpenAI-compatible    READY
```

동시에 존재할 수 있다.

하나를 등록했다고 다른 Provider를 비활성화하거나 교체하지 않는다.

이번 Slice에서는 이들을 자동으로 선택하는 Route Broker는 만들지 않는다.

---

# 15. OmniRoute의 두 가지 미래 사용 모드

이번 Slice에서 Router를 구현하지 않지만, 이후 설계를 위해 문서에는 다음 두 모드를 명확히 남긴다.

### Transparent Gateway

```text
Nidus
↓
특정 OmniRoute model ID 선택
↓
OmniRoute
↓
upstream
```

이 경우 모델 선택 책임은 Nidus에 있다.

향후 Route Broker의 기본 권장 방식이다.

### Managed Gateway

```text
Nidus
↓
OmniRoute Combo / managed model
↓
OmniRoute 내부 routing
↓
upstream
```

이 경우 OmniRoute 내부가 실제 모델을 선택한다.

Nidus는 returned actual model과 execution evidence를 기록한다.

이번 Slice에서 이 두 모드용 Router를 구현하지 않는다.

---

# 16. Double Routing은 이번에는 해결하지 않는다

이번 작업에서:

```text
Nidus Route Broker
→ OmniRoute Router
```

를 만들지 않는다.

Route Broker 자체가 아직 후속 작업이다.

이번 Slice의 책임은:

```text
Connection identity
Connection kind
Provider adapter
Probe
Catalog
GUI
```

까지만이다.

---

# 17. Legacy Gateway는 건드리지 않는다

현재 `nidus/gateway.py`의 기존 Plan/Task `default_policy()`는 아직 OmniRoute 기반 legacy route를 가지고 있다.

이번 Slice에서 이를 Connection Registry 기반으로 바꾸지 않는다.

그 변경은 향후 `Route Broker` Slice에서 처리한다.

즉:

```text
Connection Foundation
→ 새로운 direct/gateway 구조

Legacy Plan/Task Gateway
→ 기존 policy 유지
```

를 당분간 공존시킨다.

단 문서에는 이것이 legacy 경로라는 점을 명확히 기록한다.

새 Connection GUI가 기존 Task/Plan route를 자동으로 변경한다고 표현하지 마라.

---

# 18. API Key 보안 경계 유지

기존 원칙을 그대로 유지한다.

Secret은 다음에 평문 저장되지 않는다.

```text
SQLite
Vault
Git
Model Catalog
Prompt
Task
Plan
일반 로그
Evidence
GUI response
```

Keychain에는 실제 Secret을 저장하고 Connection에는:

```text
credential_ref
```

만 저장한다.

OmniRoute Endpoint Key도 동일하다.

---

# 19. 무료 API 지원을 위한 기반만 유지

사용자는 앞으로 무료 API Provider를 많이 지원할 계획이다.

하지만 이번 Slice에서 새 무료 Provider를 구현하지 않는다.

또 Manifest에:

```text
free = true
```

같은 영구적인 가격 사실을 임의로 추가하지 않는다.

무료/가격/quota 정보는 공식 출처와 갱신 정책을 설계하는 별도 Slice에서 다룬다.

이번 구조는 이후:

```text
Gemini
Groq
Cloudflare
기타 Free API
```

를 동일한 direct Provider 패턴으로 추가할 수 있어야 한다.

---

# 20. OAuth / Web Session은 이번 범위가 아니다

이번 Slice에서는 다음을 구현하지 않는다.

```text
OAuth
GitHub Copilot OAuth
ChatGPT Web
Claude Web
Web Cookie
Session Connector
browser automation
```

향후 공식 API/OAuth/session 방식이 허용되는 Provider에 한해 별도 Connection type으로 확장한다.

비공식 cookie scraping을 이번 작업에 추가하지 않는다.

---

# 21. 이번 Slice에서 구현하지 않을 것

범위를 넓히지 마라.

```text
OpenAI native adapter
Anthropic adapter
Groq adapter
Cloudflare adapter
NVIDIA native adapter
Ollama adapter

Route Broker
자동 fallback
자동 비용 최적화
무료 quota 추적

Executive Assistant
Dynamic Organization
Work Request GUI
Scheduler
Pixel Office
Budget Engine
```

---

# 22. 테스트

이번 변경에서는 최소 다음을 검증한다.

```text
Provider Manifest

gemini
→ direct
→ GeminiAdapter

omniroute
→ gateway
→ OpenAICompatibleAdapter

openai-compatible
→ compatible
→ OpenAICompatibleAdapter


Migration

legacy gemini
→ direct

legacy omniroute
→ gateway 유지

legacy openai-compatible
→ compatible

migration restart
→ 동일 결과

generic endpoint를
endpoint URL만 보고
OmniRoute로 재분류하지 않음


Multiple Connections

Gemini + OmniRoute + Generic
동시 등록 가능


Probe

Gemini 기존 native probe 유지

OmniRoute
→ /models
→ generation
→ structured probe

Generic
→ 기존 probe 유지


Security

Gemini Key
OmniRoute Key
Generic Key

SQLite/Vault/Git/log/API response에 없음


GUI

직접 API
Gateway
호환 API
그룹 표시

각 form에서 불필요한 필드 없음

기존 Secret 다시 표시하지 않음
```

기존 전체 회귀도 모두 유지한다.

---

# 23. Historical evidence

다음을 삭제하거나 덮어쓰지 않는다.

```text
기존 OmniRoute live evidence
Gemini synthetic evidence
Gemini live NOT RUN evidence
이전 Connection Foundation 검증 문서
```

과거 OmniRoute 검증은 여전히 유효한 역사 기록이다.

현재 제품 구조가 바뀌었다고 과거 evidence를 수정해 현재 성공처럼 꾸미지 않는다.

---

# 24. 문서 갱신

최소 다음을 현재 구조에 맞게 갱신한다.

```text
README.md
DESIGN.md
docs/CONNECTIONS.md
docs/VALIDATION.md
docs/plans/current-plan.md
```

문서의 핵심 설명은 다음이어야 한다.

```text
Nidus의 AI 연결은 하나의 Connection 계층으로 관리한다.

지원되는 연결 방식:

Direct API
- Google Gemini

Gateway
- OmniRoute

Compatible
- OpenAI-compatible API

OmniRoute는 Nidus의 필수 의존성이 아니다.
그러나 여러 Provider/API를 하나로 묶어 사용할 수 있는
공식 Gateway 선택지로 지원한다.

사용자는 Direct와 Gateway를 동시에 사용할 수 있다.
```

---

# 25. Git Flow

이번 작업도 실제 Git Flow를 따른다.

전체 작업명:

```text
API 연결 최적화
```

구현은 두 feature branch로 분리한다.

## Feature 1

```text
feature/connection-kinds
```

범위:

```text
connection_kind
Manifest schema
Connection persistence
기존 데이터 migration
adapter dispatch 검증
tests
```

완료 후:

```bash
# 관련 테스트
git add ...
git commit ...

git checkout develop
git merge --no-ff feature/connection-kinds
# 전체 회귀
```

---

## Feature 2

최신 develop에서:

```text
feature/omniroute-gateway
```

범위:

```text
OmniRoute first-class manifest 복원
gateway identity 유지
OpenAICompatibleAdapter 재사용
GUI Gateway grouping
OmniRoute CRUD/probe tests
docs
```

완료 후:

```bash
# 관련 테스트
git add ...
git commit ...

git checkout develop
git merge --no-ff feature/omniroute-gateway
# 최종 전체 회귀
```

Branch 수를 늘리는 것이 목적은 아니다.

필요 없는 세 번째 feature branch를 만들지 않는다.

논리적으로 분리할 수 있는 commit은 여러 개 남겨도 된다.

예:

```text
feat: classify provider connection kinds

fix: preserve gateway identity during connection migration

feat: restore OmniRoute as first-class gateway connection

test: verify direct gateway and compatible connections coexist

docs: document optimized API connection model
```

하나의 giant final commit으로 몰지 않는다.

---

# 26. main / remote

이번 작업에서는:

```text
main 변경 금지
release/* 금지
hotfix/* 금지
PR 생성 금지
```

사용자가 별도로 요청하지 않는 한 로컬 `develop` 통합까지 수행한다.

단 사용자가 이후 원격 반영을 명시적으로 요청한 경우에만 push한다.

---

# 27. 완료 조건

다음이 모두 충족되어야 한다.

```text
Connection kind가 존재한다.

Gemini = direct.

OmniRoute = gateway.

OpenAI-compatible = compatible.

OmniRoute가 다시 first-class Provider identity를 가진다.

OmniRoute protocol 구현은 기존 OpenAICompatibleAdapter를 재사용한다.

기존 omniroute record를 generic으로 강제 변환하지 않는다.

현재 generic connection을 OmniRoute라고 추측해 변환하지 않는다.

Gemini / OmniRoute / Generic을 동시에 등록할 수 있다.

세 Connection 모두 동일한 Credential/Registry/Catalog 구조를 사용한다.

모델 identity는 connection_id + model_id 경계를 유지한다.

GUI에서 Direct / Gateway / Compatible을 구분한다.

API Key 중심 연결 UX를 유지한다.

사용자에게 model ID를 요구하지 않는다.

기존 Gemini native probe가 회귀하지 않는다.

기존 Generic OpenAI-compatible probe가 회귀하지 않는다.

OmniRoute probe가 동작한다.

Secret boundary가 유지된다.

기존 Plan/Task Runtime을 변경하지 않는다.

기존 legacy Gateway default policy를 이번 Slice에서 Route Broker로 바꾸지 않는다.

Route Broker를 구현하지 않는다.

Historical evidence를 보존한다.

문서와 실제 코드가 일치한다.

전체 기존 회귀가 통과한다.

Git Flow가 실제 commit/merge history에 남는다.

main은 변경되지 않는다.

최종 develop working tree가 clean하다.
```

---

# 28. 최종 보고 형식

완료 후 다음을 보고하라.

```text
Status

Starting develop HEAD

Architecture Before

Architecture After

Connection Kinds
- direct
- gateway
- compatible
- local reserved

Provider Manifests
- Gemini
- OmniRoute
- OpenAI-compatible

Adapter Dispatch

Migration
- previous Gemini
- previous OmniRoute
- previous Generic
- idempotency

Multiple Connection Test

Gemini Regression

OmniRoute Gateway
- discovery
- generation
- structured output

Generic Compatible Regression

GUI

Credential Security

Tests
- targeted
- full Python regression
- Gateway HTTP
- Plan HTTP
- frontend
- compileall
- JS syntax
- diff check

Evidence

Known Limitations

Legacy Gateway Boundary

Docs

Git Flow
- feature/connection-kinds
- commits
- merge
- feature/omniroute-gateway
- commits
- merge
- final develop HEAD
- main HEAD
- working tree

Recommended Next Slice
```

---

## 다음 단계는 아직 구현하지 않는다

이 Slice가 끝난 이후에는 다음 순서가 자연스럽다.

```text
API 연결 최적화
        ↓
무료 Native Provider 1개
        ↓
무료 Native Provider 1개 추가
        ↓
주요 Native Provider 확대
        ↓
Route Broker
        ↓
자동 비용/가용성 기반 선택
        ↓
Assistant / Dynamic Organization
```

이번 작업에서는 **Provider 수를 늘리는 것보다 Connection 모델을 안정적으로 고정하는 것**이 우선이다.

최종 목표는 사용자가 다음 세 방식 중 원하는 조합을 자유롭게 사용할 수 있게 하는 것이다.

```text
Gemini API Key 직접 연결

+

OmniRoute Endpoint Key 연결

+

필요한 OpenAI-compatible endpoint 연결
```

그리고 업무를 수행할 때는 이 연결 방식의 차이를 다시 신경 쓰지 않도록 한다.