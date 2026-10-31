# Phase 5–6: Agent Runtime · Vault VM · Unified Tools

## 현재 설계 기준 — 2026-11-01

이 절부터 「M0 실제 검증 기록」 직전까지가 **현재 설계**다. 아래 날짜별 검증 기록은 당시 설계와 결과를 그대로 보존한 역사 기록이며, 현재 정책보다 우선하지 않는다. 이번 변경은 문서만 갱신하며 구현·DB migration·Prototype 변경·develop 병합을 하지 않는다.

작업 브랜치: `feature/agent-runtime-vault-sandbox`. 설계 변경 기준 코드: `a9a9c71`(M0 구현 `374b920` 포함). 해당 작업의 develop 통합은 `d5972ba`이며 별도의 후속 개발 준비 브랜치는 `feature/agent-runtime-vault-m1-m6`이다. 이번 문서는 사용자 지정에 따라 기존 feature에서 작성한다.

**방향:** Vault가 VM Environment를 소유한다. 도구는 Host / Vault VM / Provider로 분리하고, 단일 Agent가 Step 단위로 실행한다. VM 브라우저 기반 웹 검색·탐색은 필수 범위이며 검색 API로 대체하지 않는다. M0 잔여 검증과 Manager 사망 후 추가 복구 개발은 별도 후속 작업으로 미룬다. 이는 M0 통과를 의미하지 않는다. 개발 계획과 Mock/비활성 구현은 진행할 수 있지만, M0의 미검증 조건을 우회해 제품 Shell·브라우저를 활성화하지 않는다. **현재 요청은 설계 검토까지만이며 구현은 후속 승인 대상이다.**

## 기존 코드와 재사용 경계

| 현재 구성 | 확인된 상태 / 후속 재사용 |
|---|---|
| `ConnectivityEngine`, Provider Adapter 8개 | 공통 계정 실행 권한·Tier 재검사·HTTP·토큰 기록 재사용. 현재 ChatRequest는 user/assistant 문자열이고 ChatResponse는 text 중심이며 Tool 실행 API는 없다 |
| Model Registry / Router / Routing Context | 동적 모델 목록·Tier·가용성·사용량 정보 유지. `capabilities.tools`는 supported/unsupported/unknown이며 실제 Adapter 왕복 지원과 함께 검증해야 Agent 후보가 됨 |
| Usage Ledger / Soft Budget | 기존 SQLite 데이터 보존. 이미지 요청의 사용량 단위·비용 미확인은 확장 계약이 필요. 비용 기반 호출 차단이나 예약을 복원하지 않음 |
| SwiftUI Runtime | 기존 단발 JSON 요청은 유지. Agent 실행에만 장기 양방향 채널을 추가할 계획 |
| M0 Swift Manager / Python lifecycle·Registry·복구 UI | 실행별 합성 fixture에서 검증한 Prototype. Vault 소유권·세션 정리·VM 재사용을 구현/검증한 것으로 취급하지 않음 |
| Host 파일 Prototype | 최상위 제한 파일·신규 파일 반영 범위. 일반 디렉터리·overwrite·경쟁 조건 검증을 대신하지 않음 |

기존 Provider Adapter는 모델 API 형식 변환을 담당하고 실제 파일·Shell·브라우저 Tool을 실행하지 않는다. Provider 종류에 따라 같은 Tool의 권한 의미가 달라지지 않는다. Provider가 제공하는 원격 Shell·검색 기능을 Nidus의 검증된 Tool로 자동 대체하지 않는다.

## 전체 아키텍처와 책임

```text
SwiftUI / CLI
  └─ Single-Agent Runtime (Task → 순차 Step → Tool Invocation)
       ├─ 기존 Provider 엔진: 텍스트 추론 / Tool Calling 정규화
       └─ Unified Tool Registry → Schema 검증 → Permission Gateway
            ├─ Host File Gateway → Vault 내부 허용 파일
            ├─ Vault VM Execution Gateway → Vault VM Manager → Linux VM Session
            │    └─ Shell / 코드 / 빌드·테스트 / 실제 브라우저
            └─ Provider Tool Gateway → 이미지 API → 임시 artifact
                                                 └─ 승인된 Host File Gateway 저장
```

Keychain·API Key·Usage DB·원본 Vault는 Host에 둔다. 실행 대상은 신뢰된 Registry의 정적 정의로 결정하며 모델 인자에 따라 변경하지 않는다. VM Backend는 Apple Virtualization Linux ARM64를 우선 대상으로 유지한다. macOS 게스트는 확장점만 두며 이번 구현을 확정하지 않는다.

### Host Tool Gateway

