# 남아 있는 가설에 대한 결정

> 최신 상태: 실제 Copilot 생성형 실행 VERIFIED, Completed/Archive 확인.
> 이전 미검증/Blocker 본문은 당시 기록입니다. MODEL_GATEWAY_REPORT.md 및
> docs/evidence/model-live-copilot.json이 최신 결과입니다.


오프라인 Runtime은 구현 및 검증이 완료되었다. 그러나 원래 미션의 더 강한 가설인
**실제 생성형 AI Employee가 계획을 세우고 작업을 수행하는 것**은 아직 검증되지 않았다.
현재 저장소에는 모델 Runtime, 모델 Adapter, Credential 또는 Provider 설정이 존재하지 않는다.
또한 `ollama`와 `llama-cli`는 PATH에 존재하지 않는다.

결정론적 추출 작업을 AI의 판단으로 조용히 재해석해서는 안 된다.
실제 Provider를 선택하는 순간 새로운 네트워크/데이터 전송/Secret 경계가 생성된다.
기존 프롬프트는 보안 모델 또는 승인 정책이 변경되는 경우 반드시 작업을 중단하도록 요구하며,
임의의 유료 서비스 사용이나 외부 데이터 전송도 금지하고 있다.

다음 Slice를 진행하기 위해 필요한 인간의 결정은 다음과 같다.

- 로컬 모델 Host를 선택하거나,
- 명시적으로 승인된 외부 Provider를 선택하고,
- 어떤 데이터의 전송을 허용할지,
- Credential을 어떻게 처리할지 결정해야 한다.

API Key는 Task Context에 직접 입력하거나 Vault에 Commit해서는 안 된다.

현재까지의 작업은 로컬 Feature Branch와 Integration Branch에 안전하게 Commit되어 있다.
어떠한 모델 서비스도 생성되지 않았고,
외부로 데이터가 전송되지 않았으며,
Conceptual Design 문서 역시 변경되지 않았다.


## 2026-10-08 갱신 — 이전 결정 Blocker는 해소
새 prompt.md가 외부 모델 경계 구현을 명시적으로 승인해 Gateway와 Permission을
구현했습니다. 최신 Blocker 원본은 BLOCKED.md입니다. 현재 남은 문제는 정상 접근
가능한 실제 모델 Route/Credential이 설정되지 않았다는 점입니다. OpenCode 무료
경로의 실제 합성 문서 요청은 접근 거부로 Blocked가 되었고 완료로 처리하지 않았습니다.
클라이언트 제한을 우회하지 않았습니다. API Key는 채팅·Vault·Git에 넣지 말고
프로세스 환경변수로 설정해야 합니다. 결제·계정 생성·민감 데이터 전송은 하지 않습니다.


### OmniRoute 설치 후 갱신
사용자 요청에 따라 OmniRoute 3.8.51 설치와 127.0.0.1:20128 서버 실행을 완료했습니다.
Nidus 기본 정책은 무료 전용 nidus-free Combo를 이 서버에서 사용하도록 설정되어
있습니다. 실제 Combo/무료 Provider/Endpoint Key 설정과 모델 완료 검증은 남아 있습니다.
자세한 설치 증거는 OMNIROUTE_INSTALL_REPORT.md, 최신 검증 상태는
MODEL_GATEWAY_REPORT.md를 참고하세요. 기존 모델 미검증 상태를 성공으로 변경하지 않습니다.


## Copilot live 검증 후속 — 2026-10-08
이전 미설정/미검증 상태는 해소됐습니다. 사용자가 연결한 Copilot의
`gh/gpt-4o-mini`로 승인 → 실제 생성 → 검증 → Completed/Archive를 확인했습니다.
증거: docs/evidence/model-live-copilot.json. Nidus 전용 키는 저장소 밖 권한 600 파일에
있으며 모델/연결을 제한했습니다. 무료 보장 없이 별도 Paid 정책을 사용했고 결제 설정은
변경하지 않았습니다. 상세 범위·테스트·비용 unknown은 MODEL_GATEWAY_REPORT.md 참조.


## 최신 다중 Provider 검증 — 2026-10-08
Copilot VERIFIED; Gemini/NVIDIA 단독 생성은 404/400으로 BLOCKED. 명시적인 로컬
503 장애 주입 후 실제 NVIDIA 429 → Copilot 성공으로 Fallback 완료를 확인했습니다.
401에서는 후속 호출 없이 차단했습니다. 실제 Provider 장애와 주입 장애를 구분합니다.
MODEL_PROVIDER_VALIDATION_REPORT.md 및 docs/evidence/model-provider-validation-summary.json 참조.


## 최신 Provider 활성화 — 2026-10-08
Gemini `gemini-3.5-flash-lite` / NVIDIA NIM `nvidia/nemotron-3.5-lightning-30b-a3b`
모두 실제 Nidus Completed/Archive 검증 완료. 이전 Blocked 기록은 당시 상태입니다.
`model-policy.pool.example.json`으로 Gemini → NVIDIA → Copilot 순서의 검증된 Pool을
선택할 수 있습니다. 키는 저장소 밖 `~/.config/nidus/provider-pool.env` (600)의
NIDUS_POOL_API_KEY를 환경변수로 사용합니다. 비용 unknown, 무료 보장 없음, 새 결제 설정 없음.
사용법/증거/제한: [활성화 보고서](PROVIDER_ACTIVATION_REPORT.md).
