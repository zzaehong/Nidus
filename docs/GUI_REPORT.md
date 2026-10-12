# Nidus Local GUI v1 report

## Status

구현·브라우저 검증 완료. 최종 develop 통합 뒤 전체 회귀와 clean working tree를 다시 확인한다. 최종 HEAD/merge는 완료 응답에 기록한다.

## Starting develop HEAD

`fcd97115d02a50336922ede8722ffaeb539ab1ce`. 원격 fetch 성공; origin/develop `4d8c854`의 후속 로컬 검증 완료 develop에서 시작했다. 사용자 수정 `doc/prompt.md`는 요구사항 커밋 `6578da8`로 보존했다.

## Architecture

- GUI server: Python stdlib HTTPServer, 127.0.0.1:8765, optional port, no new dependency/build/CDN.
- Application/API adapter: Store read projection과 Runtime command 위임; 별도 업무 엔진 없음.
- Runtime reuse: 동일 PlanRuntime/Runtime 메서드, 기존 권한·품질·DAG·완료·Git·복구 유지. GUI stale revision은 기존 lock 안에서 확인.
- Store boundary: GUI/Adapter는 업무 DB UPDATE/save를 수행하지 않는다. Store initialization/migration/checkpoint는 기존 공용 Store에서 처리한다.

## Frontend

- Dashboard: 실제 active Plan/attention/Runtime-ready/Archive 수, 최근 Plan, 선택 Plan, 사람 판단함, 최근 완료 Task.
- Plans: 목록과 작업/의존 관계/전체 정보/실행 기록 탭, progress, 할당, 시각, 상태.
- Tasks: 실제 Manager 계약과 Runtime 계약, 제출/self-check, 검증, Review, 재작업, 결과 reference/hash, 시각/이력.
- Human Attention: 전송/덮어쓰기 Permission과 Task Quality/Task ESCALATE/Plan Final ESCALATE/Plan 재개를 별도로 표시한다.
- Archive: 완료 Plan/Task, Final Review/결과/해시 읽기 전용.
- Settings: Vault, schema/GUI version, bind, limits, 정책, theme 읽기 전용.

## Workflow actions

- create plan: 요청·Vault source 경로·Planning policy JSON, optional Worker/Review/Final 정책과 CLI 동일 한도 10/20/5.
- run one step: 클릭당 PlanRuntime.run 한 번. 요청 동안 busy/중복 클릭 잠금. 자동 실행 loop 없음.
- permission decisions: 기존 Runtime.decide 또는 PlanRuntime.decide의 approve/reject.
- quality decisions: 기존 Runtime.quality_decide의 approve/rework/cancel, 이유·재작업 지시.
- plan decisions: Task 품질 해결 이후 resume, Final ESCALATE resume/cancel; 이유 필요, 강제 COMPLETE 없음.

## Security

- Bind: 127.0.0.1 only, 외부 host 명시 거부.
- Mutation protection: POST JSON, 정확한 Host/Origin, memory-only 세션 token, cross-site fetch 거부, CORS 없음, CSP/escaping/no-store/no-framing, 크기·socket timeout 제한. 세션 자료를 업무 body에 복사하는 요청도 거부.
- Runtime validation: ID 검사, 기존 safe_path/sources_for, 잠금 안의 상태+자료 revision 재검사, 기존 scoped approvals/quality/final 검증 유지. Structured error 응답에 Python traceback 없음.

## Theme separation

업무 status/ready/attention type/allowed_actions와 CSS design tokens를 분리했다. default-light만 구현했다. Pixel Office는 Runtime 변경 없이 새 표현 계층으로 만들 수 있으며 복잡한 plugin system은 추가하지 않았다.

## Tests

- Existing regression: 시작 기준 104 unit + 7 local HTTP/CLI 재실행 PASS.
- New GUI tests: 15개; 전체 discovery 119 PASS. 실제 HTTP GUI→Runtime→Gateway→fake model→Archive, server restart, permission/quality/plan 결정, stale, path/ID, immutable history, session 경계를 포함한다.
- Frontend: Node stdlib VM 6 checks; GUI 실행에는 Node가 필요 없다.
- Browser/manual: 실제 Chrome에서 새 Plan→Planning permission→Worker permission→Manager permission→Task 완료→Final permission→COMPLETE→Archive를 클릭했다. 별도로 Task ESCALATE rework→Plan resume, Plan Final ESCALATE cancel을 확인했다. CLI GUI 재시작 후 같은 상태가 표시됐다. [실제 검토와 해시](evidence/gui-browser-review.json).
- compileall, JS syntax, git diff --check PASS. 최종 통합 후 같은 전체 회귀를 확인한다.

## Known limitations

현재 대화에 기준 이미지가 첨부되지 않아 문서의 흰색/회색·파란 포인트·카드·여백·layout 지침을 사용했다. 브라우저 screenshots는 도구에서 직접 검토했으며 파일로 보존하지 않았다. 새 GUI 검증은 로컬 합성 모델만 사용해 외부 모델 품질/비용을 새로 검증하지 않았다. 기존 실제 모델 evidence는 유지했다.

정책은 JSON 붙여넣기, source는 경로 입력이다. 파일 업로드/호스트 정책 탐색/Prompt Editor/Full Model Management는 없다. 기존 과거 이벤트에는 없는 시각을 만들어 채우지 않고 미기록/event sequence로 표시한다. 새 요청에는 실제 attention/run/completion 시각을 저장한다. 조회는 수동 새로고침/요청 완료 시 갱신하며 polling/streaming/WebSocket은 없다. 모델 실행 중 단일 서버가 요청을 동기 처리한다. 원격 인증/계정/악성 로컬 프로세스 격리/Pixel Office/다중 Worker/병렬 작업/자동 scheduler는 범위 밖이다.

## Docs

README, DESIGN, PRD의 GUI 범위, CONCEPT의 Manager's Office 구현 경계, VALIDATION, current-plan, 이 보고서와 browser evidence를 갱신했다. 예전 단일 Task/다중 Task 증거는 보존했다.

## Git Flow

| Feature | 주요 commits | develop merge |
|---|---|---|
| gui-foundation | `de8db92` server/adapter/Runtime revision/CLI/tests | `22834e2` |
| gui-dashboard | `90f5aec` Dashboard/views/create/run/decisions | `5406723` |
| gui-evidence | `61fa0c7` lifecycle/session fixes, `606a583` workflow/HTTP/browser evidence; 최종 UI 및 문서 commits는 git log 참조 | 최종 통합 단계 |

각 feature가 실제 최신 검증 develop에서 만들어졌고 기능별 commit/test/merge 후 다음 feature를 시작했다. 최종 merge/HEAD는 자기 참조를 피하기 위해 완료 응답에서 보고한다. main 기준 `230e304ca394e1cfa918877335c23ee7e686f10d`를 유지한다. push/PR/release/main merge는 하지 않는다. 최종 working tree clean을 확인한다.

## Recommended next step

공개 가능한 실제 업무를 GUI에서 수행해 생성 폼·판단 이유·오류 설명·읽기 흐름을 평가한다. Pixel Office는 기존 state/action 계약을 재사용하는 별도 시각 계층으로 후속 검토한다.