- `list_files`, `search_files`, `read_file` 및 내부 메타데이터/Diff 기능은 허용된 Vault 파일에 한정한다. 검색은 Native/라이브러리 함수로 수행하며 임의 Shell로 위임하지 않는다.
- `write_file`, `apply_patch`, `delete_file`은 사용자 승인 대상이다. 삭제는 개별 파일만 허용하고 재귀 디렉터리 삭제는 제공하지 않는다.
- 루트 디렉터리 핸들 기반 경로 순회, no-follow, 파일 종류·링크 수·동일성 확인, 크기 제한, 정규화와 직전 재검사를 함께 적용한다. `.nidus`, `.git`, Secret·기기별 인증 경로는 Agent 접근에서 제외한다. Nidus 자체의 메타데이터 접근과 Agent 권한을 구분한다.
- 승인 시 대상·Diff·기준 해시를 고정한다. 승인 후 파일/정책/입력 변경은 충돌 또는 승인 무효로 처리하고 자동 overwrite하지 않는다. 임시 파일과 원자적 교체는 부분 쓰기를 줄이는 수단이지 compare-and-swap/TOCTOU 방어의 증명이 아니다. Native Helper의 파일 교체·부모 디렉터리 경쟁 조건을 검증한 뒤 지원 범위를 늘린다.
- 원본 변경은 이 Gateway만 수행한다. VM·이미지 결과도 예외가 아니다. Host 파일 접근 가능성이 macOS 전체 접근 권한을 뜻하지 않는다.

### Vault VM Execution Gateway

- Shell, Python/Node 등 코드 실행, 빌드·테스트, 실제 브라우저와 JavaScript 페이지 처리, 비신뢰 실행을 담당한다. VM이 필요하지 않은 Tool은 VM을 부팅하지 않는다.
- 원본 Vault를 writable mount하지 않는다. 승인된 manifest(경로·해시·크기·버전)로 파일을 작업 Workspace에 복사한다. 결과를 불신 입력으로 검사하고 Host Diff 승인 후 반영한다. Git 메타데이터가 필요하면 별도 검토된 snapshot을 전달하며 원본 `.git` 공유는 금지한다.
- 이미지/도구 구성은 검증된 VM Environment의 일부다. Session 임시 쓰기 영역·HOME·TMP·브라우저 프로필과 분리한다. 게스트에 Provider 키·Host DB·인증 데이터를 전달하지 않는다.
- 초기 기본 네트워크는 차단이다. 네트워크 허용은 Invocation/Session 범위의 별도 승인으로, VM 재사용 시 자동 승계하지 않는다. Host NAT 직접 연결이나 브라우저 request interception만으로 정책 집행을 주장하지 않는다.

### Provider Tool Gateway

- `generate_image`와 지원이 검증된 이미지 편집/변형을 Provider API로 수행한다. VM 슬롯을 사용하지 않는다. 텍스트 추론·Tool Calling도 기존 Provider 엔진에서 처리하며 VM 슬롯과 무관하다.
- 텍스트 모델과 이미지 생성 모델 선택은 별도다. 기존 텍스트 Tier Router에 이미지 모델을 억지로 포함하지 않는다. 초기 이미지 모델은 사용자 지정/검증된 capability만 사용하며 지원 모델이 없으면 unsupported를 반환한다.
- 생성 요청·외부로 보내는 이미지/프롬프트·과금 가능성에 대한 승인과 계정 실행 권한을 모두 확인한다. 결과 저장은 별도의 Host 변경 승인이다. 이미지 API 승인이 원본 파일 저장 승인으로 확대되지 않는다.
- 응답은 제한된 임시 artifact로 수신해 MIME·실제 파일 형식·크기·개수를 검증한다. Provider URL은 모델이 지정한 임의 URL이 아니며, 다운로드 origin/redirect/인증정보 전달 정책을 별도로 검증한다. 원본 bytes/URL/token은 감사 DB에 저장하지 않는다.
- Usage Ledger에 provider/model/requestId 및 제공된 usage/단위를 연결한다. 토큰이 없으면 null, 가격·비용이 불명확하면 null을 유지한다. 이미지 단가를 토큰 비용으로 위장하지 않는다. 실제 API 지원표·정산 확장 방식은 구현 전 결정 항목이다.

## Vault 소유권 및 데이터 계약

아래는 **Markdown 내 TypeScript 의사코드**이며 기존 public API나 구현 완료 타입이 아니다. runId는 기존 감사 실행 ID로 유지하며 Task·Step·Session과 혼용하지 않는다.

```ts
type ExecutionTarget = 'host' | 'vaultVM' | 'provider';
type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

type VaultDescriptor = {
  schemaVersion: 1; vaultId: string; displayName: string; createdAt: string;
  environmentId: string; // 설정 참조: 살아 있는 VM 핸들이 아님
};
type VMEnvironment = {
  environmentId: string; vaultId: string; revision: number;
  backendKind: 'apple-virtualization-linux-arm64'; imageDigest: string;
  toolsetRevision: string; resourcePolicyId: string;
};
type VMInstance = {
  instanceId: string; environmentId: string; vaultId: string;
  managerGeneration: string; hostBootId: string | null;
  managementState: 'CREATED' | 'STARTING' | 'RUNNING' | 'STOP_REQUESTED'
                 | 'STOP_CONFIRMED' | 'STOP_UNCONFIRMED' | 'FAILED';
  frameworkState: string | null; activeSessionId: string | null;
};
type Task = { taskId: string; vaultId: string; runId: string; workerId: string };
type Step = {
  stepId: string; taskId: string; runId: string; sequence: number;
  state: 'pending' | 'running' | 'awaiting_approval' | 'succeeded'
       | 'failed' | 'cancelled' | 'outcome_unknown';
};
type ToolInvocation = {
  invocationId: string; toolCallId: string; toolId: string; toolVersion: string;
  runId: string; stepId: string; input: unknown; inputHash: string;
};
type VMExecutionSession = {
  sessionId: string; instanceId: string; stepId: string; invocationId: string;
  workspaceId: string; workspaceRevision: number; policyRevision: number;
  state: 'preparing' | 'running' | 'stopping' | 'cleaning'
       | 'released' | 'quarantined';
};
```

