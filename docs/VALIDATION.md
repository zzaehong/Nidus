# 검증 보고서와 이력 / Validation and history

[한국어](#한국어) · [English](#english)

## 한국어

### 최신 핵심 업무 순환 검증 — 2026-10-08

**완료**: 공개 합성 원문으로 계약 → Worker 결과/자기 점검 → 결정적 검증 → Manager 독립 검토 APPROVE → Completed → Archive를 실제 통과했다. [성공 증거](evidence/manager-worker-live-copilot-json-mode.json). 원 요청·계약·기준·두 역할의 응답/정책/시도·검토·결정·검증·전체 이력을 JSON에 보존한다. 실제 두 역할은 같은 Copilot `gpt-4o-mini`를 사용했으며 역할 지침은 분리되어 있다. 이 성공 표본의 재작업은 0회다.

- Worker: 입력 488 / 출력 140 / 합계 628 tokens.
- Manager: 입력 1059 / 출력 190 / 합계 1249 tokens. 두 호출 합계 1877; 실제 비용은 null이다.
- 결정적 검사 6개 모두 true, Manager APPROVE, Active 0 / Archive 1. 시작/종료는 14:07:50–14:07:54 UTC.
- 오프라인 테스트 53개, 로컬 HTTP/CLI 통합 5개, compileall, diff 검사를 통과했다. A 정상 완료, B 잘못된 결과 REWORK, C 수정 후 승인, D ESCALATE, E 반복 한도, F 승인 후 결과 변경 차단을 결정적인 Adapter로 검증했다. HTTP 테스트는 모델을 호출하지 않는 loopback fixture다. 실제 REWORK/ESCALATE 판단의 일반적 정확성을 입증한 것은 아니다.
- 별도 검토 전송 승인, 역할 정책 변경 시 재승인, 승인 후 재시작 시 무호출, 검토 중 원문 변경 차단, 역할 간 알려진 키 문자열 차단, 사람이 수정한 초안 보호, 품질 판단 CLI를 검증했다.

실패도 성공으로 바꾸지 않고 보존한다:

| 증거 | 실제 관측 |
|---|---|
| [Pool 첫 실행](evidence/manager-worker-live.json) | Gemini `gemini/gemini-3.5-flash-lite` HTTP 400; nonretryable이므로 후속 경로 없이 Blocked/Archive 0 |
| [Copilot 첫 실행](evidence/manager-worker-live-copilot.json) | Worker 정상, Manager가 잘못된 JSON을 반환; 형식 검사로 차단. Manager 내용에도 실제 원문과 다른 판단이 있었으며 승인으로 해석하지 않음 |
| [지침 보강 후](evidence/manager-worker-live-copilot-v2.json) | Worker JSON에 여분의 닫는 괄호; 차단 |
| [JSON mode 실행](evidence/manager-worker-live-copilot-json-mode.json) | 명시적 JSON mode를 기존 Gateway에 추가한 뒤 두 역할 정상 응답, APPROVE/완료/보관 |

현재 키의 모델 목록(200)에서 기존 설정 모델 중 Copilot만 확인됐다. [발견 기록](evidence/manager-worker-provider-discovery.json). Gemini 400의 전체 원인을 단정하지 않으며 NVIDIA는 이번에 직접 호출하지 않았다. 과거 Gemini/NVIDIA 성공 증거는 그대로 유효한 역사적 관측이지만 현재 가용성의 증명은 아니다. 기존 Pool 파일을 덮어쓰지 않고 [Copilot 검증 정책](policies/workflow-live-copilot.json)을 별도로 추가했다. 비밀 값은 저장하지 않으며 기존 키/연결/결제 설정을 변경하지 않았다. 아래 내용은 이전 Provider 활성화 Slice의 기록이다.


### 이전 Provider 활성화 상태 — 2026-10-08

오프라인 Runtime, Model Gateway, Copilot/Gemini/NVIDIA의 실제 문서 생성 → Verification → Completed → Archive를 검증했다.
명시적인 주입 장애 Fallback과 인증 오류 시 중단도 검증했다. 완료를 막는 현재 Blocker는 없다.
장기 개념 설계 전체나 임의 Agent 자율 업무가 완성됐다는 뜻은 아니다. 무료 quota·실제 청구도 확인하지 못했다.

| Provider | 실제 응답 모델 | Task | 지연 / 입력·출력·합계 tokens | 증거 |
|---|---|---|---|---|
| Copilot | gpt-4o-mini | 879034f98e4b4c11a933e9a8e17e30f6 | 약 1.335초 / 202·33·235 | [Copilot](evidence/model-live-copilot.json) |
| Gemini | gemini-3.5-flash-lite | 81d9cf35e7ae4a17ab8f6ae05725da5a | 1.009859초 / 208·32·240 | [Gemini](evidence/model-live-gemini-success.json) |
| NVIDIA NIM | nvidia/nemotron-3.5-lightning-30b-a3b | bf007d0ae1a24d1caaaa044b4a2f48df | 11.160926초 / 231·415·646 | [NVIDIA](evidence/model-live-nvidia-success.json) |

모두 Active 0 / Archive 1이며 원문 불변·출력/후보 일치·비어 있지 않음·정상 종료·필수 문구의 6개 검증이 true다.
공개용 합성 원문 세 사실을 세 bullet로 요약하도록 요청했으며 사람이 사실 일치를 검토했다.
지연은 Gateway 시작/종료 차이로 Router/네트워크를 포함한 단일 표본이다. 토큰은 해당 Task의 Provider 보고값이며 Probe/실패를 포함한 세션 총량이 아니다. 비용은 모두 null이다.

### 실제 요청 ID와 활성 정책

| 경로 | 요청 모델 ID | 환경변수 |
|---|---|---|
| Gemini | gemini/gemini-3.5-flash-lite | NIDUS_POOL_API_KEY |
| NVIDIA | nvidia/nvidia/nemotron-3.5-lightning-30b-a3b | NIDUS_POOL_API_KEY |
| Copilot | gh/gpt-4o-mini | NIDUS_POOL_API_KEY |

NVIDIA 첫 prefix는 OmniRoute Provider, 나머지는 공식 모델 ID다. Pool은 [정책](../model-policy.pool.example.json)의 Gemini → NVIDIA → Copilot 순서다.
Gemini의 이번 Task가 더 빠르고 적은 토큰을 보고해 우선했지만 통계적 비용 최적화는 아니다. 순서는 코드가 아닌 정책에서 바꾼다.
무료 여부를 보장하지 않아 모든 경로를 kind=paid / allow_paid=true로 명시한다. 새로운 결제·구독·추가 과금 설정은 하지 않았다.
기본 `nidus-free`는 별도 구성해야 하는 Combo 이름이며 활성 Pool이 아니다. 사용법은 [README](../README.md)에 있다.

### Fallback 검증 범위

| 시나리오 | 실제 관측 순서 | 결과/증거 |
|---|---|---|
| 한 경로 주입 | Gemini 이름의 로컬 fixture 503 → 실제 NVIDIA Route HTTP 429 → 실제 Copilot 성공 | Completed/Archive; [sequence](evidence/model-live-fallback.json) |
| 두 경로 주입 | 로컬 Gemini 503 → 로컬 NVIDIA 503 → 실제 Copilot 성공 | Completed/Archive; [two failures](evidence/model-live-fallback-two.json) |
| 인증 실패 | 로컬 Gemini 401 → 후속 호출 없음 | Blocked/Archive 0; [auth stop](evidence/model-live-fallback-auth.json) |

주입 경로는 실제 Gemini/NVIDIA에 전송되지 않고 Credential도 받지 않는다. NVIDIA Route의 429는 OmniRoute Endpoint 관측이며 계정 quota를 실제 소진했다는 증거가 아니다.
두 성공 Fallback Task는 각각 202/30/232 tokens다. 첫 harness는 NVIDIA 즉시 성공만 예상해 exit 1이었으나 실제 Task는 올바르게 Copilot으로 완료했다.
허용된 NVIDIA retryable 실패 후 세 번째 Route까지 평가하도록 고쳤으며 raw events/응답은 그대로 보존했다. 수정 사유는 JSON에 있다.
새 활성 모델들의 자연 장애 전환을 검증하기 위해 quota를 소진하거나 계정을 변경하지 않았다. 기존 주입 증거로 확인한 범위만 주장한다.

### 실패 기록과 원인 진단

| 기록 | 관측과 해석 |
|---|---|
| [OpenCode Zen](evidence/model-live.json) | big-pickle 접근 거부, Blocked/Result null/Archive 0. 최초 코드는 401/403을 함께 분류해 정확한 HTTP status는 알 수 없음; 후속 코드에서 구분. 클라이언트 신원 위장은 하지 않음 |
| [Copilot 첫 후보](evidence/model-live-copilot-gpt5mini-failed.json) | gpt-5-mini HTTP 400, Router 모델 미지원. 정적 카탈로그와 실제 가용성이 다름; gpt-4o-mini 실제 성공으로 해결 |
| [Gemini 첫 검증](evidence/model-live-gemini.json) | 2.5 Flash-Lite/Flash는 별도 candidate1/2 실패 JSON에서 404, 3.5 Flash는 400. 후속 Probe와 Router 로그에서 3.5 Flash의 활성 카탈로그 거부 확인; Flash-Lite로 해결 |
| [NVIDIA 첫 검증](evidence/model-live-nvidia.json) | Mistral 7B, Gemma 3 4B, Nemotron Nano 과거 후보는 404. 전체 원인을 은퇴/계정/Mapping 중 하나로 단정하지 않음; 최신 Lightning으로 해결 |
| [초기 활성화 Probe](evidence/provider-activation-probes-initial.json) | Gemini Flash-Lite NIDUS_OK/stop, NVIDIA Lightning HTTP 200이지만 128 output tokens에서 length. 잘린 응답은 정상 성공으로 세지 않음 |
| [Gemma Timeout](evidence/provider-activation-probe-gemma-timeout.json) | NVIDIA Gemma 4 31B 60초 Timeout, 채택하지 않음 |
| [정상 Probe](evidence/provider-activation-probes.json) | NVIDIA Lightning 512-token 예산에서 NIDUS_OK/stop, 이후 기존 Nidus 1024 예산으로 성공 |

API discovery와 valid=true 연결 테스트만으로 VERIFIED를 선언하지 않았다. 공식 문서 → 계정 discovery → 최소 Probe → Nidus Live 순서로 확인했다.
기존 실패 JSON은 덮어쓰지 않았으며 candidate1/2를 포함한 모든 원시 기록은 [evidence 디렉터리](evidence)에 남아 있다.
400/404 오류 정책이나 Security를 느슨하게 바꾸지 않았고 Gateway 코드 변경 없이 활성화했다.

### 완료 기준과 회귀

| 기준 | 현재 판단 |
|---|---|
| AC-01–08 | PASS: 계약/브리핑/복구/권한/승인/검증/Archive·Git |
| MG-AC-01 | PASS: Provider 독립 Adapter, 정책 기반 Free/Paid/Local |
| MG-AC-02 | 실제 생성·완료 PASS; 원래 무료 사용 조건의 quota/청구는 미검증 |
| MG-AC-03–06 | PASS (검사 범위): 전송 승인/Secret 분리/완료 Guard/오류·관측 |
| PV-AC-01–04 | PASS (명시된 주입 범위): 단독 실제 결과/순서 Fallback/인증 중단/이전 증거 보존 |

- `python3 -m unittest discover -s tests -q`: 37 PASS.
- `python3 tests/integration/model_http.py -v`: 3 PASS. 외부 모델 없이 별도 CLI/루프백 HTTP·인증·redirect·재시작 검증.
- `PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts`, `git diff --check`: PASS.
- 기존 오프라인 MVP 시점에는 18 tests와 `scripts/demo.py`가 통과했고 이후 37개로 확대됐다.
- 초기 HTTP 테스트의 Blocked exit 0 예상은 기존 exit 2 동작에 맞게 후속 수정했다. 실패 기대값이 먼저 커밋된 이력은 재작성하지 않았다.

당시 문서 통합은 새 Live 호출을 하지 않았다. 문서의 예시는 사용자 실행 시에만 모델을 호출한다.

### 설치·Credential·보안

기록된 Host는 macOS/Python 3.9.6/Git 2.54.0, fnm Node 24.21.0/npm 11.19.0/OmniRoute 3.8.51이다.
공식 npm 패키지를 사용자 Node 환경에 설치했다. npm 11 설치 스크립트 허용은 해당 설치에만 적용했고 전역 설정을 바꾸지 않았다.
Loopback 127.0.0.1:20128 LISTEN, Dashboard 200, 인증 없는 모델 API 401을 확인했다. 자동 시작·외부 공개·Provider 결제·계정 보안 변경은 하지 않았다.
설치 때의 관측이며 현재 daemon 생존 여부를 보장하는 상시 health 지표가 아니다.

Provider OAuth/API Credential은 OmniRoute가 저장소 밖에서 관리한다. 기존 Provider 비밀은 진단 중 읽거나 출력하지 않았다.
Probe/Live는 모델·connection 제한, noLog=true, 1시간 만료 임시 Endpoint Key를 메모리 환경으로 전달한 뒤 삭제했다. 최종 임시 키 0개다.
재사용 Pool 키는 세 모델·세 connection만 허용하고 noLog=true이며 `~/.config/nidus/provider-pool.env` (600, 디렉터리 700)에 있다.
기존 Copilot 키는 별도 `~/.config/nidus/model-gateway.env` (600)에 있으며 제한을 유지했다.
Pool 키 /v1/models 인증 200, Repo/성공 Vault의 새 키 문자열 유출 0건을 확인했다. [경계 증거](evidence/provider-activation-credential-boundary.json).
일반 DLP 검증은 아니며 unknown Secret이나 개인 민감정보를 자동 분류하지 않는다.

### 개발 이력과 통합 출처

| 단계 | 주요 Commit / 브랜치 |
|---|---|
| 오프라인 설계/실행/보안/Archive | fe742a8, 57852c3, aafa4d3, 68360fe, 76245f1, ec79653, 5e28e31; feat/nidus-mvp |
| Gateway/생성형 Runtime/HTTP | 762c12e, af13bab, 97527c2, 57d6824/6d4024f; feat/generative-execution |
| 상태/Retry 보강·OmniRoute 설치 | fd79649, 5516660, 2161b95 |
| Copilot Live | 6c1f1f5, b3e8d28, fb7475c; feat/model-live-acceptance |
| 다중 Provider/Fallback | b541069, a1410f5, 67d9143, 20348e5; feat/model-provider-validation |
| Gemini/NVIDIA 활성화 | 9c1db4b, f447a97, d8ab677; feat/free-provider-activation |

Integration은 feat/model-gateway다. Remote push/PR/main/develop merge/history rewrite는 수행하지 않았다.
이 보고서는 MVP_REPORT(+ko), MODEL_GATEWAY_REPORT, MODEL_PROVIDER_VALIDATION_REPORT, PROVIDER_ACTIVATION_REPORT,
OMNIROUTE_INSTALL_REPORT, BLOCKED(+ko)를 통합한다. 과거 문서 원문은 `git show d8ab677:파일명`으로 조회할 수 있다.

### 남은 제한과 다음 단계

텍스트 Chat Completions만 지원하며 streaming/Responses/tool 실행·자연어 계약·GUI·다중 Worker는 없다.
문자/구조·바이트 검증은 일반적인 의미적 정확성을 증명하지 않는다. 모델 저장 전 crash는 중복 호출할 수 있고 socket timeout은 전체 실행 deadline이 아니다.
Provider 가용성·계정 quota·비용은 바뀔 수 있다. Vault/Git/파일 전체가 하나의 원자적 트랜잭션은 아니고 적대적 OS 프로세스를 격리하지 않는다.
사용자는 실제 전송할 원문을 검토하고 명시적으로 승인해야 한다. 다음은 공개 가능한 실제 업무의 사용량/지연을 축적하고 별도로 제품 확장 범위를 정하는 것이다.

## English

### Latest core responsibility validation — 2026-10-08

**Complete**: real public-synthetic contract → Worker result/self-check → deterministic checks → independent Manager APPROVE → Completed → Archive. [Successful evidence](evidence/manager-worker-live-copilot-json-mode.json) retains original request, contract/criteria, both role responses/policies/attempts, decisions, checks and full history. Both roles used Copilot gpt-4o-mini with separate instructions. This live success required zero revisions.

Worker usage: 488 input / 140 output / 628 total. Manager: 1059 / 190 / 1249. Combined 1877 tokens; cost unknown/null. All six checks true, Manager APPROVE, Active 0 / Archive 1; 14:07:50–14:07:54 UTC.

53 offline tests and 5 local HTTP/CLI tests, compileall and diff checks passed. Deterministic adapters cover A normal completion, B erroneous result/rework, C successful revision, D escalation, E bounded iterations and F post-approval tampering. Loopback HTTP fixtures make no external model calls. Tests also cover separate transmission decisions, role-policy invalidation, approved-review restart without calls, sources changed during review, cross-role known credential strings, human-edited drafts and quality-decision CLI. This is not evidence of generally correct live rework/escalation judgment.

Preserved failures: [pool](evidence/manager-worker-live.json), Gemini HTTP 400 stops without fallback; [first Copilot](evidence/manager-worker-live-copilot.json), Worker succeeded but malformed Manager JSON was blocked (its reasoning also misread the actual source); [prompt revision](evidence/manager-worker-live-copilot-v2.json), malformed Worker JSON blocked. [Explicit JSON mode](evidence/manager-worker-live-copilot-json-mode.json) then completed successfully. No speculative JSON repair or relabeling of failures.

The current key's model catalog returned 200 with only Copilot among the configured models; [discovery](evidence/manager-worker-provider-discovery.json). Do not infer a complete Gemini failure cause from 400. NVIDIA was not called in this slice. Earlier Gemini/NVIDIA successes remain historical observations, not current availability guarantees. Added a separate [Copilot policy](policies/workflow-live-copilot.json); preserved existing pool/evidence. No credential values, account/connection/payment changes. The sections below document the earlier activation slice.


### Current status — 2026-10-08

Verified offline Runtime, Model Gateway and real Copilot/Gemini/NVIDIA document generation → Verification → Completed → Archive.
Explicit injected-fault fallback and stopping on authentication errors are verified. No current blocker prevents the completed scope.
This does not complete the long-term concept or arbitrary autonomous agent work. Free quota and actual billing remain unverified.

| Provider | Actual response model | Task | Latency / input·output·total tokens | Evidence |
|---|---|---|---|---|
| Copilot | gpt-4o-mini | 879034f98e4b4c11a933e9a8e17e30f6 | about 1.335 s / 202·33·235 | [Copilot](evidence/model-live-copilot.json) |
| Gemini | gemini-3.5-flash-lite | 81d9cf35e7ae4a17ab8f6ae05725da5a | 1.009859 s / 208·32·240 | [Gemini](evidence/model-live-gemini-success.json) |
| NVIDIA NIM | nvidia/nemotron-3.5-lightning-30b-a3b | bf007d0ae1a24d1caaaa044b4a2f48df | 11.160926 s / 231·415·646 | [NVIDIA](evidence/model-live-nvidia-success.json) |

All have Active 0 / Archive 1 and six true checks: unchanged sources, matching output/candidate, nonempty response, normal finish and required phrase.
Each request summarized three public synthetic facts into three bullets, with human factual review.
Latency is a single Gateway start/end observation including router/network. Tokens are provider-reported for that task, not session totals including probes/failures. All costs remain null.

### Request IDs and active policy

| Route | Requested model ID | Environment variable |
|---|---|---|
| Gemini | gemini/gemini-3.5-flash-lite | NIDUS_POOL_API_KEY |
| NVIDIA | nvidia/nvidia/nemotron-3.5-lightning-30b-a3b | NIDUS_POOL_API_KEY |
| Copilot | gh/gpt-4o-mini | NIDUS_POOL_API_KEY |

NVIDIA's first prefix is the OmniRoute provider; the remainder is the official model ID. The [pool policy](../model-policy.pool.example.json) orders Gemini → NVIDIA → Copilot.
Gemini was faster and reported fewer tokens in this task, so it goes first; this is not statistical cost optimization. Change order in policy, not code.
All routes explicitly use kind=paid / allow_paid=true because free usage is not guaranteed. No new billing/subscription/additional-payment settings were introduced.
Default `nidus-free` requires separate combo setup and is not this active pool. See [README](../README.md) for usage.

### Fallback validation scope

| Scenario | Observed sequence | Result/evidence |
|---|---|---|
| One injected route | Local fixture named Gemini 503 → real NVIDIA route HTTP 429 → real Copilot success | Completed/archive; [sequence](evidence/model-live-fallback.json) |
| Two injected routes | Local Gemini 503 → local NVIDIA 503 → real Copilot success | Completed/archive; [two failures](evidence/model-live-fallback-two.json) |
| Authentication failure | Local Gemini 401 → no downstream calls | Blocked/archive 0; [auth stop](evidence/model-live-fallback-auth.json) |

Injected routes neither contact real Gemini/NVIDIA nor receive credentials. The NVIDIA-route 429 was observed at OmniRoute, not proof of deliberately exhausted upstream quota.
Both successful fallback tasks report 202/30/232 tokens each. The first harness initially expected immediate NVIDIA success and exited 1, while the task correctly completed through Copilot.
The evaluation was corrected to accept the permitted third route after retryable NVIDIA failure; raw events/responses remain unchanged and the JSON records the correction.
No quota exhaustion or account mutation manufactured natural outages in the new active models. Claims remain limited to existing injected-fault evidence.

### Historical failures and diagnosis

| Record | Observation and interpretation |
|---|---|
| [OpenCode Zen](evidence/model-live.json) | big-pickle access refusal, Blocked/result null/archive 0. Original code combined 401/403 so exact status is unknown; later code separates them. No client impersonation |
| [First Copilot candidate](evidence/model-live-copilot-gpt5mini-failed.json) | gpt-5-mini HTTP 400, router model unsupported. Static catalog differed from actual availability; real gpt-4o-mini success resolved it |
| [Initial Gemini validation](evidence/model-live-gemini.json) | 2.5 Flash-Lite/Flash returned 404 in separate candidate1/2 JSON; 3.5 Flash returned 400. Later probe/router logs identified the active-catalog gate for 3.5 Flash; Flash-Lite resolved it |
| [Initial NVIDIA validation](evidence/model-live-nvidia.json) | Older Mistral 7B, Gemma 3 4B and Nemotron Nano candidates returned 404. Do not attribute every failure to retirement/account/mapping; latest Lightning resolved it |
| [Initial activation probes](evidence/provider-activation-probes-initial.json) | Gemini Flash-Lite NIDUS_OK/stop; NVIDIA Lightning HTTP 200 but length at 128 output tokens. Truncation was not counted as normal success |
| [Gemma timeout](evidence/provider-activation-probe-gemma-timeout.json) | NVIDIA Gemma 4 31B timed out at 60 seconds and was not activated |
| [Normal probe](evidence/provider-activation-probes.json) | NVIDIA Lightning returned NIDUS_OK/stop with a 512-token allowance; subsequent Nidus succeeded using existing 1024 allowance |

API discovery and valid=true connection tests never established VERIFIED alone. Followed official docs → account discovery → minimal probe → Nidus live acceptance.
Old failure JSON was never overwritten; all raw records, including candidate1/2, remain in [evidence](evidence).
Activation required no Gateway code changes or weakening 400/404/error/Security policy.

### Acceptance and regression

| Criteria | Current assessment |
|---|---|
| AC-01–08 | PASS: contract/briefing/recovery/permission/approval/verification/archive/Git |
| MG-AC-01 | PASS: provider-independent adapter, configured Free/Paid/Local |
| MG-AC-02 | Real generation/completion PASS; original free-use quota/billing condition unverified |
| MG-AC-03–06 | PASS within checks: transmission approval/secret separation/completion guards/errors/observability |
| PV-AC-01–04 | PASS within stated injection scope: real standalone results/ordered fallback/auth stop/retained evidence |

- `python3 -m unittest discover -s tests -q`: 37 PASS.
- `python3 tests/integration/model_http.py -v`: 3 PASS; separate CLI/loopback HTTP, auth, redirects and restart without external models.
- `PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts`, `git diff --check`: PASS.
- Original offline MVP passed 18 tests and `scripts/demo.py`; later expanded to 37 tests.
- The initial HTTP test expecting Blocked exit 0 was corrected to existing exit 2 behavior; the premature failing-expectation commit was not rewritten.

This documentation consolidation makes no new live calls. Documented commands call models only when a user executes them.

### Installation, credentials and security

Recorded host: macOS/Python 3.9.6/Git 2.54.0, fnm Node 24.21.0/npm 11.19.0/OmniRoute 3.8.51.
Installed the official npm package into user Node. npm 11 install-script allowances applied only to that installation, not global settings.
Observed loopback 127.0.0.1:20128 LISTEN, dashboard 200 and unauthenticated model API 401. No autostart/public exposure/provider billing/account-security changes.
These are installation observations, not continuous health guarantees that the daemon is running now.

OmniRoute manages provider OAuth/API credentials outside the repository. Existing provider secrets were not read or printed during diagnosis.
Probe/live batches passed model/connection-restricted, noLog=true, one-hour temporary endpoint keys through in-memory environment variables, then deleted them; final temporary-key count was zero.
The reusable pool key allows only three models/three connections, noLog=true, stored in `~/.config/nidus/provider-pool.env` (600, directory 700).
The existing Copilot key remains separately restricted in `~/.config/nidus/model-gateway.env` (600).
Verified pool-key /v1/models authentication 200 and zero occurrences of the new key in repository/success vaults. [Boundary evidence](evidence/provider-activation-credential-boundary.json).
This is not general DLP or automatic classification of unknown secrets/personal sensitive information.

### Development history and consolidated sources

| Stage | Important commits/branches |
|---|---|
| Offline design/execution/security/archive | fe742a8, 57852c3, aafa4d3, 68360fe, 76245f1, ec79653, 5e28e31; feat/nidus-mvp |
| Gateway/generative Runtime/HTTP | 762c12e, af13bab, 97527c2, 57d6824/6d4024f; feat/generative-execution |
| Status/retry hardening, OmniRoute installation | fd79649, 5516660, 2161b95 |
| Copilot live | 6c1f1f5, b3e8d28, fb7475c; feat/model-live-acceptance |
| Multi-provider/fallback | b541069, a1410f5, 67d9143, 20348e5; feat/model-provider-validation |
| Gemini/NVIDIA activation | 9c1db4b, f447a97, d8ab677; feat/free-provider-activation |

Integration is feat/model-gateway. No remote push/PR/main/develop merge/history rewrite was performed.
This report consolidates MVP_REPORT (+ko), MODEL_GATEWAY_REPORT, MODEL_PROVIDER_VALIDATION_REPORT, PROVIDER_ACTIVATION_REPORT,
OMNIROUTE_INSTALL_REPORT and BLOCKED (+ko). Retrieve original documents with `git show d8ab677:filename`.

### Limits and next steps

Text Chat Completions only; no streaming/Responses/tools/natural-language contracts/GUI/multiple workers.
Literal/structural/byte verification does not prove general semantic correctness. Crash before generation persistence may duplicate calls; socket timeout is not a total execution deadline.
Provider availability/account quota/cost can change. Vault/Git/filesystem are not one atomic transaction; hostile OS processes are not isolated.
Users must inspect transmitted sources and explicitly approve. Next, accumulate usage/latency from nonsensitive real work and separately define further product scope.
