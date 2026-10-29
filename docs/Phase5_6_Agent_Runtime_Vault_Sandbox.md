# Phase 5–6: Single Agent Runtime · Vault · Sandbox

## 승인된 설계와 구현 상태

기준 develop: `81ecb887cd2f2b8803ead55c0c50d945aacbf15a`.
작업 브랜치: `feature/agent-runtime-vault-sandbox`.

이 문서는 승인된 통합 계획의 구현 기준이다. **아래 계약은 구현 목표이며, 완료된 기능 목록이 아니다.** 단계별 실제 결과는 마지막 검증 기록으로 구분한다. 현재 제품의 Provider·Router·권한·사용량·SwiftUI 동작은 M0 진단으로 변경하지 않는다. 실제 API 호출, 원격 push, develop 병합은 별도 승인 없이 수행하지 않는다.

사용자 선택:

- macOS 네이티브 Shell, 원본 Vault 직접 실행.
- 파일 Tool 쓰기·수정은 Diff 승인, 파일 삭제는 개별 승인.
- Shell은 정확한 명령과 지정 경로의 **수정·삭제 가능성 전체를 명령 단위로 승인**한다. Shell 내부의 개별 파일 삭제 사전 승인을 보장하지 않는다.
- 외부 네트워크는 기본 차단, 요청별 별도 승인. 네트워크 허용 Shell은 Vault 정보를 외부로 전송할 수 있음을 명시한다.
- 전용 브라우저 검색·공개 페이지 읽기 포함. 로그인·임의 폼 제출·다운로드·게시·구매 제외.
- 기존 8개 Provider의 Tool Calling 변환 지원. 개별 모델의 실제 지원 여부가 불명확하면 Agent 후보에서 제외.
- M0에서 네이티브 격리를 먼저 검증한다. 검증 전 Shell·브라우저 실행을 활성화하지 않는다.

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
