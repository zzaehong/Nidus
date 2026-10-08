# Nidus

로컬 Agent Vault 안에서 요청·작업 계약·문맥 복구·권한 검사·실행·검증·보관을
연결하는 최소 Runtime입니다. 기본 Worker는 결정적인 evidence briefing을 만들며,
선택적인 생성형 경로는 실제 OmniRoute → GitHub Copilot `gpt-4o-mini`로
생성·검증·Completed/Archive까지 확인했습니다. 임의의 Tool 실행은 지원하지 않습니다.

Python 3.9 이상과 Git이 필요합니다. 오프라인 실행은 추가 패키지/API Key 없이 가능하고,
생성형 실행에는 명시적인 모델 정책과 Credential이 필요합니다.
macOS/Linux에서 저장소 루트의 터미널로 실행합니다.

```sh
python3 scripts/demo.py
```

별도 임시 Vault에서 실제 CLI 프로세스들을 실행합니다. 출력된 Vault 경로에 결과와
로컬 Git 이력이 남습니다. 실행 직후 종료하고 다시 실행하는 검증 경로도 포함합니다.

직접 사용할 때는 Library에 UTF-8 `.md`/`.txt` 원문을 넣고 다음 명령을 실행합니다.
`/path/to/vault`는 사용자 Vault의 실제 경로, `<task-id>`는 submit 결과의 id입니다.

```sh
python3 -m nidus --vault /path/to/vault init
python3 -m nidus --vault /path/to/vault submit "회의 기록 브리핑" --source notes.md --output results/brief.md --priority do-now
python3 -m nidus --vault /path/to/vault run <task-id>
python3 -m nidus --vault /path/to/vault show <task-id>
python3 -m nidus --vault /path/to/vault list
python3 -m nidus --vault /path/to/vault list --archive
```

기존 출력 파일은 Waiting으로 전환됩니다. `show`의 attention에서 대상과 영향을
검토한 후 명시적으로 결정합니다. 승인 후 파일이 달라지면 다시 승인을 요청합니다.

```sh
python3 -m nidus --vault /path/to/vault decide <task-id> approve
python3 -m nidus --vault /path/to/vault run <task-id>
# 또는 decide <task-id> reject: 원문을 보존하고 작업 취소
```

`run --execute-only`는 결과 저장 후 Verifying에서 멈춥니다. 다음 `run`이 검증을
재개합니다. Blocked는 `show`의 error와 history를 확인하고 원인을 고친 후 명시적으로
다시 run할 수 있습니다. Waiting/Completed/Cancelled는 run으로 자동 변경되지 않습니다.
Blocked CLI 종료 코드는 2이며 Waiting은 정상적인 판단 대기이므로 0입니다.

Vault의 `.nidus/state.sqlite3`에는 Home·Desk·Task Board·결정·체크포인트·감사 이력이
저장됩니다. 완료 작업은 활성 목록에서 빠지고 Archive에서 유지됩니다. Library는
`.nidus/` 밖의 사용자 일반 파일입니다. 승인된 덮어쓰기 전 기존 파일 버전도 Git에
보존합니다. Runtime은 관련 파일만 로컬 커밋하고 사용자의 무관한 staged 변경은
커밋하지 않습니다. Remote push는 없습니다. 실행 중인 Vault는 복사하지 마세요.

허용 도구는 제한된 파일 읽기/쓰기뿐입니다. 경로 탈출, 숨김 파일, 심볼릭 링크,
원문 덮어쓰기는 거부합니다. 결정적 경로에는 Shell·네트워크·Secret 접근 도구가 없습니다. 생성형 경로는 아래의
정확한 전송 승인과 환경변수 인증을 사용합니다. 외부 프로세스가
적대적으로 파일을 바꾸는 상황에 대한 OS sandbox는 제공하지 않습니다.

