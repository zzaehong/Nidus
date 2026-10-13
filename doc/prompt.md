# Nidus Native Provider Connection — Slice 1

## 목표

현재 Nidus `develop`을 기준으로 **OmniRoute를 핵심 연결 경로에서 제거하고, Nidus가 Provider API를 직접 연결할 수 있는 최소 구조를 만든다.**

이번 Slice의 성공 기준은 단 하나다.

```text
사용자
↓
설정 → AI 연결
↓
Google Gemini
↓
API Key 입력
↓
Nidus가 Gemini API를 직접 호출
↓
모델 탐색
↓
일반 응답 Probe
↓
구조화 응답 Probe
↓
READY
```

OmniRoute를 거치지 않는다.

현재 `develop`의 실제 코드와 HEAD를 작업 시작 시 직접 확인하고 그것을 source of truth로 사용한다.

---

## 1. 현재 구현을 버리지 않는다

현재 존재하는 다음 기반은 최대한 재사용한다.

```text
CredentialStore
MacOSKeychainCredentialStore

ConnectionRegistry

Model Catalog

configured
probing
ready
degraded
blocked

Provider connection GUI

Connection Probe

기존 ModelError taxonomy
```

이번 작업은 Connection Foundation을 다시 만드는 작업이 아니다.

목적은 현재 구조를:

```text
OpenAI-compatible 중심
```

에서:

```text
Provider-neutral
```

로 최소한 확장하는 것이다.

---

# 2. OmniRoute의 위치 변경

OmniRoute를 Nidus의 first-class 핵심 Provider에서 내린다.

즉:

```text
현재

OmniRoute
→ first-class Provider
```

를 장기적으로:

```text
Generic OpenAI-compatible
→ 필요하면 OmniRoute도 연결 가능
```

로 변경한다.

이번 Slice에서 OmniRoute 지원 코드를 반드시 삭제할 필요는 없다.

단:

> Nidus 설계가 OmniRoute를 필요로 한다고 가정하지 마라.

README와 설계 문서에서도 OmniRoute를 기본 또는 권장 연결처럼 표현하지 않는다.

---

# 3. 최소 Provider Adapter interface

현재 `OpenAICompatibleAdapter`를 일반화할 수 있는 가장 작은 interface를 만든다.

예:

```python
class ProviderAdapter:
    def discover_models(...)
    def probe_model(...)
    def generate(...)
```

구체적 method 이름과 signature는 현재 코드 스타일을 따라라.

중요한 것은:

```text
ConnectionRegistry
```

가 OpenAI-compatible API 형식을 직접 알지 않게 만드는 것이다.

---

# 4. Provider Manifest 확장

현재 Manifest를 유지하되 Provider별 Adapter를 선택할 수 있어야 한다.

개념 예:

```json
{
  "id": "gemini",
  "name": "Google Gemini",
  "auth_type": "api_key",
  "adapter": "gemini",
  "credential_label": "Gemini API Key"
}
```

그리고 기존 Generic:

```json
{
  "id": "openai-compatible",
  "name": "OpenAI-compatible API",
  "auth_type": "api_key",
  "adapter": "openai-compatible"
}
```

Manifest를 거대한 Plugin framework로 만들지 마라.

이번 Slice에서 필요한 필드만 추가한다.

---

# 5. 첫 Native Provider는 Gemini 하나만 구현

이번 Slice에서는 다음 Provider만 새로 직접 지원한다.

```text
Google Gemini
```

이유는 다양한 Provider를 한꺼번에 구현하기 전에:

```text
native API
+
native authentication
+
native model discovery
+
native generation
+
structured output
```

이 Nidus Connection Foundation 위에서 실제로 작동하는지 증명하기 위함이다.

---

# 6. GeminiAdapter

새 Adapter를 구현한다.

개념:

```text
GeminiAdapter

discover_models()
generate()
structured output probe
```

공식 Gemini API의 현재 규격을 확인해서 구현하라.

오래된 모델 이름이나 과거 API 형태를 추측해서 하드코딩하지 마라.

특히 이전 Nidus 작업에서 특정 Gemini 모델이 신규 사용자에게 404가 난 사례가 있었으므로:

```text
모델 이름을 코드 기본값으로 신뢰하지 않는다.
```

Model discovery 결과를 사용한다.

---

# 7. 모델 자동 탐색

사용자에게 Gemini model ID를 입력받지 않는다.

흐름:

```text
Gemini API Key
↓
모델 목록 조회
↓
generation 가능한 후보 필터
↓
bounded probe
↓
실제 사용할 수 있는 후보 발견
```

