# M2/M3 보완 및 M4 Shared VM Runtime — 개발 검토 결과

작성: 2026-11-03. 브랜치: `feature/vault-runtime-v2`.

**M4 전체 완료가 아니다.** 실제 Apple Virtualization 기반 오프라인 VM, cgroup 실행 세션, VM 재사용, Host 서비스, 제한된 Shell, SwiftUI 승인 채널을 구현했다. 실제 Browser, 허용된 외부 네트워크, 영속 개발 디스크·패키지 캐시, 전체 개발 도구 이미지는 미완료다. Browser와 Host 파일 생성·수정·삭제는 제품 Tool 목록에서 계속 제외한다. VM이 부팅된다는 사실을 전체 VM 안전성 검증으로 표시하지 않는다.

현재 전달물은 `dist/Nidus.app`의 로컬 개발 빌드다. 앱 번들의 Node·VM helper·이미지로 실제 Shell을 실행한 검증은 통과했다. **실제 사람의 SwiftUI 버튼 클릭 검증은 NOT_RUN**이다. UI 자동화 도구가 두 차례 `Sky Computer Use native pipe startup failed`로 초기화에 실패했다. 프로그램으로 주입한 승인 fixture를 실제 사용자 승인이라고 기록하지 않았다.

## 1. 기준과 호환성

`CONCEPT.md`, 최신 `Vault_Runtime_v2_Plan.md`, Phase 5–6 설계, M1a/M1b/M2–M3 문서와 저장·테스트 구조를 기준으로 구현했다. M0의 생명주기·종료 미확인 사례만 참고했고 Prototype 전체, 복구 기능, 원본 Evidence를 이식·변경하지 않았다.

- M1a Descriptor v1과 Vault Registry API는 유지한다. Environment ID를 새로 발급하지 않는다.
- M1b의 Mock Admission API 및 `stopAfterExecution=true` 테스트 계약은 보존한다. 실제 Backend의 재사용 정책을 이 Mock 상태 파일에 혼합하지 않았다.
- 실제 실행은 별도의 `SharedVMController`와 단일 Host 서비스로 제공한다. VM 부팅/종료와 Session 시작/정리를 분리한다. 기존 M1b API의 모든 구현이 실제 Backend로 교체됐다는 뜻은 아니다.
- 기존 Provider Adapter, Model Router, Usage Ledger 구현은 이번 작업에서 수정하지 않았다. OpenAI Tool Calling과 기존 계정 실행 권한·Soft Budget 계약을 이용한다. Budget Guard를 재도입하지 않았다.
- Host 읽기 및 Provider 호출은 VM 슬롯을 사용하지 않는다. 이미지 생성, Phase 7 Memory, Phase 8 Scheduler는 구현하지 않았다.

## 2. M2/M3 보완

`ToolDispatcher`의 호출 ID와 읽기량 예약을 Execution별로 관리하고 Runtime의 `finally`에서 정리한다. 미소비 파일 변경안·승인 grant도 같은 범위에서 제거한다. 실행 범위 수와 호출 수에 상한을 두며 실행 중 중복 차단은 유지한다. 종료한 Task를 동일 ID로 재개하는 API는 없다.

실제 Shell은 메모리 Set에만 의존하지 않는다. Journal에 Vault/Execution/Call의 결합 hash와 Session을 **게스트 dispatch 전에** 기록한다. 완료된 Invocation도 재실행하지 않는다. 서비스가 정상 종료 후 다시 시작해도 같은 Invocation의 재사용을 차단한다. 미확인 기록은 자동 삭제·초기화하지 않는다.

Provider의 `NidusError` code를 보존하여 네트워크, timeout, 인증, rate limit, 불완전 응답 등을 일반 예외와 구별한다. 모델 응답이 취소 뒤 도착해도 새 Tool을 시작하지 않는다. 이미 dispatch한 VM 호출의 결과 채널을 잃으면 보수적으로 `unknown`/Task `UNCONFIRMED`로 종료하고 자동 재시도하지 않는다. Provider 사용량의 불확실성은 기존 Engine/Ledger 처리를 그대로 사용한다.