```sh
python3 -m unittest discover -s tests -v
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

제품 범위는 [PRD.md](PRD.md), 기술 구조는 [DESIGN.md](DESIGN.md), Slice와 Git 이력은
[current-plan.md](docs/plans/current-plan.md), 최종 결과는 [MVP_REPORT.md](MVP_REPORT.md)에
기록합니다. 개념 설계의 원본은 [v2](doc/Nidus_Conceptual_System_Design_v2.md)와
[변경 요약](doc/Nidus_Conceptual_System_Design_v2_changes.md)입니다.


## Model Gateway — 생성형 문서 작업

Python 표준 라이브러리만 사용하는 Chat Completions Gateway입니다. OmniRoute를
설치하지 않아도 호환 API를 연결할 수 있습니다. `model-policy.example.json`은
설치된 OmniRoute의 `http://127.0.0.1:20128/v1`을 사용합니다. 모델명 `nidus-free`는
Dashboard에서 무료 Provider만으로 구성할 Combo 이름이며 아직 생성됐다는 뜻은 아닙니다.
정상 무료 모델 ID를 직접 지정해도 됩니다. 앞서 OpenCode Zen 직접 경로의 Live 호출은
접근 거부로 끝났습니다. 가짜 클라이언트 신원으로 제한을 우회하지 않았습니다.

사용 권한이 있는 API 또는 실행 중인 Router의 `base_url`과 모델을 정책에 지정합니다.
정책 JSON에는 `api_key_env`라는 환경변수 **이름만** 넣습니다. 실제 Key는 환경변수로
제공하고 Library·Task·Vault·정책 파일·Git에 기록하지 마세요. `.env`를 자동으로 읽지
않습니다. 인증이 필요 없는 정상 Local 서버에서는 `api_key_env`를 생략할 수 있습니다.

```sh
python3 -m nidus --vault /path/to/vault submit "Nidus 기록을 요약해줘" --source notes.md --output results/summary.md --mode generative --model-policy model-policy.local.json --require Nidus
python3 -m nidus --vault /path/to/vault run <task-id>
python3 -m nidus --vault /path/to/vault show <task-id>
python3 -m nidus --vault /path/to/vault decide <task-id> approve
python3 -m nidus --vault /path/to/vault run <task-id>
```

첫 run은 Waiting으로 전환되고 전송할 원문 경로·해시, Prompt 해시·크기,
전체 Route 정책을 attention에 표시합니다. 기존 출력이 있으면 덮어쓰기 판단을
먼저 받습니다. 각 승인 후 다시 run하세요. 요청과 선택된 원문 전체만 모델에
전달되며 Home/Desk/전체 Vault는 전송하지 않습니다. 원문·요청·정책 변경은 재승인이
필요합니다. 알려진 Credential이 입력/출력에 포함되면 차단하지만 일반적인 민감정보를
자동 판별하지는 않습니다. 전송할 자료의 민감성은 사용자가 검토해야 합니다.

Route 목록 순서가 실행 순서입니다. `kind`는 `free`, `paid`, `local`입니다.
일시적인 Rate/Quota/Timeout/Network/서버 실패만 다음 승인된 Route로 넘어갑니다.
Paid Route는 정책의 `allow_paid: true`와 전송 승인이 모두 필요하며 기본값은 false입니다.
Router 내부 정책은 별도이므로 기본값은 무조건적인 `auto` 대신 무료 전용 Combo 이름을
사용합니다. 실제 Combo의 모든 Upstream이 무료인지 Dashboard에서 확인해야 합니다.
Free 표시는 운영자가 지정하는 정책 정보이며 Nidus가 공급자의 청구를 보장하지 않습니다.
OmniRoute는 예를 들어 `http://localhost:20128/v1`로 연결할 수 있으나 Router가 뒤에서
외부로 전송할 수도 있습니다. Local Model도 승인 경로를 사용합니다.

