# M2 + M3 — Unified Tools and Single-Agent Runtime

2026-11-03. 브랜치 `feature/vault-runtime-v2`, 시작 HEAD `f7689cb`, 시작 작업 트리 clean.

**안전하게 지원할 수 있는 범위의 통합 구현이다. 전체 파일 수정·삭제 제품 기능 완료가 아니다.** 제품 기본 경로는 읽기 Tool과 단일 Agent 라이브러리 API다. 격리된 테스트 모드에서 Mock 승인 후 Vault 루트의 신규 파일 생성까지 검증했다. 기존 파일 교체·Patch 반영·삭제, 실제 사용자 승인 UI는 미구현/비활성이다. 이 제한은 이번 요청의 Gate B 및 제품 활성화 조건을 따른다.

기존 계획의 “Provider Adapter 변경은 별도 승인 전 보류”는 이번 명시적 M2/M3 요청으로 해당 확장 범위가 승인된 것으로 적용했다. 기존 텍스트 API는 유지하고 optional Tool Calling 메서드만 추가했다. M0 Evidence는 변경하지 않았으며 실제 VM·Shell·브라우저·이미지·M4는 구현하지 않았다.

## 변경 구조

| 경로 | 역할 |
|---|---|
| `src/tools/contracts.ts`, `registry.ts` | 정적 Tool 정의, 제한된 JSON Schema, 오류·결과 계약 |
| `src/tools/files.ts` | 매 작업 Vault 재검증, Native helper, 읽기/검색/변경안·Diff |
| `native/vault-files.swift` | no-follow directory FD 순회, bounded UTF-8 읽기, no-replace 신규 생성 |
| `src/tools/permission.ts` | 정책 revision, Host/Mock 승인 Adapter, 만료·일회용 grant |
| `src/tools/dispatcher.ts` | 입력·권한·구현 범위 검사, 중복 호출 방지, 실행·출력/총 읽기 제한 |
| `src/agent/model.ts`, `runtime.ts` | Provider 독립 Tool turn 계약, Mock/Engine port, 단일 Task/Step 루프 |
| `src/adapters/openai-tools.ts`, `openai.ts` | Responses Function Calling 요청·파싱·continuation |
| `src/engine.ts`, `types.ts`, `index.ts` | optional Tool Calling, capability 필터, Ledger 재사용, 공개 API |
| `scripts/build-vault-helper.mjs`, `package.json` | macOS helper를 build에 포함 |
| `scripts/build-app.mjs` | Tool/Agent/Vault 하위 모듈과 helper를 개발 앱 번들에 포함 |
| `tests/{tool-registry,tool-files,provider-tools,agent-runtime}.test.mjs` | Gate A~E 검증 |

M1a/M1b 코드, `src/router.ts`, `src/ledger.ts`, `src/storage.ts`, SwiftUI/Runtime.swift 및 기존 M0 evidence는 불변이다. dependency 추가나 Usage DB migration은 없다.

## Tool Registry와 실제 사용 가능 범위

각 정의는 ID/name/version/description, input/output schema, target, permissions, sideEffect, approval, timeout, output limit, cancellation, implemented를 포함한다. Registry 등록은 신뢰된 Host 코드만 수행한다. 모델 응답을 정의로 등록하는 경로는 없다. 이름 중복·미등록 호출·알 수 없는 schema keyword·추가 인자를 거절한다. 모델이 target 또는 approved를 넣으면 입력 검증에 실패한다.

| Tool | 제품 기본 | 테스트 모드 / 구현 범위 |
|---|---|---|
| `list_files` | 사용 가능 | 허용된 텍스트 파일/디렉터리 목록, 단일 디렉터리 최대 1,000개 |
| `read_file` | 사용 가능 | 최대 64 KiB UTF-8 파일, hash/객체 metadata 포함 |
| `search_files` | 사용 가능 | literal 검색, 최대 200개 항목·100개 결과, 읽기 합계 제한 |
| `write_file` | **비활성·광고 안 함** | Mock Approval Adapter + 명시적 test mode에서 루트의 새 파일만 생성 |
| `apply_patch` | 비활성·광고 안 함 | 정확한 단일 일치 텍스트 치환의 변경안·Diff만 생성 |
| `delete_file` | 비활성·광고 안 함 | 개별 파일 삭제 변경안·Diff만 생성, 실제 unlink 없음 |
| `run_shell`, `browser_search`, `browser_navigate`, `browser_read_page` | 비활성·광고 안 함 | 향후 VM 계약만 존재 |
| `generate_image` | 비활성·광고 안 함 | 향후 Provider 계약만 존재 |

