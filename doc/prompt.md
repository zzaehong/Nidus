# Nidus Provider Connection Foundation v1 — Codex 구현 지시

## 목표

현재 Nidus `develop`을 기준으로 **동적 조직 기능을 구현하기 전에 Provider/API 연결 기반을 먼저 안정화하라.**

현재 원격 기준:

```text
develop:
11a36f39df42c7e9272c68237a1061bfe00d737a

main:
d9bd9d0069cef5157a283bea2a0af365c99d44b6
```

단, 작업 시작 시 반드시 직접:

```bash
git status
git branch --show-current
git log -1 --oneline
git fetch
```

를 확인하라.

사용자가 최근 작업 상태를 의도적으로 되돌렸으므로, 과거 feature branch나 이전 대화에서 존재했던 동적 조직/Assistant 구현이 현재 `develop`에 있다고 가정하지 마라.

현재 `develop`의 실제 코드를 source of truth로 삼는다.

---

# 1. 이번 Slice의 목적

현재 사용자는 Plan을 만들 때 Provider/Model policy JSON을 직접 입력해야 한다.

현재 GUI도:

```text
사용자 요청
Sources
Planning Policy JSON

고급:
Worker Policy
Review Policy
Final Policy
Task limits
```

구조다.

이번 Slice에서는 GUI 자체를 크게 재설계하지 않는다.

대신 다음 기반을 만든다.

```text
Provider Registry
        ↓
Provider Manifest
        ↓
Credential Store
        ↓
Connection Registry
        ↓
Connection Probe
        ↓
Model Discovery
        ↓
Model Catalog
```

목표는:

> 사용자가 Provider를 한 번 연결하면 Nidus가 그 연결을 스스로 검증하고 사용할 수 있는 모델과 기능을 파악할 수 있게 하는 것.

이다.

향후:

```text
Work Request
↓
Assistant / Manager / Worker
↓
Route Broker
↓
Connection
↓
Provider
```

구조를 만들기 위한 기반이다.

---

# 2. 이번 작업에서 하지 않을 것

이번 Slice에서 다음은 구현하지 않는다.

```text
GUI v2 전체 재설계
Executive Assistant
Dynamic Team
Work Request
비동기 Scheduler
자동 Team 실행
Pixel Office
병렬 Worker
병렬 Team
복잡한 Budget Reservation
자동 모델 품질 최적화
JEV
OAuth Provider 전체 구현
Remote GUI
Multi-user
```

특히 **현재 PlanRuntime이나 Manager/Worker workflow를 Provider 연결 문제 때문에 다시 설계하지 마라.**

---

# 3. 핵심 UX 목표

Provider 연결 경험은 OmniRoute의 단순한 연결 방식을 참고한다.

최종적으로 GUI에서는 다음 정도의 흐름을 만들 수 있어야 한다.

```text
AI Provider 연결
↓
Provider 선택
↓
API Key 또는 Endpoint 입력
↓
[연결 확인]
↓
Nidus 자동 검증
↓
READY
```

향후 GUI 예:

```text
AI 연결

[ OmniRoute ]
[ OpenAI 호환 API ]
[ 기타 로컬/호환 API ]

+ 연결
```

OmniRoute:

```text
OmniRoute 연결

Endpoint
http://127.0.0.1:20128/v1

Endpoint Key
••••••••••••

[ 연결 확인 ]
```

사용자가 다음을 직접 고르게 하지 않는다.

```text
model ID
route
JSON policy
context length
structured output option
fallback order
```

---

# 4. 중요한 제품 원칙

Provider 연결은 Nidus의 핵심 사용자 경험이 아니다.

장기 목표:

```text
95%
업무 요청 / 진행 / 결과

5%
Provider 연결 설정
```

Provider 연결을 마친 이후 일반 사용 중에는:

```text
Provider
Model
Route
Endpoint
Policy JSON
```

을 거의 볼 필요가 없어야 한다.

이번 Slice에서는 그 기반만 구축한다.

---

# 5. 기존 Gateway를 먼저 감사하라

현재 `nidus/gateway.py`에는 이미:

```text
ChatCompletions
Gateway
route fallback
policy validation
error classification
token/cost metadata
transmission snapshot
credential env reference
```

가 존재한다.

현재 구조를 삭제하거나 무조건 교체하지 마라.

먼저 다음을 분석하라.

```text
무엇을 재사용할 수 있는가
무엇이 Task policy와 과도하게 결합되어 있는가
Connection Layer가 어디에 위치해야 하는가
기존 Gateway와 새 Provider layer의 경계는 어디인가
```