- **VM Environment**는 Vault에 귀속된 구성이고, **VM Instance**는 이번 부팅의 실제 실행이다. **Session**은 VM 자원을 사용하는 한 Step의 격리 작업 단위다. Worker는 실행 주체, Task는 업무, Step은 작은 실행 단위이며 서로 수명과 ID가 다르다.
- `.nidus/vault.json`은 이동 가능한 Vault 식별/설정 참조만 보관한다. 절대 경로·Manager 제어 채널·boot ID·활성 Instance 잠금은 Host Registry에 둔다. Secret은 어느 곳에도 평문 저장하지 않는다.
- Vault 등록·전환·해제는 원본 파일 삭제가 아니다. 중첩 Vault 및 홈/파일시스템 루트 전체 등록을 거부한다. 복사된 vaultId는 사용자가 이동/독립 복사를 구분하도록 하고, 이전 VM/잠금을 복사해 살아 있는 실행으로 인식하지 않는다.
- Vault당 Environment 1개와 활성 VM 최대 1개를 초기 정책으로 삼는다. 중지된 이미지가 여러 버전 존재해도 활성 Instance는 하나다. Environment revision 변경은 활성 세션이 없고 안전한 종료가 확인된 뒤 적용한다.
- 초기에는 앱·CLI 합계 Agent Run 1개, **호스트 전체 활성 VM도 최대 1개**로 제한한다. Vault별 최대 1개와 별개의 보수적 전역 정책이다. 다른 Vault 병렬 실행은 격리/자원 검증 전 허용하지 않는다.

## Unified Tool Registry와 권한 계약

```ts
type ToolDefinition = {
  toolId: string; name: string; version: string; description: string;
  inputSchema: object; outputSchema: object; executionTarget: ExecutionTarget;
  requiredPermissions: string[]; sideEffect: 'none' | 'local-write' | 'external';
  approvalPolicy: 'policy-read' | 'per-invocation' | 'per-file-delete';
  timeoutMs: number; maxResultBytes: number;
  cancellation: 'cooperative' | 'session-stop' | 'not-guaranteed';
  errorCodes: string[]; capabilityRequirements: string[];
};
type ToolResult = {
  invocationId: string; status: 'succeeded' | 'failed' | 'denied'
    | 'cancelled' | 'outcome_unknown';
  data?: unknown; artifactRefs?: string[]; truncated: boolean;
  errorCode?: string; eventId: string;
};
type PermissionRequest = {
  approvalId: string; runId: string; stepId: string; invocationId: string;
  payloadHash: string; policyRevision: number; expiresAt: string;
  targetSummary: unknown; // 대상·Diff·명령·외부 전송 범위: 실행 중 메모리에만 유지
};
```

| Tool | 실행 대상 | 초기 승인·제한 |
|---|---|---|
| list_files / read_file / search_files | Host | 보호 대상 외 Vault 읽기, 검색 건수·출력 제한 |
| write_file / apply_patch | Host | Diff·기준 해시 승인 및 직전 재검증 |
| delete_file | Host | 파일별 명시적 승인, 재귀 삭제 미지원 |
| run_shell / run_tests | Vault VM | 정확한 명령·cwd·쓰기 대상·network 범위 승인. 테스트도 임의 코드 실행과 동일하게 취급 |
| browser_search / browser_navigate / browser_read_page | Vault VM | 검색어/URL/공개 읽기 범위·network 승인, 검색 API 미사용 |
| generate_image | Provider | 외부 전송·API 권한 승인, 저장은 별도의 Host 변경 승인 |

호출 순서는 **Adapter 정규화 → Registry 조회 → Schema/기능 검증 → Permission Gateway → 필요한 승인 → 실행 직전 재검증 → 대상 Gateway → 결과 정규화 → 모델**이다. 모델이 보낸 `executionTarget`, `approved`, `permissions`는 권한 근거로 쓰지 않으며 입력 Schema의 알 수 없는 필드는 거절한다. Tool별 승인·결과 크기·취소 의미를 Registry에서 정의한다.

승인은 일회성이며 payloadHash, run/step/invocation, 파일 버전, policyRevision에 결합한다. 중복 응답·만료·취소 후 응답·변경된 인자로 실행하지 않는다. 승인 대기 중 DB transaction이나 VM slot을 유지하지 않는다. 권한/감사 기록 저장 실패 시 부작용을 시작하지 않고, 결과 불명확 작업을 자동 재시도·rollback하지 않는다.

## 브라우저와 네트워크

