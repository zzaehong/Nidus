# Phase 5–6: Single Agent Runtime · Vault · Sandbox

## 승인된 설계와 구현 상태

기준 develop: `81ecb887cd2f2b8803ead55c0c50d945aacbf15a`.
작업 브랜치: `feature/agent-runtime-vault-sandbox`.

이 문서는 승인된 통합 계획의 구현 기준이다. **아래 계약은 구현 목표이며, 완료된 기능 목록이 아니다.** 단계별 실제 결과는 마지막 검증 기록으로 구분한다. 현재 제품의 Provider·Router·권한·사용량·SwiftUI 동작은 M0 진단으로 변경하지 않는다. 실제 API 호출, 원격 push, develop 병합은 별도 승인 없이 수행하지 않는다.

이전 네이티브 설계의 사용자 선택(역사 기록; Shell 경계는 아래 VM M0로 대체):

- macOS 네이티브 Shell, 원본 Vault 직접 실행.
- 파일 Tool 쓰기·수정은 Diff 승인, 파일 삭제는 개별 승인.
- Shell은 정확한 명령과 지정 경로의 **수정·삭제 가능성 전체를 명령 단위로 승인**한다. Shell 내부의 개별 파일 삭제 사전 승인을 보장하지 않는다.
- 외부 네트워크는 기본 차단, 요청별 별도 승인. 네트워크 허용 Shell은 Vault 정보를 외부로 전송할 수 있음을 명시한다.
- 전용 브라우저 검색·공개 페이지 읽기 포함. 로그인·임의 폼 제출·다운로드·게시·구매 제외.
- 기존 8개 Provider의 Tool Calling 변환 지원. 개별 모델의 실제 지원 여부가 불명확하면 Agent 후보에서 제외.
- M0에서 네이티브 격리를 먼저 검증한다. 검증 전 Shell·브라우저 실행을 활성화하지 않는다.

현재 방향: **Host 앱·엔진은 유지하고 Shell은 VM 내부의 승인된 작업 복사본에서만 실행**한다. 아래 기존 계약은 구현 목표로 보존하며, 이번 범위는 문서 끝의 VM M0 prototype뿐이다. 전체 M0 자격 판정은 아직 미통과이며 M1~M6는 보류한다.

## 기존 구조 재사용

`ConnectivityEngine.execute`의 API 권한 재검사·사용량 기록을 Agent 호출에도 적용한다. Router의 Tier 우선순위·안전한 초기 Fallback을 재사용한다. Soft Budget은 참고 정보이며 비용 기반 차단은 도입하지 않는다. 기존 ChatRequest는 user/assistant 문자열 메시지만 받고, Adapter 응답은 텍스트가 비면 오류 처리하므로 Tool 전용 타입·응답 처리가 필요하다.

SwiftUI의 Runtime은 요청마다 Node 자식을 만들고 단일 최종 JSON을 받는다. 기존 채팅·설정 흐름을 유지하며 Agent 전용 양방향 채널을 추가한다. 현재 Runtime.shutdown은 직접 자식 PID만 종료하므로 Shell의 손자·분리된 자식 종료를 보장한다고 취급하지 않는다.

Keychain과 로컬 모델 캐시, Usage Ledger(schema 8), Routing Context v2를 유지한다. API Key·Provider 자격 증명은 Shell·브라우저·Vault 메타데이터에 전달하지 않는다.

## 데이터 계약

### Vault

- `VaultDescriptor`: schemaVersion, vaultId(UUID), displayName, createdAt.
- `.nidus/vault.json`: 이동 가능한 식별 정보. 절대 경로와 기기별 연결 정보는 앱 로컬 Registry에 저장.
- `.nidus/executions.sqlite`: Vault별 실행 감사 DB. 전역 Usage Ledger와 분리하고 requestId로 연결.
- 등록·선택·전환·해제와 새 디렉터리 생성 지원. 해제는 프로젝트 삭제가 아님.
- 동일 ID 복사본은 이동/독립 복사본을 명시적으로 선택. 중첩 Vault 및 홈·파일시스템 루트 전체 등록 거부.
- 앱·CLI 합계 하나의 Agent 실행만 허용. OS 잠금으로 중복 실행 방지. 실행 중 Vault 전환·해제 거부.

파일 Tool은 상대 경로만 받는다. 절대 경로, `..`, NUL, 심볼릭 링크 경유, 다중 하드링크, 특수 파일을 거부한다. Native Helper가 루트 핸들 기준 경로 순회와 링크 추적 방지, 파일 동일성 재검사를 수행해야 한다. 문자열 정규화만으로 경로 안전을 주장하지 않는다. `.nidus`, `.git`, 알려진 자격 증명 파일은 Agent 접근에서 제외한다.

### Tool / Permission

- `ToolDefinition`: name, version, inputSchema, permissions, outputLimit.
- `ToolInvocation`: runId, toolCallId, toolName, input, inputHash.
- `ToolResult`: status(succeeded/failed/denied/cancelled), boundedOutput, truncated, structuredError.
- `PermissionRequest`: approvalId, runId, toolCallId, action, targetPaths, diff/command, networkScope, expiresAt, policyRevision, payloadHash.
- `PermissionDecision`: approvalId, payloadHash, decision(approve/deny/cancel), decidedAt.

Tools: list_files, read_file, write_file, apply_patch, delete_file, run_shell, web_search, read_web_page.

모든 실행은 공통 Permission Gateway를 통과한다. 모델이 보내는 approved/permission 필드를 권한으로 취급하지 않는다. 읽기는 보호 경로 외 기본 허용. 쓰기는 현재 파일 해시와 Diff를 승인받고 실행 직전에 재검증한다. 파일 변경·인자 변경·revision 변경 시 승인을 무효화한다. 삭제는 파일별 승인만 지원하며 재귀 디렉터리 삭제 Tool은 제공하지 않는다.

승인은 호출별 일회성이다. 중복 응답·만료·취소 후 응답으로 실행하지 않는다. 승인 대기에 DB 트랜잭션을 열어두지 않는다. 권한 확인·실행 전 감사 기록 저장에 실패하면 새 부작용을 실행하지 않는다. 쓰기는 임시 파일과 원자적 교체를 사용하며, 성공 여부를 알 수 없는 중단은 outcome_unknown으로 남긴다. 자동 재실행·자동 rollback을 약속하지 않는다.

### 실행 / 감사 이벤트

`AgentRun`: runId, vaultId, state, startedAt, endedAt, limits, stopReason, usageRequestIds.
상태: created → running ↔ awaiting_approval → succeeded / failed / cancelled / limit_reached / interrupted.

