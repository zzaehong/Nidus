# Provider activation — 2026-10-08

## Status
**COMPLETE: GitHub Copilot VERIFIED / Gemini VERIFIED / NVIDIA NIM VERIFIED /
Fallback VERIFIED / Free–Low-cost Pool ACTIVE (billing not guaranteed free).**
이전 실패와 Copilot/Fallback 증거는 그대로 보존했습니다. Gateway 코드 변경 없이
실제 호출 가능한 최신 모델을 선택해 두 Provider의 전체 Nidus 흐름을 검증했습니다.

## Diagnosis and model selection
공식 문서 → OmniRoute 계정 discovery → 최소 생성 Probe → Nidus Live 순서로 확인했습니다.
Gemini 공식 GA Flash-Lite 모델과 NVIDIA Hosted NIM의 Lightning 모델을 선택했습니다.

| Observation | Supported conclusion |
|---|---|
| 과거 Gemini 2.5 후보/NVIDIA 과거 후보 404 | 해당 경로의 생성 실패; 원인을 계정/과금/Mapping 중 하나로 단정할 근거는 없음 |
| Gemini 3.5 Flash 재Probe 400 + Router 로그 | 현재 활성 live catalog에 없어 OmniRoute에서 거부됨 |
| Gemini 3.5 Flash-Lite Probe 200 / NIDUS_OK / stop | 기존 계정/Endpoint/요청 형식으로 실제 생성 가능 |
| NVIDIA Lightning 첫 Probe 200 / length, 128 output tokens | 생성은 가능하나 출력 예산 부족; 성공한 정상 응답으로 세지 않음 |
| NVIDIA Gemma-4-31B Probe 60초 Timeout | 단독 가용성 미검증; 후보로 채택하지 않음 |
| NVIDIA Lightning 512-token Probe 200 / NIDUS_OK / stop | 같은 모델의 정상 종료 생성 확인; Nidus에서는 기존 1024 예산 사용 |

NVIDIA OmniRoute 요청 ID는 `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b`입니다.
첫 nvidia는 Router Provider prefix, 뒤 `nvidia/nemotron-3.5-lightning-30b-a3b`가
공식 Hosted NIM 모델 ID입니다. 중복처럼 보여도 Mapping 오류가 아닙니다.
Gemini는 `gemini/gemini-3.5-flash-lite` → 실제 `gemini-3.5-flash-lite`입니다.
새 계정/결제/구독이나 Provider Endpoint/보안 설정 변경은 필요하지 않았습니다.
오류 본문은 보존하지 않고 type/code 및 사전 허용한 진단 키워드만 기록했습니다.
과거 404 전체를 모델 은퇴 등 특정 원인으로 재해석하지 않았습니다.

## Live execution / verification / usage
| Provider | Actual model | Latency | Input / output / total tokens | Result |
|---|---|---|---|---|
| Gemini | gemini-3.5-flash-lite | 1.009859 s | 208 / 32 / 240 | Completed, Active 0 / Archive 1 |
| NVIDIA NIM | nvidia/nemotron-3.5-lightning-30b-a3b | 11.160926 s | 231 / 415 / 646 | Completed, Active 0 / Archive 1 |

Latency는 Gateway 시도 시작/끝 시각의 차이로 Router와 네트워크를 포함합니다.
단일 표본이므로 일반적인 성능/성공률 보장은 아닙니다. 사용량은 각 Task의 응답 관측값이며
Probe 및 실패 요청을 포함한 세션 전체 사용량이 아닙니다. 비용은 모두 null입니다.
NVIDIA Probe의 usage=120 tokens 등은 본문 길이가 아닌 Provider 보고값 그대로입니다.

두 Task 모두 Waiting → 명시적 scoped transmission approve → 실제 생성 → 결과 저장 →
6개 검증 true → Completed → Archive를 통과했습니다. 원문 세 사실을 정확히 세 bullet로
출력했으며 사람이 의미도 확인했습니다. 기존 완료 guard/전송 승인/Fallback 오류 정책은
그대로입니다. 의미 검증 일반화나 모델 Tool 실행을 추가하지 않았습니다.

- Gemini Task 81d9cf35e7ae4a17ab8f6ae05725da5a:
  docs/evidence/model-live-gemini-success.json.
- NVIDIA Task bf007d0ae1a24d1caaaa044b4a2f48df:
  docs/evidence/model-live-nvidia-success.json.
- Probe 최초/정상 종료/Timeout: provider-activation-probes-initial.json,
  provider-activation-probes.json, provider-activation-probe-gemma-timeout.json.