읽기/쓰기 정의는 공통 Schema subset(object/string/integer/boolean, required, additionalProperties=false, 문자열 길이·정수 범위)만 사용한다. 지원하지 않는 keyword는 등록 시 거절하며, Provider 전송 시 필드를 삭제해 의미를 축소하지 않는다. output은 `{ text: string }` envelope이며 내부 metadata/result는 JSON text로 표현한다. 모든 Tool Result는 `callId`, status, code, content, `untrusted:true`를 갖는다.

## Host 파일 경계와 변경 지원 제한

매 작업 전후 M1a Registry를 resolve한다. Native helper는 루트 경로의 모든 요소를 `openat`/`O_NOFOLLOW`/directory FD로 연 뒤 device/inode/birthtime을 확인한다. 상대경로도 디렉터리 FD를 따라 순회한다. 읽은 파일은 단일 링크 일반 파일이어야 하며 읽기 전후 stat/경로 객체/크기/mtime/ctime을 확인한다. 부모 디렉터리와 루트 이름도 재검증한다. 이 FD는 한 작업에서만 사용하고 이후 접근 권한으로 재사용하지 않는다.

절대경로, 빈 요소, `.`/`..` 탈출, backslash, 제어문자를 거절한다(`.`는 목록/검색의 루트 지정에만 허용). dotfile/디렉터리 전체, secret/credential/config가 포함된 이름, SSH 키 이름, keychain, node_modules, package 설정을 차단한다. 초기 확장자 allowlist는 `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.log`다. NUL/제어 바이트·잘못된 UTF-8·과대 파일도 거절한다. 이는 이름/형식 정책이며 일반 문서 안의 모든 비밀값을 자동 식별하는 DLP가 아니다. 민감한 문서가 있는 Vault의 외부 모델 전송 여부는 Host 소유자가 판단해야 한다.

변경안은 원본 content/hash/객체 version, 예상 결과, target, Vault/execution/call, root identity, diff와 전체 변경안 hash를 고정한다. 저장된 변경안은 복사본이며 변조된 객체를 재사용할 수 없다. 반영 전 승인·정책·Vault·파일 hash/객체를 다시 확인한다.

실제 지원하는 변경은 **루트의 새 파일 생성만**이다. helper는 루트 FD 아래 무작위 0600 staging 파일에 쓰고 fsync한 뒤 `renameatx_np(..., RENAME_EXCL)`로 게시한다. 대상이 파일·symlink·디렉터리 등 무엇이든 이미 존재하면 교체하지 않는다. 별도 OS 프로세스 두 개의 충돌 테스트에서 정확히 하나만 게시됨을 확인했다. 부모 이동 문제를 줄이기 위해 하위 디렉터리 생성은 비활성이다. 경로가 바뀌더라도 replacement 경로를 따라 쓰지 않으며, 이미 핸들로 고정한 원래 Vault 객체에만 접근한다.

기존 파일 overwrite와 delete에는 “검사했던 객체만 교체/삭제”하는 Native compare-and-swap 근거가 추가로 필요하다. 단순한 hash 검사 후 rename/unlink는 그 보장이 아니므로 실행하지 않는다. 적용 전 파일 교체·hash 차이 차단 테스트는 통과했지만 이를 기존 파일 수정/삭제 지원의 근거로 삼지 않았다.