`ExecutionEvent`: schemaVersion, eventId, runId, vaultId, sequence, timestamp, type, toolCallId?, approvalId?, requestId?, status, errorCode?, durationMs?, metadata.

이벤트: 실행 시작/종료, 모델 선택, LLM 요청, Tool 제안/시작/완료, 승인 요청/결정, 파일 변경 결과, 제한 도달, 중단. sequence는 실행별 단조 증가한다. 저장 정보는 경로·변경 종류·전후 해시·결과 코드·소요 시간·토큰·Usage Ledger 요청 연결 등 최소 기록으로 한정한다.

프롬프트, 파일 본문, 출력 원문, 웹 본문, API Key, 모델 내부 추론, continuation 원문은 저장하지 않는다. 정확한 명령·Diff는 현재 실행 UI 메모리에만 표시하고 감사 DB에는 해시·실행 파일·권한 범위를 기록한다. 재시작 후 실행 사실과 결과는 볼 수 있지만 과거 Diff·대화·작업 맥락을 복구하지 않는다. 감사 기록은 위변조 방지 저장소나 백업이 아니다.

## Runtime와 UI 프로토콜

Agent 전용 Node worker ↔ Swift AgentRuntimeSession의 NDJSON 양방향 통신을 추가한다. 기존 dashboard 단발 JSON은 유지한다.

- Swift → Node: start, approval_decision, cancel, shutdown.
- Node → Swift: ready, execution_event, approval_required, terminal, error.
- protocolVersion, messageId, runId를 사용하고 이벤트에 sequence 포함.
- stdout은 프로토콜 전용. Shell 출력은 별도 파이프에서 수집.
- 잘못된 프레임·연결 종료·출력 초과·앱 종료는 취소로 처리. 승인 창 종료·무응답을 승인으로 해석하지 않는다.
- CLI도 동일 Runtime·Gateway 사용. 비대화형 호출은 승인 필요 작업을 거절하고 자동 승인 옵션을 제공하지 않는다.

실행 순서:

1. Vault·실행 잠금·모델·backend 준비 상태 확인, 감사 실행 생성.
2. 요청은 메모리 보관. 수동 모델 또는 기존 Router로 Tool 지원 모델 선택.
3. 공통 LLM 호출 경로에서 계정 권한·Tier 재검사, 실제 전송 횟수 기록.
4. Tool Call 스키마 검증 → 권한 검사 → 사용자 승인 → 직전 재검사 → 순차 실행.
5. 제한된 결과를 메모리 대화에 추가하고 반복. 최종 텍스트 또는 제한·취소·실패에서 종료.

Tool-only 응답을 정상 처리한다. OpenAI Responses, Anthropic content blocks, Gemini functionCall/functionResponse 및 thought signature, OpenAI-compatible tool_calls/tool messages를 Provider별로 손실 없이 변환한다. 모델 목록을 임의 생성하지 않으며 지원 근거를 공식 자료와 함께 유지한다. 첫 유효 응답 이후 모델은 고정한다. continuation을 다른 Provider로 자동 전달하지 않는다. 타임아웃·전송 불명확·부작용 불명확 시 자동 재시도하지 않는다.

| 제한 | 기본값 |
|---|---:|
| 실제 LLM 시도(Fallback 포함) | 20회 |
| 실행 시간(승인 대기 포함) | 15분 |
| Tool 호출 | 100회 |
| 한 응답 Tool Calls | 8개, 순차 |
| 동일 Tool·인자 연속 반복 | 3회 |
| 파일 읽기·패치 입력 | 1 MiB |
| 모델에 전달하는 Tool 출력 | 64 KiB |
| Shell 시간 | 120초 |
| Shell 수집 출력 합계 | 1 MiB |
| 웹 요청 | 30초 |
| NDJSON 프레임 | 2 MiB |

LLM 횟수는 실제 Adapter 전송 직전 검사한다. 컨텍스트 한도 초과 시 명시적으로 종료한다. 요약·압축·자동 복구는 구현하지 않는다.

## Sandbox와 M0 채택 기준

1. sandbox-exec: 로컬 개발 환경에서 먼저 검증하는 후보. macOS 매뉴얼이 deprecated로 표시하므로 장기 지원 보장이 없다.
2. App Sandbox·XPC: 공식 분리 방식이나 서명·패키징·권한 상속·SDK 호환성 검증이 필요하다.
3. Linux VM/컨테이너: 사용자의 macOS 네이티브 요구와 달라 기본 backend에서 제외.

**M0 후보가 필수 검증을 통과하지 못하면 backend를 채택하지 않는다. App Sandbox·XPC 전환안은 별도 설계 승인 대상으로 보고한다. 일반 spawn이나 비격리 브라우저로 대체하지 않는다.**

Shell은 승인된 Vault 범위만 변경 가능. 시스템 실행 파일·라이브러리·SDK는 검증된 읽기 전용 예외다. 홈·다른 Vault·앱 DB·Keychain·Docker socket은 허용하지 않는다. 새 환경변수 허용 목록, 실행별 HOME/TMPDIR/캐시, 셸 초기화 파일 미사용. 명령 승인에는 정확한 명령·cwd·수정/삭제 범위·네트워크 상태를 표시한다. 명령 종료가 프로세스 트리 전체 종료와 같다고 가정하지 않는다.

Supervisor는 UI/worker 연결 종료·시간 제한을 처리하고 detached 자식까지 종료 확인 전 잠금을 해제하지 않아야 한다. 단순 process.kill(pid) 또는 process.kill(-pgid)는 setsid 자식에 충분하지 않을 수 있다. 프로세스 PID 재사용도 고려해야 한다. 권한 불확실·격리 실패 시 실행하지 않는다.

브라우저: Playwright 전용 Chromium, 임시 프로필, chromiumSandbox 활성화. 사용자 Chrome·쿠키·키·확장 기능 재사용 금지. web_search는 Bing 공개 검색 페이지와 검색어를 승인 UI에 표시한다. read_web_page는 URL 승인. 로컬 파일·내부망·loopback·link-local·비HTTP(S)·업로드·다운로드·권한 요청 차단. Service Worker 차단, 통신 broker에서 DNS·목적지·redirect 검증. 승인하지 않은 최상위 origin 이동은 새 승인. CAPTCHA·로그인·검색 차단 우회 금지. 요청 가로채기만으로 격리를 주장하지 않는다.

M0는 filesystem, symlink/hardlink/rename, 환경·credentials, network, native code build/run, detached child, crash/timeout, browser filesystem/network, 프로토콜 승인 순서 검증을 포함한다. 모든 항목이 PASS이기 전 제품 활성화 금지. 실패한 실행을 접근 차단 성공으로 기록하지 않는다.

