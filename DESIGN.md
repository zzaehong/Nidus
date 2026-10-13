# 기술 설계 / Technical design

[한국어](#한국어) · [English](#english)

## 한국어

### 개발 Vault 경계

`nidus.testing`는 테스트와 합성 데모마다 `/Users/parkjaehong/Developer/nidus_vault` 아래에 별도 임시/영속 Vault를 만든다. `Store`와 GUI 진입점은 Vault가 소스 저장소 또는 그 상위 디렉터리인 경우 거부한다. 테스트 중 남는 Git checkpoint/artifact history는 해당 disposable Vault에 한정된다. 운영 작업공간은 사용자가 명시적으로 소스 밖 경로를 지정한다.

### Provider Connection Foundation 경계 — 2026-10-13

기존 Gateway의 policy 검증·전송 snapshot·fallback·Task/Plan 메시지 생성은 유지했다. `request_bytes`와 `ChatCompletions`를 공통 transport로 재사용하고 `ProviderRegistry`(manifest), `ConnectionRegistry`(health/영속 Catalog), `OpenAICompatibleAdapter`(discovery/synthetic generation)를 추가했다. GUI 연결 API는 업무 Runtime을 생성/실행하지 않는다. Keychain은 `CredentialStore` 경계 내부에만 있으며 DB에는 reference를 저장한다.

연결 상태는 configured/probing/ready/degraded/blocked다. 실제 일반 응답과 JSON 검증 전 ready를 허용하지 않는다. 기존 env policy 경로와 새 연결 경로는 공존하며 Route Broker는 미구현이다. 상세 책임·보안·discovery 실패 규칙·Catalog와 제약은 [CONNECTIONS](docs/CONNECTIONS.md)에 기술했다.

### Local GUI / Application 경계

```text
Browser (default-light HTML/CSS/JS)
  → loopback GUIServer / structured HTTP API
  → Application projection / thin commands
  → PlanRuntime / Runtime
  → Store / Security / Gateway / Git
```

`nidus/gui.py`의 표준 라이브러리 HTTPServer는 단일 요청을 동기 처리하며 127.0.0.1에만 bind한다. 모델 실행 중 HTTP 요청을 유지하며 Frontend는 실행 중 상태로 중복 버튼을 잠근다. 별도 scheduler·Thread worker·자동 plan-run loop는 없다. 요청별 Store/SQLite connection을 열고 닫으며 업무 상태를 직접 쓰지 않는다. CLI와 GUI는 동일한 Runtime 메서드를 호출한다. `Application`은 Store를 읽어 상태·진행도·attention·allowed_actions를 투영하고 Plan 생성·실행·판단을 위임한다. task ready는 PlanRuntime.board/ready의 값이며 Dashboard 합계는 실행 액션을 허용하는 Plan의 ready Task 수다. 완료·승인·한도·DAG 판단은 Runtime에서 유지한다.

API는 GET `/api/overview`, `/api/plans/ID`, `/api/tasks/ID`, `/api/session`과 POST `/api/plans`, `/api/plans/ID/run`, `/api/plans/ID/decision`, `/api/tasks/ID/decision`, `/api/tasks/ID/quality`다. Overview에 활성/Archive Plan, Task, Attention, 설정을 함께 제공하여 별도 목록 endpoint를 늘리지 않는다. 정책은 non-secret JSON object이며 호스트 파일 경로를 API로 열지 않는다. Source는 기존 safe_path/sources_for를 통한다.

모든 mutation에 정확한 Host·Origin·서버 세션 token과 JSON Content-Type을 요구한다. cross-site fetch를 거부하고 CORS를 열지 않는다. token은 메모리에만 있고 no-store session endpoint를 통해 동일 Origin에 전달한다. Task/Prompt에 token을 복사하는 요청도 거부하며 요청 body/URL/token을 로그하지 않는다. CSP는 self-only script/style/connect와 frame/base/form 제한을 설정하고, 모든 모델/사용자 값은 textContent 또는 HTML escaping으로 표시한다. 임의 정적 파일 경로 대신 세 asset만 허용한다. body 256 KiB, socket timeout 30초로 제한한다. 이는 외부 사용자 인증이나 악성 로컬 프로세스 방어를 대신하지 않는다.

실행·판단 요청에는 객체와 source/output 파일 해시에서 얻은 revision을 전달한다. Runtime의 기존 vault lock 안에서 revision을 다시 검사한 뒤 기존 전이를 수행한다. 상태·파일 변경은 STALE_STATE이며 Frontend가 새 상태를 읽는다. 기존 transmission/quality/final approval 검증도 그대로 실행한다. CLI의 expected_state 기본값은 None으로 하위 호환하며 기존 snapshot 경계를 유지한다. Graph/완료 상태를 Frontend에서 계산하거나 DB를 직접 UPDATE하지 않는다.

Permission과 Quality는 별도 API/카드이며 allowed_actions는 현재 attention과 Runtime 선택지를 바탕으로 제공한다. Task quality가 남아 있으면 Plan resume는 노출하지 않고 Runtime도 거부한다. 오류는 `{error,message,details}`이며 INVALID_DECISION/STALE_STATE/PERMISSION_DENIED 등 HTTP 오류와 Runtime의 waiting/blocked/model_error를 보존한다. Python traceback은 응답에 넣지 않고 개발 로그에 남긴다. 모델/구조화 결과 실패는 Runtime의 원래 진단을 표시하며 자동 수리하지 않는다.

새 attention에는 requested_at, Task 실행/완료에는 last_run_at/completed_at을 기록한다. 기존 데이터는 migration이나 과거 이력 수정 없이 그대로 읽고, 없는 시각은 미기록 또는 실제 event sequence로 표시한다. 손상되거나 접근 불가한 source도 projection 자체를 차단하지 않으며 실행 시 Runtime이 거부한다.

Theme는 업무 데이터의 status/ready/type/allowed_actions와 분리한 CSS 변수로 표현한다. default-light만 구현하며 Runtime 변경 없이 CSS/표현 계층을 교체할 수 있다. Pixel Office plugin system·캐릭터·공간 상태는 만들지 않는다. 데스크톱 우선이며 좁은 화면에서 판단함이 아래로, Plan 목록이 위로 이동한다.

### 다중 Task 조정 v1 — 2026-10-12

`PlanRuntime`은 기존 `Runtime.run` 위의 조정 계층이다. 별도 Task 실행기/Planner Employee를 만들지 않는다. `plan_model.py`는 ID·strict Proposal·DAG·Ready 계산, `planning.py`는 Manager 호출/Plan 변경/Task 조정/전체 검토를 담당한다. 프롬프트는 prompts/common, manager_planning, manager_review, manager_completion, worker로 책임별 분리한다.

| Prompt / AI responsibility | Program / Runtime responsibility |
|---|---|
| Goal interpretation, completion criteria proposal | Plan/Task ID generation, persistence, Task-Plan mapping |
| Task decomposition, semantic dependency reasoning | Graph storage, cycle/invalid-reference detection, ready calculation |
| Task addition necessity, plan-change reasoning | State transitions, Task/revision limits, atomic changes |
| Worker execution, Task quality review | Completed-history protection, approval snapshots, hashes |
| Final-goal review, human judgment escalation | Permission, secrets, Git, recovery, audit |

Schema 2는 별도 `plans(id PRIMARY KEY, data)`를 추가하고 기존 tasks/events/state 및 Task JSON 호환성을 유지한다. Schema 1 Vault는 열 때 자동 확장한다. Plan은 원 요청, 상위 contract, 생성 Manager/시각, 상태/version, permanent Task ID/local-key mapping, specs, 최초 Proposal, 변경 이력, 모든 전체 검토/실제 generation, 판단 및 result를 저장한다. Plan/Task 생성과 변경/이벤트는 하나의 SQLite transaction으로 처리한다. 파일/Git/DB 전체는 하나의 원자적 transaction이 아니다.

ID는 Runtime이 UTC microsecond 시각, 생성 Manager, UUID 기반 12자리 suffix로 생성한다. Plan은 `pln_TIMESTAMP_manager1_RANDOM`, Task는 `tsk_TIMESTAMP_manager1_PLAN-SUFFIX_003_RANDOM`. DB primary key와 중복 검사로 충돌을 거부한다. plan_id/local_key/created_manager/sequence/created_at은 Task의 immutable 식별 이력이며 assigned_manager/assigned_worker와 분리한다. v1은 manager-1/worker-1만 사용한다.

Plan JSON은 duplicate key/NaN/fence/trailing text를 거부하며 임의 수리하지 않는다. Runtime은 필수 goal/criteria, local-key 고유성, priority(int 1–100), 경로·source 권한, 정규화된 출력 충돌, 자기 참조·없는 참조·cycle 및 Task 한도를 검사한다. Sources는 최초 선택 원본 또는 명시된 직접 dependency의 expected_output만 허용한다. 다른 Plan/Task가 이미 소유한 출력도 예약된 자원으로 보고 거부한다. Task 내부 depends_on은 permanent ID이고 Model Proposal은 local key만 사용한다.

Ready는 queued AND 모든 dependency completed다. priority → sequence → created_at → stable ID로 하나를 선택하고 같은 vault lock 안에서 기존 Runtime을 실행한다. Plan Task를 개별 run으로 우회해도 활성 Plan의 현재 선택 및 dependency 승인을 검사한다. waiting Task는 해결 전 다음 Task를 선택하지 않는다. cancelled/blocked dependency는 후속 실행을 열지 않는다. Task Board의 ready는 그래프 조건이며 전송 승인/Plan 상태와 별개의 실행 가능성 표시다.

Result Reference는 task_id/plan_id/output/output_hash/completed/approval/result를 후속 Task의 dependency_results에 고정한다. 매번 실제 승인 파일의 해시를 검사한다. dependency artifact를 source로 읽을 때 과거 요청/provenance envelope 대신 승인 result 본문만 투영하며 representation, 본문 SHA-256과 artifact SHA-256을 구분한다. 정확한 Prompt hash가 이 본문과 reference에 바인딩된다. 외부 파일 변경은 조용히 최신 입력으로 대체되지 않는다. 완료된 하위 Task도 과거 snapshot을 유지하며 변경된 artifact를 사용하려면 승인 버전 복원 또는 새 Plan이 필요하다.

Completed Task 전체와 Completed Plan의 mutation은 Store에서 거부한다. Git checkpoint 실패만 명시적 성공 무효화로 처리한다: 이전 완료 객체 전체를 invalidated_completion에 남기고 blocked/result null로 표시한다. 승인 제출·검토를 지우지 않는다. Git 자동 background maintenance는 checkpoint에서 비활성화해 임시 Vault 종료와 경쟁하지 않게 한다.

변경 Proposal은 reason/operations이며 다음 연산을 지원한다. add_task는 새 local_key/spec를 추가한다. cancel_unstarted_task는 한번도 claimed되지 않은 queued Task를 취소한다. modify_unstarted_task는 title/goal/priority/sources/completion_criteria/expected_output만 갱신하며 ID를 유지한다. add_dependency/remove_dependency도 대상은 never-started queued Task이고 전체 graph를 다시 검사한다. 변경 중 어느 연산이 실패해도 Task/Plan/이벤트 전체를 rollback한다. 완료·시작 이력은 수정할 수 없다. 취소 Task와 과거 local key도 전체 Task 한도에 포함한다.

History는 version/timestamp/authority/reason/operations/affected_tasks/previous_plan_hash/new_plan_hash를 보존한다. Hash는 specs와 취소 ID 목록을 포함한다. 기본 한도 initial 10 / total 20 / revisions 5이며 설정 가능하다. 초과는 명시적 blocked로 전환하고 자동 확대하지 않는다.

정상 완료 후 Planning을 재호출하지 않고 Runtime이 다음 ready를 계산한다. Worker questions/limitations, blocked Task 또는 ready가 없는 미완료 Plan은 Adjustment Context로 보낸다. 이 문맥만 CONTINUE/CHANGE_PLAN/ADD_TASKS/ESCALATE를 허용한다. CONTINUE는 ready work가 있어야 하며 CHANGE_PLAN은 추가 Task 없이도 지원 변경을 제안할 수 있다. 전체 Task가 완료/명시 취소되면 Final Review는 정확히 COMPLETE/ADD_TASKS/ESCALATE다. COMPLETE는 모든 비취소 Task 완료, 하나 이상의 승인 결과, 모든 상위 기준 satisfied, 빈 질문/change, 현재 Task/contract/history snapshot 및 실제 완료 출력 해시 일치를 요구한다. ADD_TASKS는 새 Task를 포함해야 한다.

Worker 문맥은 현재 Task 계약, 원래 상위 요청/목표/제약, 승인 dependency 결과로 제한하고 상위 criterion ID를 전달하지 않는다. Manager Task Review는 실제 제출과 개별 기준, 검증된 artifact 경로/hash/저장 주체를 받는다. 파일 저장은 Runtime 책임이며 모델은 내용 품질을 검토한다. Final Review는 상위 기준과 선택 원본, Board/변경 이력, 승인 result/검토/한계/질문만 받는다. Home/전체 Vault/과거 Prompt를 전송하지 않는다.

Planning/Task Review/Final 정책은 독립적으로 지정할 수 있고 employee identity와 호출 목적은 분리된다. 모든 호출은 기존 Gateway의 exact prompt/source hash/policy snapshot 전송 승인을 요구한다. 모든 역할 정책의 알려진 credential 문자열을 입력·출력·판단 메모·변경 Proposal에서 검사한다. Secret 값은 DB/프롬프트/증거에 저장하지 않는다. 알려지지 않은 민감정보의 일반적인 DLP 보장은 아니다.

plan-run은 bounded 명시적 재개 단계다. 재시작 시 DB의 Plan/version/mapping/dependencies/기존 generation과 승인을 재사용한다. 현재와 동일한 snapshot에 이미 저장된 generation은 재호출하지 않는다. 모델 응답 저장 전 crash는 기존처럼 중복 호출할 수 있다. 인간 판단은 Task 기존 quality-decide, Plan resume/cancel로 나누며 Task 품질 대기는 먼저 해결해야 한다. 잘못된 모델 응답은 자동 수리·무한 재시도하지 않는다.

### 핵심 업무 순환 구현

`nidus/workflow.py`는 별도 검증 객체가 아니라 Manager/Worker 계약·업무 전이를 제공하며 지침은 prompts/에서 가져온다. `manager-1`과 `worker-1`은 역할 식별자이고 Provider와 독립적이다. `--contract`는 명시 계약 JSON, `--manager-policy`는 검토용 별도 정책이다. 생략하면 기본 계약과 Worker 정책을 사용한다. 기존 SQLite Task JSON을 확장하며 Schema 2에서도 기존 Task 형식은 유지한다.

Worker는 `result/self_check/known_limitations/questions`, Manager는 `decision/criteria/reason/issues/instructions/questions` JSON을 반환한다. 모든 기준 ID가 정확히 한 번 나타나야 한다. JSON mode(`response_format=json_object`)를 기존 Gateway 정책·전송 Snapshot에 포함하고 Chat Completions payload로 전달한다. 형식/정상 종료/Secret 실패는 차단하며 임의 JSON 수리나 성공 전환을 하지 않는다. Manager APPROVE에는 모든 기준 satisfied, 빈 issues/instructions/questions가 필요하다. REWORK에는 구체적 지적과 수정 지시, ESCALATE에는 질문이 필수다.

결정적 검사 뒤 Manager가 실제 결과를 독립적으로 검토한다. Worker와 Manager의 Prompt·정책은 별도 전송 승인을 받는다. Manager 문맥은 선택 자료/계약/제출/현재 실행 Metadata로 제한하며 Home·전체 Vault를 전송하지 않는다. 양 역할의 알려진 키 문자열을 모든 역할 입력·출력에서 차단한다. JSON mode 미지원 Provider는 오류로 차단될 수 있다.

`workflow_stage`는 worker_execution/manager_review/rework/human_review/done을 사용하고 기존 Board 상태를 재사용한다. REWORK는 한 run을 종료한 뒤 다음 명시적 run으로 재개한다. 이전 응답·자기 점검·검토·해시·수정 지시를 `revisions`와 `reviews`에 보존한다. 동일 경로·원문·바이트로 소유가 확인된 이전 후보만 추가 교체 승인 없이 갱신하며, 사람이 수정했다면 기존 교체 승인을 다시 받는다. 새 재작업 Prompt는 별도로 승인한다.

승인은 요청/계약/원문/결과/자기 점검/정책/검증/후보 해시에 바인딩된다. 검토 후 파일과 원문을 재확인하며 변경 시 승인을 제거하고 Blocked로 둔다. `--review-only`는 승인 후 완료 전 Checkpoint다. 유효한 저장 승인으로 재시작하면 모델을 재호출하지 않는다; 검토 전 Verifying은 Manager 호출이 필요할 수 있다.

ESCALATE/한도는 품질 안건 Waiting이다. `quality-decide`는 이유를 필수로 받아 approve/rework/cancel을 기록하며, 일반 `decide`로 품질 안건을 승인할 수 없다. 인간 approve는 Manager의 ESCALATE/REWORK를 APPROVE로 바꾸지 않고 `authority=human`으로 별도 책임을 기록한 뒤 결정적 검증을 다시 수행한다. 오래된 안건은 승인할 수 없다. 전체 다중 직원 조직과 자동 모델 최적화는 구현하지 않았다. 상위 목표 계획은 별도 Plan 기능이다.

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

Waiting은 덮어쓰기·모델 전송 또는 별도의 업무 품질 판단을 기다린다. 저장된 Running은 실행을, Verifying은 검증을 복구한다.
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
Legacy Verifying 또는 승인된 Manager 검토를 복구할 때는 모델을 다시 부르지 않는다. 전송 이후 원문이 바뀌면 쓰기를 차단하고 다음 run에서 재승인한다.
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

SQLite는 외부 의존성 없이 트랜잭션/정렬된 감사를 제공한다. CLI와 동기 실행은 Queue/daemon 없이 복구 가능한 작은 Slice를 만든다.
제한된 파일 작업만 제공하므로 현재 Docker 설치는 필수가 아니다. 향후 코드/Shell Tool 추가 전 격리를 재검토해야 한다.
실제 설치된 OmniRoute는 교체 가능한 실행 수단이며 설치·Provider 선택 이력은 [검증 보고서](docs/VALIDATION.md)에 통합했다.
`scripts/model_fallback_live.py`는 Credential 없는 별도 Loopback fixture로 503/401을 주입하고 나머지 경로만 실제 호출한다. 이는 실제 Provider 장애를 재현했다는 주장이 아니다.
Live harness는 기존 evidence 경로를 덮어쓰지 않는다. 개발 검증 명령은 [README](README.md), 책임 개념은 [CONCEPT](docs/CONCEPT.md)를 참조한다.

## English

### Local GUI boundary

A standard-library loopback HTTP server delegates all commands through Application to the same PlanRuntime/Runtime used by CLI. The adapter projects Store data and Runtime readiness; it never updates business state directly. Each explicit click runs one bounded step. Exact Host/Origin, a memory-only session token, CSP, escaped content, strict IDs/paths and under-lock state/resource revisions protect localhost mutations. Completed history, scoped permissions, quality judgments and recovery retain Runtime semantics. CSS tokens implement default-light independently of status/action data; Pixel Office and autonomous scheduling remain deferred.

### Multi-task orchestration v1

Schema 2 adds separate plans without rewriting legacy Tasks. PlanRuntime calls the existing Runtime under one vault lock. Runtime owns traceable IDs, strict proposal validation, DAG integrity, stable readiness, atomic five-operation changes, limits, frozen completed history and snapshot-bound completion. Prompts own goal interpretation, minimum decomposition, semantic dependencies, Task quality and final-goal judgment. Final decisions are COMPLETE/ADD_TASKS/ESCALATE; unfinished-plan Adjustment also permits CONTINUE and CHANGE_PLAN. Source selection is restricted to original selected paths or declared direct dependency outputs, with approved artifact hashes checked before reads. Dependency source text is the approved result, with separate artifact/text hashes. Each role has exact transmission approval and all role credentials are screened. Restart reuses stored generations and approvals. No multiple workers, parallel execution, tools or daemon.

### Core responsibility implementation

`nidus/workflow.py` implements Manager/Worker contracts, instructions and transitions, not a verifier object. `manager-1`/`worker-1` role identifiers are independent of providers. `--contract` supplies explicit JSON; `--manager-policy` independently selects review routes. Defaults persist a Manager contract and reuse Worker policy without an extra planning call. Schema 2 adds plans while retaining legacy Task JSON. Role instructions live in prompts/.

Worker returns result/self_check/known_limitations/questions; Manager returns decision/criteria/reason/issues/instructions/questions. Every criterion appears exactly once. JSON mode (`response_format=json_object`) is included in the existing Gateway policy, exact transmission snapshot and Chat Completions payload. Reject malformed/truncated/credential-bearing responses without speculative repair. APPROVE requires satisfied criteria and no outstanding issues/instructions/questions; REWORK needs concrete issues/instructions; ESCALATE needs questions. Unsupported JSON-mode providers may fail closed.

Manager independently reviews after deterministic PASS. Approve Worker and Manager transmissions separately; send only selected sources, contract, submission and current execution metadata, never Home or the whole vault. Check both role credential references across inputs and outputs.

Keep existing Board states; workflow_stage is worker_execution/manager_review/rework/human_review/done. Each REWORK returns control, and the next explicit run resumes with prior result/issues/instructions. Preserve response, self-check, review, hashes and instructions in revisions/reviews. Only an unchanged owned candidate at the same path/source hashes may be replaced without another overwrite decision. Human edits require renewed overwrite permission, and revision prompts need new transmission approval.

Bind approval to original request, contract, sources, actual result/self-check, policies, checks and candidate hash. Recheck resources after review; changes invalidate approval and block completion. --review-only checkpoints approval before completion. Restart with valid saved approval makes no new model call; Verifying before review can still need a Manager call.

Escalation/limits produce a quality Waiting agenda. quality-decide records a required reason for approve/rework/cancel; ordinary decide cannot approve quality agendas. Human approval preserves Manager's original ESCALATE/REWORK and records authority=human, followed by deterministic checks. Stale agendas cannot be approved. Full organization and automatic model optimization remain unimplemented; upper-goal planning is a separate Plan feature.

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

Waiting requests overwrite/model-transmission or separate work-quality decisions. Persisted Running recovers execution; Verifying recovers verification.
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
Legacy Verifying and recovery of an already-approved Manager review never recall the model. Source changes after transmission block writes and require reapproval on the next run.
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

SQLite provides transactions/ordered audits without external dependencies. CLI and synchronous execution create a small recoverable slice without a queue/daemon.
Restricted file operations do not require Docker today. Revisit isolation before introducing code/shell tools.
Installed OmniRoute remains replaceable; installation/provider-selection history is consolidated in [validation](docs/VALIDATION.md).
`scripts/model_fallback_live.py` injects 503/401 through a separate credential-free loopback fixture and calls only non-injected routes for real. It does not establish actual provider outages.
Live harnesses refuse existing evidence paths. See [README](README.md) for checks and [CONCEPT](docs/CONCEPT.md) for conceptual responsibilities.
