# 목표

현재 Nidus `develop` 브랜치를 기준으로 **Nidus Local GUI v1**을 구현하라.

이번 작업의 목표는 새로운 업무 엔진을 만드는 것이 아니다.

현재 구현된:

```text
Execution Plan
→ PlanRuntime
→ 기존 Task Runtime
→ Manager / Worker workflow
→ Security / Store / Git
```

위에 사용자가 상태를 보고, 판단하고, 다음 실행 단계를 명시적으로 시작할 수 있는 **로컬 GUI 계층**을 추가한다.

핵심 원칙:

> GUI는 Nidus의 새로운 두뇌가 아니다.

> GUI는 기존 Runtime의 상태를 보여주고 사용자의 명령을 전달하는 인터페이스다.

---

# 1. 기준 UI

첨부된 Dashboard 이미지를 **Default GUI의 시각적 기준**으로 사용한다.

전체적으로:

```text
깨끗한 흰색/연회색 배경
파란색 포인트
macOS와 잘 어울리는 현대적인 Dashboard
둥근 카드
얇은 Border
과하지 않은 Shadow
명확한 상태 Badge
넉넉한 여백
```

을 사용한다.

기본 화면 구조:

```text
┌────────────┬────────────────────────────────┬───────────────────┐
│            │                                │                   │
│   NIDUS    │ Dashboard                      │ 사람 판단함       │
│            │                                │                   │
│ 홈         │ 상태 요약                       │ 전송 승인         │
│ Plans      │                                │                   │
│ Tasks      │ 최근 Plans │ 선택된 Plan        │ 품질 판단         │
│ 판단함     │             │                    │                   │
│ Archive    │             │ Task 목록          │ 최근 완료 Task    │
│            │             │                    │                   │
│ Vault      │             │ 진행도             │                   │
│ 설정       │                                │                   │
└────────────┴────────────────────────────────┴───────────────────┘
```

현재 단계에서는 픽셀 아트나 게임형 Office UI를 구현하지 않는다.

단, 향후 같은 상태 데이터를:

```text
Default Dashboard Theme
Pixel Office Theme
```

등으로 표현할 수 있도록 **업무 상태와 시각 표현을 분리**한다.

---

# 2. GUI의 책임

GUI는 다음 세 가지 행동에 집중한다.

```text
Observe
→ 현재 상태를 본다.

Decide
→ 사람에게 요청된 판단을 처리한다.

Run
→ 다음 한 단계를 실행한다.
```

GUI가 직접 다음을 판단해서는 안 된다.

```text
Task Ready 여부
Dependency 충족 여부
Task 완료 여부
Plan 완료 여부
승인 유효성
Snapshot 유효성
권한 유효성
Plan 변경 가능 여부
```

이것들은 기존 Runtime의 책임이다.

---

# 3. Architecture

권장 구조:

```text
Browser
   ↓
Local GUI Server
   ↓
GUI Service / API Adapter
   ↓
PlanRuntime / Runtime
   ↓
Store / Security / Gateway / Git
```

금지:

```text
GUI
→ SQLite 직접 UPDATE

GUI
→ Task 상태 직접 변경

GUI
→ Plan 상태 직접 변경
```

모든 상태 변경은 기존 Runtime 또는 이를 얇게 감싼 public service를 통해서만 수행한다.

CLI와 GUI가 서로 다른 업무 로직을 가지지 않도록 한다.

가능하면:

```text
CLI ─┐
     ├→ shared Nidus application/service layer
GUI ─┘
          ↓
      Runtime
```

구조를 사용한다.

필요하면 기존 CLI 내부 로직을 최소한으로 추출하여 재사용 가능한 service 함수로 만든다.

GUI 구현을 위해 Runtime 전체를 리팩터링하지 않는다.

---

# 4. 기술 방향

v1은 **로컬 웹 GUI**로 구현한다.

실행 예:

```bash
python3 -m nidus --vault "$vault" gui
```

기본 주소:

```text
http://127.0.0.1:8765
```

원칙:

- `127.0.0.1`에만 Bind한다.
- 외부 네트워크에 노출하지 않는다.
- GUI 자체에는 외부 CDN/폰트/JavaScript 의존성을 두지 않는다.
- 가능한 한 현재 Python Runtime과 자연스럽게 통합한다.
- Frontend는 단순한 HTML/CSS/JavaScript로 충분하다.
- 큰 SPA Framework나 Electron/Tauri는 이번 범위에서 도입하지 않는다.
- 새로운 Python dependency가 필요하다면 이유를 문서화하고 최소화한다.
- 현재 표준 라이브러리만으로 안정적으로 구현 가능하다면 그것을 우선 검토한다.

Frontend Build Pipeline이 없어도 실행 가능하도록 하는 것을 선호한다.

---

# 5. Theme와 업무 상태 분리

GUI 코드에서 상태와 색/레이아웃을 강하게 결합하지 않는다.

예:

```text
PlanStatus
TaskStatus
AttentionType
AllowedActions
```

등은 UI 데이터 모델로 전달하고,

표현은 CSS/Component에서 결정한다.

CSS 변수 또는 동등한 Design Token을 사용한다.

예:

```text
--color-accent
--color-success
--color-warning
--color-danger
--surface-primary
--surface-secondary
--border-color
--text-primary
--text-secondary
```

현재는 `default-light`만 구현한다.

향후 Pixel Office Theme가 Runtime 수정 없이 추가될 수 있는 구조를 선호한다.

단, 아직 복잡한 Theme Plugin System은 만들지 않는다.

---

# 6. Dashboard

첫 화면은 첨부 이미지와 유사하게 구성한다.

상단 요약:

```text
진행 중 Plan
사람 판단 필요
실행 가능한 Task
완료된 Plan
```

각 수치는 반드시 Runtime/Store의 실제 상태에서 계산한다.

그 아래:

```text
최근 Plans
선택된 Plan
사람 판단함
최근 완료 Task
```

을 보여준다.

사용자가 페이지를 처음 열었을 때 가장 중요한 질문:

> 지금 Nidus에서 무슨 일이 진행 중인가?

에 답할 수 있어야 한다.

---

# 7. Navigation

v1 Navigation:

```text
홈
Plans
Tasks
사람 판단함
Archive
설정
```

하단에는 현재 Vault를 표시한다.

예:

```text
현재 Vault
/tmp/nidus-example-vault
```

Settings는 복잡한 설정 편집기가 아니라 최소한의 read-only 정보 화면으로 시작해도 된다.

예:

```text
Vault path
Nidus version
GUI bind address
기본 Task/Plan limit
현재 사용 정책 정보
```

작동하지 않는 버튼이나 메뉴를 장식용으로 두지 않는다.

---

# 8. Plans 화면

활성 Plan 목록을 보여준다.

각 Plan 카드에는 최소:

```text
제목 또는 Goal 요약
상태
완료 Task / 전체 Task
생성 시각
Manager
Plan version
사람 판단 필요 여부
```

를 표시한다.

Plan을 선택하면 상세 화면으로 이동한다.

---

# 9. Plan 상세 화면

첨부 이미지의 중앙 패널을 기준으로 한다.

Header:

```text
Plan 제목
상태 Badge
Goal 설명
생성 시각
Manager
Plan Version
[다음 단계 실행]
```

Tabs:

```text
작업 목록
의존 관계
전체 정보
실행 기록
```

v1에서는 탭을 모두 구현하되 지나치게 복잡하게 만들지 않는다.

---

# 10. Task 목록

Plan 안의 Task를 표 형태로 보여준다.

최소 열:

```text
local_key
제목
상태
의존성
담당 Worker/Manager
Ready 여부
완료/실행 시각
```

상태 예:

```text
완료
실행 가능
대기
진행 중
사람 판단 필요
차단됨
취소됨
```

Ready 여부는 GUI가 계산하지 않는다.

Backend가 Runtime 상태를 기준으로 제공한다.

Task를 선택하면 Task 상세 화면 또는 Side Panel을 보여준다.

---

# 11. Dependency View

v1에서는 무거운 Graph Library를 도입하지 않는다.

다음 중 단순하고 안정적인 방식을 선택한다.

```text
T1 ─┐
    ├→ T3 → T4
T2 ─┘
```

또는 카드/연결선 기반의 간단한 DAG 표현.

