# Nidus

[한국어](#한국어) · [English](#english)

## 한국어

### 개발 테스트 Vault 분리

테스트 및 합성 데모는 소스 저장소 옆의 `/Users/parkjaehong/Developer/nidus_vault` 아래에 실행별 임시 Vault를 만들고 종료 시 정리합니다. 실제 GUI/CLI Vault도 `/Users/parkjaehong/Developer/Nidus` 또는 그 상위/하위 소스 경로로 지정할 수 없도록 막습니다. 기존 사용자 Vault는 명시적으로 `--vault`에 지정해야 합니다.

```sh
python3 -m unittest discover -s tests -q
python3 tests/integration/model_http.py -q
python3 tests/integration/plan_http.py -q
node tests/gui_frontend.js
```

재현 용도의 영속 합성 데모는 실행별 `nidus-demo-*` Vault를 같은 분리 폴더에 남깁니다. 테스트가 만드는 Git 체크포인트와 산출물 커밋도 해당 격리 Vault의 로컬 `.git` 안에서만 발생합니다.

### Native AI connections

Nidus connects to **Google Gemini directly** with one API Key. In **Settings → AI connection**, enter the key; Nidus discovers generation-capable models and checks normal plus structured JSON responses. The key goes to macOS Keychain. Nidus does not ask for a model ID, Endpoint, route, or policy for Gemini, and does not assume Gemini is free.

**OpenAI-compatible API** remains available for LM Studio, NVIDIA NIM, OmniRoute, and other compatible endpoints. The Connection path does not require OmniRoute. Existing Plan/Task policies and transmission approval continue to work independently; Connections are not automatically used by those policies. [Connection setup, status, security, and scope](docs/CONNECTIONS.md).

Gemini model discovery uses Google's `generateContent` capability metadata, then tries at most five candidates. A model must pass both real probe calls for the connection to become READY. The Generic OpenAI-compatible adapter retains its bounded first-three check when the endpoint provides no generation-capability metadata. [Synthetic fixture and live evidence](docs/CONNECTIONS.md#검증-자료).

### Local GUI v1

```sh
python3 -m nidus --vault "$vault" gui
```

브라우저에서 `http://127.0.0.1:8765`를 엽니다. 다른 포트는 `gui --port 8766`으로 지정할 수 있습니다. Python 표준 라이브러리만 사용하며 별도 설치·Frontend build·CDN이 필요 없습니다. 서버는 127.0.0.1에만 bind하며 종료는 터미널의 Ctrl-C입니다.

Dashboard에서 Plan/Task 상태와 사람 판단 요청을 확인합니다. **새 Plan 만들기**에 요청, Vault 기준 `.md/.txt` source 경로(한 줄에 하나), 비밀 값 없는 Planning policy JSON을 입력하세요. 기존 정책 파일의 JSON 내용을 붙여 넣으면 됩니다. 고급 설정의 Worker/Review/Final policy를 비우면 CLI와 같은 정책 상속 및 한도 10/20/5를 사용합니다. Source는 Runtime에서 경로·내용·권한을 검증합니다.

**다음 단계 실행 → 사람 판단함에서 정확한 범위 검토·승인 → 다음 단계 실행** 순서로 진행합니다. 한 클릭은 기존 `plan-run` 한 bounded step이며 Plan 전체를 자동 실행하지 않습니다. Worker/Manager/Final 전송 승인은 각각 처리합니다. Permission 카드와 Quality 카드는 구분되며, 품질 판단에는 이유가 필요하고 재작업에는 지시를 적습니다. Task 품질 판단을 먼저 해결한 뒤 Plan을 별도로 재개합니다. Plan Final ESCALATE는 이유와 함께 계속/취소합니다.

Plans의 상세에는 작업 목록·의존 관계·전체 정보·실행 기록이 있고, Task 상세에는 계약·제출·검증·Manager Review·재작업·결과 해시가 있습니다. Archive는 완료된 Plan/Task의 읽기 전용 조회이며 설정의 AI 연결에서는 Provider를 등록·검사·관리합니다. 화면은 요청 완료나 **새로고침** 시 갱신하며 다른 CLI/브라우저 변경이 있으면 stale 요청을 거부하고 최신 상태를 다시 불러옵니다. 이전 기록에 없는 시각은 만들어 표시하지 않습니다. GUI 세션 토큰은 서버 재시작 때 교체됩니다.

로컬 GUI는 같은 컴퓨터의 신뢰할 수 있는 사용자용입니다. 원격 접속, 계정, 파일 업로드, 정책 파일 시스템 탐색, Pixel Office, 자동 실행, 실시간 streaming은 지원하지 않습니다. [GUI 보고서](docs/GUI_REPORT.md)와 [브라우저 검증](docs/evidence/gui-browser-review.json)을 참조하세요.

### 다중 Task 조정 v1

하나의 상위 요청을 `Execution Plan`으로 등록하면 manager-1이 상위 완료 계약과 의존 Task들을 제안합니다. Runtime은 구조를 검사하고 한 번에 하나의 Task를 기존 Worker/Manager 순환으로 실행합니다. 전체 Task가 끝나도 Manager Final Review의 COMPLETE 승인 전에는 Plan을 완료하지 않습니다.

```sh
python3 -m nidus --vault "$vault" plan-submit "선택 자료를 조사하고 짧은 보고서를 작성한다" --source notes.md --model-policy docs/policies/workflow-live-copilot.json
python3 -m nidus --vault "$vault" plan-run PLAN_ID
python3 -m nidus --vault "$vault" plan-show PLAN_ID
# attention의 정확한 전송 범위를 검토한 뒤 승인
python3 -m nidus --vault "$vault" plan-decide PLAN_ID approve
python3 -m nidus --vault "$vault" plan-run PLAN_ID
# current_task의 Worker/Manager 전송은 기존 decide로 각각 승인
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" plan-run PLAN_ID
python3 -m nidus --vault "$vault" plan-list --archive
```

각 `plan-run`은 계획 호출, 선택된 Task의 기존 실행 단계, 또는 전체 검토 한 단계만 처리합니다. 반복은 사용자가 명시적으로 재개합니다. Planning은 `--model-policy`, Worker는 `--worker-policy`, Task 검토는 `--review-policy`, Final/Adjustment는 `--final-policy`로 분리할 수 있으며 생략한 정책은 Planning 정책을 따릅니다. 기본 한도는 초기 10 / 전체 20 Task / 변경 5회입니다. `--initial-tasks`, `--total-tasks`, `--revisions`로 지정합니다.

Plan이 task_quality 대기라면 먼저 해당 Task의 기존 `quality-decide`를 해결하고 `plan-decide PLAN_ID resume --note "해결 근거"`로 재개합니다. 전체 목표의 ESCALATE도 `resume --note` 또는 `cancel --note`로 처리합니다. 사람 판단으로 전체 목표의 COMPLETE 검토를 생략하지 않습니다.

Manager 변경 제안은 추가·미시작 취소·미시작 내용 수정·의존성 추가·제거를 지원합니다. 이미 한 번이라도 실행된 Task와 완료 이력은 변경할 수 없습니다. cancelled/blocked/waiting dependency는 완료로 취급하지 않습니다. 후속 Task는 선택 원본 또는 직접 dependency의 승인 출력만 source로 사용할 수 있습니다. 승인 출력이 변조되면 실행을 차단하므로 승인된 Git 버전을 복원하거나 새 Plan으로 재검토합니다.

실제 합성 검증은 저장소 루트에서 `PYTHONPATH=. python3 scripts/plan_live.py --allow-synthetic-transmission --policy docs/policies/workflow-live-copilot.json --evidence /tmp/new-plan-evidence.json`으로 실행합니다. 필요한 키는 정책의 환경 변수에 준비합니다. 선택적인 `--credential-env-file PATH`는 NIDUS_*_API_KEY 할당만 메모리에 읽습니다. 증거 파일은 덮어쓰지 않고 품질 판단을 자동 승인하지 않습니다. [설계](DESIGN.md), [검증](docs/VALIDATION.md)을 참고하세요.

### 관리자 업무 순환 사용

새 `--mode generative` Task는 Manager workflow가 기본입니다. `--contract PATH`로 명시 계약 JSON을 지정하거나 기본 계약을 사용할 수 있습니다. `--manager-policy PATH`로 검토 모델을 분리하고 `--max-reworks 2`로 반복 한도를 정합니다. 계약의 필수 필드는 [설계](DESIGN.md)와 `nidus/workflow.py`의 기본 계약을 참고하세요. 기존 단일 모델 브리핑은 `--workflow legacy`, 오프라인 추출은 기존 명령으로 사용할 수 있습니다.

Worker 전송과 Manager 검토 전송의 attention을 각각 확인하고 승인합니다. REWORK 후에는 다음 run으로 재개하고 새 Prompt를 승인합니다. ESCALATE 또는 반복 한도에서는 품질 안건을 확인한 뒤 다음 중 하나를 실행하세요. 품질 승인은 전송 권한을 대신하지 않습니다.

```sh
python3 -m nidus --vault "$vault" quality-decide TASK_ID approve --note "검토한 현재 결과를 수용한다"
python3 -m nidus --vault "$vault" quality-decide TASK_ID rework --note "필수 조건 누락" --instruction "누락된 조건을 보완한다"
python3 -m nidus --vault "$vault" quality-decide TASK_ID cancel --note "작업 취소"
# approve 또는 rework 후 run TASK_ID
```

현재 전체 업무 순환의 실제 검증 정책은 `docs/policies/workflow-live-copilot.json`입니다. 기존 Pool의 Gemini 첫 경로는 이번에 400으로 차단됐습니다. 과거 Provider 성공과 현재 모델 가용성은 구분합니다.

```sh
python3 scripts/workflow_live.py --allow-synthetic-transmission --policy docs/policies/workflow-live-copilot.json --evidence /tmp/nidus-workflow-new.json
```

이 명시적 합성 harness는 고정 공개 자료만 전송 승인하며 인간 품질 판단은 자동 승인하지 않습니다. 비용이 발생할 수 있으며 기존 evidence 경로는 덮어쓰지 않습니다.

로컬 Vault에서 요청, 작업 계약, 권한 승인, 실행, 검증과 보관을 연결하는 CLI Runtime입니다.
기본 오프라인 모드는 결정적인 문서 브리핑입니다. 새 생성형 작업은 관리자 계약 → 작업자 수행·자기 점검 → 결정적 검증 → 관리자 검토 → 승인/재작업/사람 판단을 따릅니다.
GitHub Copilot, Gemini, NVIDIA NIM의 생성 결과가 Completed → Archive까지 검증됐습니다.

### 1. 준비와 빠른 체험

macOS/Linux, Python 3.9 이상, Git이 필요합니다. 저장소 루트에서 실행하세요.
오프라인 사용에는 추가 Python 패키지나 API Key가 필요하지 않습니다.

```sh
python3 scripts/demo.py
```

데모는 별도 임시 Vault를 만들고 재시작·승인·보관 흐름을 실행합니다. 출력된 경로에서 결과와 로컬 Git 이력을 확인할 수 있습니다.

### 2. 직접 문서 작업하기

다음 예시는 `/tmp/nidus-example-vault`가 새 디렉터리라고 가정합니다. 원문 경로는 Vault 기준이며, `.md`/`.txt` UTF-8 파일을 사용합니다.

```sh
vault="/tmp/nidus-example-vault"
python3 -m nidus --vault "$vault" init
cat > "$vault/notes.md" <<'EOF'
Nidus stores task state in a local vault.
A task completes only after verification passes.
Existing output files require human approval before replacement.
EOF
python3 -m nidus --vault "$vault" submit "Create an evidence briefing" --source notes.md --output results/brief.md
# Replace TASK_ID with the id returned by submit.
python3 -m nidus --vault "$vault" run TASK_ID
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" list --archive
```

`--source`는 여러 번 지정할 수 있습니다. `--priority`는 `do-now`, `schedule`, `quick-task`, `later` 중 선택하며 기본값은 `do-now`입니다.
브리핑에는 요청, 원문 경로·해시와 각 원문의 비어 있지 않은 첫 세 줄이 포함됩니다. 기본 모드는 의미적 요약을 수행하지 않습니다.

### 3. 실제 모델 사용하기

기존 OpenAI-compatible route policy를 사용할 때는 호환 endpoint를 직접 지정할 수 있습니다. OmniRoute도 같은 호환 경로로 선택해 쓸 수 있지만 필수 구성요소는 아닙니다. 아래는 과거 검증 환경에서 사용한 optional OmniRoute 실행 예입니다. 설치 프로그램은 저장소에 포함되지 않습니다.

```sh
omniroute --version
OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray
# Stop only when you want to shut down the router.
# omniroute stop
```

대시보드: http://127.0.0.1:20128 . `model-policy.pool.example.json`은 기존 Chat Completions 경로의 예이며 Native Gemini Connection과는 별개입니다.
현재 호스트에는 모델 세 개와 기존 연결 세 개로 제한한 키가 저장소 밖 권한 600 파일에 준비되어 있습니다.
다른 호스트에서는 직접 발급한 키를 `NIDUS_POOL_API_KEY` 환경변수로 제공하세요. Nidus는 `.env`를 자동으로 읽지 않습니다.
앞 절의 `vault`와 `notes.md`를 사용하고, 아래 `TASK_ID`는 이번 submit이 반환한 새 ID로 교체하세요.

```sh
# This file is provisioned on the validated local host, not shipped in Git.
set -a
. "$HOME/.config/nidus/provider-pool.env"
set +a
python3 -m nidus --vault "$vault" submit "Summarize the facts in three bullet points; include Nidus" --source notes.md --output results/summary.md --mode generative --model-policy docs/policies/workflow-live-copilot.json --require Nidus
python3 -m nidus --vault "$vault" run TASK_ID
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" run TASK_ID
# Review the new Manager transmission attention before approving.
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" run TASK_ID
# If REWORK queues a revision, run again and review each new transmission.
unset NIDUS_POOL_API_KEY
```

첫 run은 `Waiting`에서 멈춥니다. `show`의 attention에서 전송 원문·해시, Prompt 크기·해시, Endpoint와 전체 Route 정책을 검토한 뒤 승인하세요.
기존 출력 파일이 있으면 덮어쓰기 승인을 먼저 받으므로, 각 결정 후 run하고 추가 attention이 있는지 확인하세요.
선택한 원문 전체와 요청·계약이 전송됩니다. Manager 검토에는 결과·자기 점검·실행 정보도 포함되며 별도 전송 승인을 받습니다. 로컬 Router도 외부 Provider로 전달할 수 있습니다.
키를 원문·Task·정책·Vault·Git에 넣지 마세요. 알려진 키 문자열 차단은 일반적인 민감정보 탐지 기능이 아닙니다.

| 정책 | 용도 |
|---|---|
| `model-policy.pool.example.json` | 과거 검증된 세 모델의 순차 Pool; 현재 가용성은 VALIDATION 참조; `NIDUS_POOL_API_KEY` 사용 |
| `model-policy.copilot.example.json` | Copilot 단독; `NIDUS_MODEL_API_KEY` 사용 |
| `model-policy.example.json` | 기본 `nidus-free` Combo 예시; 실제 Combo를 구성해야 사용 가능 |
| `docs/policies/model-active-*.json` | 단독 Live 검증 당시 정책; 임시 `NIDUS_VALIDATION_API_KEY`는 삭제됨 |

Pool은 무료 사용을 보장하지 않아 `kind=paid`, `allow_paid=true`를 명시합니다. 계정별 quota·청구는 Provider에서 확인하세요.
요율 미설정 시 비용은 `null`입니다. 새 결제 설정이나 무조건적인 유료 fallback을 활성화하지 않습니다.
정책은 submit 시 Task에 복사되므로 예시 JSON을 나중에 바꿔도 기존 Task 정책이 자동으로 바뀌지 않습니다.

### 4. 상태 확인과 재개

| 상태 | 다음 행동 |
|---|---|
| Queued / Running | `run TASK_ID`로 실행 또는 복구 |
| Waiting | 권한/전송은 `decide approve/reject`, 품질 안건은 `quality-decide approve/rework/cancel`; 결정 후 run |
| Verifying | 저장된 후보 검증과 미완료 Manager 검토 재개; 승인된 검토는 모델 재호출 없음 |
| Blocked | show의 error/model_error/history 확인, 원인 해결 후 명시적으로 run |
| Completed / Cancelled | 종료 상태; run으로 자동 변경되지 않음 |

`run TASK_ID --execute-only`는 결과 저장 후 Verifying에서 멈춥니다. `list`는 활성 작업, `list --archive`는 완료 기록을 조회합니다.
Blocked 조회/실행 및 CLI 오류는 종료 코드 2, Waiting은 0입니다. 원문·출력 변경으로 기존 승인이 무효가 될 수 있습니다.

Vault 상태는 `.nidus/state.sqlite3`, 원문과 결과는 `.nidus/` 밖에 있습니다. 한 Vault에는 한 Worker만 실행됩니다.
관련 파일만 로컬 Git 커밋하며 승인된 교체 전 버전도 보존합니다. 실행 중인 Vault를 복사하지 마세요.
경로 탈출·숨김 경로·심볼릭 링크·원문 덮어쓰기는 거부합니다. 임의 Shell/Tool 실행과 적대적 프로세스에 대한 OS 격리는 제공하지 않습니다.

### 5. 테스트와 문서

```sh
python3 -m unittest discover -s tests -q
python3 tests/integration/model_http.py -v
python3 tests/integration/plan_http.py -v
node tests/gui_frontend.js
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

현재 회귀 기준은 기존 오프라인 104개 + GUI 15개 = 119개와 기존 로컬 HTTP/CLI 7개입니다. GUI 15개 중 서버/HTTP 테스트도 루프백 소켓 권한이 필요하며 외부 모델은 사용하지 않습니다. Node는 Frontend 검증용으로만 사용하며 GUI 실행에는 필요하지 않습니다.
실제 합성 Live 테스트는 키를 환경에 넣은 상태에서 별도로 실행하며 사용량이 발생할 수 있습니다. 새 evidence 경로를 사용하세요.

```sh
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.pool.example.json --evidence /tmp/nidus-live-new.json
```

| 문서 | 읽는 목적 |
|---|---|
| [PRD](PRD.md) | 제품 범위, 요구사항, 완료 기준 |
| [DESIGN](DESIGN.md) | 현재 구현, 상태·보안·복구 경계 |
| [개념 설계](docs/CONCEPT.md) | 장기 구조와 아직 구현하지 않은 책임 |
| [검증 보고서](docs/VALIDATION.md) | Provider 결과, 비용·제한, 실행 증거와 과거 실패 |
| [현재 계획](docs/plans/current-plan.md) | 최신 완료 상태와 개발 이력 |

각 문서는 한 파일 안에 한국어와 영어를 포함합니다. 원시 Live JSON은 [docs/evidence](docs/evidence)에 보존합니다.

### 개발 흐름

사용자의 현재 지시에 따라 Git Flow를 사용합니다. `main`은 안정 버전, `develop`은 기능 통합 브랜치입니다. `develop`에서 `feature/*`를 만들고 기능 단위로 구현·검증·커밋한 뒤 `develop`에 병합합니다. 원격 push/PR/릴리스의 main 통합은 해당 작업 범위에 따라 별도로 수행합니다.

```sh
git switch develop
git switch -c feature/short-description
# 기능 구현·검증·커밋 후 develop에 병합
```

## English

### Local GUI v1

Run `python3 -m nidus --vault "$vault" gui`, then open `http://127.0.0.1:8765`. Use `gui --port 8766` for another port; Ctrl-C stops the server. No dependencies, frontend build or CDN are required.

Create a Plan with a request, vault-relative .md/.txt sources (one per line) and non-secret planning policy JSON. Optional role policies inherit the CLI defaults; task/revision limits are 10/20/5. Observe the Dashboard, explicitly run one bounded step, review exact scopes in Human Attention, decide, then run the next step. Permission and Quality actions use separate Runtime methods. Resolve Task quality first, then resume its Plan with a reason. Completed archives and workspace metadata are read-only; AI connections can be managed in Settings. Refresh to observe changes from another CLI/browser; stale mutations are rejected under the Runtime lock. The GUI adds no autonomous scheduler. See [GUI report](docs/GUI_REPORT.md).

### Multi-task orchestration v1

`plan-submit` registers an upper goal and selected sources; manager-1 proposes its contract and dependent Tasks. `plan-run` advances one bounded step through the existing Task runtime. Inspect `plan-show`, approve each exact Plan transmission with `plan-decide approve`, and each Task transmission with the existing `decide`. Final COMPLETE is required before Plan Archive. Worker, Task Review and Final/Adjustment routes can be selected independently with --worker-policy, --review-policy and --final-policy.

Five validated change operations support additions, never-started cancellation/modification, and dependency additions/removals. Completed and started history is protected. Approved predecessor content/hash/review references are frozen; changed artifacts block downstream execution. Default limits are 10 initial / 20 total Tasks / 5 revisions. Task quality escalation uses quality-decide first, then Plan resume with an explicit note. Plan escalation supports resume/cancel, not a forced completion override. See [design](DESIGN.md) and [live validation](docs/VALIDATION.md).

### Using the Manager workflow

New --mode generative tasks default to Manager workflow. Supply --contract PATH for an explicit contract or use the default; --manager-policy PATH selects separate review routes; --max-reworks 2 bounds revisions. See DESIGN and the default contract in nidus/workflow.py for required fields. --workflow legacy preserves single-generation compatibility; offline extraction retains its existing commands.

Inspect/approve Worker and Manager transmission agendas separately. REWORK resumes on the next run with a new exact prompt approval. ESCALATE/limits require an explicit quality decision, separate from permissions:

```sh
python3 -m nidus --vault "$vault" quality-decide TASK_ID approve --note "Accept the reviewed current result"
python3 -m nidus --vault "$vault" quality-decide TASK_ID rework --note "Missing requirement" --instruction "Include the missing requirement"
python3 -m nidus --vault "$vault" quality-decide TASK_ID cancel --note "Cancel this task"
# Run TASK_ID after approve/rework.
```

The current end-to-end verified policy is docs/policies/workflow-live-copilot.json. The historical pool's first Gemini route returned 400 in this run. Historical provider success does not guarantee current availability.

```sh
python3 scripts/workflow_live.py --allow-synthetic-transmission --policy docs/policies/workflow-live-copilot.json --evidence /tmp/nidus-workflow-new.json
```

This explicit harness approves only fixed public synthetic transmissions, never human quality judgments. Usage may incur cost; existing evidence cannot be overwritten.

A CLI runtime connecting requests, completion contracts, permissions, execution, verification and archive in a local vault.
Offline mode creates deterministic evidence briefings. New generative tasks follow Manager contract → Worker execution/self-check → deterministic checks → Manager approval/rework/human escalation.
GitHub Copilot, Gemini and NVIDIA NIM have completed verified model-backed tasks through Completed → Archive.

### 1. Requirements and quick start

Use macOS/Linux, Python 3.9+ and Git. Run commands from the repository root.
Offline use requires no additional Python packages or API keys.

```sh
python3 scripts/demo.py
```

The demo creates an isolated temporary vault and exercises restart, approval and archive. Inspect results and local Git history at the printed path.

### 2. Run a document task

This example assumes `/tmp/nidus-example-vault` is new. Source paths are relative to the vault; use UTF-8 `.md`/`.txt` files.

```sh
vault="/tmp/nidus-example-vault"
python3 -m nidus --vault "$vault" init
cat > "$vault/notes.md" <<'EOF'
Nidus stores task state in a local vault.
A task completes only after verification passes.
Existing output files require human approval before replacement.
EOF
python3 -m nidus --vault "$vault" submit "Create an evidence briefing" --source notes.md --output results/brief.md
# Replace TASK_ID with the id returned by submit.
python3 -m nidus --vault "$vault" run TASK_ID
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" list --archive
```

Repeat `--source` for multiple documents. `--priority` accepts `do-now`, `schedule`, `quick-task` or `later`; the default is `do-now`.
The briefing includes the request, source paths/hashes and the first three nonempty lines of each source. Default mode does not perform semantic summarization.

### 3. Use a real model

For an existing OpenAI-compatible route policy, configure a compatible endpoint directly. OmniRoute can still be used through this optional compatibility path; it is not required. The following is an example from the historical validation host (OmniRoute 3.8.51 / Node 24.21.0); its installer is not bundled here.

```sh
omniroute --version
OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray
# Stop only when you want to shut down the router.
# omniroute stop
```

Dashboard: http://127.0.0.1:20128 . `model-policy.pool.example.json` shows existing Chat Completions routes and is separate from the native Gemini Connection setting.
The validated host has a mode-600 credential file outside the repository, limited to three models and three existing connections.
Elsewhere, supply your own endpoint key through `NIDUS_POOL_API_KEY`. Nidus does not automatically load `.env` files.
Use `vault` and `notes.md` from the previous section; replace `TASK_ID` below with the new ID returned by this submission.

```sh
# This file is provisioned on the validated local host, not shipped in Git.
set -a
. "$HOME/.config/nidus/provider-pool.env"
set +a
python3 -m nidus --vault "$vault" submit "Summarize the facts in three bullet points; include Nidus" --source notes.md --output results/summary.md --mode generative --model-policy docs/policies/workflow-live-copilot.json --require Nidus
python3 -m nidus --vault "$vault" run TASK_ID
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" run TASK_ID
# Review the new Manager transmission attention before approving.
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" run TASK_ID
# If REWORK queues a revision, run again and review each new transmission.
unset NIDUS_POOL_API_KEY
```

The first run stops at `Waiting`. Inspect attention in show: transmitted sources/hashes, prompt size/hash, endpoints and the complete route policy, then approve.
If the destination exists, overwrite approval comes first; run after each decision and check for further attention requests.
The full selected source text and request are transmitted. A local router can forward them to external providers.
Keep keys out of sources, tasks, policies, vaults and Git. Known-key string rejection is not general sensitive-data detection.

| Policy | Purpose |
|---|---|
| `model-policy.pool.example.json` | Ordered pool of three live-verified models; uses `NIDUS_POOL_API_KEY` |
| `model-policy.copilot.example.json` | Copilot only; uses `NIDUS_MODEL_API_KEY` |
| `model-policy.example.json` | Default `nidus-free` combo example; requires actual combo setup |
| `docs/policies/model-active-*.json` | Historical standalone live policies; temporary `NIDUS_VALIDATION_API_KEY` was deleted |

The pool explicitly uses `kind=paid`, `allow_paid=true` because free usage is not guaranteed. Check account quota/billing with the provider.
Costs remain `null` without configured rates. No new billing settings or unconditional paid fallback are enabled.
Policy is copied into the task at submission; later edits to the example JSON do not automatically change existing tasks.

### 4. Inspect and resume

| State | Next action |
|---|---|
| Queued / Running | Execute or recover with `run TASK_ID` |
| Waiting | Permissions: decide approve/reject; quality agendas: quality-decide approve/rework/cancel; then run |
| Verifying | Resume candidate checks and pending Manager review; already-approved reviews need no model recall |
| Blocked | Inspect error/model_error/history, fix the cause, explicitly run again |
| Completed / Cancelled | Terminal; run does not change them automatically |

`run TASK_ID --execute-only` stops at Verifying after writing. `list` shows active tasks; `list --archive` shows completion records.
Blocked inspection/execution and CLI errors exit 2; Waiting exits 0. Source/output changes can invalidate prior approval.

Vault state lives in `.nidus/state.sqlite3`; sources/results remain outside `.nidus/`. Only one worker mutates a vault at a time.
Only relevant files receive local Git commits; approved replacement preimages are retained. Do not copy a running vault.
Traversal, hidden paths, symlinks and source overwrite are denied. Arbitrary shell/tools and OS isolation from hostile processes are not provided.

### 5. Tests and documentation

```sh
python3 -m unittest discover -s tests -q
python3 tests/integration/model_http.py -v
python3 tests/integration/plan_http.py -v
node tests/gui_frontend.js
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

The current regression baseline is 119 discovery tests (104 existing + 15 GUI) and 7 existing local HTTP/CLI tests. GUI server/HTTP tests require loopback permission; no external model calls occur. Node is used only for six frontend checks and is not a GUI runtime dependency.
Synthetic live acceptance is separate, requires the key in the environment and can consume model usage. Choose a new evidence path.

```sh
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.pool.example.json --evidence /tmp/nidus-live-new.json
```

| Document | Purpose |
|---|---|
| [PRD](PRD.md) | Product scope, requirements and acceptance criteria |
| [DESIGN](DESIGN.md) | Current implementation, state, security and recovery |
| [Concept](docs/CONCEPT.md) | Long-term structure and unimplemented responsibilities |
| [Validation](docs/VALIDATION.md) | Provider results, costs/limits, evidence and historical failures |
| [Current plan](docs/plans/current-plan.md) | Latest completion state and development history |

Each document contains both Korean and English. Raw live JSON remains in [docs/evidence](docs/evidence).

### Development workflow

Follow the current user-requested Git Flow: main holds stable releases; develop integrates features. Branch feature/* from develop, implement/validate/commit each feature, then merge into develop. Remote push/PR and release integration into main depend on the scope of each task.

```sh
git switch develop
git switch -c feature/short-description
# Implement, validate, commit, then merge into develop.
```