기본 방향:

```text
Runtime
↓
Gateway
↓
[향후 Route Broker]
↓
Connection Registry
↓
Provider Adapter
```

이번에는 `Route Broker` 전체를 구현하지 않는다.

---

# 6. Provider Manifest

Provider 연결 UI와 연결 로직을 Provider별 하드코딩으로 만들지 않는다.

Provider의 사용자-facing metadata를 `Provider Manifest`로 정의한다.

개념 예:

```json
{
  "id": "omniroute",
  "name": "OmniRoute",
  "auth_type": "api_key",
  "default_base_url": "http://127.0.0.1:20128/v1",
  "endpoint_editable": true,
  "credential_label": "Endpoint Key",
  "protocol": "openai_chat_completions",
  "supports_model_discovery": true
}
```

Generic OpenAI-compatible:

```json
{
  "id": "openai-compatible",
  "name": "OpenAI-compatible API",
  "auth_type": "api_key",
  "endpoint_editable": true,
  "credential_label": "API Key",
  "protocol": "openai_chat_completions",
  "supports_model_discovery": true
}
```

필요한 최소 필드만 정의하라.

Manifest를 복잡한 Plugin framework로 만들지 않는다.

---

# 7. v1 Provider 범위

이번 Slice에서는 **실제로 끝까지 검증 가능한 Provider 유형만 지원한다.**

필수:

```text
1. OmniRoute
2. Generic OpenAI-compatible endpoint
```

Generic OpenAI-compatible은 예를 들어:

```text
OpenAI
NVIDIA NIM
LM Studio
사내 Gateway
기타 OpenAI-compatible service
```

를 연결할 수 있는 기반이어야 한다.

직접 Gemini native API나 Anthropic native API는 이번 Slice의 필수 완료 조건이 아니다.

향후 Provider Adapter로 추가할 수 있는 구조만 확보한다.

아직 지원하지 않는 Provider를 GUI에서 작동하는 것처럼 표시하지 마라.

---

# 8. Provider Adapter

Provider와 protocol을 분리한다.

예:

```text
Provider Manifest
OmniRoute

Protocol Adapter
OpenAICompatibleAdapter
```

OmniRoute와 여러 OpenAI-compatible Provider가 동일한 adapter를 재사용할 수 있어야 한다.

개념 인터페이스:

```text
discover_models(connection)
probe_model(connection, model)
generate(...)
```

구체적인 이름은 현재 코드 스타일에 맞게 결정하라.

`Gateway.ChatCompletions`의 안정적인 부분은 최대한 재사용한다.

---

# 9. Credential Store

API Key를 다음 위치에 저장하지 않는다.

```text
SQLite
Vault
Git
Policy JSON
Task
Plan
Prompt
일반 로그
Model Catalog
Connection record의 평문 필드
```

DB에는 다음과 같은 reference만 존재한다.

```text
credential_ref
```

예:

```text
cred_...
```

## v1 권장

현재 주 사용환경이 macOS이므로:

```text
CredentialStore interface
        ↓
MacOSKeychainCredentialStore
```

를 구현하는 방식을 우선 검토한다.

macOS Keychain은 OS의 `security` 명령 또는 검증 가능한 안전한 방법을 사용할 수 있다.

단:

- shell injection 방지
- Key 자체 로그 금지
- subprocess argv/diagnostic leakage 검토
- 조회 결과를 필요 이상 메모리에 유지하지 않음
- 삭제/교체 가능

을 지킨다.

기존 환경변수 방식은 **호환 모드**로 유지할 수 있다.

예:

```text
EnvironmentCredentialProvider
```

그러나 새 GUI 연결에서 입력된 Key를 `.env` 파일로 저장하지 않는다.

---

# 10. Credential Store abstraction

OS-specific 구현을 다른 코드에 퍼뜨리지 않는다.

개념:

```text
CredentialStore

put(ref, secret)
get(ref)
replace(ref, secret)
delete(ref)
exists(ref)
```

실제 method 이름은 코드 스타일에 맞게 조정한다.

향후 Linux Secret Service나 Windows Credential Manager 구현을 추가할 수 있어야 한다.

이번 v1에서 지원하지 않는 OS를 지원하는 척하지 않는다.

---

# 11. Connection Registry

Model과 Provider 연결 자체를 분리한다.

Connection 예:

```json
{
  "id": "conn_...",
  "provider": "omniroute",
  "base_url": "http://127.0.0.1:20128/v1",
  "credential_ref": "cred_...",
  "status": "ready",
  "created_at": "...",
  "last_probe_at": "...",
  "last_error": null
}
```

Connection에는 API Key 평문이 없어야 한다.

Connection ID는 Runtime이 생성한다.

불변 ID를 사용한다.

---

# 12. Connection 상태

내부 상태는 최소:

```text
configured
probing
ready
degraded
blocked
```

를 표현할 수 있어야 한다.

세부 실패 원인은 별도 error metadata로 기록한다.

예:

```text
authentication_failed
access_denied
network_failure
timeout
rate_limited
provider_unavailable
invalid_request
model_unavailable
structured_output_unsupported
```

현재 Gateway의 ModelError taxonomy와 최대한 일관되게 사용하라.

중복 taxonomy를 만들지 않는다.

---

# 13. configured와 ready는 반드시 다르다

가장 중요한 규칙 중 하나다.

```text
API Key 저장됨
≠
Nidus에서 사용 가능
```

`configured`는 단순히 설정이 존재하는 상태다.

`ready`는 Nidus가 실제로 검증한 상태다.

---

# 14. Test Connection / Probe Pipeline

사용자가 `[연결 확인]`을 누르면 다음 단계를 수행한다.

```text
1. Endpoint 형식 검증
2. Endpoint 접근
3. 인증 검증
4. 모델 후보 탐색
5. 실제 짧은 Generation
6. Structured Output probe
7. 결과 기록
```

가능한 한 실제 호출로 확인한다.

`GET /models`가 성공했다는 이유만으로 `ready`로 만들지 않는다.

최소 하나의 실제 generation이 성공해야 한다.

---

# 15. Probe는 실제 업무 요청과 분리

Connection probe는 Task나 Plan을 만들지 않는다.

```text
Provider Probe
```

라는 별도의 기술 실행으로 처리한다.

Probe prompt에는 개인 Vault 자료를 넣지 않는다.

고정된 공개 synthetic payload를 사용한다.

예:

```text
Return exactly the word READY.
```

Structured output probe:

```json
{
  "status": "READY"
}
```

같은 최소 synthetic payload를 사용한다.

---

# 16. Model Discovery

OpenAI-compatible Adapter에서는 가능하면:

```text
GET /models
```

을 사용한다.

그러나 모델 목록 조회가 실패했다고 연결 전체를 즉시 실패시키지는 않는다.

Provider가 discovery를 지원하지 않거나 결과가 불완전할 수 있기 때문이다.

상태를 정확히 기록하라.

```text
discovery_supported
discovery_success
discovery_failed
```

등의 의미를 명확히 구분한다.

---

# 17. Model Catalog

탐색된 모델은 내부 Catalog에 기록한다.

최소:

```text
connection_id
model_id
discovered_at

availability

capabilities:
  chat
  structured_output

last_probe_at
last_success_at
last_failure_at

latency
```

가격/context/free quota 같은 값은 **확실한 근거가 있는 경우에만 저장**한다.

모르면:

```text
unknown
```

으로 남긴다.

0이나 free로 추정하지 않는다.

첨부 설계의 모델 catalog는 기능·가격·가용성·context·구조화 출력 등을 라우팅 근거로 저장하고, 사용자에게 모델 ID 선택을 강요하지 않는 방향이다. 이를 유지하라. :chatgpt-content-reference{index="2"}

---

# 18. Structured Output capability

현재 Manager / Plan workflow는 JSON 출력에 크게 의존한다.

따라서 v1에서 가장 중요한 capability 중 하나는:

```text
structured_output
```

이다.

단:

```text
provider documentation says supported
```

와:

```text
Nidus probe passed
```

를 구분한다.

Catalog에는 실제 검증 결과를 우선 사용한다.

---

# 19. Model Availability

Model availability를 단순 boolean으로만 표현하지 않는 것을 선호한다.

예:

```text
unknown
available
temporarily_unavailable
rate_limited
authentication_failed
unsupported
```

단 Connection 상태와 Model 상태의 책임을 뒤섞지 않는다.

---

# 20. 자동 모델 선택은 이번 Slice에서 제한

이번 Slice에서 완전한 Route Broker는 만들지 않는다.

그러나 Provider Foundation 검증을 위해 다음 API 정도는 제공할 수 있다.

```text
list_ready_connections()

list_available_models(connection)

select_probe_candidate()
```

