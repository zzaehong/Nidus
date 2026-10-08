# Nidus

[한국어](#한국어) · [English](#english)

## 한국어

로컬 Vault에서 요청, 작업 계약, 권한 승인, 실행, 검증과 보관을 연결하는 CLI Runtime입니다.
기본 모드는 결정적인 문서 브리핑이며, 생성형 모드는 선택한 문서를 실제 모델로 처리합니다.
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

OmniRoute를 이미 설치했다면 다음과 같이 시작합니다. 기록된 검증 환경은 OmniRoute 3.8.51 / Node 24.21.0이며 설치 프로그램은 저장소에 포함되지 않습니다.
다른 컴퓨터에서는 OmniRoute 설치·Provider 인증·Endpoint Key 발급을 먼저 마치거나, 다른 Chat Completions 호환 Endpoint를 정책에 지정하세요.

```sh
omniroute --version
OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray
# Stop only when you want to shut down the router.
# omniroute stop
```

대시보드: http://127.0.0.1:20128 . `model-policy.pool.example.json`은 Gemini Flash-Lite → NVIDIA Lightning → Copilot 순서입니다.
현재 호스트에는 모델 세 개와 기존 연결 세 개로 제한한 키가 저장소 밖 권한 600 파일에 준비되어 있습니다.
다른 호스트에서는 직접 발급한 키를 `NIDUS_POOL_API_KEY` 환경변수로 제공하세요. Nidus는 `.env`를 자동으로 읽지 않습니다.
앞 절의 `vault`와 `notes.md`를 사용하고, 아래 `TASK_ID`는 이번 submit이 반환한 새 ID로 교체하세요.

```sh
# This file is provisioned on the validated local host, not shipped in Git.
set -a
. "$HOME/.config/nidus/provider-pool.env"
set +a
python3 -m nidus --vault "$vault" submit "Summarize the facts in three bullet points; include Nidus" --source notes.md --output results/summary.md --mode generative --model-policy model-policy.pool.example.json --require Nidus
python3 -m nidus --vault "$vault" run TASK_ID
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" run TASK_ID
unset NIDUS_POOL_API_KEY
```

첫 run은 `Waiting`에서 멈춥니다. `show`의 attention에서 전송 원문·해시, Prompt 크기·해시, Endpoint와 전체 Route 정책을 검토한 뒤 승인하세요.
기존 출력 파일이 있으면 덮어쓰기 승인을 먼저 받으므로, 각 결정 후 run하고 추가 attention이 있는지 확인하세요.
선택한 원문 전체와 요청이 전송됩니다. 로컬 Router도 외부 Provider로 전달할 수 있습니다.
키를 원문·Task·정책·Vault·Git에 넣지 마세요. 알려진 키 문자열 차단은 일반적인 민감정보 탐지 기능이 아닙니다.

| 정책 | 용도 |
|---|---|
| `model-policy.pool.example.json` | 실제 검증된 세 모델의 순차 Pool; `NIDUS_POOL_API_KEY` 사용 |
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
| Waiting | attention 검토 후 `decide TASK_ID approve` 또는 `reject`; 승인 후 run |
| Verifying | run으로 저장된 결과 검증 재개; 모델 재호출 없음 |
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
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

현재 회귀 기준은 오프라인 37개와 로컬 HTTP 3개입니다. HTTP 테스트는 루프백 소켓 권한이 필요하며 외부 모델은 사용하지 않습니다.
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

## English

A CLI runtime connecting requests, completion contracts, permissions, execution, verification and archive in a local vault.
The default mode creates deterministic evidence briefings; optional generative mode processes selected documents with real models.
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

If OmniRoute is installed, start it as below. The recorded validation host used OmniRoute 3.8.51 / Node 24.21.0; its installer is not bundled here.
On another host, install OmniRoute, authenticate providers and issue an endpoint key first, or configure another Chat Completions-compatible endpoint.

```sh
omniroute --version
OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray
# Stop only when you want to shut down the router.
# omniroute stop
```

Dashboard: http://127.0.0.1:20128 . `model-policy.pool.example.json` orders Gemini Flash-Lite → NVIDIA Lightning → Copilot.
The validated host has a mode-600 credential file outside the repository, limited to three models and three existing connections.
Elsewhere, supply your own endpoint key through `NIDUS_POOL_API_KEY`. Nidus does not automatically load `.env` files.
Use `vault` and `notes.md` from the previous section; replace `TASK_ID` below with the new ID returned by this submission.

```sh
# This file is provisioned on the validated local host, not shipped in Git.
set -a
. "$HOME/.config/nidus/provider-pool.env"
set +a
python3 -m nidus --vault "$vault" submit "Summarize the facts in three bullet points; include Nidus" --source notes.md --output results/summary.md --mode generative --model-policy model-policy.pool.example.json --require Nidus
python3 -m nidus --vault "$vault" run TASK_ID
python3 -m nidus --vault "$vault" show TASK_ID
python3 -m nidus --vault "$vault" decide TASK_ID approve
python3 -m nidus --vault "$vault" run TASK_ID
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
| Waiting | Review attention, `decide TASK_ID approve` or `reject`; run after approval |
| Verifying | Run to resume stored-result verification; no model recall |
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
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

The current regression baseline is 37 offline and 3 local HTTP tests. HTTP tests require loopback socket permission and make no external model calls.
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