웹 검색·페이지 탐색은 **VM 내부 실제 브라우저**로 수행한다. 초기 후보는 Playwright + Chromium이며 guest image·browser sandbox·network 정책의 호환성 검증 전에는 제품 채택으로 간주하지 않는다. 검색엔진 공개 페이지에서 결과를 탐색하고 페이지 텍스트·출처 URL을 제한된 결과로 정규화한다. 검색엔진은 M4 전 결정하며 새 검색 API를 도입하지 않는다. CAPTCHA·로그인 벽·검색 제한을 우회하지 않는다.

- 페이지·검색 결과·이미지 metadata는 비신뢰 입력이다. 페이지에 포함된 명령을 system instruction, Tool 승인, 정책 변경으로 승격하지 않는다.
- Host 브라우저·쿠키·확장·인증 session을 사용하지 않는다. Execution Session별 독립 profile을 만들고 page handle을 sessionId/generation에 묶는다. 다음 Step에는 URL 등 명시적 입력만 전달하며 숨은 쿠키/프로세스를 승계하지 않는다.
- 검색어·URL 자체도 외부 전송이다. 대상과 필요한 부속 resource 범위를 승인 UI에 표시한다. 새로운 최상위 origin 또는 승인 범위 밖 이동은 중지하고 재승인을 요구한다. 승인 대기는 안전한 경계에서 browser Session을 종료한 후 수행한다. 정리를 확인하지 못하면 slot을 반환하거나 다음 Step을 실행하지 않는다.
- VM의 직접 외부 통신을 차단하는 경계와 통제 proxy/broker를 설계한다. URL뿐 아니라 실제 DNS 목적지, IPv4/IPv6, redirect, WebSocket, Service Worker, QUIC 등 우회 경로도 다룬다. 내부망/loopback/link-local/metadata endpoint/Host 서비스, 비HTTP(S), DNS rebinding, 검증되지 않은 경로는 거절한다. browser request interception만으로 격리를 보장하지 않는다.
- 다운로드·업로드·로그인·폼 제출·게시·구매는 읽기 승인에 포함되지 않는다. 초기 Tool은 공개 검색/읽기만 제공하고 해당 행동은 미지원으로 거절한다. 추후 지원 시에도 별도 Schema와 대상/전송 내용에 결합된 개별 승인이 필요하다. navigate/read에 부작용 기능을 숨기지 않는다.
- 외부 페이지의 JavaScript가 무부작용이라고 보장하지 않는다. 인증정보 없는 환경, 전송/통신 범위 제한, 감사와 사용자 승인을 함께 적용하고 검증 전에는 활성화하지 않는다.

## Step·VM Slot·Session 운영

Phase 5–6은 단일 Agent의 Step 순차 실행이며 Tool도 순차 실행한다. 모델이 복수 Tool Call을 반환해도 병렬로 실행하지 않는다. LLM 추론, Host read/write, Provider 이미지 생성은 VM slot을 점유하지 않는다. 승인된 VM Step 시작 직전에만 slot을 얻고 Task 전체에는 할당하지 않는다.

1. Invocation과 승인을 검증하고 Vault/Environment/Instance revision 및 장애 상태를 재확인한다.
2. Host Registry의 배타적 admission에서 Vault별 VM 최대 1개·Session 최대 1개·전역 VM 상한을 함께 검사한다. 동시 시작으로 2대를 생성하지 않는다. slot은 instanceId/managerGeneration/sessionId에 결합한다.
3. Instance가 없으면 지연 부팅한다. 재사용 VM에서도 새 Session의 Workspace·프로세스 경계·network lease·profile을 준비한다.
4. 제한 시간 내 실행하고, 완료/취소 후 Session의 자식·분리된 프로세스, FD, 쓰기 활동, network 권한, browser profile의 종료·회수를 확인한다.
5. 종료와 정리를 확인한 경우에만 slot을 반환한다. 신호 전송·leader 종료·lease 만료는 반환 근거가 아니다. 불명확하면 Session과 Instance를 격리하고 필요하면 VM 전체를 종료한다.

Session 경계의 후보는 guest의 신뢰된 제어 서비스, 비특권 실행 사용자, cgroup/namespace 등이다. 구체 방식은 M4 전 기술 결정 대상이다. workload가 제어 서비스나 관리 cgroup을 바꿀 권한을 갖지 않도록 한다. **PGID만으로 setsid/double-fork를 통제하지 못한다**는 기존 M0 결과를 유지한다. 전체 자손 종료·청소를 검증하지 못하면 warm VM 재사용을 금지하고 VM 전체 종료 확인 후 다음 Instance를 시작한다. 재사용 성능보다 안전을 우선한다.

동일 Task에서도 쓰기 가능한 Workspace를 Step 간 암묵적으로 공유하지 않는다. 필요한 결과는 명시적인 artifact/manifest revision으로 인계하고 입력 해시·승인 범위를 확인한다. Host와 VM 결과가 같은 원본을 수정했다면 적용 시 충돌로 중지한다. 승인 없이 overwrite/자동 merge하지 않는다.

짧은 Step 우선·Aging, Task 의존성, Worker별 공정성, Task Board는 Phase 8 확장점이다. 예상 시간은 휴리스틱이지 실제 측정이나 성능 보장이 아니다. 초기에는 순차 실행만 구현하며 실행 중 command를 강제로 선점해 다른 Step에 slot을 넘기지 않는다.

