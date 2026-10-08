# 요구사항 / Product requirements

[한국어](#한국어) · [English](#english)

## 한국어

### 관리자·작업자 업무 순환 v1

새 CLI 생성형 작업의 기본 흐름은 Manager 계약 → Worker 실행·자기 점검 → 결정적 검증 → Manager 검토다. 명시 계약 입력을 지원하고 생략 시 관리자 기본 계약을 저장한다. 계획 생성용 추가 모델 호출은 없다. Manager는 자동 책임 종료점이며 검증 전용 AI 객체를 만들지 않는다.

| 기준 | 관찰 가능한 동작 |
|---|---|
| MW-AC-01 | 목적·범위·ID별 완료 기준·제약·선택 자료·예상 결과물·사람 판단 조건을 호출 전에 보존하고 Worker 문맥에 전달 |
| MW-AC-02 | 결과·모든 기준의 자기 점검·한계·질문을 제출; 자기 점검만으로 완료하지 않음 |
| MW-AC-03 | 원 요청·계약·원문·결과·자기 점검·실행 기록을 별도 Manager 지침으로 검토; APPROVE/REWORK/ESCALATE |
| MW-AC-04 | 결정적 검사 PASS와 현재 후보에 바인딩된 Manager 승인 또는 명시적 인간 품질 승인 없이는 완료 금지 |
| MW-AC-05 | 이전 결과·지적·수정 지시 전달, 재작업 이력 보존; 기본 2회, 설정 0–10회; 한도 시 사람 대기 |
| MW-AC-06 | ESCALATE는 Waiting/품질 안건으로 이동; 인간 승인·재작업·취소는 권한 결정과 분리 |
| MW-AC-07 | 역할별 정책과 정확한 전송 승인을 유지; 원문·계약·결과·정책 변경 시 이전 승인 재사용 금지 |
| MW-AC-08 | A–F 결정적 테스트, 기존 회귀 및 실제 공개 합성 작업의 Completed/Archive 증거 |

기존 deterministic 추출과 API의 `workflow=None`, CLI `--workflow legacy`는 이전 계약의 호환 경로다. 기존 작업을 자동으로 새 계약에 편입하지 않는다. 자연어 계획 생성, 전체 조직/Project/GUI/Red Team/JEV/Tool은 여전히 범위 밖이다. Manager의 품질 판단은 의미 정확성의 수학적 증명이 아니다.

### 목적과 현재 범위

한 명의 로컬 사용자가 한 Employee에게 범위가 정해진 문서 작업을 맡기고, 권한·진행·결과·검증을 확인한다.
기본 오프라인 브리핑과 선택적인 실제 모델 문서 작성을 지원한다. 기본 흐름은 요청 → 계약 → 문맥 복구 → 승인 → 실행 → 검증 → 완료 → 보관이다.
결정적인 브리핑은 모델의 자율적 판단을 증명하지 않으며, 실제 생성 검증도 임의의 자율 업무 수행 능력을 증명하지 않는다.

P0 목표는 실행 가능한 로컬 흐름, 지속적 복구, 명시적 인간 결정, 원문 보호, 관찰 가능한 검증과 이력이다.
GUI·자연어 계약 자동 구성·임의 Tool/Shell·전체 조직/Project 실행·여러 Worker·daemon·vector 검색·Red Team·Dream Sequence·배포는 구현 범위 밖이다.
개념 설계의 Inbox 매트릭스는 CLI로 대체 완료된 것이 아니라 후속 UX다. 생성형 경로만 명시적 외부 모델 전송을 추가하며 기본 모드는 오프라인이다.

### 주요 시나리오

1. 원문과 새 출력 경로를 선택해 제출하고 브리핑 및 Archive를 확인한다.
2. 기존 출력 교체는 정확한 입력·출력 Snapshot에 대한 승인을 받는다. 거절하면 원본을 보존한다.
3. 실행 후 중단해도 저장된 후보를 새 프로세스에서 검증하며, 잘못되거나 없는 결과는 완료하지 않는다.
4. 잘못된 경로나 사용할 수 없는 원문은 원인이 보이는 Blocked가 된다.
5. 생성형 작업은 전송할 요청·원문·전체 정책을 승인한 뒤 모델 응답을 보존하고 검증한다.

### 오프라인 요구사항과 완료 기준

| 요구사항 | 관찰 가능한 완료 기준 |
|---|---|
| FR-01 Inbox/계약 | AC-01 원 요청, 사용자 우선순위, Worker와 Goal/Scope/Constraints/Acceptance Criteria/Verification/Result 계약 보존 |
| FR-02 Workshop | AC-02 UTF-8 원문의 요청·경로·SHA-256·비어 있지 않은 첫 세 줄을 출력하고 원문 보존 |
| FR-03 지속 상태 | AC-03 새 프로세스에서 조회·후보 실행 후 재개 가능; 동시 Worker 중복 점유 금지 |
| FR-04 문맥 복구 | AC-04 Home → Desk → Board → Library 복구 기록; 오래된 참조는 Board와 대조하고 Native Notes는 Checkpoint History에 보존 |
| FR-05 권한 | AC-05 절대·탈출·심볼릭 링크·숨김 시스템 경로 및 원문 덮어쓰기 거부; 오프라인 Worker에 Shell/삭제/네트워크/Secret Tool 없음 |
| FR-06 인간 개입 | AC-06 교체 시 Waiting에 배경·근거·선택·영향 표시; 해시에 묶인 승인, 변경 시 재승인, 거절 시 쓰기 없이 취소 |
| FR-07 검증 | AC-07 독립적 예상 바이트 재계산과 원문 Snapshot 일치 필수; 변조·누락은 Blocked |
| FR-08 보관/감사 | AC-08 완료는 활성 목록에서 제외하고 Brief·계약·결과·검증·결정·순서 있는 감사 이력을 보관; Vault 변경은 로컬 Git 추적 |

### Model Gateway 요구사항과 완료 기준

추가 계약은 AC-01–08을 삭제하거나 약화하지 않는다. 확률적 응답을 다시 생성해 동일 바이트가 나올 것으로 가정하지 않는다.

| 요구사항 | 관찰 가능한 완료 기준 |
|---|---|
| MG-FR-01 Provider 독립성 | MG-AC-01 표준 라이브러리 Chat Completions Adapter, 설정된 Free/Paid/Local 순서; OmniRoute 필수 종속성 없음; Paid 명시적 허용 |
| MG-FR-02 실제 실행 | MG-AC-02 실제 외부 무료 생성형 모델이 비민감 요청을 Runtime에서 Completed로 처리하고 Live 증거 기록 |
| MG-FR-03 전송 승인 | MG-AC-03 정확한 요청/원문/정책 승인 전 호출 없음; 변경 시 재승인; Endpoint/모델/Prompt 해시·크기/포함 자료 감사; 전체 Home/Desk/Library 전송 금지 |
| MG-FR-04 Secret 분리 | MG-AC-04 전송 시 명명된 환경변수로만 키 조회; 키/인증 헤더/오류 본문 기록 금지; 알려진 Credential의 입력·출력 포함 차단 |
| MG-FR-05 완료 Guard | MG-AC-05 비어 있지 않은 정상 종료 응답, 필수 문구, 원문 해시와 저장된 응답·출처 바이트 일치; 재시작 검증은 모델 0회 호출; 실패 완료 금지 |
| MG-FR-06 오류/관측 | MG-AC-06 인증/quota/rate/timeout/unavailable/invalid/network 구분; 승인된 retryable만 fallback; 각 시도 시각/route/provider/model/결과/tokens/알려진 또는 미상 비용 기록 |

MG-AC-02의 원래 무료 경로 목표는 유지한다. 실제 생성·완료는 검증했지만 계정별 무료 quota/실제 청구는 검증하지 않았으므로 무료 조건까지 충족했다고 표시하지 않는다. 현재 Pool은 명시적인 Paid 허용 정책이다.
기존 출력 승인은 외부 전송보다 먼저 받는다. 자연어 `--require`가 아니라 문자 그대로의 필수 문구만 검사하며, 의미적 정확성 일반화는 범위 밖이다.

### 다중 Provider 검증 기준

- PV-AC-01 Gemini/NVIDIA 실제 합성 호출 결과를 Provider별로 기록한다. 카탈로그·인증 성공은 생성 성공의 대체가 아니다.
- PV-AC-02 승인된 retryable 전송 장애 후 설정 순서로 실제 추론 → Completed/Archive를 확인한다. 주입 장애와 실제 장애를 구분하고 전 시도를 남긴다.
- PV-AC-03 인증·정책·Secret·권한 실패는 후속 경로 없이 중단한다.
- PV-AC-04 이전 증거/Credential을 보존하고 신규 결제·보안 설정 변경 없이 관측 토큰·지연·미상 비용을 기록한다.

단독 Provider 성공과 Fallback 성공은 별도 목표다. 현재 Gemini·NVIDIA·Copilot 단독 생성은 검증됐으며 주입 장애 Fallback은 제한 범위를 명시한다.

### 제약과 가정

Python 3.9+/Git, 한 Vault·한 Worker, 명시적 일반 UTF-8 `.md`/`.txt` 원문 최대 20개·각 1 MiB, 같은 확장자 출력.
상태는 `.nidus/`, Library/출력은 그 밖에 둔다. 인간은 로컬 CLI/Vault를 통제하고 승인 여부는 시간 경과로 추정하지 않는다.
사용자가 비민감 입력과 우선순위를 정한다. 모델이 Tool·Shell·URL을 선택하지 않는다. 계정/결제/구독 자동 생성과 강제 유료 fallback은 없다.
실행 종료 후 Vault를 이동·백업할 수 있으나 적대적 파일시스템 프로세스로부터의 격리는 보장하지 않는다.
구현 책임은 [DESIGN](DESIGN.md), 현재 검증은 [보고서](docs/VALIDATION.md)에 있다.

## English

### Manager/Worker responsibility loop v1

New CLI generative tasks default to Manager contract → Worker execution/self-check → deterministic checks → independent Manager review. Explicit contracts are accepted; otherwise a default Manager contract is persisted without a planning-model call. Managers terminate automated responsibility; there is no separate AI verifier.

MW-AC-01: persist goal/scope/identified criteria/constraints/materials/deliverable/human-judgment conditions before execution and pass them to Worker. MW-AC-02: require result, criterion-by-criterion self-check, limitations and questions; self-check cannot complete a task. MW-AC-03: Manager independently reviews original request, contract, actual sources/result, self-check and execution records, returning APPROVE/REWORK/ESCALATE. MW-AC-04: require deterministic PASS and approval bound to current content, or explicit human quality approval. MW-AC-05: retain revisions and concrete instructions, with a configurable 0–10 rework limit (default 2), then human attention. MW-AC-06: separate quality approve/rework/cancel from permission decisions. MW-AC-07: independent role policies and exact per-call transmission approval; invalidate changed inputs/content/policy. MW-AC-08: scenarios A–F, regression and real public-synthetic completion/archive evidence.

Deterministic extraction, API `workflow=None` and CLI `--workflow legacy` retain earlier contracts. Do not silently migrate existing tasks. Full organization/project/GUI/Red Team/JEV/tools and natural-language planning remain deferred. Manager judgment is not mathematical proof of semantic correctness.

### Purpose and current scope

One local user delegates a bounded document task to one persistent Employee and inspects permissions, progress, results and verification.
Support default offline briefings and optional real-model document generation. The flow is request → contract → recovery → permission → execution → verification → completion → archive.
Deterministic extraction does not prove model judgment; live generation does not establish arbitrary autonomous work capability.

P0 goals are executable local flow, durable recovery, explicit human decisions, protected originals, observable verification and retained history.
GUI, natural-language contract formation, arbitrary tools/shell, full organizational/project execution, multiple workers, daemon, vector search, Red Team, Dream Sequence and deployment are outside implementation scope.
The conceptual Inbox matrix remains future UX, not a completed CLI replacement. Only the opt-in generative path adds external model transmission; default mode is offline.

### Primary scenarios

1. Select sources and a new output, submit, then inspect the briefing and archive.
2. Replacing an existing output requires approval of the exact input/output snapshot. Rejection preserves it.
3. Restart after execution to verify the stored candidate in a new process; bad/missing results cannot complete.
4. Invalid paths or unavailable sources become visibly Blocked.
5. Generative work approves the request, sources and full policy before preserving and verifying a model response.

### Offline requirements and acceptance criteria

| Requirement | Observable acceptance criterion |
|---|---|
| FR-01 Inbox/contract | AC-01 Retain original request, user priority, worker and Goal/Scope/Constraints/Acceptance Criteria/Verification/Result contract |
| FR-02 Workshop | AC-02 Output request, source paths, SHA-256 and first three nonempty lines of UTF-8 sources; preserve originals |
| FR-03 Durable state | AC-03 Fresh processes inspect/resume after candidate execution; concurrent workers cannot both claim the vault |
| FR-04 Context recovery | AC-04 Record Home → Desk → Board → Library; reconcile stale references with Board and retain native notes in checkpoint history |
| FR-05 Permission | AC-05 Deny absolute/traversal/symlink/hidden-system paths and source overwrite; offline worker has no shell/deletion/network/Secret tools |
| FR-06 Human attention | AC-06 Replacement Waiting contains background/reason/choices/effects; hash-scoped approval, reapproval on change, cancellation without writes on rejection |
| FR-07 Verification | AC-07 Independently recompute expected bytes and match source snapshots; tampered/missing candidates are Blocked |
| FR-08 Archive/audit | AC-08 Remove completion from active listing while retaining brief/contract/result/verification/decisions/ordered audit; locally Git-version vault changes |

### Model Gateway requirements and acceptance criteria

The additional contract neither removes nor weakens AC-01–08. Never assume replaying stochastic generation produces identical bytes.

| Requirement | Observable acceptance criterion |
|---|---|
| MG-FR-01 Provider independence | MG-AC-01 Stdlib Chat Completions adapter, configured ordered Free/Paid/Local routes; no mandatory OmniRoute dependency; explicit paid opt-in |
| MG-FR-02 Real execution | MG-AC-02 A real external free generative model handles a nonsensitive request through Runtime to Completed with live evidence |
| MG-FR-03 Transmission approval | MG-AC-03 No call before exact request/source/policy approval; reapprove changes; audit endpoint/model/prompt hash/size/included resources; no full Home/Desk/Library dump |
| MG-FR-04 Secret separation | MG-AC-04 Resolve keys only from named environment variables at transport; never record keys/auth headers/error bodies; reject known credentials in input/output |
| MG-FR-05 Completion guard | MG-AC-05 Nonempty, normally finished response, required phrases, unchanged source hashes and matching retained response/provenance bytes; zero model calls during restart verification; failed criteria cannot complete |
| MG-FR-06 Errors/observability | MG-AC-06 Distinguish auth/quota/rate/timeout/unavailable/invalid/network; fallback only on approved retryable failures; log each attempt's time/route/provider/model/outcome/tokens/known or unknown cost |

The original free-route objective in MG-AC-02 is retained. Actual generation/completion is verified, but account free quota/billing is not; do not claim its free-use condition passed. The current pool explicitly permits paid-kind routes.
Obtain existing-output approval before external transmission. `--require` checks literal phrases, not natural-language criteria; general semantic correctness remains outside scope.

### Multi-provider validation criteria

- PV-AC-01 Record individual real synthetic Gemini/NVIDIA calls; catalog/auth success cannot replace successful inference.
- PV-AC-02 After an approved retryable transport fault, confirm real inference → Completed/Archive in configured order; distinguish injected/actual faults and retain every attempt.
- PV-AC-03 Auth/policy/Secret/permission failures stop without downstream routes.
- PV-AC-04 Preserve old evidence/credentials; avoid new billing/security changes; record observed tokens, latency and unknown costs.

Standalone provider success and fallback success are separate goals. Gemini, NVIDIA and Copilot standalone generation is verified; injected-fault fallback is reported within its actual scope.

### Constraints and assumptions

Python 3.9+/Git, one vault/worker, explicitly selected regular UTF-8 `.md`/`.txt` sources: at most 20, 1 MiB each; outputs use the same suffixes.
State lives in `.nidus/`; Library/results live outside it. The trusted human controls CLI/vault, and elapsed time never implies approval.
Users select nonsensitive inputs and priority. Models do not choose tools/shell/URLs. No automatic account/payment/subscription creation or forced paid fallback.
Move/back up vaults after closing the runtime; hostile filesystem-process isolation is not guaranteed.
Implementation ownership is in [DESIGN](DESIGN.md); current validation is in [the report](docs/VALIDATION.md).
