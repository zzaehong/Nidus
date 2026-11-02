# M1b — Vault Environment & Execution Admission

2026-11-03, `feature/vault-runtime-v2`, 시작 HEAD `ba5648b`. 작업 트리는 clean이었다. 최신 Vault Runtime v2 계획과 이번 M1b 요청을 기준으로 구현했다. 이전 문서의 M1b 미구현 표시는 해당 시점의 기록이다. M0 코드·Evidence·실패 기록은 이식하거나 수정하지 않았다.

**M1b의 Mock 기반 Host 소유권·Admission 구현을 완료했다. 실제 VM 운영은 불가능하며 안전성 검증도 완료하지 않았다.** Apple Virtualization, Shell, Agent, Tool Registry, Host File Gateway, Provider Tool Calling, 자동 복구·작업 재개는 없다. M4의 실제 Backend 검증을 대체하지 않는다.

## 도메인과 파일

| 파일 | 책임 |
|---|---|
| `src/vault/execution-types.ts` | Environment, VM Instance, Session, Lease, 전역 정책, 상태 응답 |
| `src/vault/execution-state.ts` | 저장 스키마 및 ID·generation·소유 관계·슬롯 불변식 검증 |
| `src/vault/execution-store.ts` | Host 소유권 잠금, 상태 읽기/원자적 기록, revision 충돌 검사 |
| `src/vault/mock-backend.ts` | Backend port와 지연·실패·제어 상실 Mock |
| `src/vault/admission.ts` | FIFO, lease 발급/검증, 상태 전이, 취소, 종료 확인 |
| `src/index.ts` | 공개 모델·Mock·Controller export |
| `tests/vault-admission.test.mjs` | 단위/통합 테스트 |
| `tests/helpers/admission-child.mjs` | 실제 OS 프로세스 경쟁 및 crash fixture |

Environment는 `vaultId`, 기존 descriptor의 `environmentId`, `configVersion`, `backendKind: 'mock'`, `enabled`, Vault별 정책, 마지막 `generation`을 가진다. ID를 새로 생성하지 않는다. 설정은 Host에 두고 Descriptor v1은 그대로 유지한다. 초기 enabled는 Mock 실행 허용을 뜻한다. 설정 변경은 expectedVersion CAS를 요구하고 해당 Vault의 대기·활성·미확인 세션이 있으면 거절한다.

VM Instance는 UUID `vmInstanceId`, Vault/Environment ID, 단조 증가 generation, 관리 `state`, 별도의 관측 `backendState`, 생성/변경 시각, UUID `backendRef`, 종료 근거를 가진다. `backendRef`는 Mock의 논리 참조이며 VM 핸들·PID가 아니다. 상태는 `STOPPED`, `STARTING`, `RUNNING`, `STOPPING`, `STOP_CONFIRMED`, `STOP_UNCONFIRMED`, `FAILED`다. 초기 STOPPED는 아직 start가 제출되지 않은 관리 상태이고 종료 근거를 대신하지 않는다. FAILED도 슬롯 반환 근거가 아니다.

Execution Session은 요청자가 미리 정한 UUID `executionId`, Vault/Instance 참조, 추상 `requestedBy`, 영속 FIFO sequence, 생성/시작/종료 시각, 상태, `cancelRequested`, `completion: { outcome, resultId }`를 가진다. QUEUED 단계의 Instance는 null이다. 상태는 `QUEUED`, `ACQUIRED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `UNCONFIRMED`다. requestedBy/resultId는 제한된 문자와 길이의 식별자이며 프롬프트·본문·자격증명 저장용 필드가 아니다.

완료 결과와 종료 확인은 독립적이다. 결과가 COMPLETED라도 VM 종료가 미확인이면 Session은 UNCONFIRMED이고 lease는 활성이다. 실행 중 취소도 같은 원칙이다. 종료가 확인된 경우에만 terminal 상태와 endedAt을 확정한다. 아직 시작하지 않은 대기 요청의 취소/검증 실패는 VM 종료 근거가 필요 없다.

## API 및 사용

```ts
import { randomUUID } from 'node:crypto';
import { VaultRegistry, MockVMBackend, ExecutionAdmissionController } from './dist/index.js';