필수 목적은:

> 어떤 Task가 무엇을 기다리고 있는지 사람이 이해할 수 있게 하는 것

이다.

그래프 편집 기능은 만들지 않는다.

---

# 12. Task 상세

Task 상세에서는 기존 Manager/Worker workflow를 사람이 이해할 수 있게 보여준다.

최소:

```text
Task ID / local_key
Goal
상태
Manager
Worker
Dependencies
Completion Contract
Worker result
Worker self-check
Deterministic checks
Manager Review
REWORK history
Result reference
Output hash
관련 timestamps
```

Completed Task의 과거 기록을 GUI에서 편집할 수 없게 한다.

---

# 13. 사람 판단함

이 화면은 v1의 핵심 기능이다.

현재 Nidus의 다양한 `attention`을 한 곳에서 보여준다.

단, 종류를 섞어 표현하지 않는다.

최소 유형:

```text
외부 모델 전송 승인
출력 덮어쓰기 승인
Task 품질 판단
Task ESCALATE
Plan Final ESCALATE
Plan 재개 필요
```

각 Attention 카드에는:

```text
종류
관련 Plan / Task
요청한 역할
발생 시각
이유
정확한 전송/판단 범위
허용된 행동
```

을 보여준다.

---

# 14. Permission과 Quality를 명확히 구분

특히 다음 두 종류는 시각적으로 명확히 다르게 표현한다.

### Permission

예:

```text
외부 모델 전송 승인

manager-1이 다음 자료를 전송하려고 합니다.

notes.md
T1 승인 결과
T2 승인 결과

[상세 범위]
[거부] [승인]
```

### Quality / Human Judgment

예:

```text
사람의 업무 판단 필요

Manager decision: ESCALATE

이유:
두 결과 중 어떤 기준을 우선해야 하는지
현재 정보만으로 결정하기 어렵습니다.

[취소]
[재작업]
[계속]
```

GUI가 가능한 행동을 추측하지 않는다.

Backend가 현재 attention에 대해 `allowed_actions` 또는 동등한 데이터를 제공하는 것을 선호한다.

---

# 15. 다음 단계 실행

가장 중요한 Primary Action:

```text
[다음 단계 실행]
```

이다.

이 버튼은 현재 `plan-run`의 의미를 그대로 가져야 한다.

즉 클릭 한 번:

```text
사용자 클릭
↓
PlanRuntime 한 bounded step
↓
State persist
↓
응답
↓
화면 갱신
```

이다.

금지:

```text
while plan not complete:
    계속 run
```

GUI가 자동으로 Plan 전체를 실행하지 않는다.

현재 CLI의 명시적 실행/재개 경계를 보존한다.

---

# 16. 실행 중 UI

모델 호출은 시간이 걸릴 수 있다.

버튼 클릭 후에는:

```text
실행 중...
```

상태를 보여주고 중복 실행 버튼을 잠근다.

Frontend의 HTTP 요청이 끝날 때까지 Spinner 또는 Progress 표시를 제공한다.

새로운 별도 Autonomous Background Scheduler는 만들지 않는다.

Runtime의 기존 persistence/recovery/idempotency 성질을 유지한다.

---

# 17. 새 Plan 만들기

Dashboard의:

```text
+ 새 Plan 만들기
```

버튼으로 간단한 생성 UI를 제공한다.

최소 입력:

```text
사용자 요청
Source(s)
Planning model policy
```

Advanced 영역에서 필요하면:

```text
Worker policy
Review policy
Final policy
Initial Task limit
Total Task limit
Revision limit
```

을 설정할 수 있다.

기본값은 현재 CLI 기본값을 사용한다.

GUI만의 새로운 기본값을 만들지 않는다.

Source path는 Vault 기준이며 기존 Runtime 경로 검증을 그대로 통과해야 한다.

가능하면 Vault에서 허용되는 `.md/.txt` 파일을 안전하게 선택할 수 있는 UI를 제공하되, 이를 위해 범위를 과도하게 키우지 않는다.

---

# 18. Archive

완료된 Plan과 Task를 조회할 수 있다.

Archive에서는:

```text
완료 시각
Goal
Task 수
Final Review
결과
Plan Version
```

