# Model Gateway 결과 — 2026-10-08

## Status
**COMPLETE — 실제 GitHub Copilot 생성 → Verification → Completed → Archive 검증 완료.**

사용자가 OmniRoute에 연결한 Copilot을 사용했습니다. 기존 실패 기록은 보존했습니다.

## What changed / architecture
Python 표준 라이브러리 기반 Chat Completions Adapter와 설정 기반 Gateway를 기존
Runtime에 연결했습니다. Free/Paid/Local Route, 승인된 Retryable Fallback, 환경변수
Credential, 정확한 전송 Snapshot 승인, 응답 보존, 기존 Security/Verification/Archive/Git를
활용합니다. OmniRoute는 교체 가능한 호환 Endpoint이며 Nidus 코드의 필수 종속성이 아닙니다.
기본 무료 정책의 nidus-free는 여전히 운영자가 구성할 Combo 이름입니다.
이번 성공 경로는 별도 model-policy.copilot.example.json의 단일 Copilot 모델입니다.

## Actual provider / model / end-to-end evidence
- Endpoint: http://127.0.0.1:20128/v1, OmniRoute 3.8.51 → GitHub Copilot.
- Requested model: gh/gpt-4o-mini; response model: gpt-4o-mini.
- Task: 879034f98e4b4c11a933e9a8e17e30f6.
- Call: 2026-10-08T04:25:35.396422+00:00 → 04:25:36.731778+00:00.
- Work request: supplied Nidus facts를 정확히 세 bullet로 요약하고 Nidus 문구 포함.
- 공개용 합성 원문만 임시 Vault에 제출; Waiting → 명시 승인 → 모델 응답 → 검증 → Completed.
- Active 0 / Archive 1; 결과 results/summary.md; 6개 검증 항목 모두 true.
- 사람이 응답을 검토해 세 bullet이 원문의 세 사실과 일치함을 확인했습니다.
- 실제 증거: [model-live-copilot.json](docs/evidence/model-live-copilot.json).

초기 OpenCode 접근 거부는 docs/evidence/model-live.json에 보존했습니다.
Copilot gpt-5-mini는 HTTP 400 invalid_request로 Blocked였으며
model-live-copilot-gpt5mini-failed.json에 보존했습니다. OmniRoute 로그는 해당 모델 미지원을
표시했고, refresh=true 모델 조회도 API unavailable/local_catalog fallback이었습니다.
공식 연결 테스트는 valid=true였고, 다른 명시적 경량 모델 gpt-4o-mini에서 실제 성공했습니다.
정적 카탈로그의 available 표시는 계정별 모델 호출 성공 증거가 아닙니다.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 기존 AC-01–AC-08 | PASS | 기존 오프라인 회귀 유지 |
| MG-AC-01 교체 가능한 Gateway | PASS | 호환 Adapter, 설정 Route, OmniRoute 실제 연결 |
| MG-AC-02 실제 생성형 Completed | PASS | Copilot live JSON, Active 0 / Archive 1 |
| MG-AC-03 전송 승인 | PASS | live permission ask/allow, 변경/거절 테스트 |
| MG-AC-04 Secret 경계 | PASS (검사 범위) | 환경변수/헤더 분리, 실제 키 Repo/Vault 검사 0건 |
| MG-AC-05 Completion guard | PASS | live 6개 검증 true; 변조/재시작 회귀 |
| MG-AC-06 오류/관측 | PASS | 실제 실패/성공, 토큰/시각, 구분된 오류 및 Fallback 테스트 |

## Test results
- python3 -m unittest discover -s tests -q: 37 PASS.
- python3 tests/integration/model_http.py -v: 3 PASS (별도 CLI/HTTP 프로세스).
- compileall 및 git diff --check: PASS.
- 실제 live harness: exit 0 / Completed; 실패 시도는 exit 2 / Blocked로 보존.
- 실제 Endpoint Key의 현재 Repo/Vault 파일 검사: 유출 0건. 일반 DLP 보장은 아닙니다.

## Security / credential handling
Provider OAuth는 OmniRoute가 저장소 밖에서 관리합니다. 정상 로컬 관리 API로 Nidus 전용
Endpoint Key를 만들고 gh/gpt-4o-mini와 사용자가 연결한 단일 Copilot connection에 제한했습니다.
noLog=true. Key는 ~/.config/nidus/model-gateway.env (600, 디렉터리 700)에 보관하고,
자식 프로세스 환경변수 NIDUS_MODEL_API_KEY로만 전달했습니다. 값은 출력하지 않았습니다.
Credential은 정책/Task/Library/Git/Prompt에 없습니다. 선택된 합성 원문만 전송했습니다.
Redirect 및 ambient proxy 차단, HTTPS/Loopback 제한, 기존 전송·파일 승인과 완료 Guard 유지.
결제 등록/추가 과금 설정/다른 Provider fallback/OS 자동 시작은 변경하지 않았습니다.

## Usage / cost
성공한 Nidus Task: prompt_tokens 202, completion_tokens 33, total_tokens 235.
비용 및 실제 청구/포함 quota 차감은 확인할 수 없어 estimated_cost_usd=null입니다.
무료라고 주장하지 않습니다. Copilot 경로는 kind=paid, allow_paid=true로 명시하고
승인 Snapshot에 포함했습니다. 이는 사용자가 연결한 기존 Copilot 사용 경로를 허용하는
설정이며 새 결제 설정은 아닙니다. 다른 유료 fallback은 없습니다.
추가 진단 요청도 있었으므로 235는 세션 전체 사용량이 아니라 해당 Task 관측량입니다.
현재 Copilot 요금 참고: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing .

## Git branches / commits
Integration: feat/model-gateway. 완료 Slice: feat/model-gateway-design,
feat/generative-execution, feat/model-gateway-hardening, feat/omniroute-connection,
feat/model-live-evidence, feat/model-live-acceptance.
주요 기존 Commit: 762c12e 설계, af13bab Gateway, 97527c2 Runtime,
57d6824/6d4024f HTTP 테스트/수정, fd79649 hardening, 5516660/2161b95 설치,
d9741a7/2e90956 이전 live 증거/보고서. 이번 성공 Slice의 Commit은 해당 브랜치 이력 참조.
사용자 doc/prompt.md는 보존하고 커밋하지 않았습니다. Push/PR/main/develop merge 없음.

## Known limitations / remaining blockers / next step
완료를 막는 Blocker는 없습니다. Chat Completions 텍스트만 지원하며 tool 실행,
streaming, 자연어 계약 자동 구성은 범위 밖입니다. Literal/구조 검증이 일반적인 의미적
정확성을 증명하지는 않습니다. 모델 재시도는 중복 과금 가능성이 있고 socket timeout은
전체 wall-clock deadline이 아닙니다. Router 내부 과금/계정 quota를 Nidus가 보장하지 않습니다.
Copilot 모델별 가용성은 실제 호출로 확인해야 합니다. 다른 Free/Paid/Local 경로는 정책과
offline 테스트 수준이며 모든 Provider의 live 검증을 의미하지 않습니다.
다음은 사용자가 로컬 Integration diff와 보고서를 검토한 후 원하는 배포/PR 범위를 정하는 것입니다.