## Vault VM 생명주기와 장애

Environment는 Vault가 보유하고 독립 Manager가 Instance를 소유한다. Worker/Task 종료를 VM 소유권 소멸로 해석하지 않는다. 활성 Session이 있으면 유휴 종료를 금지한다. 초기 idle timeout은 **5분을 제안**하며, Session 없음·cleanup 확인·중지 처리 중 아님 조건에서만 적용한다. Vault 닫기는 활성 Step 취소/종료 확인을 먼저 수행한다.

| 대상 | 수명 및 정리 조건 |
|---|---|
| Vault 원본·Environment 설정 | VM 종료와 독립. Vault 해제로 원본을 삭제하지 않음 |
| 검증된 base image/toolset | immutable version/digest로 식별. 이용 중 참조가 있으면 삭제하지 않음 |
| Instance disk·임시 쓰기 영역 | VM 종료 확인과 참조/무결성 검사 후 회수. 미검토 변경을 다음 부팅으로 승계하지 않음 |
| Session Workspace·profile·network lease | Session마다 격리하고 정리 확인 후 회수. 반영 대기 artifact는 별도 보관 |
| 반환 artifact·Diff | Host 승인/버전 확인 후 원본 반영. 미승인·결과 불명확이면 격리 |
| Host Journal·Registry | 최소 실행 안전 기록. Task 재개용 context로 사용하지 않음 |

관리 상태는 CREATED/STARTING/RUNNING/STOP_REQUESTED/STOP_CONFIRMED/STOP_UNCONFIRMED/FAILED를 유지한다. Framework 상태와 관리 상태, VM 종료와 Session 정리를 별도 기록한다. FAILED도 종료 확인을 뜻하지 않는다.

작업 취소 시 Session 종료를 먼저 시도한다. 확인 불가면 quarantined로 전환해 slot을 유지하고 VM 전체 종료를 시도한다. 초기 활성 Session은 하나이므로 다른 실행 중 Step은 없지만 같은 Vault의 대기 Step에는 `blocked_by_vm_failure`를 기록한다. 종료 확인 후에도 이전 Task를 자동 재실행하지 않는다. 새 작업은 새로운 사용자 요청/실행 ID/승인을 요구하며 이전 작업 맥락을 복원하지 않는다.

Manager 사망/제어 단절은 기존 M0 Fail-closed와 사용자 알림을 유지한다. instanceId→vaultId→session/step 관계로 영향 범위를 찾고 해당 Vault의 모든 VM 의존 Step을 동결한다. **종료 미확인 상태에서 같은 Vault에 새 VM을 만들지 않는다.** 시간 경과로 slot을 해제하지 않는다. 다른 Vault VM도 격리·전역 자원 검증 전에는 전역 차단을 유지한다.

장애 중 Host read는 원본 Vault가 VM에 공유되지 않았고 Registry/루트 동일성·보호 경로·무결성이 확인되는 경우, 사용자의 명시적 읽기 조작에 한해 허용한다. 미확인 Workspace/artifact는 읽지 않으며 Registry 손상 또는 원본 접근 가능성이 불명확하면 read도 거절한다. 격리 Vault의 Host 쓰기·이미지 저장·새 Agent Run은 금지한다. 이미 Provider가 수락한 요청은 취소를 보장하지 않고 결과를 격리하며 기존 Task를 자동 계속하지 않는다.

M0의 boot 증거·파일 inventory·복구 UI는 기존 범위에서 유지한다. Vault 소유 metadata 확장은 필요하지만 Manager 사망 후 자동 복구나 새로운 종료 증명 기능은 이번 추가 개발 대상이 아니다. 실제 host 재시작·VM 재연결이 검증됐다고 표시하지 않는다.

## Agent Runtime·전달·감사

Agent용 typed messages/Tool Call/Tool Result/opaque continuation을 기존 문자열 chat 계약과 구분해 확장한다. 기존 chat API의 호환성을 보존하고 Tool-only 응답을 정상 처리한다. Provider별 ID·결과 대응·서명/continuation은 구현 전 공식 자료와 Mock으로 확인한다. 모든 Provider/모델에 공통 지원을 가정하지 않는다.

첫 유효 응답 이후 모델은 고정한다. Tool 실행 후 대화를 다른 Provider로 임의 전달하지 않는다. 명시적 거절 시 안전한 초기 Fallback은 기존 Router를 재사용하지만, 전송/부작용 불명확 상태에서는 자동 재시도하지 않는다. Provider 실행 권한과 Tool 권한을 각각 확인하며 이미지 usage/비용 미확인은 0으로 만들지 않는다.

CLI/SwiftUI는 같은 Runtime/Gateway를 사용한다. Agent 전용 NDJSON은 protocolVersion/messageId/runId/stepId를 포함하고 start/approval_decision/cancel/shutdown 및 ready/execution_event/approval_required/terminal/error를 교환한다. 기존 단발 Dashboard JSON은 유지한다. stdout은 protocol 전용이며 끊어진 연결·잘못된 frame·출력 초과를 승인으로 해석하지 않는다. 비대화형 CLI는 승인 필요 작업을 거절한다.