생성 결과는 응답과 함께 저장하고 재시작 시 모델 재호출 없이 검증합니다.
`--require`는 응답에 반드시 들어갈 **문자 그대로의 문구**이며 여러 번 지정할 수 있습니다.
Completion은 응답이 비어 있지 않음, 정상 종료, 필수 문구, 원문 불변, 결과 바이트
일치를 확인합니다. 의미적 정확성 전부를 증명하는 검증은 아닙니다. 실패 원인은
`model_error`, 시도 이력은 history의 `model_attempt_*`에서 확인할 수 있습니다.

오프라인 전체 테스트와 별도로 로컬 HTTP 통합 테스트를 실행합니다. 후자는 로컬
소켓 권한이 필요하지만 외부 모델이나 Key는 사용하지 않습니다.

```sh
python3 tests/integration/model_http.py -v
```

Live Acceptance는 공개용 합성 문서만 새 임시 Vault에서 전송합니다. 실제 모델을
사용하므로 정상적으로 접근 가능한 무료 Route를 먼저 설정하세요. 기존 실패 증거를
보존하려면 새로운 evidence 파일명을 사용하세요.

```sh
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.local.json --evidence /tmp/nidus-live-result.json
```

[Model Gateway 보고서](MODEL_GATEWAY_REPORT.md)와 [실제 성공 증거](docs/evidence/model-live-copilot.json)에
현재 검증 범위를 기록했습니다. 이전 실패 증거도 보존했습니다.


## 설치된 OmniRoute
OmniRoute `3.8.51`을 현재 사용자 Node `v24.21.0` 환경에 설치했습니다. 서버는
`127.0.0.1:20128`에서 실행 중이고 대시보드는 [여기](http://127.0.0.1:20128)입니다.
모델 API는 인증이 필요합니다. Dashboard에서 정상 무료 Provider/Combo와 Endpoint Key를
설정한 뒤 Key를 `NIDUS_MODEL_API_KEY` 환경변수로 제공하세요. 현재 Copilot 모델의 실제 생성·검증·완료를 확인했습니다. [설치 결과](OMNIROUTE_INSTALL_REPORT.md)를 참고하세요.

```sh
# 종료됐다면 다시 시작 (외부 공개 없이 Loopback만 사용)
OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray
# 종료
omniroute stop
```


## 검증된 GitHub Copilot 경로
사용자가 연결한 Copilot의 `gh/gpt-4o-mini`로 실제 Nidus Task가 Completed/Archive에
도달했습니다. `model-policy.copilot.example.json`을 명시적으로 선택하세요. 이 경로는
무료가 보장되지 않아 `kind=paid`, `allow_paid=true`이며 다른 경로 fallback은 없습니다.
추가 과금 설정은 변경하지 않았고 실제 청구/남은 quota는 Copilot에서 확인해야 합니다.
기본 무료 Combo 정책은 자동으로 이 정책으로 변경되지 않습니다.

이 컴퓨터의 Nidus 전용 키는 저장소 밖 `~/.config/nidus/model-gateway.env` (600)에 있으며
단일 모델/연결로 제한했습니다. 다음 명령은 키를 출력하지 않고 실행 환경에 넣습니다.

```sh
set -a
. "$HOME/.config/nidus/model-gateway.env"
set +a
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.copilot.example.json --evidence /tmp/nidus-copilot-live.json
unset NIDUS_MODEL_API_KEY
```

Live 명령은 새 실제 호출입니다. 단순 증거 열람은
[기록된 결과](docs/evidence/model-live-copilot.json)를 확인하세요.


## 최신 다중 Provider 검증 — 2026-10-08
Copilot VERIFIED; Gemini/NVIDIA 단독 생성은 404/400으로 BLOCKED. 명시적인 로컬
503 장애 주입 후 실제 NVIDIA 429 → Copilot 성공으로 Fallback 완료를 확인했습니다.
401에서는 후속 호출 없이 차단했습니다. 실제 Provider 장애와 주입 장애를 구분합니다.
MODEL_PROVIDER_VALIDATION_REPORT.md 및 docs/evidence/model-provider-validation-summary.json 참조.
