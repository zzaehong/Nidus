# Multi-provider live validation — 2026-10-08

> 최신 활성화 결과: **Gemini VERIFIED / NVIDIA NIM VERIFIED / Pool ACTIVE**.
> 이전 Blocked 결과는 당시 기록이며 삭제하지 않았습니다.
> 최신 모델·증거·사용법은 PROVIDER_ACTIVATION_REPORT.md 참조.


## Status
**PARTIAL: 실제 Fallback VERIFIED; Gemini 및 NVIDIA NIM 단독 실행 BLOCKED.**
기존 Copilot 성공 증거는 변경하지 않았습니다. 신규 결제/구독 없이 가능한 Live 검증을
수행했고 실패를 성공으로 간주하지 않았습니다.

| Target | Result | Actual observation |
|---|---|---|
| Copilot baseline | VERIFIED | 기존 gpt-4o-mini evidence 보존; 이번 Fallback에서도 두 번 실제 완료 |
| Gemini | BLOCKED | 2.5-flash-lite/2.5-flash HTTP 404, 3.5-flash HTTP 400 |
| NVIDIA NIM | BLOCKED | mistral-7b-instruct-v0.3, gemma-3-4b-it, nemotron-nano-3-30b-a3b HTTP 404 |
| Fallback | VERIFIED (fault injection scope) | 주입된 503 → 실제 NVIDIA 429 → 실제 Copilot 완료 |
| Two injected failures | VERIFIED (fault injection scope) | 주입된 503 두 번 → 실제 Copilot 완료 |
| Auth fail closed | VERIFIED | 주입된 401 → Blocked, 후속 호출 없음 |

## Provider/model selection and failures
OmniRoute의 두 연결은 활성 상태였고 공식 연결 테스트는 valid=true였습니다.
refresh=true 모델 조회는 source=api였으며 선택한 후보가 포함됐습니다. 카탈로그와 인증
성공이 생성 성공을 보장하지 않음을 실제 호출로 확인했습니다. Provider별 세 후보만
시도하고 계정/결제/보안 설정을 변경하거나 무제한 재시도하지 않았습니다.
Gemini 최신 후보 400과 NVIDIA 404의 상세 원인은 안전한 상태 코드만으로 확정할 수 없습니다.
오류 본문/Provider Credential을 읽거나 저장하지 않았습니다. Account quota/모델 권한/Router
호환성 문제 중 무엇인지 추측해서 확정하지 않습니다.

현재 선택 정책: docs/policies/model-live-gemini.json, model-live-nvidia.json.
과금 여부를 검증하지 못해 두 경로 모두 kind=paid / allow_paid=true로 정직하게 명시했습니다.
사용자가 기존 연결로 요청한 테스트 범위의 경로만 허용하며 새 결제나 유료 fallback 설정을
Provider 계정에 추가하지 않았습니다. 요율은 지정하지 않아 비용은 null입니다.

## Actual fallback sequences
1. gemini-injected-fault (local HTTP 503, provider_unavailable, retryable)
   → nvidia-live (OmniRoute 실제 호출 HTTP 429, rate_limited, retryable)
   → copilot-live (real gpt-4o-mini) → Completed, Active 0 / Archive 1.
2. gemini-injected-fault (local HTTP 503) → nvidia-injected-fault (local HTTP 503)
   → copilot-live (real gpt-4o-mini) → Completed, Active 0 / Archive 1.
3. gemini-injected-fault (local HTTP 401, authentication_failed, nonretryable)
   → Blocked, Active 1 / Archive 0; NVIDIA/Copilot 시도 없음.

장애 주입은 별도 Loopback HTTP fixture가 응답한 것입니다. 주입 경로는 OmniRoute 또는
해당 외부 Provider에 전송하지 않았고 Credential 참조도 없습니다. 실제 Gemini/NVIDIA
장애를 관측했다는 주장이 아닙니다. 실제 후속 Provider 응답으로 Nidus 전체 완료 흐름을
검증했습니다. 자연 발생한 두 Provider 장애 후 전환은 아직 검증되지 않았습니다.
404/400을 retryable로 바꾸는 등 Gateway 오류 정책 변경은 없습니다.

첫 fallback harness는 NVIDIA에서 바로 성공할 것으로 좁게 예상해 exit 1이었습니다.
관측된 Task는 올바르게 NVIDIA 429 후 Copilot으로 완료됐습니다. 평가를 허용된 세 번째
Route까지 포함하도록 수정했고 해당 JSON에 평가 수정 사유를 기록했습니다. 원시 시도
이력/응답은 바꾸지 않았습니다. 두 단계 시나리오는 원래부터 exit 0입니다.

## Evidence / verification / usage
각 JSON에는 Task, 전송 승인 Snapshot, 요청/실제 모델, 시각, 시도 순서, 오류, 토큰,
결과 검증과 Active/Archive 수가 있습니다. Summary는 시각 차이로 latency_seconds를
계산하고 unknown은 null로 유지합니다. 이는 Router와 전송을 포함한 Gateway 관측 지연입니다.

