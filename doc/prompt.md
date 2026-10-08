# 작업 지시 / Work instructions

[한국어](#한국어) · [English](#english)

## 한국어

# Mission

현재 Nidus Model Gateway에서 연결되어 있지만 실제 생성 성공이 검증되지 않은
**Gemini와 NVIDIA NIM을 실제 사용 가능한 Provider 경로로 활성화하라.**

이번 작업은 새로운 Gateway 기능을 만드는 작업이 아니다.

현재 실패 원인을 좁히고,
각 Provider에서 실제 호출 가능한 Model을 확인하고,
Nidus의 기존 End-to-End Flow에서 실제 `Completed → Archive`까지 검증하는 것이 목표다.

---

# Current State

현재 다음은 이미 검증되었다.

- Model Gateway
- OmniRoute
- GitHub Copilot 실제 Generative 실행
- Model Response → Verification → Completed → Archive
- Provider Fallback
- Retryable / Non-retryable Error 정책
- Secret 경계
- Human Transmission Approval
- Regression Test

현재 미완료 상태:

```text
Gemini       → BLOCKED
NVIDIA NIM   → BLOCKED
```

기존 Evidence와 실패 기록을 보존하라.

실패를 성공으로 다시 해석하지 마라.

---

# Primary Goal

최소한 다음 두 Flow를 실제 Live Evidence로 검증한다.

```text
Nidus
→ Model Gateway
→ OmniRoute
→ Gemini
→ Generated Response
→ Verification
→ Completed
→ Archive
```

그리고:

```text
Nidus
→ Model Gateway
→ OmniRoute
→ NVIDIA NIM
→ Generated Response
→ Verification
→ Completed
→ Archive
```

---

# Step 1 — Diagnose Before Changing Code

먼저 현재 400 / 404 실패의 원인을 조사하라.

다음을 구분하려고 시도한다.

- 잘못되거나 오래된 Model ID
- Provider Account가 해당 Model에 접근할 수 없음
- OmniRoute Model Mapping 문제
- OpenAI-compatible Request 형식 차이
- Provider Endpoint 차이
- 무료 Tier / Quota 제한
- Provider 자체 Availability 문제

HTTP Status만 보고 원인을 추측해서 확정하지 마라.

Credential이나 민감한 Error Body를 Evidence에 저장하지 마라.

하지만 Secret을 노출하지 않는 범위에서
진단에 필요한 안전한 Metadata와 Provider 응답 정보를 사용할 수 있다.

---

# Step 2 — Discover Actually Callable Models

정적 Catalog의 `available` 표시만 신뢰하지 마라.

현재 Provider 계정에서 실제 호출 가능한 Model을 찾아야 한다.

가능하면 다음 순서로 확인한다.

```text
Official Provider API / Docs
→ OmniRoute Provider model discovery
→ minimal live request
→ Nidus live request
```

Gemini와 NVIDIA NIM 각각에 대해
실제 생성 요청에 성공한 Model ID를 확보한다.

특정 과거 Model ID를 고집하지 마라.

현재 공식적으로 제공되는 안정적인 Text Generation Model을 우선한다.

무료 사용 또는 기존 연결 범위 안에서 테스트한다.

새 결제나 구독은 생성하지 마라.

---

# Gemini

현재 사용자가 연결한 Gemini Provider를 사용한다.

현재 실제로 접근 가능한 최신 Model을 확인한다.

과거 실패한 Model ID를 반복해서 무제한 테스트하지 마라.

가능하면 최신 Stable / GA 계열의 경량 모델부터 검토한다.

Model Discovery 결과와 실제 API 호출 결과가 다르면
실제 호출 결과를 Source of Truth로 사용한다.

---

# NVIDIA NIM

현재 사용자가 연결한 NVIDIA NIM Provider를 사용한다.

NVIDIA의 실제 Hosted NIM Chat Completion API에서 호출 가능한 Model을 확인한다.

과거 실패한 Alias를 반복해서 사용하지 말고
현재 Catalog의 정확한 Model ID를 확인한다.

가장 단순한 Text / Chat Generation Model부터 검증한다.

---

# Minimal Provider Probe

Nidus 전체 Flow를 반복하기 전에
필요하다면 아주 작은 Provider Probe를 사용해서 실제 생성 가능 여부를 확인해도 된다.

예:

```text
"Reply with exactly: NIDUS_OK"
```

이 Probe의 목적은:

```text
credential
+
model ID
+
endpoint
+
request compatibility
```

만 확인하는 것이다.

Probe 성공 후에만 Nidus Live Acceptance Flow를 실행한다.

불필요한 Token을 사용하지 마라.

---

# Nidus Live Acceptance

Provider Probe가 성공하면
기존 Synthetic Nidus Work Request를 사용해 실제 Flow를 실행한다.

최종 성공 조건:

```text
Waiting
→ Human-approved transmission
→ Model call
→ Generated response
→ Verification
→ Completed
→ Archive
```

다음도 확인한다.

```text
Active = 0
Archive = 1
Verification = PASS
```

---

# Evidence

Provider별 Machine-readable Evidence를 남긴다.

예:

```text
docs/evidence/model-live-gemini-success.json
docs/evidence/model-live-nvidia-success.json
```

기존 실패 Evidence는 삭제하거나 덮어쓰지 않는다.

각 Evidence에는 가능한 범위에서:

- provider
- requested model
- actual model
- route
- task
- timestamps
- latency
- token usage
- cost observation
- verification
- active/archive count
- error if any

를 기록한다.

Credential 값은 절대 기록하지 않는다.

---

# Free Pool

Gemini와 NVIDIA NIM이 모두 실제 검증되면
둘을 Nidus의 Free/Low-cost Provider Pool에 사용할 수 있도록 정책을 구성한다.

우선순위는 실제 검증 결과를 보고 합리적으로 결정한다.

예:

```text
Gemini
→ NVIDIA NIM
→ Copilot
```

하지만 이번 실제 Latency, 성공률, 무료 사용 조건 등을 기준으로
더 적절한 순서가 있다면 변경할 수 있다.

Routing 순서는 설정으로 관리하고
코드에 고정하지 않는다.

---

# Natural Fallback Validation

가능하다면 Fault Injection만이 아니라
실제 Provider의 정상적인 Retryable Failure에서도 Fallback이 동작하는지 확인한다.

단:

- Quota를 일부러 소진하지 마라.
- Credential을 망가뜨리지 마라.
- 계정 설정을 위험하게 변경하지 마라.
- 유료 요청을 무의미하게 발생시키지 마라.

자연스러운 Retryable Failure를 안전하게 만들 수 없다면
기존 Fault Injection Evidence로 충분하다고 기록한다.

실제 장애를 인위적으로 만들어 성공했다고 주장하지 마라.

---

# Do Not Overbuild

이번 Slice에서 하지 않아도 되는 것:

- 새로운 Model Router 재설계
- Semantic Verification 시스템
- JEV
- Local Model 설치
- Tool Calling
- Streaming
- Responses API Migration
- GUI
- 새로운 Manager 구조

현재 목표는 오직:

> Gemini와 NVIDIA NIM의 실제 Generative Execution 성공

이다.

---

# Git

현재 Integration Branch를 확인한다.

`main` / `develop`에서 직접 작업하지 않는다.

이번 작업용 Feature Branch를 생성한다.

예:

```text
feat/free-provider-activation
```

의미 있는 작은 변경마다 Commit한다.

예:

```text
fix: use callable Gemini model
fix: align NVIDIA NIM model routing
test: record Gemini live acceptance
test: record NVIDIA live acceptance
docs: activate validated free provider pool
```

기존 History를 Rewrite하지 마라.

Remote Push / PR / main / develop Merge를 수행하지 마라.

---

# Regression

기존 모든 Test를 다시 실행한다.

현재 Gateway / Offline 기능이 깨지면 완료하지 않는다.

---

# Completion Criteria

다음이 모두 충족될 때 완료로 선언한다.

1. Gemini 실제 Model Response 성공
2. Gemini Nidus Task Completed → Archive
3. NVIDIA NIM 실제 Model Response 성공
4. NVIDIA NIM Nidus Task Completed → Archive
5. 두 Provider Model ID가 실제 호출 증거로 확인됨
6. Credential 노출 없음
7. 기존 Regression 전부 PASS
8. Free/Low-cost Routing Policy 갱신
9. 성공/실패 Evidence 모두 보존
10. Validation Report가 실제 상태와 일치

하나가 실패한다면
성공으로 선언하지 말고 정확한 Blocker를 남긴다.

---

# Final Report

MODEL_PROVIDER_VALIDATION_REPORT.md를 갱신하거나
후속 Provider Activation Report를 작성한다.

최종적으로 다음과 같이 확인할 수 있어야 한다.

```text
GitHub Copilot   VERIFIED
Gemini           VERIFIED / BLOCKED
NVIDIA NIM       VERIFIED / BLOCKED
Fallback         VERIFIED
Free Pool        ACTIVE / PARTIAL
```

각 Provider에 대해 실제 Model ID와 Live Evidence를 연결한다.

---

# Core Rule

이번 작업의 목표는 Provider를 더 많이 연결하는 것이 아니다.

> **이미 연결한 Gemini와 NVIDIA NIM이 실제 Nidus 작업을 수행하도록 만들어라.**

Catalog, Connection Test, Model Discovery만으로 성공을 선언하지 마라.

실제 생성 응답이 Nidus의:

```text
Verification
→ Completed
→ Archive
```

까지 도달한 경우에만 VERIFIED로 기록하라.

계획만 세우고 멈추지 말고,
진단 → 실제 모델 발견 → Provider Probe → Nidus Live Test → Evidence → Regression → Commit → Report까지 가능한 범위에서 자율적으로 진행하라.

## English

### Mission

Activate the already connected Gemini and NVIDIA NIM routes in the current Nidus Model Gateway as actually usable providers. This is not a new Gateway feature project. Narrow the failures, identify callable models, and verify Completed → Archive through the existing end-to-end flow.

### Current state

Already verified: Model Gateway, OmniRoute, real GitHub Copilot generation, model response → verification → completion → archive, provider fallback, retryable/nonretryable policies, secret boundary, human transmission approval and regression tests.
Gemini and NVIDIA NIM remain BLOCKED at the time of this instruction. Preserve all evidence/failure records and never reinterpret failure as success.

### Primary goal

Verify both real flows with live evidence:

```text
Nidus → Model Gateway → OmniRoute → Gemini → Generated Response
      → Verification → Completed → Archive
Nidus → Model Gateway → OmniRoute → NVIDIA NIM → Generated Response
      → Verification → Completed → Archive
```

### Step 1 — Diagnose before changing code

Investigate 400/404 failures first. Attempt to distinguish incorrect/stale model IDs, account access, OmniRoute mapping, OpenAI-compatible request differences, provider endpoints, free-tier/quota restrictions and provider availability.
Do not assert a cause from HTTP status alone. Never store credentials or sensitive error bodies in evidence, but use safe metadata/provider response information when it does not expose secrets.

### Step 2 — Discover actually callable models

Do not trust static catalog `available` alone. Find models callable by the current accounts, preferably through official API/docs → OmniRoute account discovery → minimal live request → Nidus live request.
For each provider, obtain a model ID that succeeds in actual generation. Prefer currently offered stable text-generation models over insisting on historical IDs. Stay within free use or existing connections; do not create billing/subscriptions.

### Gemini

Use the user's connected Gemini provider. Identify currently accessible models, preferring recent stable/GA lightweight candidates. Do not repeat failed historical IDs without bounds. Actual inference is the source of truth when discovery and calls disagree.

### NVIDIA NIM

Use the user's connected NVIDIA provider. Identify an exact current model ID callable through Hosted NIM Chat Completions. Do not keep using old failed aliases; start with the simplest text/chat model.

### Minimal provider probe

Before repeating the whole Nidus flow, use a tiny probe if useful:

```text
Reply with exactly: NIDUS_OK
```

This checks credential + model ID + endpoint + request compatibility only. Run Nidus acceptance only after probe success and avoid unnecessary token consumption.

### Nidus live acceptance

After a successful probe, reuse the existing synthetic Nidus work request. Required flow:

```text
Waiting → Human-approved transmission → Model call → Generated response
        → Verification → Completed → Archive
```

Confirm Active = 0, Archive = 1 and Verification = PASS.

### Evidence

Write provider-specific machine-readable evidence, such as `docs/evidence/model-live-gemini-success.json` and `docs/evidence/model-live-nvidia-success.json`.
Never delete/overwrite earlier failures. Include provider, requested/actual model, route, task, timestamps, latency, tokens, cost observations, verification, active/archive counts and any error when available. Never record credential values.

### Free pool

Only after both providers are actually verified, configure them for the Free/Low-cost Provider Pool. Choose a reasonable configurable order based on observed latency, success and free-use conditions; Gemini → NVIDIA → Copilot is an example, not a hardcoded requirement.

### Natural fallback validation

If possible, confirm fallback on an actual normal retryable failure rather than injection alone. Never deliberately exhaust quota, damage credentials, change account settings dangerously or generate pointless paid requests.
If no safe natural retryable failure is available, record that existing fault-injection evidence is sufficient. Do not manufacture an actual outage and claim it as natural validation.

### Do not overbuild

This slice need not redesign routing, add semantic verification/JEV/local models/tool calling/streaming/Responses migration/GUI or new managers. The only goal is actual Gemini and NVIDIA generative execution.

### Git

Check the current integration branch; never work directly on main/develop. Create a feature branch, for example `feat/free-provider-activation`.
Commit meaningful small changes separately, such as callable Gemini model, NVIDIA routing alignment, each provider's live evidence and validated pool documentation.
Preserve history. No remote push/PR/main/develop merge.

### Regression

Run all existing tests again. Do not complete if existing Gateway/offline behavior is broken.

### Completion criteria

All are required before declaring completion:

1. Real Gemini model response succeeds.
2. Gemini Nidus task completes and archives.
3. Real NVIDIA NIM response succeeds.
4. NVIDIA Nidus task completes and archives.
5. Both model IDs are proven through actual calls.
6. No credential exposure.
7. All existing regression tests pass.
8. Free/low-cost routing policy is updated.
9. Success/failure evidence is preserved.
10. The validation report matches actual status.

If any fails, record the exact blocker instead of claiming success.

### Final report

Update the consolidated validation report or write a follow-up activation report. Show GitHub Copilot VERIFIED, Gemini VERIFIED/BLOCKED, NVIDIA NIM VERIFIED/BLOCKED, Fallback VERIFIED and Free Pool ACTIVE/PARTIAL, linking actual model IDs to live evidence.

### Core rule

The goal is not more provider connections: make the already connected Gemini and NVIDIA providers perform real Nidus work.
Catalog/connection/discovery alone cannot establish success. Mark VERIFIED only after a real generated response passes Verification → Completed → Archive.
Do not stop at a plan. Continue diagnosis → model discovery → probe → Nidus live → evidence → regression → commit → report as far as possible autonomously.