등을 볼 수 있다.

Archive는 기본적으로 read-only다.

---

# 19. API / GUI Adapter

구체적인 endpoint 이름은 현재 코드 구조를 분석하여 정한다.

개념적으로는 다음 기능이 필요하다.

```text
GET  overview

GET  active plans
GET  archived plans
GET  plan detail
GET  task detail
GET  attentions

POST create plan
POST run plan one step
POST plan decision
POST task decision
POST task quality decision
```

API layer는 Store를 직접 수정하지 않는다.

항상 기존 application/runtime 계층을 통한다.

오류 응답은 구조화한다.

예:

```json
{
  "error": "PLAN_BLOCKED",
  "message": "...",
  "details": {}
}
```

Frontend에서 Python traceback을 그대로 사용자에게 노출하지 않는다.

개발 로그에는 원인을 보존한다.

---

# 20. Local GUI Security

GUI도 Nidus Security boundary의 일부로 취급한다.

최소:

```text
127.0.0.1 only
GET과 mutation 요청 구분
mutation은 POST 사용
Origin 확인
요청 위조 방지
잘못된 ID 거부
Vault 밖 경로 거부
Runtime permission 우회 금지
```

를 구현한다.

브라우저의 다른 사이트가 localhost Nidus에 임의 POST를 보내는 것을 막기 위해
간단한 per-session token/CSRF 방어 또는 동등한 보호를 사용한다.

GUI Token은 Nidus Task/Prompt/Log에 유출하지 않는다.

외부 접근용 인증 시스템은 이번 범위에서 구현하지 않는다.

---

# 21. 기존 Runtime이 최종 진실

GUI에 표시된 상태가 stale일 수 있다는 점을 고려한다.

사용자가 버튼을 눌렀을 때 Backend는 항상 현재 Runtime 상태를 다시 확인한다.

예:

```text
화면상 승인 가능
↓
그 사이 snapshot 변경
↓
사용자 승인 클릭
↓
Runtime 재검증
↓
승인 거부
↓
GUI 최신 상태 갱신
```

Frontend 상태만 믿고 mutation하지 않는다.

---

# 22. 오류 처리

사용자가 이해할 수 있게 다음을 구분한다.

```text
Waiting
Blocked
Invalid decision
Stale approval
Model failure
Permission denied
Malformed model output
Runtime error
```

사용자에게는 친화적인 설명을 보여주되,
원본 오류/진단 정보는 필요하면 펼쳐볼 수 있게 한다.

기존 오류 의미를 GUI가 새롭게 재해석하지 않는다.

---

# 23. 반응형 범위

이번 GUI는 데스크톱 사용을 우선한다.

기준:

```text
Mac mini / Desktop browser
```

화면이 좁아지면:

```text
오른쪽 사람 판단함
→ 아래로 이동

최근 Plan sidebar
→ 접기 또는 상단으로 이동
```

정도의 기본 반응형은 지원한다.

모바일 전용 UX는 이번 완료 기준이 아니다.

---

# 24. 이번에 구현하지 않는 것

```text
Pixel-art Office Theme
Manager 캐릭터
Worker 캐릭터
사무실 Map
Drag & Drop Plan editing
Dependency 직접 편집
Task 상태 직접 편집
Prompt Editor
Employee Management
Multiple Workers
Parallel Execution
Project / Phase
Full Model Management UI
Git Client UI
실시간 Token Streaming
WebSocket 기반 실시간 Dashboard
Electron / Tauri packaging
Remote access
User accounts
Complex analytics
```

향후 Theme 구현을 막는 구조만 만들지 않으면 된다.

---

# 25. 테스트

Frontend 모양만 만들고 끝내지 않는다.

최소 자동 테스트:

### Server

```text
GUI server가 127.0.0.1에 시작
기본 페이지 반환
정적 asset 반환
외부 bind 금지 또는 명시적 거부
```

### Dashboard

Seed된 Store 상태가 올바른:

```text
active plans
human attentions
ready tasks
archive count
```

로 변환된다.

### Plan Detail

```text
Task order
dependency
status
ready
manager/worker
progress
```

가 실제 Plan state와 일치한다.

### One-step Run