- docs/evidence/model-live-gemini.json: 마지막 Gemini 실패.
- docs/evidence/model-live-nvidia.json: 마지막 NVIDIA 실패.
- 각 candidate1-failed/candidate2-failed.json: 이전 실패 보존.
- docs/evidence/model-live-fallback.json: 주입 503 + 실제 429 + 실제 성공.
- docs/evidence/model-live-fallback-two.json: 주입 503 두 번 + 실제 성공.
- docs/evidence/model-live-fallback-auth.json: 401 전환 중단.
- docs/evidence/model-provider-discovery.json: 모델 조회 출처/임시 키 삭제 확인.
- docs/evidence/model-provider-validation-summary.json: 모든 시도 latency/usage 요약.

두 성공 Task는 각각 prompt 202 / completion 30 / total 232 tokens입니다.
비용은 null이며 세션 전체 청구액을 의미하지 않습니다. 실패 요청의 사용량도 unknown입니다.
출력은 각각 정확히 세 bullet이며 원문의 세 사실과 일치함을 사람이 확인했습니다.
원문 불변/결과 일치/응답 일치/비어 있지 않음/정상 종료/필수 문구 검증 모두 true입니다.

## Security / credentials
공개용 합성 Nidus 문서만 사용했습니다. 기존 Provider Credential/기존 Nidus 키 값은
읽거나 출력하지 않았습니다. 정상 관리 API로 1시간 만료 임시 Endpoint Key를 생성해
선택한 세 모델/세 connection으로 제한하고 noLog=true로 설정했습니다. 값은 자식 프로세스
환경변수 NIDUS_VALIDATION_API_KEY에 메모리로만 전달하고 각 batch finally에서 키를
삭제했습니다. 최종 관리 API 확인: 임시 키 0개. 기존 Copilot 키 제한은 유지했습니다.
값을 정책/Task/Vault/Git/Prompt에 넣는 코드는 없습니다. 장애 fixture에는 키를 전달하지
않습니다. Repository 파일의 Credential 패턴 검사도 수행했습니다. 일반 DLP 보장은 아닙니다.

## Regression / completion criteria
37 offline tests, 3 loopback HTTP tests, compileall, git diff --check PASS.
최소 실제 Fallback 한 경로, 순서, 최종 실제 모델 Completed/Archive, 인증 차단,
증거/문서/회귀는 충족했습니다. Gemini/NVIDIA 실제 호출 결과 기록 조건은 충족했지만
두 Provider의 단독 생성 성공 목표는 미충족이며 Blocker로 남깁니다.

## Git / next step / limits
Feature: feat/model-provider-validation. Integration: feat/model-gateway.
변경: 증거 보호, opt-in fault harness, 단독 정책, machine-readable evidence와 보고서.
사용자 doc/prompt.md, .DS_Store, docs/.DS_Store는 손대거나 커밋하지 않습니다.
Push/PR/main/develop merge/history rewrite 없음. 주요 Commit: b541069 (harness/policy),
a1410f5 (실제 증거). 문서/통합 Commit은 Feature 및 Integration 이력 참조.

권장 다음 단계는 OmniRoute Dashboard에서 Gemini/NVIDIA 생성 테스트에 성공하는 정확한
모델 ID를 확인한 뒤 해당 단독 정책으로 재검증하는 것입니다. Key를 채팅에 보내지 않습니다.
현재 400/404는 nonretryable이므로 정상적으로 Blocked입니다. 인증 오류 우회/새 유료
구독/보안 설정 변경으로 이 결과를 성공시키지 않습니다.

참고한 공식 API 문서:
- https://ai.google.dev/api/generate-content
- https://docs.api.nvidia.com/nim/reference/google-gemma-3n-e4b-it-infer
모델 카탈로그보다 실제 evidence의 결과가 이 보고서의 판단 근거입니다.


재실행 예시 (새로 승인된 제한 Endpoint Key가 NIDUS_VALIDATION_API_KEY 환경에 있을 때):

```sh
python3 scripts/model_live.py --allow-synthetic-transmission --policy docs/policies/model-live-gemini.json --evidence /tmp/nidus-gemini-new.json
python3 scripts/model_fallback_live.py --allow-synthetic-transmission --scenario fallback-two --evidence /tmp/nidus-fallback-new.json
```

이 명령은 실제 모델 사용량을 소비할 수 있습니다. 이번 검증용 임시 키는 모두 삭제돼
있으며 기존 Copilot 전용 키는 Gemini/NVIDIA용으로 확장하지 않았습니다.


## Provider activation follow-up — latest
Gemini gemini-3.5-flash-lite와 NVIDIA nvidia/nemotron-3.5-lightning-30b-a3b 모두
실제 응답 → 검증 → Completed/Archive 확인. Evidence는 model-live-gemini-success.json /
model-live-nvidia-success.json. 기존 실패 Evidence는 보존했습니다. 전용 제한 키와
model-policy.pool.example.json으로 재사용 가능. 과금 무료 보장은 없으며 비용 null.
상세: PROVIDER_ACTIVATION_REPORT.md.
