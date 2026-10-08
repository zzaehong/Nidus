# 기술 설계 / Technical design

[한국어](#한국어) · [English](#english)

## 한국어

### 실행 단위와 상태 소유권

한 동기식 Python CLI 프로세스가 선택한 Vault를 운영한다. 지속적인 `worker-1`은 Operations/document analyst이며 Home 정체성에 모델을 배치하지 않는다.
Runtime은 Inbox·Board·Desk·Security·Meeting Room·Workshop·검증을 조정한다. SQLite `.nidus/state.sqlite3`가 요청·계약·Board·Home 포인터·Desk Native Notes/참조 Checkpoint·결정·감사 이력을 소유한다.
Library는 `.nidus/` 밖의 일반 사용자 파일이며 Workshop은 결과 하나를 쓴다. Archive는 Completed 행을 별도 조회하는 논리적 보관으로, 사실을 복사하거나 삭제하지 않는다.

변이는 프로세스 flock으로 보호하고 DB 열기 시 Schema 버전을 확인한다. Home에는 기기 경로와 Secret을 넣지 않는다.
Vault Git은 필수이며 없으면 초기화한다. 각 변이는 상태·Runtime ignore·선택된 원문/출력만 stage하여 로컬 커밋한다. 승인된 교체 전 파일은 먼저 커밋한다.
Lock/journal은 ignore하고 무관한 사용자 staged 파일은 보존한다. 로컬 체크포인트는 hooks/commit signing을 끄며 Remote를 건드리지 않는다.

### 인터페이스와 상태 전이

`python3 -m nidus --vault PATH` 아래 `init`, `submit`, `run`, `decide`, `show`, `list`를 제공한다.

```text
Queued → Running → Verifying → Completed → Archive query
Running → Waiting → Queued (approve) / Cancelled (reject)
Error → Blocked → explicit run to retry
```

Waiting은 덮어쓰기 또는 모델 전송 판단을 기다린다. 저장된 Running은 실행을, Verifying은 검증을 복구한다.
`run --execute-only`는 결과 저장 후 검증 전에 체크포인트를 남긴다. 완료/취소는 재실행하지 않는다.
모든 Task 전이는 DB에 트랜잭션으로 보존하지만 DB·파일시스템·Git 사이에 단일 트랜잭션은 없다.

### Context Recovery와 파일 권한

Home → 마지막 Desk → 최신 Board → 선택 Library → Desk Update 순서다. Board가 오래된 Task 참조보다 우선한다.
Desk Native Notes와 Checkpoint History는 유지하고 Next Action은 오래된 Desk 지시가 아닌 최신 Board 상태에서 복구한다. 종료 시 Home의 Task 포인터를 비운다.

모든 읽기/쓰기 전 절대·`..`·심볼릭 링크·숨김 요소·비일반 파일·지원하지 않는 확장자·원문 덮어쓰기를 거부한다.
기존 출력 교체는 원문/출력 해시 Snapshot 승인으로만 가능하며 승인이 허용 경로를 확대하지 않는다. 쓰기 직전 재검사하고 새 파일은 exclusive create, 교체는 atomic rename을 사용한다.
파일 쓰기와 DB commit 사이 실패는 계약의 write intent로 재조정한다. 검증은 원문 해시와 독립적인 예상 결과 바이트를 확인한다.
손상된 DB/Schema는 fail closed한다. Git 체크포인트 실패는 Task를 Blocked로 두고 Completion Result를 제거한다. 명시적 재시도로 write intent/commit을 복구할 수 있다.
적대적인 외부 프로세스의 경로 경쟁은 현재 협력적인 로컬 보안 모델 밖이다.

### Model Gateway

`Gateway.generate` 뒤의 교체 가능한 표준 라이브러리 urllib Chat Completions Adapter를 사용한다. Direct API·OmniRoute·호환 Local 서버를 같은 정책으로 연결한다.
Task JSON에 mode, 비밀 없는 정책, 필수 문구, 전송 Snapshot, 보존 응답과 시도 Metadata를 추가했으며 DB Schema 변경은 없다.
정책은 최대 5개 순서 있는 Route, 1–60초 socket timeout, 1–4096 출력 토큰을 허용한다. Prompt는 128 KiB, 응답은 2 MiB로 제한한다.
각 Route는 name/kind/provider/base_url/model과 선택적 credential 환경변수명·입출력 요율을 가진다. Free는 운영자 분류이며 청구 보장이 아니다. Paid에는 `allow_paid=true`가 필요하다.

Remote는 HTTPS만 허용하고 HTTP는 문자 그대로의 localhost/127.0.0.1/::1에만 허용한다. URL Credential·query·fragment, redirect와 ambient proxy 상속은 금지한다.
키는 전송 시 명명된 환경변수에서 헤더로 전달하며 정책/Prompt/Task에 넣지 않는다. 정책·요청·응답의 알려진 키 문자열을 차단하고 오류 본문은 폐기한다.
Secret Store 탐색이나 무관한 Credential 재사용은 하지 않는다. 신뢰된 Endpoint와 로컬 Router도 외부 전송 가능성을 포함해 승인을 받는다.

전송 Snapshot은 요청·원문 경로/해시·전체 Prompt 해시/크기·요율/Paid 허용을 포함한 정책을 묶는다. 입력/정책 변경은 재승인을 요구한다.
먼저 출력 교체를 승인받고, 선택 원문 전체와 요청·필수 문구만 보낸다. Home/Desk/DB/전체 Vault는 보내지 않는다.
원문은 신뢰할 수 없는 데이터로 취급하며 모델 출력은 실행되지 않는 텍스트다. 일반 DLP나 의미 검증 시스템은 없다.

### 검증·오류·복구·관측

응답을 파일 쓰기 전에 보존한다. 생성형 검증은 비어 있지 않음·정상 종료·필수 문구·원문 Snapshot·보존 응답과 출처를 포함한 정확한 결과 바이트를 확인한다.
Verifying은 모델을 다시 부르지 않는다. 전송 이후 원문이 바뀌면 쓰기를 차단하고 다음 run에서 재승인한다.
원격 성공 직후 응답 저장 전 crash는 명시적 재시도 시 중복 호출/비용을 유발할 수 있다. exactly-once 실행과 전체 wall-clock deadline은 보장하지 않는다.

| 실패 | 코드/정책 |
|---|---|
| 401 / 403 | authentication_failed / access_denied; Fallback 없이 차단 |
| 402 / 429 | quota_exhausted / rate_limited; 승인된 다음 Route 허용 |
| 408 / 504 | timeout; 승인된 다음 Route 허용 |
| 5xx | provider_unavailable; 승인된 다음 Route 허용 |
| Network / socket timeout | network_failure / timeout; 승인된 다음 Route 허용 |
| 400 / 404, redirect, invalid/truncated response, acceptance/Secret/policy 실패 | 재시도 불가; 후속 경로 없이 차단 |

Route당 한 번만 시도하고 무한 재시도는 없다. 시작/종료 UTC 시각·Task·Route·Provider·요청/실제 모델·Prompt/원문 해시·성패·오류·토큰·알려진 비용을 감사한다.
모르는 값은 null, 설정된 0 요율은 정책 추정치이며 청구 영수증이 아니다. 성공한 명시적 재시도는 이전 model_error를 지운다.

### 검증 환경과 선택 근거

SQLite는 외부 의존성 없이 트랜잭션/정렬된 감사를 제공한다. CLI와 동기 실행은 GUI/Queue/daemon 없이 복구 가능한 작은 Slice를 만든다.
제한된 파일 작업만 제공하므로 현재 Docker 설치는 필수가 아니다. 향후 코드/Shell Tool 추가 전 격리를 재검토해야 한다.
실제 설치된 OmniRoute는 교체 가능한 실행 수단이며 설치·Provider 선택 이력은 [검증 보고서](docs/VALIDATION.md)에 통합했다.
`scripts/model_fallback_live.py`는 Credential 없는 별도 Loopback fixture로 503/401을 주입하고 나머지 경로만 실제 호출한다. 이는 실제 Provider 장애를 재현했다는 주장이 아니다.
Live harness는 기존 evidence 경로를 덮어쓰지 않는다. 개발 검증 명령은 [README](README.md), 책임 개념은 [CONCEPT](docs/CONCEPT.md)를 참조한다.

## English

### Execution units and state ownership

One synchronous Python CLI process operates a selected vault. Persistent `worker-1` is an Operations/document analyst; its Home identity contains no model assignment.
Runtime coordinates Inbox, Board, Desk, Security, Meeting Room, Workshop and verification. SQLite `.nidus/state.sqlite3` owns requests, contracts, Board, Home pointers, Desk native notes/reference checkpoints, decisions and audit history.
Library consists of ordinary user files outside `.nidus/`; Workshop writes one result. Archive is a separate query of retained Completed rows, not copied/deleted task truth.

A process flock protects mutations; opening the database checks schema version. Home contains no machine paths or secrets.
Vault Git is mandatory and initialized if absent. Each mutation stages only state, runtime ignore and selected sources/output for a local commit. Approved replacement preimages are committed first.
Ignore locks/journals and preserve unrelated staged user files. Disable hooks/commit signing for local checkpoints; never touch remotes.

### Interfaces and state transitions

`python3 -m nidus --vault PATH` provides `init`, `submit`, `run`, `decide`, `show` and `list`.

```text
Queued → Running → Verifying → Completed → Archive query
Running → Waiting → Queued (approve) / Cancelled (reject)
Error → Blocked → explicit run to retry
```

Waiting requests overwrite or model-transmission decisions. Persisted Running recovers execution; Verifying recovers verification.
`run --execute-only` checkpoints after writing and before verification. Completed/cancelled tasks are not rerun.
Task transitions persist transactionally in SQLite, but DB/filesystem/Git do not share one transaction.

### Context recovery and file permission

Recover Home → last Desk → current Board → selected Library → Desk update. Board overrides stale task references.
Retain native notes/checkpoint history; recover the next action from current Board state rather than stale Desk instructions. Clear Home's task pointer at terminal completion.

Before each read/write, reject absolute/`..`/symlink/hidden paths, nonregular files, unsupported suffixes and source overwrite.
Replacing an output requires source/output-hash snapshot approval; approval cannot expand permitted paths. Recheck before writing; use exclusive creation for new files and atomic rename for replacements.
Reconcile failure between file write and DB commit through the contract's write intent. Verify source hashes and independently expected result bytes.
Corrupt DB/schema fails closed. Git checkpoint failure blocks the task and removes its completion result. Explicit retry can reconcile write intent/commit.
Hostile external processes racing path changes are outside this cooperative local security model.

### Model Gateway

A replaceable stdlib urllib Chat Completions adapter sits behind `Gateway.generate`. Direct APIs, OmniRoute and compatible local servers share the policy interface.
Task JSON adds mode, nonsecret policy, literal phrases, transmission snapshot, retained generation and attempt metadata without a database schema migration.
Policy permits at most 5 ordered routes, 1–60-second socket timeouts and 1–4096 output tokens. Limit prompt to 128 KiB and response to 2 MiB.
Routes contain name/kind/provider/base_url/model plus optional credential environment name and input/output rates. Free is an operator classification, not a billing guarantee. Paid requires `allow_paid=true`.

Require remote HTTPS; allow HTTP only for literal localhost/127.0.0.1/::1. Reject URL credentials/query/fragment, redirects and ambient proxy inheritance.
Resolve keys from named environment variables into headers at transport, never into policies/prompts/tasks. Reject known-key strings in policies/requests/responses; discard error bodies.
Do not scan Secret Stores or reuse unrelated credentials. Trusted endpoints and local routers still require approval covering potential external transmission.

The transmission snapshot binds request, source paths/hashes, complete prompt hash/size and full policy including rates/paid opt-in. Input/policy changes require reapproval.
Approve output replacement first; send only full selected sources, request and required phrases. Do not send Home/Desk/DB/whole vault.
Treat source text as untrusted data; model output is inert text. General DLP and semantic verification are not implemented.

### Verification, errors, recovery and observability

Retain the response before writing. Generative verification checks nonempty content, normal finish, literal phrases, source snapshot and exact result bytes including retained response/provenance.
Verifying never recalls the model. Source changes after transmission block writes and require reapproval on the next run.
A crash after remote success but before response persistence can cause duplicate calls/costs on explicit retry. Exactly-once execution and a total wall-clock deadline are not guaranteed.

| Failure | Code/policy |
|---|---|
| 401 / 403 | authentication_failed / access_denied; block without fallback |
| 402 / 429 | quota_exhausted / rate_limited; permit next approved route |
| 408 / 504 | timeout; permit next approved route |
| 5xx | provider_unavailable; permit next approved route |
| Network / socket timeout | network_failure / timeout; permit next approved route |
| 400 / 404, redirects, invalid/truncated response, acceptance/Secret/policy failure | Nonretryable; stop without downstream routes |

Attempt each route once; no infinite retry. Audit UTC start/end, task, route, provider, requested/actual model, prompt/source hashes, outcome, error, tokens and known costs.
Unknown values remain null; configured zero rates are policy estimates, not billing receipts. Successful explicit retry clears the prior model_error.

### Verification environment and decisions

SQLite provides transactions/ordered audits without external dependencies. CLI and synchronous execution create a small recoverable slice without GUI/queue/daemon.
Restricted file operations do not require Docker today. Revisit isolation before introducing code/shell tools.
Installed OmniRoute remains replaceable; installation/provider-selection history is consolidated in [validation](docs/VALIDATION.md).
`scripts/model_fallback_live.py` injects 503/401 through a separate credential-free loopback fixture and calls only non-injected routes for real. It does not establish actual provider outages.
Live harnesses refuse existing evidence paths. See [README](README.md) for checks and [CONCEPT](docs/CONCEPT.md) for conceptual responsibilities.