Native 읽기 허용 목록에 Python, TS/TSX, JS/JSX/MJS/CJS, Swift, JSON, HTML/CSS, YAML/TOML, C/C++/Rust/Go/Java/XML/SQL을 추가했다. 숨김 경로, `.nidus`, Secret/credential/config/token/password/auth 이름, settings 파일, 인증 키, 환경 파일, `node_modules` 등은 계속 차단한다. UTF-8/바이너리·링크·객체 동일성 검사와 64 KiB 파일, 실행당 보수적 1 MiB 읽기 예약, 검색 한도를 유지한다. 이는 내용 기반 Secret 탐지기가 아니다. 임의 소스 파일에 포함된 민감한 값까지 안전하다고 보장하지 않는다. 앱은 Agent 실행 전에 선택 Vault의 허용 파일과 결과를 OpenAI로 전송한다는 확인을 요구한다.

Host 파일 생성·수정·삭제의 제품 비활성 정책은 유지했다. 이번 M4 결과로 기존 파일 교체/삭제의 Native 보안 게이트를 통과 처리하지 않는다.

## 3. 구현 구조와 API

| 영역 | 주요 파일 | 역할 |
|---|---|---|
| VM 소유자 | `native/vault-vm.swift` | VZ VM 소유, 직렬 채널, 부팅, guest 종료/delegate 및 강제 stop callback 확인 |
| 실제 Backend | `src/vault/apple-backend.ts` | 고정 이미지 검증, helper 실행, 결과 정규화, 채널 상실 처리 |
| Host Admission | `src/vault/shared-vm.ts` | Environment/Generation, 부팅·Session 분리, 단일 서비스 FIFO, 취소, 유휴 종료 |
| 영속화 | `src/vault/vm-journal.ts`, `vm-protocol.ts` | 소유권 잠금, revision, Session/Invocation 기록, 중단·손상 차단 |
| IPC | `src/vault/vm-service.ts`, `vm-client.ts` | 독립 Host 서비스, 인증된 Unix socket, 여러 앱/Node 프로세스 요청 직렬화 |
| 게스트 | `scripts/vault-vm/init.sh`, `prepare.py` | 비특권 chroot, cgroup v2, 정확한 Session 정리, 고정 공개 이미지 준비 |
| Tool/Agent | `src/tools/vm.ts`, `src/agent-channel.ts` | 서비스 제안→신뢰된 UI 승인→한 번 dispatch, NDJSON 이벤트·취소 |
| 앱 | `Sources/NidusNativeApp/VaultRuntimeView.swift` | Vault 선택, VM 상태·시작·종료, 직접 Shell/Agent, 승인·거부·결과 |

`SharedVMController`의 주요 메서드는 `initialize`, `start(vaultId)`, `status`, `propose(vaultId, executionId, callId, command)`, `executeApproved(approvalId)`, `cancel(executionId)`, `stop`, `close`다. `VMClient`가 단발 RPC로 같은 서비스에 접속한다. 모델에는 이 제어 API나 서비스 token을 노출하지 않는다.

Environment는 M1a `environmentId`와 결합한다. 활성 Instance에는 `vmInstanceId`, 전역 단조 증가 Generation, Vault/Environment ID, Host 상태, ready, 활성 Session이 있다. Session에는 Execution/Call ID, Invocation hash, 명령 hash, Instance/Generation, 상태, 생성·완료 시각, cleanup 확인, 결과 hash가 있다. 명령 본문과 stdout/stderr는 Journal에 저장하지 않는다. 결과에는 종료 코드, stdout/stderr, cleanup, 종료 사유, 게스트 cgroup memory peak를 반환한다. CPU 사용량 및 Host 전체 VZ 프로세스 메모리 실측은 하지 않았다.

## 4. Host 저장·프로세스 간 보장

기본 위치는 기존 저장 정책을 따라 `~/.local/share/nidus/vaults/vm-runtime/`다. Vault 내부나 Provider/Ledger DB에 두지 않는다.

```text
vm-runtime/
  owner/identity       # 배타 mkdir로 획득한 서비스 소유권
  owner/token          # 0600 로컬 IPC capability, 모델/게스트에 전달하지 않음
  control.sock         # 0600 Unix socket
  initialized          # 기록 유실 감지
  state.json           # schemaVersion 1, revision, 정책, Instance, Session audit
  pending-<UUID>       # 미완료 기록이 있으면 안전 차단
```