```text
POST run
→ PlanRuntime 정확히 한 bounded step
```

만 수행한다.

자동 전체 실행이 없어야 한다.

### Permission Decision

GUI 승인/거부가 기존 permission decision 경로를 사용한다.

### Quality Decision

GUI의 quality action이 permission 경로와 섞이지 않는다.

### Plan Decision

Plan ESCALATE / resume / cancel이 기존 의미를 유지한다.

### Stale State

오래된 UI 상태에서 mutation 요청을 보내도 Runtime이 다시 검증한다.

### Security

```text
잘못된 CSRF/session token
잘못된 Origin
invalid ID
path traversal
```

이 거부된다.

### Completed History

GUI를 통해 Completed Task/Plan 과거 기록을 임의 변경할 수 없다.

### Recovery

GUI server 재시작 후 기존:

```text
Plan
Task
Attention
Next step
Archive
```

상태를 정상적으로 다시 표시한다.

---

# 26. 수동 UI 검증

최소 다음 시나리오를 실제 브라우저에서 확인한다.

```text
Dashboard 열기
→ 기존 Plan 목록 확인
→ Plan 선택
→ Task 상태 확인
→ 다음 단계 실행
→ 외부 전송 승인 카드 표시
→ 승인
→ 다음 단계 실행
→ Task 완료
→ Final Review
→ Archive
```

별도로:

```text
Task Quality ESCALATE
Plan ESCALATE
```

상태도 확인한다.

브라우저 자동화 도구가 없다면 없는 기능을 꾸며내지 말고
실제 가능한 수준에서 수동 검증 절차와 결과를 기록한다.

---

# 27. 기존 회귀 유지

현재 기준은:

```text
104 offline unit tests
7 local HTTP/CLI tests
compileall
git diff --check
```

이며 실제 `develop` HEAD에서 다시 확인한다.

GUI 때문에 기존:

```text
Single Task Runtime
Manager/Worker workflow
PlanRuntime
Security
Gateway
Recovery
Archive
Git
```

동작이 깨져서는 안 된다.

GUI 테스트를 추가한 뒤 전체 회귀를 다시 수행한다.

---

# 28. 문서

최소 다음을 갱신한다.

```text
README.md
DESIGN.md
docs/CONCEPT.md
docs/VALIDATION.md
docs/plans/current-plan.md
```

README에는:

```bash
python3 -m nidus --vault "$vault" gui
```

부터 GUI 사용 흐름을 설명한다.

DESIGN에는:

```text
GUI
→ Application/API Adapter
→ Runtime
```

경계를 명확히 기록한다.

CONCEPT에는 이번 GUI를 장기적으로 `Manager's Office`의 초기 구현으로 볼 수 있음을 기록하되,
아직 Pixel Office/Employee spatial UI는 구현되지 않았음을 구분한다.

---

# 29. Git Flow — 실제 개발 과정에서 적용

반드시 최신 `develop`에서 시작한다.

`main`에 직접 작업하지 않는다.

GUI 범위가 크므로 논리적 기능 단위로 feature branch를 나눈다.

권장 예:

```text
feature/gui-foundation
feature/gui-runtime-api
feature/gui-workflow-actions
feature/gui-dashboard
feature/gui-evidence
```

실제 코드 의존성에 따라 일부를 합쳐도 된다.

중요한 것은 branch 개수가 아니라:

```text
검증 가능한 작은 기능
명확한 Commit
안정된 develop
```

이다.

기본 흐름:

```text
develop
↓
feature branch
↓
구현
↓
관련 테스트
↓
논리 단위 commit
↓
develop merge
↓
develop 전체 관련 회귀
↓
다음 feature branch
```

브랜치 이동 전:

```bash
git status
```

를 확인하고 미커밋 변경을 다른 브랜치로 가져가지 않는다.

기능이 완성될 때마다 중간 Commit한다.

예:

```text
feat: add local GUI server and application adapter
feat: expose read-only dashboard state
feat: add plan and task detail views
feat: connect bounded plan execution
feat: add permission and quality decisions
feat: add plan creation flow
test: cover GUI runtime and security boundaries
docs: document local GUI workflow
```

모든 작업 후 한 번에 거대한 Commit 하나를 만들지 않는다.