실제 Manager/Worker 역할별:

```text
quality
budget
role
capability
```

라우팅은 다음 Slice로 둔다.

현재 Task policy 시스템을 임의로 제거하지 않는다.

---

# 21. 기존 Policy 호환성

현재 Plan/Task Runtime은 `model_policy` JSON을 사용한다.

이번 Slice에서 이것을 즉시 제거하지 않는다.

기존 테스트와 Runtime은 계속 작동해야 한다.

새 Connection Layer와 기존 policy는 당분간 공존할 수 있다.

예:

```text
Legacy Runtime
→ existing policy routes

New Connection Foundation
→ Connection Registry / Catalog
```

향후 Route Broker에서 통합한다.

이번 Slice에서 무리하게 전체 migration을 하지 않는다.

---

# 22. OmniRoute 특별 지원

OmniRoute는 v1에서 first-class manifest로 지원한다.

기본 endpoint 후보:

```text
http://127.0.0.1:20128/v1
```

다만 실제 연결 여부를 추측하지 않는다.

향후 자동 감지를 고려할 수 있지만,
이번 구현에서는 단순한 로컬 probe 정도만 허용한다.

OmniRoute가 실행 중이라면 연결 화면에서 기본 endpoint를 제공할 수 있어야 한다.

---

# 23. GUI 범위

이번 Slice에서는 **전체 GUI를 다시 만들지 않는다.**

현재 GUI에 최소한의:

```text
설정
→ AI 연결
```

화면만 추가해도 된다.

목적은 Connection Foundation을 실제 사람이 사용할 수 있는지 검증하는 것이다.

예:

```text
AI 연결

OmniRoute                       ● 정상
http://127.0.0.1:20128
사용 가능 모델 3

[연결 테스트] [관리]

+ AI Provider 연결
```

---

# 24. Add Provider UI

```text
AI Provider 연결

[ OmniRoute ]
[ OpenAI-compatible ]
```

OmniRoute 선택:

```text
Endpoint
[ http://127.0.0.1:20128/v1 ]

Endpoint Key
[ ••••••••• ]

[ 연결 확인 ]
```

OpenAI-compatible:

```text
이름
[ Provider name ]

Base URL
[ https://.../v1 ]

API Key
[ ••••••••• ]

[ 연결 확인 ]
```

모델 이름을 입력받지 않는 것을 기본으로 한다.

Discovery가 불가능한 Provider를 지원해야 할 필요가 실제로 확인되기 전까지 manual model ID 기능을 추가하지 마라.

---

# 25. 연결 성공 화면

사용자에게 내부 probe JSON을 그대로 보여주지 않는다.

예:

```text
AI 연결이 준비되었습니다.

Endpoint          정상
인증              정상
모델 탐색         8개
실제 응답         성공
구조화 응답       지원 확인

[완료]
```

기술 세부 정보는 펼쳐서 확인할 수 있다.

---

# 26. 연결 관리

기존 Connection에 대해:

```text
연결 테스트
Credential 교체
Endpoint 수정
Connection 삭제
상세 정보
```

를 지원한다.

Credential 원문을 다시 화면에 표시하지 않는다.

예:

```text
API Key
등록됨

[교체]
```

정도로.

---

# 27. Connection 삭제

Connection 삭제 시:

```text
Connection metadata 삭제/비활성화
Credential Store secret 삭제
Model Catalog association 처리
```

를 명확하게 한다.

과거 Task audit에서 사용했던 route/model 기록은 삭제하지 않는다.

즉:

```text
Connection 삭제
≠
과거 실행 기록 삭제
```

이다.

---

# 28. Security

현재 Nidus의 중요한 보안 원칙을 유지한다.

특히:

```text
Secret은 Prompt에 들어가지 않음
Secret은 Vault에 들어가지 않음
Secret은 Git에 들어가지 않음
Secret은 SQLite에 평문으로 들어가지 않음
Secret은 일반 로그에 들어가지 않음
```

을 자동 테스트하라.

---

# 29. Endpoint validation

기존 Gateway의 endpoint validation을 재사용하거나 동일 수준을 유지한다.

특히:

```text
HTTP remote endpoint 금지
localhost HTTP는 허용
HTTPS remote 허용
username/password embedded URL 거부
query/fragment 포함 endpoint 검토
redirect 제한
```

을 약화시키지 않는다.

---

# 30. Provider Error body

현재 Gateway는 Provider error body를 읽거나 저장하지 않는 보수적인 정책을 사용한다.