초기 제한안은 기존 실행 제한을 기반으로 새 Tool 제한을 추가한다: 실제 LLM 시도 20회(Fallback 포함), Task 15분(승인 대기 포함), Tool 100회, 응답당 Tool 8개 순차 실행, 동일 Tool/인자 연속 3회, 파일 입력 1MiB, 모델에 전달할 결과 64KiB, Shell 120초·수집 출력 1MiB, browser 조작 30초, NDJSON 2MiB. 이미지 개수/해상도/수신 크기/timeout은 Provider capability 표에서 별도 결정하고 미설정 기능은 미지원으로 거절한다. 실행 안전 제한이며 금액 Budget Guard가 아니다.

`ExecutionEvent`에는 schemaVersion/eventId/sequence/timestamp와 vaultId/environmentId/instanceId/sessionId, runId/taskId/stepId/invocationId, 해당하는 approvalId/requestId, type/status/errorCode/duration을 연결한다. 해당하지 않는 ID는 null이며 임의로 채우지 않는다. 시작·승인·실행·slot 취득/반환·cleanup·장애·취소·결과 미확인·종료를 기록한다.

원본 내용·prompt·응답 본문·명령 전체·Diff·Cookie·API Key·인증 token·이미지 bytes·continuation은 감사 DB에 저장하지 않는다. 필요한 UI 표시는 현재 실행 메모리/격리 artifact로 제한한다. URL query/fragment와 검색어도 민감할 수 있어 영속 로그에는 허용된 origin·hash 등만 기록한다. 경로 식별·전후 hash·승인 결정·시간·Usage 연결 등 최소 정보만 남긴다.

Vault 감사 DB와 Host VM Journal의 책임을 분리한다. 기존 Usage Ledger는 비용/사용량의 source이며 VM 정리나 Task Memory의 저장소가 아니다. 앱 종료 후 미완료 Run/Step은 interrupted/outcome_unknown으로 표시하고 이벤트 재생으로 작업을 자동 복구하지 않는다.

## 새 M1~M6 순서·의존성·완료 조건

기본 순서는 **M1 → M2 → M3 → M4 → M6**이며 M5는 M1부터 병행한다. M6의 최소 UI도 각 단계에 함께 연결한다. M0 잔여 검증은 별도 후속 track이며, M4의 실제 활성화는 검증 조건 충족 전까지 보류한다. Mock 성공은 실제 VM/browser 안전 인증이 아니다.

| 단계 | 산출물·의존성 | 완료 조건 |
|---|---|---|
| M1 Vault Foundation | Registry, Vault 이동/복사, Environment, Instance 소유 관계, Host 실행 잠금 | ID 충돌·중첩 Vault·동시 부팅·기록 손상 처리. 기존 M0는 legacy로 보존하고 임의 Vault에 매핑하지 않음 |
| M2 Unified Registry / Permission | M1, Host read/변경 Gateway, 공통 Schema·결과·승인, Provider 이미지 Tool 계약 | 모델 권한 위조·만료/버전/충돌/취소 테스트, 승인 전 변경 0, VM 불필요 Tool이 VM을 시작하지 않음 |
| M3 Single Agent | M2, Adapter Tool 정규화, 순차 Step loop, Router/Usage 통합, 검증된 Provider 이미지 Gateway | Tool-only/ID 대응/unknown/continuation/제한/취소/불명확 결과 및 이미지 생성·저장 별도 승인 Mock. 8개 Provider의 지원/미지원을 표로 명시 |
| M4 Vault VM Backend | M1~M3, Session·slot·지연 부팅·유휴 종료, Shell/빌드/테스트, 필수 VM browser 검색 | slot 경합·반환 근거, setsid/double-fork·세션 오염, network 우회·페이지 지시 공격·산출물 충돌을 실제 VM에서 검증. 미자격이면 비활성 |
| M5 Logging / Safety | M1부터 공통 Gateway와 함께, M0 장애 UI의 ID 연결 | 중복 이벤트·감사 실패·중단·정합성·Secret 비저장, 미확인 VM 대기 Step 동결과 무단 재개 거절 |
| M6 SwiftUI | 각 단계 API와 M5, Vault·Step·Tool·Diff·승인·VM 상태·취소·이력 | CLI와 동일 권한, 지연 승인·중복 클릭·앱 종료, 기존 Provider 회귀, Mock E2E/실VM/수동 UI/빌드를 구분 검증 |

최종 시나리오: Vault 등록 → Host 조사 → Diff 승인/수정 → VM 테스트 → VM browser 공개 검색/페이지 읽기 → 필요한 경우 Provider 이미지 생성 및 저장 승인 → 변경·테스트·사용량 보고. 각 단계는 필요한 자원만 취득한다. 실제 API 호출은 별도 명시적 승인이 필요하며 우선 Mock/로컬 fixture로 검증한다. M0 종료 미확인 시 후속 VM Step·파일 반영·정리를 막고 이력만 보존해야 한다.

## 대체 정책·Phase 경계·미결정 사항