게시 후 읽기·fsync·Vault 재검증이 실패하거나 실행 중 helper가 중단되면 `outcome_unknown`이다. Runtime은 UNCONFIRMED로 끝내며 자동 재시도·rollback하지 않는다. crash로 staging 파일이 남을 수 있으며 dotfile 정책 때문에 Tool에 노출되지 않는다. 자동 청소/전원 차단 복구는 없다. 악성 동일 사용자 Host의 메타데이터 변조, 모든 nanosecond 단위 rename 경쟁, 다른 볼륨·네트워크 파일시스템·전원 차단을 검증한 것은 아니다.

## Permission과 실제 승인 UI 상태

기본 읽기는 ALLOW, 신규 생성은 REQUIRE_APPROVAL, 미구현 Tool은 DENY다. side-effect Tool에 ALLOW를 설정해도 승인을 생략하지 않는다. 읽기 정책을 REQUIRE_APPROVAL로 바꾼 경우 현재 별도의 읽기 승인 UX가 없으므로 `read_approval_unsupported`로 차단한다.

승인 요청은 승인 ID, Vault/execution/call, Tool/version, path, 변경안 hash, 원본 hash/파일 version, policy revision, 요청·만료 시각, Diff를 포함한다. 승인된 시각은 Host grant에 보관한다. 내부 grant token은 모델 입력/Tool Result에 포함하지 않는다. 일회용 소비 후 재사용, 다른 대상/Vault/Invocation/정책/파일의 재사용을 거절한다. 반영 직전까지 정책 revision을 다시 확인한다. 승인 시간 초과, 취소, 응답 없음, 채널 오류는 쓰기를 허용하지 않는다.

`HostApprovalAdapter(displayAndWait)`는 신뢰된 Host가 Diff를 표시하고 실제 사용자 응답을 전달할 수 있는 연결점이다. **현재 SwiftUI에 연결되어 있지 않다.** `DenyApprovalAdapter`가 기본이며 product Dispatcher는 Host callback을 넘겨도 쓰기를 광고하거나 실행하지 않는다. 테스트만 `mode:'test'`와 `MockApprovalAdapter`를 명시해 신규 생성을 사용한다. 성공 결과의 `approvalSource:'mock'`를 실제 사용자 승인으로 기록하지 않는다. 제품 CLI Agent 명령이나 SwiftUI 승인 화면은 이번에 추가하지 않았다.

## Provider Tool Calling

공통 turn은 text, Tool Call ID/name/정규화 arguments/providerRef, usage, opaque continuation을 가진다. 여러 호출은 받을 수 있지만 Runtime은 순차 실행한다. ID 중복/불일치·잘못된 JSON·중단 응답은 실행 전에 거절한다.

| Provider | 이번 Tool Calling 구현 | 비고 |
|---|---|---|
| OpenAI | Responses, non-streaming 구현 및 fixture HTTP 검증 | 공식 규격 확인 + 발견된 모델 + 별도 reviewed capability 검사 |
| Anthropic | 미구현 | 기존 text Messages Adapter 유지; catalog tool capability만으로 실행 허용 안 함 |
| Gemini | 미구현 | 기존 generateContent 유지; function response/signature 정규화 미구현 |
| DeepSeek | 미구현 | 기존 text Adapter 유지 |
| NVIDIA/Groq/Mistral | 미구현 | OpenAI-compatible text 형식이라는 이유로 tool 지원을 추정하지 않음 |
| Cloudflare | 미구현 | 기존 text endpoint 유지 |

OpenAI의 검토 allowlist는 `gpt-4.1`, `gpt-4.1-2025-04-14`, `gpt-4.1-mini`, `gpt-4.1-mini-2025-04-14`다. 현재 계정의 모델 목록에 있어야 하며 명시적 tools=unsupported 모델은 차단한다. 공식 문서의 지원 여부와 실제 계정 접근/가용성은 다르다. 신규 모델이나 다른 Provider를 자동 지원으로 표시하지 않는다. 최신 모델 권장 목록을 제안하는 변경도 아니다.

`store:false`, `stream:false`, function schema 원문, `strict:false`를 명시한다. 비엄격 생성 결과도 로컬 Schema 검증은 반드시 통과해야 한다. continuation은 function call/output의 call_id를 대응시키고, reasoning/encrypted_content를 포함한 원본 output item을 다음 입력에 재전달한다. 내장 Shell/검색 등 예상하지 않은 output type은 거절한다. Streaming은 전체 JSON argument 조립·종료 검증이 없으므로 미지원이다.