기능 branch가 검증되면 `develop`에 병합하고,
다음 작업은 다시 최신 `develop`에서 branch를 만든다.

`main`, `release/*`, `hotfix/*`는 이번 Slice에서 변경하지 않는다.

원격 push / PR / main merge는 사용자가 별도로 요청하지 않는 한 수행하지 않는다.

Git 이력을 마지막에 사후 조작하지 말고 실제 개발 과정이 기록되게 한다.

---

# 30. 완료 조건

다음을 모두 만족해야 한다.

1. `python3 -m nidus --vault "$vault" gui`로 로컬 GUI를 실행할 수 있다.
2. 서버는 기본적으로 `127.0.0.1`에만 Bind한다.
3. Dashboard가 실제 Plan/Task/Attention 상태를 보여준다.
4. Plans 목록과 상세를 볼 수 있다.
5. Task 상세와 기존 Manager/Worker 업무 이력을 볼 수 있다.
6. 사람 판단함에서 Permission과 Quality 판단을 명확히 구분한다.
7. 기존 permission / quality / plan decision 경로를 GUI에서 사용할 수 있다.
8. 새 Plan을 GUI에서 만들 수 있다.
9. `[다음 단계 실행]`은 PlanRuntime 한 단계만 진행한다.
10. GUI가 DB를 직접 수정하지 않는다.
11. Ready/Completed/Approval 유효성은 Runtime이 최종 결정한다.
12. Completed history가 GUI에서도 immutable하다.
13. Archive를 조회할 수 있다.
14. Runtime 오류와 stale state를 안전하게 처리한다.
15. CSRF/Origin 또는 동등한 localhost mutation 보호가 있다.
16. 외부 CDN 없이 기본 GUI가 작동한다.
17. 기존 104+7 기준을 포함한 전체 회귀가 유지된다.
18. GUI 관련 자동 테스트가 추가된다.
19. 실제 브라우저에서 주요 workflow를 검증한다.
20. 문서가 실제 구현과 일치한다.
21. Git Flow를 실제 구현 과정에서 지킨다.
22. `main`은 변경하지 않는다.
23. 최종 `develop` working tree가 clean하다.

---

# 31. 최종 보고

작업 완료 후 다음 형식으로 보고하라.

```text
Status

Starting develop HEAD

Architecture
- GUI server
- application/API adapter
- Runtime reuse
- Store boundary

Frontend
- Dashboard
- Plans
- Tasks
- Human Attention
- Archive
- Settings

Workflow actions
- create plan
- run one step
- permission decisions
- quality decisions
- plan decisions

Security
- bind address
- mutation protection
- runtime validation

Theme separation
- current default theme
- future Pixel Office compatibility

Tests
- existing regression
- new GUI tests
- browser/manual validation

Known limitations

Docs

Git Flow
- feature branches
- 주요 commits
- develop merge commits
- final develop HEAD
- main unchanged
- working tree clean

Recommended next step
```

---

# 핵심 철학

이번 GUI의 목적은 Nidus를 다시 만드는 것이 아니다.

```text
GUI
→ 보여준다
→ 사용자 입력을 받는다

Runtime
→ 판단된 시스템 규칙을 강제한다
→ 상태를 변경한다
```

이어야 한다.

첫 GUI는:

> **본다 → 판단한다 → 실행한다**

에 집중한다.

현재 깨끗한 Dashboard를 먼저 완성하고,
향후 같은 Runtime state를 기반으로 Manager와 Worker를 캐릭터로 표현하는
Pixel Office Theme를 별도 표현 계층으로 추가할 수 있게 설계하라.

현재 Nidus의 핵심 업무 로직을 최대한 재사용하고,
GUI 구현 때문에 Runtime의 의미를 복제하거나 변경하지 마라.

계획만 작성하고 멈추지 말고:

```text
저장소 분석
→ Git Flow branch 생성
→ GUI 기반 구조
→ Runtime Adapter
→ Dashboard/Plan/Task UI
→ 판단/실행 연결
→ 보안
→ 테스트
→ 브라우저 검증
→ 문서화
→ develop 통합
→ 전체 회귀
```

까지 완료하라.