| 이전 방침 | 현재 방침 |
|---|---|
| Run/Worker의 VM 소유 | Vault가 Environment 소유, 독립 Manager가 Instance 제어, Step이 Session/slot 사용 |
| 원본 Vault에서 native Shell, Linux VM 제외 | Linux ARM64 VM과 승인된 작업 복사본. Host는 제한된 파일 Gateway |
| Task 전체 VM 점유 | VM Step만 slot 사용. LLM/Host/이미지 API는 제외 |
| M0 완료까지 M1~M6 일괄 보류 | 설계·단계 개발을 분리. M0 추가 검증은 후속으로 두되 제품 Shell/browser 안전 게이트 유지 |
| web_search/read_web_page와 별도 browser 가정 | browser_search/navigate/read_page를 Vault VM 내부에서 실행, 검색 API 미사용 |
| VM 임시 상태를 다음 작업으로 승계 | VM 재사용과 Session 정리를 분리. 명시적 artifact 외 암묵 전달 금지 |

Phase 5–6은 단일 Agent의 현재 Task·순차 Step·실행 안전 감사까지다. Phase 7의 Home/Desk/Library/Persistent Task Context, Memory/RAG/압축/세션 복구는 구현하지 않는다. Phase 8의 Multi-Agent, Task Board, Worker 분배·공정성·짧은 Step 우선·Aging은 ID와 경계의 확장점만 둔다. JEV·AI Office 전체·예산 예약·금액 기반 강제 Fallback·검색 API는 추가하지 않는다.

실제 착수 전 또는 단계 진입 전에 필요한 판단:

1. **M1 전:** Vault 소유·단일 Agent·전역 VM 1개·장애 중 Host read 조건을 검토하고 Host Registry/감사 DB schema와 기존 M0 취급을 확정한다. `.nidus` 이동/손상 처리도 정한다.
2. **M2 전:** Native File Gateway의 overwrite/rename 경쟁 방어 방식과 초기 지원 파일 범위를 검증한다. 원자 rename만으로 충돌 방어를 주장하지 않는다.
3. **M3 전:** Provider별 Tool Calling 지원표와 이미지 Provider/model/format/크기/timeout/과금 usage 단위를 확인한다. 공통 인터페이스가 모든 모델 지원을 의미하지 않는다. 이번 문서 작업에서 공식 API 지원을 새로 인증하지 않는다.
4. **M4 전:** guest image/toolchain 배포·업데이트, Session 격리/정리 증명, browser/검색엔진, network broker 위치, OS·서명 범위를 결정한다. 유휴 5분은 자원 상한과 함께 확인할 초기 제안이다.
5. **활성화 전:** 남은 M0와 실제 VM/browser/재부팅/UI E2E의 PASS 기준을 확인한다. Manager 사망 후 UNCONFIRMED를 시간 경과로 PASS 처리하는 정책은 포함하지 않는다.

## 과거 M0 실측 기록 — 이하 보존

이하의 「현재」「보류」「backend 미채택」 등은 각 날짜 당시의 판단이다. 새 Vault 소유 모델이나 Session/browser 설계가 검증됐다는 뜻이 아니다. 현재 개발 방향은 문서 앞부분을 따른다.

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

## M0 사용자 장애 대응 및 복구 UI — 2026-10-31

### 연결 범위와 사용자 절차

SwiftUI toolbar의 **VM 복구**에서 M0 Registry 파일을 선택한다. 선택한 경로는 앱 설정에 저장하고, 다음 실행에서도 3초 간격으로 복구 상태를 조회한다. STOP_UNCONFIRMED/FAILED 또는 조회 실패는 하단 장애 배너로 알린다. 화면에는 실행/Vault 식별자, 최초 관측된 장애 시각, 마지막 journal 시각, 관리 상태·종료 확인·차단 사유, 허용 목록으로 정제한 이벤트, 종료 시도 시각을 표시한다. 실제 사망 시각을 관측하지 못하면 마지막 기록 시각과 혼동하지 않는다. 기존 Registry에 Vault ID가 없으면 M0 진단으로 표시하며 경로나 이름을 추측하지 않는다.

제품에는 Agent/VM 생성 기능을 추가하지 않았다. Registry 수동 등록은 M0 검증 UI의 연결 방법이며 일반 Vault 관리가 아니다. 새 Supervisor·서비스·VM 기술도 설치하지 않았다. 기존 Provider/Router/Ledger는 변경하지 않았다. 앱 bundle에는 읽기/복구용 Python 파일 3개만 포함하며 VM 실행 바이너리는 포함하지 않는다. `/usr/bin/python3` 또는 해당 스크립트를 사용할 수 없으면 오류와 차단 상태를 표시한다. Python 런타임 설치는 하지 않는다.

### 신뢰 가능한 채널과 종료 시도

살아 있는 Swift Manager만 실행별 private 디렉터리에 `control.sock`을 생성한다. 접근권한 0600, 디렉터리 0700, run ID와 임의 capability token을 확인한다. token은 Host의 control.json에만 두며 UI·journal·Evidence에 출력하지 않는다. 별도 Supervisor나 PID 검색·종료를 사용하지 않는다. UI bridge는 동일 사용자 소유 private 디렉터리와 일치하는 run ID를 확인한 경우에만 status/cancel을 전달한다. 이 채널은 동일 사용자 악성 Host로부터의 방어를 입증한 제품 IPC가 아니다.