const registry = new VaultRegistry();
const admission = new ExecutionAdmissionController(registry, new MockVMBackend());
const executionId = randomUUID();
const lease = await admission.acquire(vaultId, { executionId, requestedBy: 'worker:example' });
// M1b는 실제 Shell/게스트 작업을 실행하지 않는다.
await admission.release(lease, { outcome: 'COMPLETED', resultId: 'result:example' });
await admission.close();
```

- `getEnvironment(vaultId)`: 유효 Vault에 대응하는 Host Environment를 조회/최초 생성한다. Admission 소유권이 필요하다.
- `configureEnvironment(vaultId, { expectedVersion, enabled })`: 실행 가능 여부를 버전 검사 후 변경한다. Backend·자원 제한을 임의 확장하는 설정은 아직 제공하지 않는다.
- `acquire(vaultId, { executionId, requestedBy })`: 등록을 검증하고 QUEUED를 먼저 기록한다. FIFO 차례가 되면 다시 검증하고 Instance/lease/ACQUIRED, STARTING을 저장한 뒤 Backend start를 호출한다. RUNNING 확인 및 등록 재검증·저장이 끝나야 lease를 반환한다.
- `release(lease, { outcome, resultId })`: 완료 결과를 기록하고 VM 전체 stop을 요청한다. 신뢰하는 Backend의 종료 근거를 확인하고 영속화한 뒤에만 슬롯을 반환한다. 호출자가 전달한 `stopConfirmed` 같은 필드는 거절한다.
- `cancel(executionId)`: 대기 요청은 CANCELLED로 기록하고 acquire Promise를 거절한다. 실행 중이면 취소 요청 기록 후 stop을 수행한다. stop 실패/timeout은 UNCONFIRMED다.
- `getStatus(vaultId)`: 등록 및 실행 snapshot을 검증한다. 현재 소유자의 응답은 관리 상태이고, 다른 소유자/재시작 프로세스는 활성 VM/세션을 미확인으로 투영한다. `recordedInstances`/`recordedExecutions`에 원래 디스크 상태를 별도로 반환한다. 외부 관측만으로 살아 있는 소유자와 사망한 소유자를 구별하지 않는다. 이 조회는 디스크 상태를 자동 변경하지 않는다.
- `close()`: 대기/활성/미확인 세션이 없는 상태에서만 ownerId=null을 저장하고 잠금을 해제한다. idle timeout이나 프로세스 종료에 따른 자동 해제는 없다.

release의 lease에는 owner/Vault/Environment/Instance/execution ID, generation, leaseId, 임의 256-bit bearer token이 결합된다. 디스크에는 token의 SHA-256만 기록한다. 중복 release, 다른 Vault/owner, 변조 token, 오래된 generation, 이미 반환된 lease는 거절한다. lease는 사용자 파일 수정 승인이나 Tool 권한을 뜻하지 않는다. token을 로그·모델·Vault에 전달하면 안 된다.

## 슬롯과 FIFO 보장 범위

**단일 Host Admission 소유자 + 프로세스 간 배타 잠금**을 선택했다. 앱/CLI의 모든 Controller는 같은 M1a Registry와 그 아래 execution 저장소를 사용해야 한다. Controller별 임의 실행 저장 경로 override는 제공하지 않는다. 테스트용 서로 다른 Registry는 독립 Host fixture이며, 서로 다른 Registry 경로 사이의 전역 제한까지 보장하지 않는다.

`admission.owner`를 exclusive mkdir로 획득한 Controller만 요청을 추가하고 Backend를 제어할 수 있다. 소유권은 첫 Environment/실행 요청부터 명시적 close까지 유지한다. 다른 프로세스나 같은 프로세스의 다른 Controller는 `admission_busy`로 거절된다. 정상 close 뒤에는 재요청할 수 있다. 소유자가 idle이어도 자동으로 잠금을 넘기지 않는다.

소유자 안에서는 API 호출을 직렬화하고 QUEUED의 영속 sequence 순서로 처리한다. FIFO는 다른 Vault 요청까지 포함한 소유자 내 전역 FIFO다. **프로세스 간 FIFO와 다른 프로세스에서의 cancel/release IPC는 미지원**이다. 여러 프로세스 요청을 한 서비스에 전달하는 IPC/daemon은 추가하지 않았다. 이 제한은 사용자 요청에서 허용한 단일 소유자 FIFO 범위이며, 메모리 배열을 근거로 프로세스 간 FIFO를 주장하지 않는다. Promise 대기자는 메모리에 있지만 세션·순서·슬롯은 디스크에도 남는다. 재시작 시 queue를 자동 실행하지 않는다.

Vault별 정책은 활성 VM 최대 1개, 활성 Execution 최대 1개다. 별도의 Host 전역 정책도 VM 1개/Execution 1개이며 `stopAfterExecution=true`다. 현재 스키마는 이 기본 정책만 수락하고 2 이상의 값은 거절한다. 정책 모델과 Backend port는 분리했으며, 향후 다중 슬롯 scheduler/검증을 추가해 확장할 수 있다. 숫자만 변경해 미검증 병렬 실행을 활성화하지 않는다.

VM warm reuse는 없다. 각 Execution마다 새 Instance/generation을 만들고, VM 전체 종료가 확인되어야 같은 Vault의 다음 실행이나 다른 Vault로 넘어간다. 전역 소유권 잠금과 활성 자원 슬롯은 다른 개념이다. close 전까지 소유권이 유지되더라도 종료 확인된 VM이 활성 슬롯을 점유하는 것은 아니다.

## 불변식의 집행

| 불변식 | 구현 근거 |
|---|---|
| A: Vault 활성 Instance 최대 1 | 전역 owner와 활성 lease 확인, Vault별 generation/Instance 관계 검사 |
| B: Instance 활성 Execution 최대 1 | Instance당 Session/lease 1개, 슬롯 미반환 동안 pump 정지 |
| C: 종료 미확인 Vault에 새 Instance 금지 | quarantine 이후 acquire 차단, 잠금·활성 lease 유지 |
| D: 종료 미확인 Execution 슬롯 재사용 금지 | Backend 증거 검증과 STOP_CONFIRMED·lease 반환의 동일 snapshot 영속화 |
| E: 소유자 상실을 종료로 간주하지 않음 | PID/TTL 확인·lock stealing 없음, 재시작 관측은 UNCONFIRMED |

Backend start/stop은 기본 5초(테스트에서는 100ms)의 응답 제한을 가진다. 이는 **관측 기한**이며 lease 만료가 아니다. timeout은 quarantine만 수행하고 슬롯을 반환하지 않는다. 늦게 도착한 callback도 상태를 되돌리거나 queue를 재개하지 않는다. 동일 Controller의 명령은 직렬화되므로 start/stop 대기 중 cancel/status 처리는 해당 관측 기한까지 지연될 수 있다.

## Host 영속 상태와 기록 중단

기본 위치는 `~/.local/share/nidus/vaults/execution/`이다. M1a의 `registry.json` 및 `registry.lock`과 분리했다. Usage DB·Provider 설정과 통합하지 않았다.

- `state.json`: `{ schemaVersion:1, revision, ownerId, policy, environments, instances, executions, leases }`
- `admission.owner/owner.json`: 임의 owner UUID. PID/VM 상태를 뜻하지 않는다.
- `initialized`: 상태 파일의 사후 누락을 빈 신규 상태로 오인하지 않기 위한 표식.
- `state.pending-<UUID>`: exclusive 기록 중간 파일. 발견하면 차단한다.

저장소 0700, 파일 0600, 현재 사용자 소유, 경로 요소 symlink 거절, no-follow 단일 링크 일반 파일 읽기, 읽기 전후 identity/시간/크기 확인을 적용했다. 디렉터리·lock 객체 동일성을 재검증한다. 파일은 최대 8 MiB이며 이력을 자동 삭제하지 않는다. 한도에 도달하면 안전 차단하며 보존/압축 정책은 후속 결정이다.

변경은 owner 검증 → 기존 전체 bytes 비교 → 스키마/불변식 검증 및 revision 증가 → 임시 파일 쓰기/fsync → owner/bytes 재검증 → atomic rename → 디렉터리 fsync 순서다. Backend start/stop보다 의도를 먼저 영속화한다. STOP_CONFIRMED와 lease 반환도 함께 저장한 뒤에만 다음 start를 허용한다.

| 장애 | 결과 |
|---|---|
| start 이전 저장 실패 | Backend를 호출하지 않고 quarantine |
| start 명시적 실패 | FAILED 기록 후 별도의 stop 확인 시도. 그 확인까지 성공해야 슬롯 반환 |
| start timeout/응답 ID 불일치 | STOP_UNCONFIRMED/UNCONFIRMED, 슬롯 보존 |
| stop 실패/응답 없음/증거 불일치/제어 상실 | STOP_UNCONFIRMED/UNCONFIRMED, 대기 Promise 거절, 영속 queue 보존·재개 금지 |
| 실제 stop 확인 후 기록 실패 | 디스크의 활성 lease 유지, 새로운 실행 차단 |
| 소유자 SIGKILL/기록 중 종료 | owner lock과 snapshot/pending 보존, 다음 Controller 거절 |
| lock만 없어지고 활성 snapshot 존재 | 새 소유권을 얻더라도 recovery_required로 차단 |
| state 손상/미지원 schema/Environment·generation 관계 불일치 | 초기화 없이 차단 |
| initialized가 있는데 state 누락 | 신규 빈 상태로 생성하지 않고 차단 |

소유권 기록과 슬롯 상태는 서로 대조한다. lock 존재를 실제 VM 생존 증거로 쓰지 않으며 lock 부재도 종료 증거로 쓰지 않는다. 명시적 close 중 crash가 발생하면 이미 안전한 상태에서도 보수적으로 잠금이 남을 수 있다. 복구/force-unlock/reset API는 없다. 미확인 기록을 지워 재실행하는 운영은 지원하지 않는다.

## Mock의 근거와 안전성 한계

Mock은 start 성공/실패/지연/무응답, stop 성공/실패/지연/무응답, loseControl, 중복 start/stop 거절을 구현한다. stop receipt는 해당 Mock이 생성한 객체인지 확인하고 Instance/generation/backendRef/STOPPED 관측과 결합한다. clone/변조한 receipt, 호출자 완료 boolean은 허용하지 않는다. 저장된 증거의 source는 항상 `mock`이다.

이는 신뢰하는 Host Backend port의 계약 검증이다. 실제 guest 프로세스 종료, Apple callback의 신뢰성, VM 격리, 네트워크 차단을 입증하지 않는다. Backend 구현을 모델이 선택하거나 주입하는 API도 아니다. M4에서 검증된 실제 Backend로 계약을 확장해야 한다.

M1a와 동일하게 로컬 파일시스템의 mkdir/link/rename/fsync 의미와 동일 사용자 Host를 신뢰한다. Native dirfd/openat 기반 원자적 경로 순회는 아니다. 악성 동일 사용자 프로세스의 parent 교체, 파일 rollback, 전체 저장소 삭제를 막는 tamper-proof 저장소는 아니다. 프로세스 간 보장은 동일 Host 저장소를 사용하는 정상 Nidus 호출자 사이의 경쟁/중단에 대한 것이다. 실제 전원 차단·네트워크 파일시스템은 검증하지 않았다. M1a resolve 결과를 파일 작업 권한으로 확대하지 않는다.

## 검증 결과

이전 M1a 보고의 Node 191/Swift 42 PASS는 역사 기록이다. 이번에는 신규 테스트를 추가하고 전체 테스트를 다시 실행했다. 모든 Vault/실행 fixture는 별도 `nidus-admission-*` 임시 경로이며 사용자 Vault를 수정하지 않았다.

- M1b 전용: **37/37 PASS**. ID 재사용·설정 버전·generation, 중복 생성/lease, FIFO/대기 취소/전역 이전, invalid Vault 재검증, start 실패/late callback, 취소·stop 미확인, receipt 위조, 재시작 관측, OS 동시 admission/SIGKILL/staging 중단, 손상·누락·revision 충돌·저장 실패·링크 검사 포함.
- 전체 Node: **228/228 PASS**(기존 169 + M1a 22 + M1b 37), fail/skip 0. 상태 조회의 로컬 직렬화 보강 후 전용 테스트도 37/37로 재확인했다.
- Swift: **42/42 PASS**. Swift 코드 변경 없음.
- TypeScript build 및 diff 공백 검사 PASS.
- Provider/Router/Usage Ledger, M1a Registry/Descriptor 구현, Swift, M0 Evidence 변경 없음. 공개 export만 추가했다.
- 실패: 실행한 전용 테스트 및 회귀 테스트에서 최종 실패 0. 코드 검토 중 start 실패 기록 자체가 실패할 때 acquire Promise를 반드시 거절하도록 보강했고 복합 장애 테스트로 확인했다.
- NOT RUN: 실제 VM/Apple Framework, Shell/게스트 프로세스 잔존, 세션 격리·네트워크, 실제 전원 차단, malicious Host TOCTOU, UI/packaging, live Provider/Keychain, 다중 프로세스 FIFO, Manager 복구. Mock 결과를 이 항목들의 PASS로 해석하지 않는다.

## M1a 호환성과 M2 전 결정사항

M1a의 public API와 `.nidus/vault.json` v1 필드는 그대로다. 실행 중 Vault가 등록 해제돼도 기존 lease의 안전 종료 절차는 허용하지만, 새로운 요청 및 대기 요청의 시작은 등록 재검증을 통과해야 한다. Registry와 실행 저장소가 하나의 원자적 트랜잭션이라는 가정은 없다. backend start 이후에도 재검증하며 lease 반환 전 불일치가 발견되면 stop 절차를 수행한다. 실제 원본 파일 접근은 없다.

M2 전에 다음을 결정해야 한다.

1. Native root-handle/no-follow Host Gateway의 지원 OS·파일 종류·rename 경쟁 방어와 미검증 작업 비활성 정책.
2. Tool 정적 Registry·Schema 및 사용자 승인 소비/만료/정책 revision 계약. 실행 lease와 사용자 승인 token은 분리한다.
3. 앱/CLI가 하나의 Admission 소유자에 접근할 IPC를 언제 도입할지, 아니면 busy 거절 UX를 유지할지. 현재 다중 프로세스 FIFO를 전제하면 안 된다.
4. quarantine 관찰/안내 방식, 이력 용량/보존 정책. 자동 reset·Task 재개는 허용하지 않는다.
5. M4 Backend의 generation·인증된 제어 채널·종료 증거 계약. 실제 격리와 VM 종료 검증 전에는 실제 Backend를 활성화하지 않는다.

## 전달 상태

구현·테스트와 문서를 논리 단위로 커밋한다. `develop` 시작/종료 HEAD는 `d5972bacbb1a41207ce5d15b25d09bcf82c942df`, `main`은 `723c03b59dcecaae27d9fe0a9f97b464c785d706`으로 불변이다. `feature/vault-runtime-v2`를 유지하며 develop 병합, 기존 브랜치 삭제, 강제 reset, 원격 push/PR은 하지 않았다. 사용자 검토 대기이며 실제 VM 운영 허가를 요청하는 결과가 아니다.