디렉터리·파일의 no-follow/소유자/권한·단일 링크·동일성을 확인한다. 파일과 디렉터리를 fsync하고 pending 파일을 원자 rename한다. 이전 원문과 revision 충돌, 손상, 누락, 오래된 Generation을 거부한다. 실패한 기록이나 프로세스 사망 후 owner를 PID/TTL로 회수하지 않는다. 같은 사용자 계정 자체가 악성인 상황이나 관리자가 저장소 전체를 강제로 삭제하는 상황을 막는 보안 경계는 아니다.

한 서비스가 FIFO와 슬롯을 소유하므로 여러 OS 클라이언트 사이에도 같은 대기열을 사용한다. 접수·Journal 기록 후 순서를 정하며 동시 네트워크 전송의 벽시계 순서를 보장한다는 주장은 하지 않는다. VM 시작과 admission 사이에 stop이 끼어드는 경쟁도 차단했다.

정책은 전역 VM 1, Vault VM 1, VM별 Session 1, `host-service-fifo`다. 다른 Vault의 요청은 활성 VM이 있으면 `vm_global_limit`으로 거절한다. 명시적 종료 또는 idle 종료가 확인된 뒤에만 다른 Vault로 넘긴다. 여러 VM 동시 실행은 미지원이다. 정책 구조와 Vault 제한을 분리했지만 현재 설정값을 2로 올리는 기능은 없다.

정상적으로 살아 있는 서비스에는 앱을 다시 열어 접속할 수 있다. **사망한 Manager의 복구·재연결·Task 재개는 없다.** stale owner/socket 또는 진행 중 기록이 남으면 `STOP_UNCONFIRMED`로 표시하고 새 실행을 차단한다. 잠금 해제/기록 초기화 버튼도 제공하지 않는다. Session 기록은 10,000건, 취소 tombstone은 10,000건, 대기 승인안은 100건까지이며 한도 뒤에는 차단한다. 안전한 감사 보존·회전 정책은 M5 작업이다.

## 5. 실제 VM과 Session 경계

검증 Host는 macOS 27.0.1 (26A434), arm64다. Apple Virtualization entitlement로 로컬 서명한 helper가 Linux ARM64 VM을 소유한다. 2 vCPU, 512 MiB, entropy/serial 장치만 구성한다. **네트워크 장치, Host 공유 디렉터리, 원본 Vault mount, 지속성 디스크가 없다.** 등록/앱 시작/승인안 생성만으로 VM을 부팅하지 않는다. 승인된 첫 Shell이나 사용자의 VM 시작 버튼에서 부팅한다.

같은 Vault의 정상 Session들은 같은 Instance/Generation을 순차 재사용한다. Session이 끝났다는 이유로 VM을 종료하지 않는다. 기본 5분 idle 뒤 정상 종료를 요청하며 활성/대기 Session이 있으면 종료하지 않는다. 서비스 시작 전 `NIDUS_VM_IDLE_MS`로 idle 시간을 구성할 수 있다(100~3,600,000 ms; 기본 300,000 ms). UI 설정 편집은 미구현이다.

게스트 root supervisor는 Session cgroup 밖에 남는다. workload는 다음 경계 안에서 실행한다.

- 새로운 chroot, UID/GID 1000, `no_new_privs`, 빈 환경과 `/work`·`/tmp`·`/home`.
- 비특권 user namespace 생성 차단. Session에 `/proc`, `/sys`, cgroup 제어 파일, serial 장치를 제공하지 않는다. stdin은 `/dev/null`.
- cgroup v2 memory 128 MiB, pids 32, CPU `50000/100000`, FD/core/output 제한. 격리 설정 실패 시 명령을 시작하지 않는다.
- 게스트 명령 30초 기본 제한. 출력 파일 한도와 stdout/stderr 각각 32 KiB 반환 한도. Agent VM Tool 전체 deadline 120초는 승인 대기·취소에도 적용되며, 종료 확인을 기다리는 시간을 완료 근거로 대체하지 않는다.
- 주 명령 종료 뒤 `cgroup.kill`을 실행하고 `cgroup.events`의 `populated 0`, cgroup 제거와 Session 디렉터리 정리를 확인한다. 이 확인 전 슬롯을 반환하지 않는다.

`setsid`, 중첩 shell fork/재부모화, background, 무한 루프, TERM 무시, 취소, 환경·임시 파일 분리, FD 경계, 긴 명령, 출력 제한을 실제 VM에서 검증했다. shell 기반 double-fork fixture를 사용했으며 모든 언어/프로세스 라이브러리 조합의 완전성을 주장하지 않는다.