안전 종료 버튼은 유효한 채널이 있고 Manager가 요청을 수용할 수 있을 때만 활성화한다. 클릭 즉시 성공으로 표시하지 않으며 기존 requestStop → forceStop → callback/stopped 검증을 재사용한다. 종료 요청은 저장되지 않은 VM 변경을 잃을 수 있음을 안내한다. 동시 클릭은 UI busy 상태로 차단하고, Manager도 중복 종료를 새 실행으로 처리하지 않는다. 채널 상실·timeout·손상된 journal에서는 STOP_UNCONFIRMED와 차단을 유지한다. raw 오류·guest serial·파일 내용은 표시하지 않는다. 복구 관측/종료 시도는 별도 Host `recovery-events.jsonl`에 최소 정보만 기록한다.

### 호스트 재시작과 파일 검증

Nidus는 Mac 재시작을 실행하지 않는다. 사용자는 다른 작업을 저장하고 데이터 손실 가능성을 검토한 뒤 직접 결정한다. 단순 앱 재시작·시간 경과·PID 소멸은 잠금 해제 근거가 아니다.

실행 전 Registry에는 조회 가능한 경우 OS `kern.bootsessionuuid`와 Registry의 device/inode 식별을 기록한다. 현재 boot UUID가 유효하고 달라졌으며 동일 Registry임을 확인하면 이전 부팅의 VM 종료 근거와 파일 검증을 **별도**로 판단한다. 새 실행 허용에는 원본과 Workspace 각각의 명시적 사전 inventory에 대해 파일 목록/내용 SHA256 일치가 추가로 필요하다. 예상 밖 파일, symlink/hardlink, 내용 변경, 누락된 inventory, 손상된 audit은 계속 차단한다. `begin_run(..., inventory=...)`는 승인된 flat-file inventory를 실행 전에 기록할 수 있다. 현재 fixture와 이전 Registry는 inventory가 없을 수 있으므로 재부팅만으로 해제되지 않는다. 승인된 변경 반영/일반 재귀 merge UI는 이번 범위가 아니다.

실제 boot UUID 조회는 이 Mac에서 확인했으나 **실제 Mac 재부팅 E2E는 NOT_RUN**이다. UUID 변경/미변경/조회 실패, Registry 복사, 파일 변경·누락을 Mock으로 검증했다. 부팅 근거를 조회할 수 없으면 추측하지 않는다. 절전/앱 재실행은 boot 변경으로 취급하지 않는다. 해당 정책은 현재 OS의 관측 가능 정보에 의존하며 다른 OS 버전·재부팅 방식은 별도 검증이 필요하다.

안전 제한은 해당 작업의 재실행·원본 반영·자료 삭제와 자동 재개 금지다. 기존 단일 Registry 실행 admission을 유지하고, 다른 Vault 허용을 추가하지 않았다. 제품 Shell은 여전히 비활성 상태이므로 이 UI가 전역 실행 제한을 해제하는 경로는 없다. 직접 저수준 진단 바이너리를 임의 실행하는 것을 제품 권한 경로로 간주하지 않는다.

### 검증 결과와 재현

- 실제 VM: UI와 동일 bridge를 통한 안전 종료 PASS, Worker 종료 PASS, Manager SIGKILL의 종료 증명 UNCONFIRMED. Manager 사망 후 버튼 비활성·재시작/반영/정리 차단 정책은 PASS.
- Swift 46개 PASS(복구 상태·버튼 정책·실패 안내·재로드·layout 구성 Mock 4개 포함), Python 21개 PASS, Node 174개 PASS, macOS release 앱 packaging PASS.
- headless 이미지 캡처는 텍스트 표시를 확인하지 못하여 시각 QA 성공으로 인정하지 않았다. 실제 창의 수동 클릭 E2E, 실제 SwiftUI crash, 실제 호스트 재부팅은 NOT_RUN이다.
- 일반 파일 merge, 외부 네트워크 허용 정책, 다른 Vault와의 동시 실행 격리, Manager 사망 후 공식 VM 재연결은 미검증/미지원 상태를 유지한다.

```sh
# 기존 VM assets 준비 후 별도 target 빌드·서명
swiftc scripts/agent-vm/VMProbe.swift -framework Virtualization -o /private/tmp/nidus-vm-m0-assets/vm-manager
codesign --force --sign - --entitlements scripts/agent-vm/probe.entitlements /private/tmp/nidus-vm-m0-assets/vm-manager
python3 scripts/agent-vm/recovery_probe.py /private/tmp/nidus-vm-m0-assets > /tmp/nidus-user-recovery-final.json
python3 scripts/agent-vm/test_recovery.py
swift test
npm test
npm run build:app
```

진단은 M0 미자격이므로 exit 1이다. [사용자 복구 Evidence](evidence/Phase5_6_M0_VM_User_Recovery.json)를 새로 저장하고 이전 결과는 보존했다. **장애 대응 경로는 추가했지만 Manager 소멸 후 즉시 종료 확정 문제를 해결한 것으로 간주하지 않는다. M0 전체 미통과와 M1~M6 보류를 유지한다.**