새 Probe Layer도 민감한 Provider response/error가 로그로 유출되지 않도록 한다.

디버깅 편의를 이유로 API 응답 body 전체를 저장하지 마라.

---

# 31. 테스트

최소 다음을 검증한다.

### A. Manifest

```text
유효 manifest
중복 provider id
잘못된 auth type
잘못된 protocol
```

---

### B. Credential Store

```text
put
get
replace
delete
missing secret
```

그리고:

```text
SQLite에 secret 없음
Vault에 secret 없음
Git diff에 secret 없음
log에 secret 없음
```

검증.

---

### C. Connection

```text
create
update
delete
unique ID
invalid endpoint
```

---

### D. Successful OmniRoute-compatible probe

Fake HTTP server를 사용하여:

```text
/models
/chat/completions
JSON response
```

을 제공한다.

```text
configured
→ probing
→ ready
```

검증.

---

### E. Authentication failure

```text
401
→ blocked/authentication_failed
```

Blind fallback 금지.

---

### F. Rate limit

```text
429
```

Connection을 영구적으로 broken 처리하지 않는다.

---

### G. Provider unavailable

```text
503
```

temporary failure로 기록.

---

### H. Model discovery failure + generation success

Provider가 `/models`를 지원하지 않아도
명확한 규칙 하에서 Connection 상태를 판단한다.

성공을 꾸며내지 않는다.

---

### I. Generation failure

`/models`가 성공했어도 실제 generation 실패 시 `ready` 금지.

---

### J. Structured output

실제 structured-output probe 성공/실패를 catalog에 반영.

---

### K. Restart

프로세스 재시작 후:

```text
Connection metadata
Model Catalog
credential_ref
health metadata
```

복구.

Secret 원문은 DB에서 복구하지 않는다.

---

### L. Existing regression

현재:

```text
Gateway
Single Task
Manager workflow
PlanRuntime
GUI
Security
Git
Archive
```

회귀를 전부 유지한다.

---

# 32. 실제 Provider 검증

Fake test만으로 끝내지 않는다.

현재 로컬 환경에서 사용 가능한 경우에 한해
**OmniRoute 실제 연결을 별도 synthetic probe로 검증**한다.

개인 Vault 데이터는 전송하지 않는다.

고정 공개 synthetic prompt만 사용한다.

Evidence에는:

```text
connection type
endpoint host
requested model candidate
actual model
probe result
structured output result
latency
token metadata
error category
timestamp
```

등을 저장할 수 있다.

Secret은 절대 저장하지 않는다.

실제 OmniRoute가 실행되지 않거나 Key가 준비되지 않았다면:

```text
NOT RUN
```

으로 명시한다.

Fake test를 실제 Provider 검증으로 표현하지 마라.

---

# 33. 첨부 GUI 설계 문서와의 관계

`gui-model-agnostic-v2.md`의 다음 원칙은 유지한다.

```text
사용자는 결과 요청에 집중한다.
연결은 최초 한 번 설정한다.
업무마다 모델을 고르지 않는다.
모델 정보는 필요할 때만 투명하게 보여준다.
민감 자료는 기존 승인 경계를 유지한다.
```

:chatgpt-content-reference{index="3"}

하지만 구현 순서를 변경한다.

기존 계획:

```text
GUI request UX
→ async
→ collaboration
→ model automation
```

이 아니라,

이번 결정은:

```text
Provider Connection Foundation
↓
Model Discovery / Probe
↓
Connection Health
↓
후속 Route Broker
↓
그 다음 GUI v2
```

이다.

따라서 이번 Slice에서는 문서의 장기 GUI 목표를 모두 구현하려 하지 마라.

---

# 34. 문서 갱신

최소:

```text
README.md
DESIGN.md
docs/VALIDATION.md
docs/plans/current-plan.md
```

를 현재 구현에 맞게 갱신한다.

필요하면:

```text
docs/CONNECTIONS.md
```

같은 전용 문서를 만들 수 있다.

문서에는:

```text
현재 지원 Provider 유형
연결 방법
Credential 저장 방식
Connection 상태 의미
Probe 정의
Model Catalog 정의
현재 미지원 기능
실제 검증 범위
```

를 명확하게 적는다.

GUI v2를 이미 완성한 것처럼 문서화하지 않는다.

---

# 35. Git Flow

현재 최신 `develop`에서 시작한다.

`main`에 직접 작업하지 않는다.

권장 브랜치:

```text
feature/provider-registry
feature/credential-store
feature/connection-probe
feature/provider-settings-ui
feature/connection-evidence
```

코드 결합도가 높으면 일부를 합쳐도 된다.

Branch 수 자체가 목표는 아니다.

실제 흐름:

```text
develop
↓
feature branch
↓
구현
↓
관련 테스트
↓
논리 단위 commit
↓
develop merge
↓
develop regression
↓
최신 develop에서 다음 feature
```

가능한 commit 예:

```text
feat: add provider manifests and connection registry
feat: add credential store abstraction
feat: probe provider connections and discover models
feat: persist model capability catalog
feat: add minimal provider connection settings
test: verify provider connection failure boundaries
docs: document provider connection foundation
```

마지막에 하나의 giant commit으로 만들지 않는다. commit은 한글로 작성한다.

---

# 36. main / remote

이번 작업에서는:

```text
main 수정 금지
release/* 금지
hotfix/* 금지
remote push 금지
PR 생성 금지
```

사용자가 별도로 요청하지 않는 한 로컬 `develop` 통합까지만 수행한다.

---

# 37. 완료 조건

다음을 모두 만족해야 한다.

1. Provider Manifest가 존재한다.
2. OmniRoute를 first-class connection type으로 지원한다.
3. Generic OpenAI-compatible Provider를 연결할 수 있다.
4. Credential이 Connection metadata와 분리된다.
5. macOS에서 안전한 Credential Store를 사용할 수 있다.
6. 기존 env credential 방식은 필요 시 호환된다.
7. Connection Registry가 존재한다.
8. Connection ID는 Runtime이 만든다.
9. `configured`와 `ready`를 구분한다.
10. 실제 generation 성공 전에는 ready가 되지 않는다.
11. Model discovery를 수행한다.
12. Model Catalog를 영속화한다.
13. structured output을 실제 probe한다.
14. Provider 오류가 현재 taxonomy와 일관되게 분류된다.
15. Secret이 SQLite/Vault/Git/Prompt/일반 로그에 나타나지 않는다.
16. 현재 Gateway/Runtime regression을 깨뜨리지 않는다.
17. 최소 Provider 연결 UI가 존재한다.
18. 사용자가 model ID나 Policy JSON을 연결 과정에서 고르지 않는다.
19. Credential 교체/삭제가 가능하다.
20. Connection 재검사가 가능하다.
21. 프로세스 재시작 후 Connection/Catalog가 복구된다.
22. Fake Provider integration test가 통과한다.
23. 가능한 경우 실제 OmniRoute synthetic probe evidence를 남긴다.
24. GUI v2나 Dynamic Organization으로 범위를 확장하지 않는다.
25. 문서가 실제 구현과 일치한다.
26. Git Flow가 실제 개발 과정에 반영된다.
27. main은 변경하지 않는다.
28. 최종 develop working tree가 clean하다.

---

# 38. 최종 보고 형식

작업 완료 후 다음을 보고하라.

```text
Status

Starting develop HEAD

Current architecture audit
- existing Gateway
- reused code
- changed boundaries

Provider Manifest

Supported providers

Credential Store
- backend
- security
- compatibility

Connection Registry

Probe Pipeline

Model Discovery

Model Catalog

Structured Output Verification

Connection States

Error Handling

Minimal GUI
- add provider
- test connection
- manage connection

Security

Tests
- unit
- fake HTTP integration
- existing regression
- real OmniRoute probe

Evidence

Known limitations

Docs

Git Flow
- feature branches
- commits
- merge commits
- final develop HEAD
- main unchanged
- working tree clean

Recommended next step
```

---

## 핵심 철학

이번 작업의 최종 목적은 이것이다.

```text
사용자

"AI 연결"

↓ 한 번

Provider 등록
↓
Credential 저장
↓
Connection probe
↓
Model discovery
↓
Capability verification
↓
READY

────────────────────────────

이후 업무

사용자 요청
↓
Nidus
↓
[향후 Route Broker]
↓
검증된 Connection
↓
Model
```

**Provider 연결의 복잡성을 한 번만 해결하고, 업무 수행 중에는 그 복잡성을 사용자에게 다시 돌려주지 마라.**

그리고 이번 Slice에서는 **연결이 신뢰할 수 있는지**를 먼저 해결한다.

라우팅, 자연어 Work Request, Executive Assistant, Dynamic Organization, GUI v2는 이 기반이 검증된 뒤 다음 단계에서 구현한다.