규격 확인 근거: [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [GPT-4.1 Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini). 2026-11-03 확인. 실제 인증된 API 호출은 NOT_RUN이며 지원 표의 PASS는 규격 기반 fixture 계약 테스트다.

`ConnectivityEngine.toolRoutePlan()`은 기존 Router의 계정·Tier·순위를 유지한 뒤 구현된 Tool capability로 필터한다. `toolChat()`은 계정 권한을 재검사하고 기존 Ledger의 recordRequest/settle을 재사용한다. Provider 오류 이후 자동 재전송·fallback은 없다. Usage DB 구조·Soft Budget·기존 text `chat()`은 변경하지 않았다. MockAgentModel은 Ledger를 참조하지 않는다. HTTP fixture의 usage 테스트는 별도 in-memory Ledger이며 실제 사용자 사용량에 합산하지 않는다.

## Agent Runtime 사용 예시

기존에 연결·모델 발견·계정 사용 권한을 설정한 `engine`과 등록된 `vaultId`를 사용한다. 자동 모델을 고르려면 먼저 `engine.toolRoutePlan()`의 후보에서 하나를 선택하고, 한 Task 동안 같은 Provider/model을 유지한다.

```ts
import {
  VaultRegistry, HostFileGateway, ToolRegistry, ToolDispatcher,
  EngineAgentModel, SingleAgentRuntime,
} from './dist/index.js';

const files = new HostFileGateway(new VaultRegistry());
const tools = new ToolDispatcher(new ToolRegistry(), files); // product, writes DENY
const runtime = new SingleAgentRuntime(new EngineAgentModel(engine, 'openai'), tools);
const outcome = await runtime.run({
  vaultId, model: 'gpt-4.1-mini', prompt: '허용된 문서에서 프로젝트 현황을 요약해 줘.',
  signal: abortController.signal,
});
```

Task, Step, Invocation ID 및 결과는 메모리에서만 유지한다. Phase 7 Context나 자동 재개는 없다. 같은 Runtime의 동시 Task는 거절한다. 여러 프로세스 전체를 조율하는 Agent service/스케줄러는 아니다.

기본 한도는 모델 20회, Invocation 100회, 15분, Tool별 10초, Tool output 128 KiB, 총 result 1 MiB다. 더 작은 Runtime 한도를 지정할 수 있다. 읽기는 실행별 1 MiB의 보수적인 사전 예약량으로 제한한다(파일 64 KiB, 목록 128 KiB, 검색 256 KiB). 검색 자체도 항목/byte 한도를 검증한다. 한도를 넘으면 추가 부작용을 시작하지 않는다. 전체 batch의 ID와 호출 수를 검사한 뒤 순차 실행하며, 중복 호출은 다시 실행하지 않는다.

취소는 승인 대기를 중단하고 미실행 Tool을 시작하지 않는다. 이미 생성된 파일은 되돌리지 않는다. 모델이 취소를 무시해도 응답을 기다리며 Tool을 뒤늦게 실행하지 않는다. 반면 mutation은 helper 종료를 기다려 성공/미확인을 분류하며, 단순 Promise timeout을 종료 확인으로 사용하지 않는다.

Host 파일 Tool·모델 API는 VM admission을 획득하지 않는다. E2E에서 Host 저장소에 execution VM 상태가 생성되지 않았음을 확인했다. M1b의 Mock Backend와 stopAfterExecution 정책은 그대로이며 M4 VM 재사용을 구현하지 않았다.

## Gate 및 검증 결과

| Gate | 판정 | 검증 범위 / 미충족 범위 |
|---|---|---|
| A Tool Contract | PASS | 4 tests: 정의·Schema·입력·위조·비활성 광고 |
| B 제한 Host/Permission | PASS | 17 tests: Native 읽기, 승인 binding, stale 객체/정책, 취소·시간 초과, root 교체, 독립 프로세스 신규 생성 충돌 |
| B 기존 파일 수정·삭제 제품 활성화 | NOT_RUN / 비활성 | Native 객체 조건부 교체/삭제 검증 및 UI 없음. 활성화 게이트 미충족 |
| C Provider Contract | PASS | 5 tests: OpenAI fixture, ID/continuation, 오류/usage, Router·계정 필터 |
| C 실제 Provider/다른 Provider/Streaming | NOT_RUN | 인증된 실제 호출 및 미구현 경로 |
| D Single-Agent | PASS | 순차 Step·상한·취소·중복·Provider 오류 |
| E 격리 임시 Vault E2E | PASS | D/E 10 tests: 읽기·검색·연속 호출·Mock 승인 신규 생성·거부·OpenAI wire fixture부터 Ledger/Host까지 |
| E 실제 사용자 승인 기존 수정·삭제 | NOT_RUN / 비활성 | 성공한 것으로 기록하지 않음 |

이전 M1b의 Node 228/Swift 42는 역사 결과이며 이번에 다시 검증했다. 현재 추가 테스트는 총 36개(A 4 + B 17 + C 5 + D/E 10)다. 모든 파일 fixture는 별도 임시 `nidus-tools-*`/`nidus-agent-*` Vault에서 수행했다.

- Node 전체: **264/264 PASS**(기존 228 + 신규 36), 최종 fail/skip 0.
- Swift: **42/42 PASS**, fail 0.
- `npm run build:app`: **PASS** — local unsigned development bundle. 새 모듈의 bundle import smoke check PASS. 실제 UI 클릭/배포 서명은 NOT_RUN.
- 초기 컴파일에서 optional Schema 타입/Target import 및 never-return 추론 오류를 수정했다. 기능 테스트의 최종 FAIL/skip은 0이며 실패한 시도를 최종 PASS와 혼동하지 않는다.
- 실제 VM/M0, live Provider, Keychain 실자격증명, 실제 사용자 승인 UI, 기존 파일 삭제/교체, crash/전원 차단 Native E2E는 NOT_RUN.

## 남은 작업과 M4 전 결정

전체 사용자 목표 중 기존 파일 수정·삭제의 실제 사용자 승인 실행 흐름과 Provider 전체 확장은 아직 완료하지 않았다. 사용자의 안전성 예외에 따라 검증된 범위까지만 구현하고 나머지는 비활성화했다.

1. macOS에서 원본 객체의 조건부 overwrite/delete를 보장할 Native 설계 및 parent/target 교체 stress·crash 검증.
2. SwiftUI의 Diff 표시, 명시적 승인·거부, 단방향 기존 Runtime bridge와 분리한 신뢰된 승인 채널. 이 완료 전 product 쓰기는 계속 비활성.
3. 추가 Provider별 schema/function continuation/signature/streaming 및 실제 계정 테스트. Tool capability catalog 갱신 정책.
4. Native helper의 배포 서명·대상 macOS 버전 범위, staging 복구·최소 감사 기록, 여러 Host Agent 프로세스의 조율 정책.
5. M4에서 실제 VM Backend·세션 격리·종료 근거·잔존 프로세스·네트워크 검증. 이번 코드는 실제 VM 안전성 증거가 아니다.

사용자 검토 없이 M4에 착수하지 않는다. develop 병합/기존 브랜치 삭제/강제 reset/원격 push·PR은 하지 않았다. 시작/종료 develop은 `d5972bacbb1a41207ce5d15b25d09bcf82c942df`, main은 `723c03b59dcecaae27d9fe0a9f97b464c785d706`으로 유지한다.

## 구현 커밋

- `be6392b`: Tool 계약, Native 파일 Gateway, 승인 및 Gate A/B 테스트.
- `3b4e458`: OpenAI Tool Calling, Agent Runtime, Ledger/Router 연결 및 Gate C~E 테스트·앱 패키징.

최종 Node 264/264, Swift 42/42, macOS 개발 앱 빌드와 bundle import smoke check PASS. 개발 앱은 서명/배포·수동 UI 검증을 완료한 제품 빌드가 아니다.