- 계정 API discovery: docs/evidence/provider-activation-discovery.json.
- 시각/모델/사용량/검증 요약: docs/evidence/provider-activation-summary.json.

## Active pool and credential boundary
재사용 정책: `model-policy.pool.example.json`, 순서 Gemini Flash-Lite → NVIDIA Lightning
→ Copilot gpt-4o-mini. 이번 Task에서 Gemini가 더 빠르고 적은 토큰을 보고했고 경량 모델이므로
우선했습니다. 충분한 표본의 비용 최적화 결과라고 주장하지 않습니다. 순서는 설정만 바꾸면
됩니다. 기존 기본 무료 Combo placeholder 정책은 자동으로 덮어쓰지 않았습니다.

NVIDIA 공식 모델 페이지는 free hosted endpoint를 표시하지만 현재 계정의 실제 청구/남은
무료 quota는 확인하지 못했습니다. 따라서 Pool은 보수적으로 kind=paid, allow_paid=true로
명시하고 비용 요율을 꾸미지 않았습니다. 기존 연결 사용을 위한 opt-in 정책이며 새로운
Provider 결제/추가 과금 설정이 아닙니다. 승인된 Retryable 오류만 다음 경로로 넘어갑니다.

Nidus 전용 Pool Endpoint Key를 새로 만들어 정확한 세 모델/세 기존 connection으로
제한하고 noLog=true로 설정했습니다. `~/.config/nidus/provider-pool.env` (600, 디렉터리
700)에 보관하며 `NIDUS_POOL_API_KEY` 환경변수로만 사용합니다. 기존 Provider Credential과
기존 Copilot 키는 읽거나 변경하지 않았습니다. Probe/Live 임시 키는 각 batch finally에서
삭제했습니다. 최종 임시 키 0개 및 Pool 키의 /v1/models 인증 HTTP 200을 확인했습니다.
제한 범위 증거는 docs/evidence/provider-activation-credential-boundary.json입니다.
새 Pool 키의 Repo/두 성공 Vault 검사 결과 유출 0건입니다.

```sh
set -a
. "$HOME/.config/nidus/provider-pool.env"
set +a
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.pool.example.json --evidence /tmp/nidus-pool-new.json
unset NIDUS_POOL_API_KEY
```

위 명령은 새 실제 호출이며 evidence 경로가 이미 있으면 거절합니다. 개별 Provider 검증
정책은 docs/policies/model-active-gemini.json / model-active-nvidia.json에 있으며 일회용 검증의
NIDUS_VALIDATION_API_KEY 참조를 보존합니다. 재사용은 위 Pool 키/정책을 사용하세요.

## Natural fallback
이번 활성화에서는 두 Provider가 정상 완료했으므로 quota 소진이나 인위적인 계정 장애를
만들지 않았습니다. 기존 `model-live-fallback.json`의 로컬 주입 503 → 실제 NVIDIA 429 →
실제 Copilot 성공과 `model-live-fallback-two.json`, `model-live-fallback-auth.json`을 그대로
유지합니다. 이번 새 모델들만으로 자연 발생한 장애 전환을 검증했다는 주장은 아닙니다.
추가 안전한 자연 장애를 만들 필요가 없어 기존 Fault Injection evidence로 충분합니다.

## Regression / Git / remaining limits
37 offline + 3 loopback HTTP tests, compileall, diff check PASS. Gateway 코드 변경 없음.
Feature: feat/free-provider-activation; integration feat/model-gateway.
정책/증거 Commit: 9c1db4b. 보고서/통합 Commit은 해당 Feature 이력에서 확인합니다.
기존 성공/실패 Evidence는 변경하지 않았습니다. 사용자 doc/prompt.md와 .DS_Store 파일은
보존하고 커밋하지 않았습니다. Push/PR/main/develop merge/history rewrite 없음.

완료를 막는 Blocker는 없습니다. 모델/계정 quota와 availability는 바뀔 수 있고 billing은
Provider에서 확인해야 합니다. Pool 정책은 직접 live 검증된 모델로 구성했으며, 모든 경로의
자연 장애나 장기 성공률을 보장하지 않습니다. 다음 단계는 로컬 diff 검토 후 실제 공개 가능
업무에 명시적으로 전송 승인해 사용하고 관측 데이터를 축적하는 것입니다.

## Official references
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6
- https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build
문서/카탈로그는 후보 선택 근거이고 VERIFIED 판단은 실제 Nidus 응답/완료 증거에 근거합니다.