Session 정리 또는 채널 상태가 불확실하면 VM을 격리하고 전체 종료를 시도하되 재사용을 금지한다. `requestStop` 성공만으로 종료를 확정하지 않는다. guest delegate 또는 force-stop 성공 callback과 실제 `.stopped` 상태를 확인한다. Manager 사망 후 관측된 프로세스 부재/EOF는 종료 증거가 아니다.

VM의 RAM 상태만 재사용한다. 세션 임시 데이터·환경·권한·출력은 다음 Session에 넘기지 않는다. **Vault 개발 디스크, 패키지 캐시, Python/Node/Swift toolchain 설치 및 Vault 프로젝트의 VM 반입/반출은 아직 없다.** 현재 Shell은 BusyBox 명령 검토 범위다.

## 6. Tool·승인·앱

| Tool | 현재 상태 |
|---|---|
| `list_files`, `read_file`, `search_files` | Host Gateway에서 사용 가능 |
| `run_shell` | 신뢰된 승인 채널을 연결한 앱에서 제한된 오프라인 VM 실행 |
| `write_file`, `apply_patch`, `delete_file` | 제품 비활성 유지 |
| Browser 3종 | 미구현·미광고·비활성 |
| `generate_image` | 미구현·미광고·비활성 |

Shell 승인안은 Vault/Environment, Execution/Call ID, Tool/version, 명령/hash, policy revision, 요청·만료 시각, 일회용 ID에 결합한다. 서비스 내부 원본을 실행하므로 승인 뒤 모델이 명령을 바꿀 수 없다. 승인 ID는 Provider 입력이나 Tool Result에 넣지 않는다. 모델이 `approved`/`target`을 추가하면 Schema에서 거절한다. 승인 없이 실행하는 테스트 flag는 제품에 없다.

앱의 **Vault Runtime** 화면은 다음을 제공한다.

1. Vault 목록/디렉터리 등록, 상태 새로 고침.
2. 오프라인 VM 시작 및 종료 요청, 종료 미확인 안내.
3. **Shell 제안 · API 호출 없음**: 명령을 입력하고 별도 승인/거부 후 실제 VM 결과 확인.
4. OpenAI Agent 요청, Tool 진행·결과 표시, 실행 취소.
5. 명령 원문·Vault·hash를 표시하는 일회성 승인 화면. 미응답은 만료, 취소/채널 오류는 거부로 처리.

Agent는 기존 OpenAI Tool Calling 지원 모델 `gpt-4.1-mini`, `gpt-4.1`을 우선 사용한다. Engine의 계정·모델 capability 검사를 우회하지 않는다. 실제 API 비용과 파일 전송 확인은 Tool 승인과 별개다. 기존 일반 채팅·설정·Router 화면을 유지했다.

앱 종료 시 Agent 입력 채널을 닫아 취소를 전달한다. VM 서비스는 UI 자식 종료를 VM 종료로 해석하지 않으며 cleanup과 idle 정책을 계속 담당한다. 제품 알림 센터·백그라운드 메뉴·자동 복구 UI는 없다.

Browser를 활성화하지 않은 이유는 실제 Chromium/DOM 실행과 브라우저 전용 네트워크 허용 경계를 아직 구현·검증하지 않았기 때문이다. 현 구성은 **모든 네트워크 차단**이며 제한된 인터넷 허용 정책이 아니다. Metadata/localhost 접근 실패를 DNS rebinding, redirect, IPv6, WebSocket, 다운로드 차단의 완전한 증거로 확대하지 않는다. NAT나 URL 문자열 필터만 추가하지 않았다. 후속으로 VM 네트워크 전달 계층의 강제 정책, guest browser 프로필 격리, CDP 제어 및 우회 테스트가 필요하다. 검색 API는 도입하지 않았다.

## 7. Gate와 실제 검증 기록

시작 시점의 M2/M3 기록은 Node 264/Swift 42였다. 아래는 이번 작업에서 새로 실행한 결과다.

