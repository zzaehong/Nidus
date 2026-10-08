# Model Gateway 결과 — 2026-10-08

## Status
**BLOCKED — Gateway 구현·오프라인 검증·OmniRoute 설치는 완료. 실제 모델 Task 완료는 미검증.**

사용자의 새 prompt.md에 따라 외부 모델 경계를 구현했습니다. 이어서 사용자가 요청한
OmniRoute를 실제 설치하고 서버를 실행했습니다. 접근 가능한 무료 Provider/Combo와
Endpoint Key가 설정되어야 실제 생성형 응답 → Completed 조건을 검증할 수 있습니다.
오프라인 Fake 성공이나 서버 설치만으로 그 조건이 충족됐다고 선언하지 않습니다.

## What changed / architecture
- Python stdlib urllib 기반 Provider-neutral Chat Completions Adapter와 Gateway.
- 명시적인 Free/Paid/Local Route 순서, 승인된 일시적 오류에만 Fallback.
- 생성형 Task/Contract, 선택된 원문과 요청만 보내는 Prompt, 정확한 전송 승인.
- 응답 저장 후 기존 file Security/Workshop/Verification/Completion/Archive/Git 연결.
- 변경된 원문/Prompt/Route는 재승인. 기존 파일 덮어쓰기 승인은 전송 전에 처리.
- 재시작 검증은 모델 재호출 없이 저장된 응답과 결과 바이트를 비교.
- 인증/접근 거부, Rate/Quota, Timeout, Network, unavailable, invalid/failed acceptance 구분.
- 시도별 Task/Route/Provider/Model/시각/Prompt 해시·크기/Usage/추정 비용/오류 기록.
- Home identity, DB schema, 기존 오프라인 계약과 Conceptual v2는 유지.

OmniRoute는 교체 가능한 실행 수단이며 Nidus의 코드 종속성이 아닙니다. 직접 API 또는
호환 Local 서버도 같은 Adapter를 사용할 수 있습니다. 현재 기본 정책은 설치된
`http://127.0.0.1:20128/v1`, 모델/Combo 이름 `nidus-free`입니다. 이 이름은 무료 전용
Combo를 설정하기 위한 명시적 값이며, 이미 생성되거나 호출에 성공했다는 뜻은 아닙니다.
무조건적인 `auto`는 Router 안의 유료 Provider를 선택할 수 있어 기본으로 쓰지 않습니다.
Router 내부의 실제 billing policy를 Nidus가 자동 검증하는 기능은 없습니다.

## Actual provider / model / E2E result
실제 외부 Live 시도: OpenCode Zen / `big-pickle`, 2026-10-08 02:28:46 UTC.
공개용 합성 Nidus 문서와 요청을 새 임시 Vault에 등록하고 정확한 전송 승인 후 호출했습니다.
Provider가 접근을 거부해 **Blocked**, Active 1건, Archive 0건, Result null로 기록됐습니다.
생성된 응답/토큰 사용량/청구 비용은 없습니다(관측값은 null이며 0으로 추정하지 않음).

실패 증거: `docs/evidence/model-live.json`.
당시 코드가 401/403을 `authentication_failed`로 함께 분류했으므로 최초 증거에는
정확한 HTTP status가 없습니다. 이를 추측해서 채우지 않았습니다. 후속 검증된 개선에서는
HTTP status를 보존하고 403을 `access_denied`로 구분합니다. 오류 본문은 저장하지 않습니다.

OmniRoute의 공개 소스가 설명하는 OpenCode 클라이언트 제한을 확인했으며, 클라이언트
신원을 흉내 내는 우회 기능은 구현하지 않았습니다. 사용자 요청에 따라 정식 Router
설치를 진행했지만 정상 Provider/인증 설정 없이 실제 모델 성공을 재시도하지 않았습니다.

OmniRoute 설치 증거: `OMNIROUTE_INSTALL_REPORT.md`. 공식 npm 3.8.51, Node 24.21.0,
CLI version/help 정상, Loopback LISTEN, Dashboard HTTP 200, 모델 API 인증 전 HTTP 401.

## Acceptance Criteria
| Criterion | Result | Evidence |
|---|---|---|
| 기존 AC-01–AC-08 | PASS | 기존 18개 테스트 유지 |
| MG-AC-01 | PASS | 설정 기반 Free/Paid/Local 정책과 호환 Adapter; OmniRoute 설치/연결 설정 |
| MG-AC-02 실제 생성형 Completed | BLOCKED / NOT VERIFIED | 실제 API 호출 접근 거부; 정상 Provider/Key 설정 필요 |
| MG-AC-03 전송 승인 | PASS | 호출 전 Waiting; 원문/Route 변경 및 거절 테스트; HTTP 승인 전 0회 호출 |
| MG-AC-04 Secret 경계 | PASS (테스트 범위) | Header 분리, 알려진 Key의 입력/출력 차단, 오류 본문 폐기, DB 유출 검사 |
| MG-AC-05 Completion guard | PASS (Fake/HTTP) | 응답/필수 문구/원문/결과 검증, 변조 Blocked, 재시작 시 0회 호출 |
| MG-AC-06 오류/관측 | PASS | 구분되는 오류, 승인된 Retryable Route만 Fallback, Usage/시각/비용 null 처리 |