## 마일스톤·완료 조건

순서: 설계 승인 → M0 → M1 → M2 → M3 → M4 → M6. M5는 M1부터 함께 구현하고 M6 이전 완성한다.

| 단계 | 구현 | 완료 조건 |
|---|---|---|
| M0 | 격리 후보·프로세스 감독·브라우저·프로토콜 검증 | 필수 격리 테스트 PASS와 backend 채택 보고 |
| M1 | Vault·Registry·잠금·Native 경로 Helper | 이동/복사 ID 충돌·중첩·탈출·동시 실행 차단, 데이터 보존 |
| M2 | 파일 Tool·Gateway·Diff·승인 | 승인 전 변경 0건, TOCTOU·변조·중복·취소 테스트 |
| M3 | 8 Provider Tool 왕복·Agent loop | Mock 왕복·Tool-only·continuation·권한 철회·호출/시간 제한 |
| M4 | 검증된 Shell·검색/읽기 | 코드 실행·테스트, 권한/네트워크/출력/종료 우회 차단 |
| M5 | 감사·Usage 연결·중단 식별 | 강제 종료 후 interrupted/outcome_unknown, 자동 재개/재실행 없음 |
| M6 | SwiftUI Vault·Agent·승인·Diff·중단·이력 | Mock E2E, 기존 회귀, 앱 빌드 |

E2E: 임시 프로젝트 등록 → 오류 조사 → Diff 승인 → 수정 → Shell 승인/테스트 → 추가 수정 → 최종 변경/테스트/사용량 보고 → 종료·재시작 이력 확인. 별도 공격 fixture로 외부 경로·네트워크·승인 우회와 중복 실행을 검증한다. CLI와 SwiftUI의 정책이 같아야 한다.

## Phase 7 경계

Home/Desk/Library, 정체성, 지속 Task 상태/Next Action, 장기 Memory, RAG, Context 압축, 재실행 복원·자동 재개는 제외한다. 현재 실행의 대화·Tool 결과는 메모리만 사용한다. runId/vaultId/버전 이벤트를 확장 가능하게 유지하되 감사 이벤트를 재생해 Task를 복원하지 않는다. JEV, Multi-Agent, AI Office 전체 구조, 자동 충전, 비용 차단은 도입하지 않는다.

## 공식 참고 자료