| Gate | 판정 | 근거와 한계 |
|---|---|---|
| 1 M2/M3 보완 | PASS | 실행 정리·5,000 Task heap/범위 상한·늦은 응답·typed 오류·개발 파일·전체 회귀 |
| 2 실제 VM 생명주기 | PASS (오프라인 개발 구성) | 실제 부팅, guest ready, 정상 종료, force stop callback + stopped, Manager 사망 차단 |
| 3 Session 정리 | PASS (명시된 14개 fixture 범위) | cgroup cleanup, 비특권/FD 경계, 잔존·오염·시간/출력 제한. 일반 VM 보안 인증 아님 |
| 4 공유 VM/슬롯 | PASS (전역 1/오프라인) | 동일 Instance 재사용, 여러 OS 클라이언트 FIFO, 취소, 다른 Vault 거절 및 종료 후 인계 |
| 5 Shell·Browser | **부분 PASS / 전체 미통과** | 오프라인 Shell과 승인 경로 검증. Browser·선택적 인터넷 격리 NOT_RUN/미구현 |
| 6 Agent·앱 | **부분 PASS / 전체 미통과** | 실제 VM+Mock Agent E2E, 앱 빌드·번들 채널·Swift 테스트. 실제 사용자 클릭·live Provider E2E NOT_RUN |

- Node: **289/289 PASS**, fail/skip 0. M1a/M1b, Provider/Router/Ledger 및 OpenAI fixture 포함.
- Swift: **45/45 PASS**, fail 0(기존 42 + 승인 이벤트/표시 경계 3).
- 5,000 Task 테스트: 완료 후 retained execution 0, 강제 GC 후 heap 증가 16 MiB 미만. 장시간 제품 전체 RSS/서비스 감사 한도까지의 성능 테스트는 아니다.
- 실제 VM: 세션 14개, Host/Agent/프로세스 통합 8개, 번들 승인 채널 3개, 별도 force-stop 검증 PASS. 이 숫자를 Node 단위 테스트 개수에 합산하지 않는다.
- 앱 빌드와 bundle Node/helper/images 실행 PASS. GUI 프로세스 실행 시도 후 UI 자동화 연결 실패로 클릭·레이아웃 검증 NOT_RUN.
- 실제 유료 API, 다른 Provider Tool Calling, Browser/인터넷 허용, 배포 서명/notarization, 실제 전원 차단·디스크 고장·장기 자원 스트레스, 모든 지원 macOS 버전 테스트 NOT_RUN.

초기 실패도 보존했다: Swift module cache sandbox 제약으로 첫 Native compile 실패 후 허용된 빌드로 해결; BusyBox `chroot -u` 미지원으로 초기 workload 실패 후 `su`/no-new-privs 경로로 수정; 검증 harness field index 오류 수정; 긴 임시 경로의 Unix socket 길이 제한 실패 후 짧은 임시 경로에서 재검증; Swift 연산자 공백 및 TS 변수명 충돌 컴파일 오류 수정. 이 실패 시도를 최종 PASS로 덮어쓰지 않는다. Unix socket 경로가 104바이트 이상인 저장 위치는 여전히 지원하지 않는다.

새 Evidence:

- [실제 세션 및 격리](evidence/Vault_M4_Sessions.json)
- [공유 VM·Agent·OS 프로세스](evidence/Vault_M4_Integration.json)
- [앱 번들 승인 채널](evidence/Vault_M4_Bundle_Channel.json)
- [실제 강제 종료](evidence/Vault_M4_Force_Stop.json)
- [초기 실패 시도](evidence/Vault_M4_Attempts.json)
- [검증 요약·소스/이미지 hash](evidence/Vault_M4_Validation.json)

Evidence의 Mock 모델과 프로그램 승인 결정은 각각 명시했다. 기존 M0 Evidence는 그대로 보존했다.

## 8. 직접 검토 절차

1. `open dist/Nidus.app`으로 개발 앱을 실행한다.
2. **Vault Runtime → 디렉터리 등록**에서 테스트용 새 빈 디렉터리를 선택한다. 개인 Vault를 검증 대상으로 사용하지 않는다.
3. `오프라인 VM 시작` → `새로 고침`으로 RUNNING과 Generation을 확인한다.
4. 기본 명령 `echo hello; pwd; id`를 **Shell 제안 · API 호출 없음**으로 제출한다. 먼저 거부하여 실행되지 않는지 확인한 다음, 다시 제출해 정확한 명령을 승인한다. `/work`와 UID 1000 결과가 나와야 한다.
5. 두 번째 승인 명령을 실행하고 같은 VM Instance/Generation이 유지되는지 상태로 확인한다. `sleep 30` 실행 후 취소를 검토한다.
6. VM 종료 요청 후 `STOP_CONFIRMED`를 확인한다. `STOP_UNCONFIRMED`라면 기록을 지우거나 강제로 다시 시작하지 않는다.
7. Agent는 별도 검토다. 기존 OpenAI 계정 실행 권한과 지원 모델 cache를 준비하고 비용·파일 전송 확인 후 실행한다. 예: “note.md를 읽고, 오프라인 VM에서 echo 명령으로 요약 제목을 출력한 뒤 결과를 설명해줘.” 실제 API 호출은 이 작업에서 수행하지 않았다.