Provider가 반환한 모델 metadata에서 generation 지원 여부를 알 수 있다면 활용한다.

모르면 추측하지 않는다.

---

# 8. 후보 탐색 규칙

현재 OmniRoute 구현처럼:

```text
alphabetical first 3
```

만 검사하는 방식을 Gemini Adapter에 복제하지 마라.

대신 Provider metadata를 기반으로 명백히 generation 용도가 아닌 모델을 제거한 뒤 bounded 탐색을 수행한다.

반드시 상한을 둔다.

예:

```text
max_probe_candidates = 5
```

정확한 수치는 테스트와 API 특성에 맞게 결정하되 무제한 탐색은 금지한다.

---

# 9. Structured Output

현재 Manager/Planning 계층은 구조화 응답을 중요하게 사용한다.

따라서 Gemini connection을 `ready`로 판단하려면 최소한:

```text
normal text generation
+
structured JSON response
```

를 모두 실제로 검증한다.

단:

```text
structured output 실패
```

한 모델 때문에 탐색 전체를 끝내지 않는다.

예:

```text
Model A
chat ✓
structured ✕

↓ 다음 후보

Model B
chat ✓
structured ✓

→ Connection READY
```

여야 한다.

---

# 10. ConnectionRegistry는 Provider-neutral하게 만든다

현재 Registry 안에:

```text
OpenAICompatibleAdapter()
```

가 사실상 고정되어 있다면 이를 제거한다.

개념:

```text
Connection
↓
provider manifest
↓
adapter lookup
↓
ProviderAdapter
```

형태로 만든다.

예:

```text
provider = gemini
→ GeminiAdapter

provider = openai-compatible
→ OpenAICompatibleAdapter
```

---

# 11. Credential 구조는 그대로 유지

Gemini API Key도 기존 Keychain infrastructure를 사용한다.

```text
Gemini API Key
↓
MacOSKeychainCredentialStore
↓
cred_...
```

SQLite에는 Key 원문을 저장하지 않는다.

기존 Secret 보안 경계를 약화시키지 않는다.

---

# 12. GUI 변경은 최소

GUI를 다시 디자인하지 않는다.

현재:

```text
설정
→ AI 연결
```

에서 Provider 목록에:

```text
Google Gemini
OpenAI-compatible API
```

가 보이면 충분하다.

Gemini 연결 화면:

```text
Google Gemini

API Key
[••••••••••••]

[연결 확인]
```

이 정도만 구현한다.

다음을 사용자에게 묻지 않는다.

```text
Model
Route
Policy JSON
Context length
Structured output setting
```

---

# 13. 무료 여부 처리

Gemini를 코드에서:

```text
free = true
```

로 영구 고정하지 않는다.

가격/무료 quota 정보가 공식적으로 안정적으로 확인되는 구조가 아직 없다면:

```text
pricing = unknown
```

으로 유지한다.

향후 무료 API Catalog를 별도로 만들 예정이다.

이번 Slice의 목표는:

```text
직접 API 연결
```

이지:

```text
가격 Router
```

가 아니다.

---

# 14. Generic OpenAI-compatible 유지

현재 Generic OpenAI-compatible 연결은 회귀시키지 않는다.

즉:

```text
Gemini Native
+
Generic OpenAI-compatible
```

가 공존한다.

이 구조 덕분에 필요하면 사용자가:

```text
LM Studio
NVIDIA NIM
OmniRoute
기타 proxy
```

를 여전히 Generic 연결로 사용할 수 있다.

하지만 Nidus 자체는 OmniRoute에 의존하지 않는다.

---

# 15. 이번 Slice에서 구현하지 않을 것

절대 범위를 넓히지 마라.

```text
OpenAI native adapter
Anthropic adapter
Groq adapter
Cloudflare adapter
NVIDIA native adapter

Route Broker

무료 Provider 자동 선택

Executive Assistant

Dynamic Organization

Work Request GUI

Scheduler

OAuth

GitHub Copilot 연결

ChatGPT Web Cookie

Claude Web Cookie

Session Connector

Pixel Office

Budget Engine
```

이것들은 후속 Slice다.

---

# 16. Web Cookie / Session 방식

이번 Slice에서는 구현하지 않는다.

다만 설계 문서에 다음 원칙만 남긴다.

향후 연결 종류는:

```text
API Key
OAuth
Local
Session Connector
```

등으로 확장될 수 있다.

하지만 Session Connector는:

```text
공식적으로 자동화가 허용된 경우
공식 OAuth/session API가 있는 경우
문서화된 연결 방식이 있는 경우
```