## Test results
- `python3 -m unittest discover -s tests -q`: 37개 PASS.
- `python3 tests/integration/model_http.py -v`: 루프백 HTTP 3개 PASS.
  외부 모델 없이 별도 실제 CLI 프로세스/인증 오류/Redirect/재시작 검증.
- `PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts`: PASS.
- `git diff --check`: PASS.
- 실제 Live script: exit 2 / Blocked; 실패를 테스트 성공 또는 Task 완료로 변경하지 않음.
- 로컬 소켓과 설치/서버 실행에는 sandbox escalation 사용. 자동 승인 거절은 없었음.

HTTP 테스트에서 Blocked 조회 종료 코드 2를 0으로 예상한 실수를 후속 커밋으로 수정했습니다.
실패 기대값을 결과 확인 전에 커밋했던 이력은 재작성하지 않았습니다. OmniRoute 기본
주소가 Local로 바뀌면서 기존 “Local+remote 거부” 테스트는 remote 주소를 명시해 유지했습니다.

## Security / credential handling
실제 Key 값은 Task/Library/정책/Git/Prompt에 넣지 않습니다. `api_key_env` 이름만 설정하고
실행 시 환경변수에서 HTTP Header로 사용합니다. 알려진 Credential의 입력/응답 포함을
차단하며, 일반 민감정보 자동 분류는 제공하지 않습니다. 선택 원문 전체를 전송하므로
사용자가 민감성을 검토해야 합니다. HTTPS 또는 명시적 Loopback HTTP만 허용하고
Redirect와 ambient proxy 상속을 막습니다. 모델 출력은 실행되지 않는 텍스트입니다.

OmniRoute 인증 데이터는 저장소 밖 `~/.omniroute/`에서 관리됩니다. 설치/CLI 초기화가
생성한 내부 암호화 설정은 공개하지 않았습니다. Endpoint Key나 Provider 계정은 아직
Nidus에 연결되지 않았습니다. 계정 생성/결제/유료 fallback 활성화/사용자 민감 데이터
전송/외부 서버 공개/OS 자동 시작 등록은 하지 않았습니다.

## Usage / cost
Fake 테스트에서는 알려진 토큰과 설정 요율에 대한 비용 계산을 확인했습니다. 실제 실패
시도에서는 토큰/비용 null. 무료 설정의 0 요율은 정책 추정값이며 billing receipt가 아닙니다.
현재 실제 모델 처리나 무료 quota 이용 성공을 주장하지 않습니다.

## Git branches / commits
- Base: feat/nidus-mvp c9c0022. 사용자 수정 doc/prompt.md는 보존하고 커밋하지 않음.
- Integration: feat/model-gateway.
- 완료 Feature: feat/model-gateway-design, feat/generative-execution,
  feat/model-gateway-hardening, feat/omniroute-connection, feat/model-live-evidence.
- 실제 성공 검증을 기다리는 Feature: feat/model-live-acceptance. 성공으로 완료 처리하지 않음.
- 주요 커밋: 762c12e (설계), af13bab (Gateway), 97527c2 (Runtime),
  57d6824/6d4024f (HTTP 테스트/기대값 수정), fd79649 (상태·Retry 보강),
  5516660/2161b95 (OmniRoute 연결·설치 증거).
- 설치/연결과 증거/문서 커밋은 해당 Feature 이력과 current-plan에서 확인 가능.
- 최종 tree의 예상 변경은 사용자 doc/prompt.md 한 건뿐. Remote Push/PR,
  main/develop Merge, history rewrite는 수행하지 않음.

## Known limitations / remaining blockers
Chat Completions 텍스트 응답만 지원하며 streaming/Responses API나 Tool 실행은 없습니다.
원문은 총 Prompt 128 KiB, 응답은 2 MiB, 최대 5개 Route/4096 출력 토큰으로 제한합니다.
HTTP timeout은 socket timeout이며 전체 wall-clock deadline을 보장하지 않습니다.
403을 자동 Retry하지 않습니다. Remote 응답 저장 전 crash 뒤의 명시적 Retry는 중복
호출할 수 있습니다. Literal/구조 검증은 모든 의미적 요구사항의 충족을 증명하지 않습니다.

전체 미션의 남은 Blocker는 정상 무료 Provider/Combo와 Endpoint Key 설정입니다.
새 Gateway를 만들기 위한 설계 결정 자체는 더 이상 Blocker가 아닙니다.

## Recommended next step
Dashboard http://127.0.0.1:20128 에서 정상 무료 Provider와 무료 전용 Combo를 설정하고,
Endpoint Key를 Nidus 실행 환경변수로 제공한 뒤 다음을 실행합니다. Key는 채팅에 보내지 않습니다.

```sh
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.example.json --evidence /tmp/nidus-omniroute-live.json
```

실제 Generated response → Verification → Completed/Archive 증거를 확보한 뒤에만
MVP_REPORT의 Actual generative model execution을 VERIFIED로 갱신합니다.