깨끗한 checkout에서 VM 리소스가 없으면 자동 다운로드하지 않고 실패한다. 다음 공식 Alpine 파일을 별도 디렉터리에 받아야 한다. `prepare.py`의 고정 SHA-256이 일치해야 빌드된다.

- `https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot/vmlinuz-virt`
- `https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot/initramfs-virt`

```sh
NIDUS_VM_BUILD_ASSETS=/absolute/path/to/downloads npm run build:app
npm test
swift test
python3 scripts/vault-vm/verify.py /absolute/path/to/downloads /private/tmp/m4-sessions.json
node scripts/vault-vm/integration.mjs /private/tmp/m4-integration.json
node scripts/vault-vm/channel-verify.mjs /private/tmp/m4-channel.json
```

통합 스크립트는 별도 임시 Vault/Registry만 사용한다. Manager 사망 fixture의 미확인 Journal은 임시 위치에 보존한다. 개발 시 `NIDUS_VAULT_REGISTRY`는 dashboard/Agent Host 저장 위치를 바꾸는 설정일 뿐 승인 우회 flag가 아니다. 정상 앱 기본 경로는 변경하지 않았다.

## 9. 미완료 및 다음 단계

M4 완결에 필요한 작업을 M5/M6 완료라고 잘못 넘기지 않는다.

- **M4 잔여:** 실제 Browser/DOM, 검증된 선택적 네트워크, persistent 개발 디스크·cache 및 toolchain 이미지, 명시적인 Vault 파일 반입/반출 정책. 현재는 사용자 원본이 VM에 보이지 않는다.
- **M5:** 감사 receipt 보존·회전/상한 운영, asset 공급·업데이트·무결성 신뢰 경계, 장기 자원·crash 검증, 독립적인 보안 검토. 미확인 Manager 자동 복구는 이번 범위에서 계속 제외.
- **M6:** 실제 사용자 클릭/취소/종료 UX 검토, 상태 자동 갱신·알림, 이미지 준비/실패 안내, 배포 서명·notarization·지원 OS 범위 검증.
- Host 기존 파일 수정·삭제는 별도 Native 교체 경쟁 검증과 UI 게이트 이후에만 활성화한다.

사용자가 직접 앱과 미완료 범위를 검토하기 전 다음 단계 완료나 M4 전체 완료로 표시하지 않는다. develop 병합, 기존 브랜치 삭제/reset, main 변경, push/PR은 하지 않았다.

## 10. 변경 커밋과 Git 상태

- `7e3a15b` — 실행 범위 메모리 정리, Provider 오류 분류, 개발 파일 읽기와 회귀 테스트.
- `d92bf11` — 실제 오프라인 VM, cgroup Session, Journal, 단일 Host Admission 서비스 및 검증 도구.
- `8371087` — Unified Tool/Agent 연결, 실제 SwiftUI 승인 채널·직접 Shell 검토 화면 및 E2E.
- 이 문서와 새 Evidence는 별도 문서 커밋으로 기록한다.

시작·종료 develop: `d5972bacbb1a41207ce5d15b25d09bcf82c942df` (변경 없음).
main: `723c03b59dcecaae27d9fe0a9f97b464c785d706` (변경 없음).
현재 feature 브랜치를 유지하며 원격 push/PR 및 병합은 하지 않았다. 기존 Adapter/Engine/Ledger/Router와 M0 Evidence에 이번 작업의 diff가 없음을 확인했다. 테스트용 앱·helper·Host 서비스 프로세스가 남아 있지 않음도 확인했지만, 이 관측을 Manager SIGKILL 사례의 VM 종료 증거로 사용하지 않았다.

새 Source/Evidence/번들 이미지 hash 일치 확인 PASS. 사용자 검토와 명시적 병합 승인은 아직 받지 않았다.