에만 지원한다.

비공식 웹 cookie scraping을 이번 Slice에 넣지 않는다.

---

# 17. 테스트 — 최소 필수

새 기능에 대해 다음 테스트를 추가한다.

### A. Adapter dispatch

```text
gemini
→ GeminiAdapter

openai-compatible
→ OpenAICompatibleAdapter
```

잘못된 Provider/Adapter는 거부.

### B. Gemini discovery fixture

가짜 Gemini HTTP endpoint 또는 deterministic adapter를 이용해:

```text
모델 목록
→ generation 가능한 모델 탐색
```

검증.

### C. Normal generation

```text
READY
```

성공.

### D. Structured output

```json
{"status":"READY"}
```

성공.

### E. 첫 모델 structured 실패

```text
Model A
chat ✓
structured ✕

Model B
chat ✓
structured ✓
```

결과:

```text
READY
Model B available
```

검증.

### F. 인증 실패

```text
401/403 또는 Gemini 대응 인증 오류
→ blocked
```

### G. rate limit / temporary error

```text
429
5xx
timeout
```

→ degraded.

### H. Secret boundary

Gemini Key가:

```text
SQLite
Vault
Git diff
Catalog
GUI response
일반 log
```

에 존재하지 않음.

### I. 기존 회귀

기존:

```text
OpenAI-compatible Connection
Gateway
PlanRuntime
Manager workflow
GUI
Security
Archive
```

전체 회귀 유지.

---

# 18. 실제 Gemini 검증

사용 가능한 Gemini API credential이 현재 로컬 환경에 준비돼 있을 경우에만 실제 synthetic probe를 실행한다.

개인 Vault 데이터는 전송하지 않는다.

고정 synthetic payload만 사용한다.

Evidence 예:

```text
provider
connection status

discovered models count

selected probe model

normal generation result

structured output result

actual model

latency

token metadata if available

timestamp
```

API Key는 절대 evidence에 포함하지 않는다.

Credential이 없으면:

```text
NOT RUN
```

으로 기록한다.

테스트 fixture 성공을 실제 Gemini 성공이라고 표현하지 마라.

---

# 19. 기존 OmniRoute 코드 처리

이번 Slice에서 삭제가 필요하지 않으면 무리하게 삭제하지 마라.

하지만:

```text
OmniRoute first-class manifest
```

가 더 이상 제품 방향과 맞지 않는다면 제거하고,

필요 시:

```text
OpenAI-compatible API
```

를 통해 연결할 수 있다고 문서화한다.

기존 OmniRoute historical evidence는 삭제하지 않는다.

과거 검증 기록은 역사다.

---

# 20. 문서

최소 다음을 갱신한다.

```text
README.md
DESIGN.md
docs/CONNECTIONS.md
docs/VALIDATION.md
docs/plans/current-plan.md
```

문서에서는 다음을 명확히 한다.

```text
Nidus는 Provider를 직접 지원하는 방향으로 전환한다.

OmniRoute는 더 이상 핵심 의존성이 아니다.

현재 Native Provider:
Google Gemini

현재 Compatibility Provider:
OpenAI-compatible

향후:
여러 무료 API
OpenAI
Anthropic
Groq
Cloudflare
Local
OAuth
공식 Session Connector
```

미구현 Provider를 지원된다고 표현하지 마라.

---

# 21. Git Flow — 반드시 지킬 것

현재 Nidus는 다음 원칙을 사용한다.

```text
main
→ 안정 버전

develop
→ 다음 버전 통합

feature/*
→ 기능 개발

release/*
→ 릴리스 준비

hotfix/*
→ main 긴급 수정
```

이번 작업에서도 반드시 실제 Git Flow를 적용한다.

---

## 시작

먼저:

```bash
git status
git branch --show-current
git fetch
git checkout develop
git pull --ff-only
git log -1 --oneline
```

현재 `develop`이 clean인지 확인한다.

미커밋 변경이 있으면 임의 삭제/reset하지 말고 먼저 보고한다.

---

# 22. 최소 Branch 단위

이번 Slice도 더 작은 두 단계로 나눈다.

## Feature 1

```text
feature/provider-adapter-interface
```

범위:

```text
ProviderAdapter abstraction
Adapter dispatch
ConnectionRegistry provider-neutral화
기존 OpenAI-compatible migration
회귀 테스트
```

이 브랜치에서는 Gemini를 아직 구현하지 않아도 된다.

완료 후:

```text
test
commit
checkout develop
merge --no-ff feature/provider-adapter-interface
전체 관련 회귀
```

---

## Feature 2

최신 develop에서:

```text
feature/gemini-native-provider
```

범위:

```text
Gemini manifest
GeminiAdapter
model discovery
normal probe
structured probe
minimal GUI entry
tests
docs
synthetic/live evidence
```

완료 후:

```text
test
commit
checkout develop
merge --no-ff feature/gemini-native-provider
전체 회귀
```

---

# 23. 필요하면 evidence 문서는 같은 Gemini branch에 포함

이번 기능 규모에서는 별도의 evidence branch를 반드시 만들 필요는 없다.

브랜치 숫자를 늘리는 것이 목적이 아니다.

단 구현과 검증 과정에서 여러 논리적 commit을 남긴다.

예:

```text
refactor: decouple provider adapters from connection registry

feat: add native Gemini provider connection

test: verify Gemini discovery and capability probes

docs: document direct provider connection strategy
```

마지막에 한 번에 giant commit하지 않는다.

---

# 24. main과 remote

이번 작업에서:

```text
main 변경 금지

release/* 금지

hotfix/* 금지

remote push 금지

PR 생성 금지
```

사용자가 따로 요청하지 않는 한 로컬 `develop` 통합까지만 진행한다.

---

# 25. 최종 완료 조건

다음을 모두 만족해야 한다.

1. ConnectionRegistry가 특정 OpenAI-compatible adapter에 고정되지 않는다.
2. Provider → Adapter dispatch 구조가 존재한다.
3. 기존 OpenAI-compatible 연결이 계속 작동한다.
4. Gemini native API를 직접 연결할 수 있다.
5. Gemini API Key만 입력하면 된다.
6. 사용자에게 model ID를 요구하지 않는다.
7. Gemini 모델을 자동 탐색한다.
8. 실제 normal generation을 검증한다.
9. 실제 structured output을 검증한다.
10. 한 후보의 structured output 실패 때문에 전체 탐색을 조기 종료하지 않는다.
11. 최소 하나의 완전한 후보가 있으면 Connection이 READY가 된다.
12. Credential은 Keychain에 저장된다.
13. Secret boundary가 유지된다.
14. Model Catalog에 native Gemini 결과가 저장된다.
15. GUI에서 Gemini 연결이 가능하다.
16. 기존 Plan/Task policy에는 영향을 주지 않는다.
17. OmniRoute가 Nidus의 필수 의존성이 아니다.
18. 과거 OmniRoute evidence는 보존한다.
19. 기존 전체 회귀가 통과한다.
20. Gemini 실제 credential이 있으면 synthetic live probe를 수행한다.
21. 없으면 NOT RUN이라고 정확히 기록한다.
22. 문서가 구현 상태와 일치한다.
23. Git Flow가 실제 commit/merge history에 반영된다.
24. `main`은 변경되지 않는다.
25. 최종 `develop` working tree가 clean하다.

---

# 26. 최종 보고

완료 후 다음 형식으로 보고하라.

```text
Status

Starting develop HEAD

Architecture change
- before
- after

Provider Adapter Interface

OpenAI-compatible regression

Gemini Native Provider
- authentication
- discovery
- normal generation
- structured output

Connection Registry changes

Model Catalog

GUI

Credential security

Tests

Synthetic integration evidence

Real Gemini evidence
- PASS / NOT RUN
- reason

Known limitations

Docs

Git Flow
- feature/provider-adapter-interface
- commits
- develop merge
- feature/gemini-native-provider
- commits
- develop merge
- final develop HEAD
- main HEAD unchanged
- working tree clean

Recommended next slice
```

---

## 이 Slice 이후 순서

이번 작업이 성공한 뒤에만 다음 Provider를 하나씩 붙인다.

```text
Slice 2
무료 API Provider 1개

Slice 3
무료 API Provider 1개

Slice 4
OpenAI / Anthropic 등 주요 유료 Provider

Slice 5
OAuth Provider

Slice 6
Route Broker

Slice 7
Assistant / Dynamic Organization GUI
```

무료 Provider 후보를 추가할 때도:

```text
Provider 조사
↓
공식 API 확인
↓
약관/자동화 허용 확인
↓
Adapter 하나 구현
↓
Probe
↓
실제 검증
↓
develop 통합
```

순서를 반복한다.

**Provider 수를 빠르게 늘리는 것보다 “API Key 하나만 넣으면 Nidus가 알아서 사용할 수 있다”는 연결 경험을 Provider마다 확실하게 만드는 것을 우선하라.**