- [Apple: sandboxed helper](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Apple: App Sandbox](https://developer.apple.com/documentation/security/app_sandbox)
- [Apple: network entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.server)
- [Apple: XPC](https://developer.apple.com/documentation/xpc)
- [Playwright: browser launch options](https://playwright.dev/docs/api/class-browsertype)
- [Playwright: network and Service Workers](https://playwright.dev/docs/network)
- [Gemini: thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

현재 macOS의 `man sandbox-exec`도 확인했다. Provider별 공식 Tool Calling 계약은 M3 진입 전 별도 검증표로 기록한다. 실 Provider 요청·실 웹 검색 없이 Mock 및 로컬 fixture로 검증하며, 실제 호출은 별도 승인 대상이다.

## M0 실제 검증 기록 — 2026-10-28

검증 환경: macOS 27.0.1, arm64, Node 24.21.0. `scripts/agent-sandbox/probe.mjs`는 제품 backend가 아닌 개발 진단이다. 실행은 `node scripts/agent-sandbox/probe.mjs`이며 JSON 보고서를 출력하고 미자격 상태에서 exit 1을 반환한다. 재현에 쓰는 모든 파일·바이너리는 전용 임시 디렉터리에 만들고 제거한다. 외부 HTTP나 Provider API는 호출하지 않는다.

- 최초 상위 개발 도구 Sandbox 안에서는 sandbox_apply가 거부됐다. 상위 Sandbox 밖의 승인된 진단에서는 macOS Sandbox 적용이 가능했다. 두 현상을 혼동하지 않았다.
- 초기 제한 프로필은 true도 SIGABRT로 종료했다. 루트 디렉터리 literal 읽기를 추가한 뒤 최소 실행이 성공했다. `allow file-read*` 전체 허용 진단도 실행했지만 제품 후보에 적용하지 않았다.
- PASS: 최소 프로세스 실행, Vault 파일 읽기·쓰기, 임시 외부 파일 읽기·쓰기 거부, `.nidus`·`.env` 읽기 거부, 외부를 가리키는 symlink 거부.
- PASS: 호스트에서는 연결되는 loopback socket fixture가 Sandbox에서 EPERM/EACCES로 거부됨. 실제 외부 네트워크·모든 네트워크 경로를 검증한 결과는 아니다.
- FAIL: process group 종료 후 setsid로 분리된 fixture 자식의 heartbeat 파일 쓰기가 계속됨. kill(pid, 0)만으로 판정하지 않고 종료 후 실제 파일 길이 증가로 확인했다. fixture PID는 따로 SIGKILL하고, fixture 자체에도 10초 수명 제한을 둔다.
- NOT RUN: 격리 내부 Swift/Xcode 빌드, 전용 브라우저, 전체 descendant supervisor, 프로토콜 승인 E2E, 실제 Provider 호출. lifecycle fixture를 호스트 clang으로 컴파일한 결과를 격리 내부 native-build 성공으로 기록하지 않는다.

결론: **M0 미통과, backend 미채택, Phase 5–6 전체 구현 미완료.** 파일 차단 성공만으로 Shell을 활성화하지 않는다. 이 결과는 sandbox-exec 전체가 원리적으로 불가능하다는 증명이 아니라, 현재 기존 Runtime 및 process-group 기반 종료가 요구사항에 부족하다는 재현이다. M1–M6는 설계 계약 상태이며 제품 구현 완료로 표시하지 않는다.

### M0 다음 기술 검증안

기존 Runtime.shutdown 확장만으로 완료 처리하지 않는다. App Sandbox·XPC의 별도 서명 Helper와 독립 감독 프로세스의 조합을 다음 후보로 검토한다. Node API 엔진은 호스트에 두고 Helper에는 키·DB 접근권을 주지 않는다. 명령별 Helper 인스턴스가 실행 권한과 descriptor를 받고, UI/Node 통신 단절과 deadline에 종료되도록 설계한다.

**XPC 자체도 detached 자식 종료를 자동 보장한다고 가정하지 않는다.** 먼저 동일 setsid/이중 fork/worker SIGKILL/감독 프로세스 종료/권한 철회 fixture를 통과하는지 검증해야 한다. 통과하지 못하면 임의 Shell을 제공하지 않으며, macOS VM 등 OS 수명 전체를 종료할 수 있는 경계 또는 지원 명령 제한에 대한 별도 설계 결정을 요청한다. unsigned 현재 빌드를 조용히 서명/권한/배포 체계로 변경하지 않는다.

이는 위 M0 채택 기준의 “App Sandbox·XPC 전환안은 별도 설계 승인 대상으로 보고한다”에 해당한다. 사용자 승인 전 전환 구현과 develop 병합을 수행하지 않는다.

재현 보고서: [M0 JSON evidence](evidence/Phase5_6_M0_Sandbox.json). 민감한 경로·키·본문·PID는 포함하지 않는다. `eligible: false`는 이 진단이 제품 backend를 활성화할 수 없다는 뜻이며, 파일 테스트 일부가 성공해도 전체 자격으로 승격하지 않는다.

### 회귀 및 검증 이력

단계별 테스트 수와 앱 빌드·실제 API 미검증 기록은 [검증 이력](VALIDATION.md)에 통합했다. Node·Swift 회귀와 기존 앱 빌드 PASS를 M0 보안 게이트 또는 Agent 기능 완료로 간주하지 않는다. 위 M0 실패와 원본 evidence는 그대로 유지한다.

## M0 생명주기 재검증 — 2026-10-30

**채택 가능한 backend 없음. M0 미통과이며 M1–M6 착수·제품 Shell 활성화를 계속 보류한다.** 독립 Supervisor prototype도 분리된 자식의 종료를 보장하지 못했다. 이는 검증한 PGID 전략의 실패이며 모든 macOS 격리 방식이 불가능하다는 결론은 아니다. Provider·Router·Ledger·앱 서명/공증 설정은 변경하지 않았다.

### 실패 원인과 대안 비교

`setsid()`는 새 세션과 프로세스 그룹을 만든다. 따라서 원래 `kill(-pgid, SIGKILL)`의 대상에서 제외된다. 이중 fork 후 부모가 종료되면 현재 PPID를 순회하는 방법도 원래 소유 관계를 잃는다. PID/시작 시각 확인 후 kill 사이에는 재사용 경쟁이 남으며, 순차 PID 조회는 fork·exit와 원자적이지 않다. Supervisor의 SIGKILL에는 종료 handler가 실행되지 않는다.

| 후보 | 검토 결과 | 채택 상태 |
|---|---|---|
| sandbox-exec + 독립 Supervisor + PGID 종료 | 일반 자식의 취소·Worker 종료·시간 제한은 처리하지만 setsid/이중 fork/감독자 사망에는 부족. 실제 fixture 실패 | 부적합 |
| App Sandbox + XPC Helper | 권한 분리·서비스 관리 수단. XPC 연결 무효화가 서비스가 만든 모든 자식의 종료 증거는 아님. 동일 생명주기 fixture와 서명된 패키지 검증 필요 | NOT_RUN, 미채택 |
| launchd 감독 + PID 목록/kqueue 추적 | 로컬 SDK `launchd.plist(5)`의 AbandonProcessGroup은 같은 PGID의 잔여 프로세스만 설명. `sys/event.h`는 NOTE_TRACK/NOTE_CHILD를 macOS 10.5부터 미지원으로 명시. 이벤트 관측 자체도 원자적 종료나 감독자 사망 처리가 아님 | 해결책으로 채택하지 않음 |
| Endpoint Security 기반 추적 | fork/exec/signal 관측·승인 API이나 전용 entitlement·배포 설계가 필요. 관측만으로 원자적인 트리 종료를 보장한다고 할 수 없음 | NOT_RUN, 범위 밖 설치 없음 |
| macOS VM / Linux VM·컨테이너 | 개별 PID 대신 게스트 전체의 실행 수명을 종료하는 경계를 검증할 수 있는 다음 후보. VM 호스트 강제 종료, 공유 디렉터리/네트워크 폐쇄도 별도 검증해야 함 | NOT_RUN, 안전하다고 선언하지 않음 |
| fork 불가 고정 실행 파일만 허용 | 공격면을 줄일 수 있지만 일반 Shell·컴파일·테스트 요구를 충족하는 대체재가 아님 | 제품 요구 변경 없이 채택 불가 |

권장 다음 검증 방향은 **VM 단위의 수명 경계**다. macOS 네이티브 작업이 필요하면 macOS 게스트, Linux 호환 작업이면 Linux 게스트를 비교한다. 원본 Vault 전체 공유는 `.nidus`·Secret 보호를 자동으로 제공하지 않으므로 승인된 작업 복사본과 변경 반영 또는 별도 파일 broker가 필요하다. 이는 기존 원본 Vault 직접 실행 요구와 설계 차이가 있으므로 이번 진단에서 임의 구현하지 않는다. XPC는 이후 제어 채널로 사용할 수 있으나 단독 해결책으로 약속하지 않는다.

공식 근거(2026-10-30 확인): [Apple App Sandbox 상속·서명](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html), [XPC 서비스](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html), [Endpoint Security](https://developer.apple.com/documentation/endpointsecurity), [Virtualization entitlement](https://developer.apple.com/documentation/virtualization/adding-the-virtualization-entitlement-to-your-project), [VM stop API](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)). VM 선택은 위 API의 존재와 격리 경계에 근거한 **설계 제안**이며 이번 실측 결과가 아니다.

### 실제 로컬 검증 방식

- 환경: macOS 27.0.1 (26A434), Darwin 27.0.0, arm64, Node v24.21.0. 다른 macOS 버전은 NOT_RUN이다.
- `lifecycle.mjs`는 독립 Node Supervisor와 별도 Node Worker **프로세스**를 만든다(Worker Thread 테스트가 아님). Supervisor가 샌드박스 내부의 고정 C fixture만 실행한다. Worker의 SIGKILL/exit, deadline, cancel을 PGID 종료로 처리한다. 제품 Runtime이나 범용 명령 실행 API가 아니다.
- 외부 관측자가 Vault heartbeat 파일 증가와 loopback 서버의 실제 접속 횟수를 센다. 시작 시 heartbeat가 없거나 관측이 fixture 자체 만료에 가까워지면 NOT_RUN이다. 종료 후 150ms 정착 구간을 두고 600ms 동안 추가 활동을 확인한다. 이 유한 구간의 PASS는 무기한 종료 보장이 아니다.
- fixture는 자식·손자 모두 같은 monotonic 4초 마감과 별도 5초 alarm을 가진다. 각 시나리오 후 5.6초까지 임시 경로를 유지한다. 이 자체 만료는 **검증 장비의 정리 장치**이며 제품 Supervisor의 성공으로 계산하지 않는다.
- C fixture는 오직 임시 파일과 127.0.0.1에만 접근한다. 명시적 loopback 허용 대조군에서 통신이 실제 관측되어야 기본 차단 결과를 판정한다. 외부 인터넷·Provider API는 사용하지 않는다.
- Shell 환경은 PATH/HOME/TMPDIR만 전달한다. 부모의 합성 Secret sentinel이 heartbeat에 나타나는지 확인한다. 실제 API Key는 읽거나 전달하지 않는다.
- 승인 false에서는 workload를 만들지 않는다. 이는 신뢰된 진단 프로토콜의 거절 검증이며, 향후 제품 승인 UI/인증/변조 방지의 E2E 검증은 아니다.
- 기존 `probe.mjs`도 재실행했다. 진단 후 저장된 자식 PID를 다시 kill하던 코드는 제거하고 fixture 자체 만료를 기다린다. 재사용된 PID를 실험 정리 대상으로 삼지 않는다. prototype의 PGID 신호 경로에는 여전히 원자적 식별 보장이 없으므로 제품 사용을 금지한다.

### 결과와 남은 게이트

| 검증 | 결과 |
|---|---|
| 일반 자식: 사용자 취소 / Worker SIGKILL / 시간 초과 | PASS (유한 관측 구간) |
| setsid 자식: 취소 / Worker SIGKILL / 시간 초과 | FAIL: 종료 이후 쓰기 지속 |
| 이중 fork + 부모 종료 / 분리된 자식의 추가 자식 생성 | FAIL: 자손 쓰기 지속 |
| Supervisor SIGKILL | FAIL: 일반 자식도 쓰기 지속 |
| 명시적 loopback 허용 중 setsid 취소 | FAIL: 리더 SIGKILL 후 600ms 동안 파일 쓰기 12회·접속 12회 추가 |
| 기본 네트워크 차단 / 부모 Secret 비전달 / 승인 거절 | PASS (고정 fixture 범위; 제품 승인 E2E 아님) |
| 기존 Vault 읽기·쓰기, 외부 파일 차단, `.nidus`/`.env` 읽기 차단, symlink 탈출 차단 | PASS (기존 제한된 fixture 범위) |
| 실제 PID 재사용 시 원자적 종료 | NOT_RUN: 안전한 원자적 primitive 없음. PID 고갈/무관한 프로세스 종료 실험은 하지 않음 |
| signed XPC / VM 수명 검증 | NOT_RUN |
| 전체 hardlink/rename 경쟁·Secret 탐지·SDK 빌드·브라우저·제품 승인 E2E | NOT_RUN: 기존 제한된 파일 테스트로 대체하지 않음 |

현재 unsigned 로컬 앱의 서명/공증 설정은 유지했다. App Sandbox/XPC 검증에는 앱·Helper의 올바른 code signature와 entitlement 구성이 필요하다. Virtualization 사용에도 entitlement가 필요하며 Endpoint Security에는 별도 권한 설계가 필요하다. 새 signing identity, provisioning, 서비스 설치를 수행하지 않았다. 배포 최소 macOS 버전이나 공증 적합성은 이 테스트로 확정하지 않는다.

재현 명령(호스트에서 sandbox-exec와 loopback listener를 허용한 개발 환경):

```sh
node scripts/agent-sandbox/probe.mjs > /tmp/nidus-m0-recheck.json
node scripts/agent-sandbox/lifecycle.mjs > /tmp/nidus-m0-lifecycle.json
node --test tests/agent-sandbox-probe.test.mjs
npm test
```

두 진단은 미자격 상태이므로 **exit 1이 예상 결과**다. 이를 Node 회귀 테스트 실패와 혼동하지 않는다. 최초 네트워크 허용 대조군은 profile selector 문제로 workload가 시작되지 않아 NOT_RUN이었고, 허용 host를 `localhost`로 수정했다. 이후 AF_INET socket 생성 권한 부재도 확인하여 명시적 loopback 대조군에만 추가하고 재검증했다. 기본 차단 profile은 변경하지 않았다. 비동기 connect 직후 close로 양성 대조군 접속이 관측되지 않던 fixture도 연결 완료를 최대 100ms 기다리도록 수정했다. 이 중간 상태에서 네트워크 격리는 NOT_RUN으로 유지했다. 시작 실패를 네트워크 차단 PASS로 기록하지 않았다.

원본 [2026-10-28 evidence](evidence/Phase5_6_M0_Sandbox.json)는 보존한다. 이번 결과와 source hash는 [생명주기 재검증 evidence](evidence/Phase5_6_M0_Lifecycle.json)에 기록한다. **현재 종료 보장 범위는 검증된 일반 자식의 제한된 상황뿐이며, 임의 Shell 전체 트리 종료 보장은 없다.**


## VM 기반 M0 재검증 — 2026-10-30

기존 native/PGID 실패 기록과 JSON은 그대로 보존한다. 새 [VM Evidence](evidence/Phase5_6_M0_VM.json)는 별도 검증이다. **Apple Virtualization Linux ARM64 Backend의 실제 부팅·강제 종료는 동작하지만 전체 Sandbox 자격은 미통과(`eligible: false`)다.** M1~M6와 제품 Shell을 활성화하지 않는다.

### 실행 및 파일 경계

`scripts/agent-vm/VMProbe.swift`는 별도 검증용 실행 파일이다. `SandboxBackend`의 start/requestStop/forceStop/cleanup과 실제 VM 상태를 분리하며 생성 시 create 이벤트를 기록한다. running/failed/stopped는 framework 상태를 함께 기록한다. 정지 요청, 제어 프로세스 종료, 관측 채널 닫힘만으로 stopped를 만들지 않는다. VM 소유 Worker 상실 시 `interrupted-stop-unconfirmed`이며 결과 반영과 자동 삭제를 보류한다. macOS 게스트 구현은 없다.

Host의 SwiftUI, Node 엔진, Provider, Router, Ledger, Keychain은 변경하지 않았다. 게스트에는 작업별 복사한 kernel/initrd와 승인된 합성 파일만 제공한다. 원본 Vault, API Key, Host 환경, 내부 DB를 마운트하지 않는다. writable virtiofs 공유는 격리된 작업 복사본 하나뿐이다. Git이 필요한 작업도 원본 `.git` 공유 대신 향후 검토된 소스 snapshot/별도 메타데이터 export가 필요하며 이번에는 지원하지 않는다.

`workspace.py`는 **최상위 일반 파일, 최대 1MiB, 신규 파일 반영만** 검증한다. root 경로의 각 구성요소와 파일에 no-follow를 적용하고 다중 hardlink, 경로 탈출, 보호 파일명을 거부한다. 승인 hash와 읽기 전후 inode/metadata를 비교한다. 게스트 결과는 호스트 Diff 검토 후 별도 승인 및 VM 정지 확인이 있어야 O_EXCL로 신규 생성한다. 기존 파일 덮어쓰기·삭제·재귀 merge는 지원하지 않는다. 파일명 차단은 Secret 내용 탐지의 보장이 아니며 승인 전 내용 검토가 필요하다. 일반적인 디렉터리 rename 경쟁과 실패 중 부분 파일 복구는 아직 제품 수준으로 검증하지 않았다. 승인은 fixture의 명시적 결정이며 실제 UI 권한 프로토콜은 NOT_RUN이다.

기본 VM에는 NIC 자체가 없다. 네트워크 대조군은 연결된 UNIX datagram socket으로 고정 UDP 목적지/내용만 수용하고 나머지는 폐기하는 **호스트 로컬 관측 sink**다. NAT·bridge·인터넷 전달은 없다. 따라서 이 결과는 외부 인터넷 allowlist, DNS, redirect, 프록시 정책의 검증이 아니다.

### 실제 결과

환경: macOS **27.0.1 (26A434), ARM64**, SDK **27.2**. Linux **6.18.58-0-virt**, Alpine **v3.24 aarch64 netboot**에 진단용 initramfs를 구성했다. 완전한 배포판 설치나 개발 toolchain 이미지는 아니다. 별도 바이너리에만 ad-hoc signing과 `com.apple.security.virtualization`을 적용했다. 이번 바이너리의 deployment minimum은 27.0이며 이전 macOS·Intel·정식 서명/공증은 검증하지 않았다. 기존 앱의 최소 버전·서명·빌드 설정은 변경하지 않았다.

| 검증 | 결과 |
|---|---|
| 생성·부팅, 일반 Shell, 사용자 취소 | PASS |
| setsid, double-fork, 중첩 자식 후 VM 종료 | PASS |
| VM 소유 Worker SIGKILL | NOT_RUN: 활동 중단 관측 PASS, 권위 있는 VM 종료 상태 확인 불가 |
| Supervisor SIGKILL | PASS: 남은 VM Worker가 제어 채널 EOF 후 forceStop 완료 |
| 시간 초과, requestStop 후 forceStop | PASS: graceful 요청만으로 완료 처리하지 않음 |
| 합성 앱 제어 프로세스 종료 | PASS; 실제 SwiftUI 앱 crash는 NOT_RUN |
| 이미 정지한 VM 재정지 오류 | PASS: 오류와 실제 stopped 상태를 구분 기록 |
| NIC 없는 기본 차단 / 로컬 sink 허용·거절 | PASS (fixture 범위) |
| Host 경로·Secret 보호, 원본 보존, symlink/hardlink 거부 | PASS (제한된 파일 fixture 범위) |
| 별도 Diff 승인·신규 파일 반영 / running 중 cleanup 거부 | PASS |
| 확인된 정지 후 작업 이미지·임시 데이터 삭제 | PASS; 정지 미확인 작업과 공통 다운로드 cache는 보존 |

시나리오 **9 PASS / 1 NOT_RUN**, 별도 보안 검사 **7 PASS**. 모든 10개 시나리오에서 활동 중단은 관측했다. 종료 전 heartbeat/패킷 양성 대조군을 확인하고, 정착 300ms 후 **1초** 동안 파일 크기와 프레임 증가를 독립 관측했다. 신호 전송 또는 PID 존재 여부만으로 판정하지 않았다. 유한 구간의 무활동을 영구 종료 보장으로 확대하지 않는다.

부팅부터 workload까지 **0.3485~0.4978초**, 정상 forceStop 요청부터 framework 완료 callback까지 **1.37~2.19ms**였다. timeout/graceful 대기 시간은 별도다. 설정 자원은 **2 vCPU / 512MiB**. Evidence의 Worker RSS/CPU는 별도 Virtualization 서비스 사용량을 포함하지 않는다. VM 전체 peak 메모리/CPU는 NOT_RUN이며 설정 메모리를 실측치로 표시하지 않는다.

초기 실패도 보존한다: (1) Busybox applet 링크 누락으로 mount/sleep 실패와 guest panic, (2) `/tmp` 누락으로 workload가 시작되지 않은 9개 NOT_RUN, (3) Worker SIGKILL 시 관측기의 ConnectionResetError로 중단. 각각 초기화와 채널 종료 처리를 수정했다. 게스트가 동작하지 않는 초기 실행을 격리 PASS로 계산하지 않았다.

회귀 검증: Node **174 PASS**, Swift **42 PASS**, workspace **6 PASS**, standalone VM 컴파일·서명·실행 PASS. 제품 앱 packaging은 NOT_RUN(제품 코드·빌드 미변경). 실제 Provider API는 호출하지 않았다.

### 재현 및 잔여 게이트

```sh
mkdir -p /private/tmp/nidus-vm-m0-assets
curl --fail --location --proto '=https' https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot/vmlinuz-virt -o /private/tmp/nidus-vm-m0-assets/vmlinuz-virt
curl --fail --location --proto '=https' https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot/initramfs-virt -o /private/tmp/nidus-vm-m0-assets/initramfs-virt
python3 scripts/agent-vm/prepare.py /private/tmp/nidus-vm-m0-assets > /private/tmp/nidus-vm-m0-assets/hashes.json
swiftc scripts/agent-vm/VMProbe.swift -framework Virtualization -o /private/tmp/nidus-vm-m0-assets/vm-probe
codesign --force --sign - --entitlements scripts/agent-vm/probe.entitlements /private/tmp/nidus-vm-m0-assets/vm-probe
python3 scripts/agent-vm/probe.py /private/tmp/nidus-vm-m0-assets > /tmp/nidus-vm-evidence.json
python3 scripts/agent-vm/test_workspace.py
npm test
swift test
```

미자격 진단의 **exit 1은 예상 결과**다. 다운로드 SHA256은 `assets.json`의 관측 pin으로 검증하며 공식 서명 provenance를 의미하지 않는다. upstream 파일이 바뀌면 검증 실패를 무시하거나 pin을 자동 갱신하지 않는다. 정지 미확인 작업 디렉터리는 Evidence에 기록하고 보존한다. 재실행 시 추가로 남을 수 있다.

제품 채택 전에는 Worker 소유권 상실 후 authoritative 정지 확인/복구, 실제 앱 crash, 일반 파일 반영 경쟁·실패 복구, 제품 승인 채널, 필요한 외부 네트워크 정책을 검증해야 한다. macOS 게스트, SDK 빌드·브라우저 등은 지원되지 않는다. 현재 채택 후보는 Apple Virtualization이지만 **M1~M6 착수 판단은 보류**한다.

공식 근거: [Linux VM](https://developer.apple.com/documentation/virtualization/running-linux-in-a-virtual-machine), [Virtualization entitlement](https://developer.apple.com/documentation/virtualization/adding-the-virtualization-entitlement-to-your-project), [stop API](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)), [Alpine netboot](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot/). 위 측정치는 API 문서의 보장이 아니라 이 로컬 fixture의 관측 결과다.

## 독립 VM Manager M0 — 2026-10-31

작업 Worker가 VM 객체를 소유하던 경계를 분리했다. 기존 별도 Swift target의 `manager` 모드만 VM을 소유하며, Python 관측기가 Manager와 Worker를 각각 독립 자식으로 만든다. 제품 앱이나 상주 서비스에는 연결하지 않았다. 기존 stdin 진단 모드는 회귀 검증을 위해 보존한다.

제어는 파일 경로/listener를 만들지 않는 UNIX socketpair를 사용한다. 신뢰된 검증기가 각 endpoint를 하나씩 전달하고 불필요한 descriptor를 닫는다. 실행 ID가 일치하는 start/heartbeat/cancel/status만 허용한다. status 결과는 Host journal에 기록한다. Worker 외 제3자 연결이나 무제한 재접속 기능은 없다. 동일 사용자 악성 Host 프로세스 방어·제품 IPC 인증을 검증한 것은 아니다.

Manager는 heartbeat 1초/만료 5초, 실행 deadline, 연결 EOF, 취소를 공통 종료 경로로 처리한다. requestStop 후 2초 내 확인되지 않으면 forceStop, 추가 5초 내 확인되지 않으면 stop-unconfirmed를 남긴다. 중복 취소는 새 종료를 시작하지 않는다. 성공 callback 또는 guest-stop callback에서 실제 stopped 상태까지 확인한 경우에만 stop-confirmed를 기록한다. 기록은 Host 파일에 flush하고 종료 확정 후 Manager를 정상 종료한다. Manager 자체의 45초 진단 watchdog 종료는 VM 종료 증거가 아니다.

검증 suite의 registry는 실행 전에 journal 경로/run ID를 기록·fsync하고 flock으로 동시 admission을 직렬화한다. 이전 실행의 마지막 유효 기록이 stop-confirmed/stopped가 아니면 신규 VM 생성을 거절한다. 재시작 검사는 별도 프로세스에서 journal을 다시 읽는다. 누락·손상·다른 run ID·정지 요청만 있는 기록은 apply/cleanup/new-execution 모두 거절한다. registry는 새 합성 suite에서만 초기화하며, 미확인 suite를 다시 시작할 때 초기화하면 안 된다. 이는 제품 전역 Registry가 아닌 검증용 진입 정책이다. Host journal은 게스트에 공유하지 않는다.

실제 VM 결과: 일반 취소(중복 포함), setsid/double-fork/중첩 자식 실행 중 Worker SIGKILL, Worker 연결 단절, heartbeat 중단, 시간 초과, 잘못된 run ID 거절은 종료 확인까지 PASS. Manager SIGKILL은 무활동 관측만 PASS이며 종료 확인은 NOT_RUN이다. 원래 문제였던 **작업 Worker 상실 시 종료 확인**은 해결했지만 **VM 소유자 자체 상실**은 해결하지 않았다. M0 전체 eligible=false와 M1~M6 보류는 유지한다.

모든 신규 시나리오는 NIC 없이 합성 Workspace만 사용한다. 종료 전 heartbeat 증가를 확인하고 정착 300ms 뒤 1초 동안 파일 증가를 독립 관측한다. 신규 Manager 네트워크 활동 검증은 NIC 없음 범위이며, 이전 제어 모드의 로컬 sink 대조군을 별도로 회귀 실행했다. 실제 앱 crash, Manager 모드의 네트워크 허용 경로, 실제 framework stop 실패/종료 확인 timeout 강제 주입은 NOT_RUN이다. 파일 반영·정리 권한 검사는 수행하지만 이번 harness는 진단 자료를 모두 보존하며 결과를 원본에 자동 반영하지 않는다.

재현(기존 VM 자산 준비 후):

```sh
swiftc scripts/agent-vm/VMProbe.swift -framework Virtualization -o /private/tmp/nidus-vm-m0-assets/vm-manager
codesign --force --sign - --entitlements scripts/agent-vm/probe.entitlements /private/tmp/nidus-vm-m0-assets/vm-manager
python3 scripts/agent-vm/manager_probe.py /private/tmp/nidus-vm-m0-assets > /tmp/nidus-manager-final.json
python3 scripts/agent-vm/test_manager.py
python3 scripts/agent-vm/test_workspace.py
```

전체 M0 미자격이므로 진단 exit 1은 예상 결과다. 환경은 macOS 27.0.1 (26A434), Linux 6.18.58-0-virt, 2 vCPU/512MiB로 유지한다. 신규 [Manager Evidence](evidence/Phase5_6_M0_VM_Manager.json)에 source hash와 회귀 결과를 저장한다. Node 174개, Swift 42개, 파일 테스트 6개, Manager 정책 테스트 4개 PASS. 첫 Node 실행은 sandbox의 localhost listen EPERM으로 실패했고 로컬 mock listener 허용 후 통과했다. 실제 API 호출, 제품 앱 packaging, 제품 서명 변경은 수행하지 않았다.

## M0 Lifecycle Reliability & Recovery — 2026-10-31

### OS·Framework 조사와 판단

SDK 27.2 `VZVirtualMachine.h`와 Apple 공개 문서에서 확인한 종료 근거는 **소유 객체의 성공한 stop callback 또는 guest-stop delegate와 stopped 상태**다. `requestStop`은 요청일 뿐이며 프로세스 종료나 조용한 heartbeat를 대체 근거로 사용하지 않는다. 조사한 공개 인터페이스에는 실행 중인 다른 프로세스의 VM을 실행 ID로 열거·인계·재연결하는 API가 없었다. save/restore는 저장한 정지 상태를 복원하는 API로, 기존 실행 인계가 아니다. 이는 조사한 SDK/문서의 범위이며 비공개 구현의 수명 보장을 추측하지 않는다.

Manager SIGKILL 전후 `ps`의 Virtualization XPC 서비스 PID·시작 시각도 독립 관측한다. 해당 서비스가 사라지는 결과는 OS 수준의 보조 관측이지만, 공개 API로 우리 run ID와 대응시킨 증거는 아니다. 다른 VM이 있을 수 있고 프로세스 재사용·순간적인 목록 변화도 있으므로 이 결과만으로 STOP_CONFIRMED를 만들지 않는다.

launchd는 프로세스 장애 감지·재시작에 활용할 수 있지만 VM 인계나 이전 VM 종료 확인을 제공한다는 근거는 없다. **새 상주 Supervisor는 추가하지 않았다.** 향후 제품에서 필요하면 on-demand Manager를 시작하고 먼저 reconciliation만 수행하도록 구성한다. KeepAlive 재시작마다 start를 자동 호출하거나 Task를 재개해서는 안 된다. launchd 설치·실행 자체는 NOT_RUN이다.

공식 근거: [stop callback](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)), [VM state](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/state-swift.property), [launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html). 실제 관측치는 아래 별도 Evidence를 따른다.

### 최소 상태 대조와 실패 시 차단

`lifecycle.py`는 Host journal에서 관리 상태를 재구성한다. 실제 Framework 상태는 별도 필드로 유지한다. 기존 `recovered_stop`/신규 실행 admission도 같은 판정을 사용한다. 마지막 stop-confirmed 문자열만 신뢰하던 검사를 강화해 동일 실행의 callback/stopped 증거를 요구한다.

| 관리 상태 | 근거 / 재시작 시 처리 |
|---|---|
| CREATED | Manager 준비, VM 시작 전; 종료 증거가 없으면 재시작 시 미확인 |
| STARTING | start 요청; 재시작 시 미확인 |
| RUNNING | start 완료; 재시작 시 미확인 |
| STOP_REQUESTED | 취소·종료 요청; 완료로 처리하지 않음 |
| FAILED | 시작·종료 오류; stopped 증거가 아님 |
| STOP_CONFIRMED | 동일 실행 callback과 stopped 확인 기록; 현재 상태와 모순되면 차단 |
| STOP_UNCONFIRMED | 기록 없음·손상·불일치·timeout·소유자 상실 후 종료 증거 없음 |

미확인 상태에서는 동일 Workspace 재실행을 포함한 신규 실행, 원본 반영, 임시 데이터 삭제를 거부하고 autoResume=false를 유지한다. CLI `manager_probe.py recover <journal> <runID>`는 상태와 원인을 JSON으로 출력한다. 이는 실행 안전 기록이며 프롬프트·Task 진행 상황·Memory는 저장하지 않는다. 기록은 게스트에 공유하지 않으며 악성 동일 사용자 Host가 기록을 위조하는 상황은 현재 신뢰 모델 밖이다. registry 초기화는 새로운 합성 suite 생성에만 허용되며 복구 시 초기화하면 안 된다.

### 검증 기준과 재현

`reliability_probe.py`는 기존 Manager/Worker 구조를 재사용한다. Manager SIGKILL을 동일 setsid·로컬 datagram 조건에서 5회 반복한다. 각 실행의 실제 파일 증가와 approved UDP payload를 먼저 관측하고, 종료 후 300ms 정착 뒤 5초 동안 파일 크기와 프레임 증가를 센다. 패킷은 로컬 sink에서 폐기하며 외부 네트워크로 전달하지 않는다. 무활동 관측과 framework 종료 증명을 각각 판정한다.

추가 검증은 정상 강제 종료/취소·중복 취소, Worker SIGKILL, 중복 시작, Supervisor SIGKILL, 합성 앱 제어 프로세스 종료, 기록 재읽기 및 실제 실행 admission 차단이다. 오류·callback 미도착은 **prototype의 명시적 fault injection**으로 재현한다. 실제 Apple framework가 오류를 발생시켰다는 의미가 아니다. 주입 상태에서는 stop 호출을 생략하고 timeout 시 미확인으로 끝내므로 게스트가 계속 실행될 수 있으며, Manager 소멸 후 관측과 차단 정책을 따로 기록한다.

정상 종료 PASS는 framework 근거와 무활동 관측을 모두 요구한다. Manager SIGKILL은 무활동이더라도 UNCONFIRMED이며, 주입 실패 시 종료 증명은 NOT_RUN이다. 반면 해당 상황의 차단 정책은 별도로 PASS/FAIL 판정한다. 실제 SwiftUI crash, 실제 framework 내부 고장, 외부 네트워크 정책, 일반 파일 merge는 NOT_RUN이다. 제품 앱과 Provider/Router는 변경하지 않는다.

```sh
swiftc scripts/agent-vm/VMProbe.swift -framework Virtualization -o /private/tmp/nidus-vm-m0-assets/vm-manager
codesign --force --sign - --entitlements scripts/agent-vm/probe.entitlements /private/tmp/nidus-vm-m0-assets/vm-manager
cp /private/tmp/nidus-vm-m0-assets/vm-manager /private/tmp/nidus-vm-m0-assets/vm-probe
python3 scripts/agent-vm/reliability_probe.py /private/tmp/nidus-vm-m0-assets > /tmp/nidus-reliability-final.json
python3 scripts/agent-vm/test_lifecycle.py
python3 scripts/agent-vm/test_manager.py
python3 scripts/agent-vm/test_workspace.py
```

진단 exit 1은 M0 미자격을 의미한다. 각 반복은 독립된 합성 suite이며, 이전 미확인 작업의 registry를 초기화하거나 같은 Workspace에서 재실행하지 않는다. 임시 진단 자료는 보존한다. 결과는 [Lifecycle Recovery Evidence](evidence/Phase5_6_M0_VM_Recovery.json)에 별도로 저장한다. 기존 Evidence는 수정하지 않는다.

**결론: 소유자 상실 후 종료의 공개 API 근거가 확보되지 않아 M0 전체 통과 및 M1~M6 착수는 보류한다.** 확인 가능한 상태 조회·재연결 기능이 필요하면 Apple에 해당 수명 계약을 확인하거나, 안정적인 실행 ID 기반 재조회와 종료 확인을 제공하는 Backend를 별도 검증해야 한다. Supervisor를 하나 더 쌓거나 재시작 성공을 종료 증거로 삼는 것은 해결책으로 인정하지 않는다.

최종 결과: Manager SIGKILL **5 UNCONFIRMED**(각각 5초간 파일/패킷 증가 0, OS 서비스 관측 1→0), 정상/중복 요청·Worker/Supervisor·합성 앱 연결 검증 **5 PASS**, 종료 장애 주입 **2 NOT_RUN**(종료 증명 기준; 차단 정책은 2 PASS). Node 174, Swift 42, 파일 6, Manager 4, lifecycle 4개 테스트 PASS. 기록/현재 상태 불일치는 단위 테스트 입력으로 검증했으며 실제 Framework 상태 위조를 수행하지 않았다.
