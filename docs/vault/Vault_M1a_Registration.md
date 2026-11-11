# M1a — Vault Registration & Identity Foundation

2026-11-02, `feature/vault-runtime-v2`. M1a의 등록·식별 API를 구현했다. **M1 전체 완료가 아니다.** M1b의 Environment 설정, Mock Instance, Session, 실행 admission은 아직 없다. 실제 VM, Agent, Tool, Host 파일 변경 Gateway, SwiftUI/CLI 관리 화면은 추가하지 않았다.

## 설계 기준과 저장 위치

`Vault_Runtime_v2_Plan.md`와 이번 M1a 요청을 적용한다. Phase 5–6 문서의 과거 M0/M1 착수 보류 및 “문서만 변경” 문구는 당시 기록이며 이번 비실행 구현을 막는 기준으로 사용하지 않았다. 기존 M0의 FAIL/UNCONFIRMED evidence는 변경하지 않았다.

기반 코드의 `src/storage.ts` 모델 캐시와 `src/ledger.ts`는 macOS에서도 `~/.local/share/nidus`를 사용한다. 따라서 독립 Host Registry는 **`~/.local/share/nidus/vaults/registry.json`**이다. Usage SQLite/Provider 저장소 migration은 없다. `VaultRegistry(directory)`의 저장 위치 주입은 임시 테스트와 명시적인 Host 구성용이다. 동일 Host의 모든 호출자는 같은 Registry 경로를 사용해야 한다. 여러 Registry를 만들어 전역 중복 검사나 잠금을 우회하는 사용은 지원하지 않는다.

## Descriptor v1

Vault의 `.nidus/vault.json`은 다음 필드만 허용한다. 알 수 없는 필드, 손상 JSON, 미지원 버전은 보존하고 거절한다.

```json
{
  "schemaVersion": 1,
  "vaultId": "7aa2ca54-c405-4de0-b29c-43824268a009",
  "displayName": "My Vault",
  "createdAt": "2026-11-02T00:00:00.000Z",
  "environmentId": "be2bbf01-0c14-40ec-9a71-58560742fa98"
}
```

신규 ID는 `crypto.randomUUID()`로 생성한다. Environment ID는 미래 실행 환경 참조이며 VM을 만들지 않는다. 기존 UUID는 변경하지 않는다. 날짜는 UTC ISO-8601, 이름은 비어 있지 않은 최대 255자다. Secret/API Key/Host 경로/VM 핸들을 저장하지 않는다. 새 이름은 디렉터리 basename이며 기존 descriptor의 이름은 유지한다.

## Registry 구조와 API

`src/vault/types.ts`, `src/vault/registry.ts`를 `src/index.ts`에서 export한다.

```ts
const registry = new VaultRegistry();
const entry = await registry.registerVault('/Users/example/Documents/MyVault');
await registry.listVaults();
await registry.resolveVault(entry.vaultId);
await registry.unregisterVault(entry.vaultId);
```

Registry는 `{ schemaVersion: 1, revision, vaults: VaultRegistration[] }`이다. 각 항목은 descriptor 필드와 `canonicalRoot`, `identity: { device, inode, birthtimeNs }`, `status: 'registered'`, 해당 항목의 `revision`, `lastValidation: { checkedAt, result, code? }`를 가진다. 파일시스템 식별 숫자는 정밀도 손실 없이 문자열로 저장한다. 등록/재등록/해제마다 전역 revision을 증가시킨다. UUID, Environment ID, 경로 중복 및 중첩을 로드 시에도 검증한다.

- `registerVault(path)`: 검증, 필요 시 descriptor 신규 생성, 기존 동일 등록 갱신 또는 검증된 이동. 같은 Vault 재등록은 하나의 항목으로 유지한다.
- `listVaults()`: 저장된 등록 목록을 매번 실제 파일시스템과 대조한다. 유효하지 않은 항목도 `lastValidation.result='invalid'`로 표시한다. 손상된 Registry는 목록 전체를 거절한다.
- `resolveVault(vaultId)`: 경로·객체·descriptor ID/Environment/생성시각을 다시 검증한다. 누락/불일치는 throw하며 오래된 등록을 권한 근거로 반환하지 않는다.
- `unregisterVault(vaultId)`: 등록 항목만 제거한다. 원본과 `.nidus`는 보존한다. 사라진 Vault도 해제할 수 있다. 다시 등록하면 descriptor ID를 재사용한다.
- `classifyVaultLocation(...)`: 동일 위치/검증된 이동/복제 충돌/미확인 판정. 낮은 수준의 분류 함수 자체는 등록 권한을 부여하지 않는다.

저장된 lastValidation은 마지막 성공한 등록 검증의 기록이다. list/resolve는 새 검증 결과를 응답에 반영하지만 읽기만으로 Registry revision이나 디스크 기록을 변경하지 않는다. 호출 시점의 검증이며 이후 파일 작업에 재사용할 capability가 아니다. 오류는 `VaultError.code` 또는 filesystem errno로 전달한다.

## 이동·복제

같은 경로인데 객체가 바뀌면 ID가 같아도 거절한다. 다른 경로에서 같은 ID를 발견했을 때 기존 위치가 남아 있으면 복제 충돌이다. 기존 위치가 없어야 이동 후보가 되며, device/inode/birthtime까지 같아야 자동 이동을 수락한다. 저장 직전에도 기존 위치 부재를 다시 검사한다.

복사 후 원본 삭제, 볼륨 간 이동, inode/생성시각의 동일성을 확인할 수 없는 경우는 `identity_unconfirmed`다. 기존 경로 접근 오류도 동일성을 추측하지 않는다. ID 재발급·복사본 채택 UI/API는 없다. 향후 별도 사용자 승인 절차에서 두 ID와 Environment의 관계를 다뤄야 한다. 등록을 해제하면 Host의 기존 위치 기억도 제거되므로, 전 세계에 존재하는 모든 복사본을 탐지하는 기능은 아니다.

## 저장·잠금·중단 정책

Host 디렉터리는 현재 사용자 소유이며 group/other 권한이 없어야 한다(신규 0700). 파일은 신규 0600이다. Registry/descriptor 읽기는 no-follow, 단일 링크 일반 파일, 4 MiB 제한, 읽기 전후 객체/크기/시간 검증을 사용한다.

모든 API는 Host 디렉터리의 `registry.lock` 디렉터리를 배타적 mkdir로 획득한다. 대기/재시도 없이 경쟁 호출을 `registry_locked`로 거절한다. PID나 시간 경과를 근거로 잠금을 빼앗지 않는다. Registry 변경은 기존 전체 bytes 비교(같은 revision의 외부 변경도 탐지), revision 증가, exclusive 임시 파일 쓰기, 파일 fsync, 직전 재검증, atomic rename, 부모 디렉터리 fsync 순서다. Registry 저장은 4 MiB를 초과하면 거절한다.

Descriptor는 `.nidus/vault.pending-<UUID>`에 쓰고 fsync한 뒤 hard-link의 no-replace 동작으로 `vault.json`에 게시하고 임시 링크를 제거한다. 이후 `.nidus`를 fsync한다. 기존 descriptor를 rename으로 덮어쓰지 않는다. 완성된 descriptor의 링크 수는 1이다.

| 실패 시점 | 남는 상태 / 후속 동작 |
|---|---|
| descriptor 생성 전 | Registry·사용자 파일 불변 |
| descriptor 임시 쓰기/게시 도중 | pending 파일 또는 링크 수 불일치. 자동 덮어쓰기·삭제 없이 차단 |
| descriptor 완성, Registry staging 전 | descriptor만 남을 수 있음. 정상 재시도 시 동일 ID를 등록 |
| Registry staging 이후 실패 | 이전 snapshot 또는 게시된 새 snapshot, pending이 남을 수 있음. 잠금 보존, 자동 재시도 차단 |
| 프로세스 강제 종료 | lock 보존. 재시작도 차단; lock 획득 직후 죽은 경우도 보수적으로 동일 취급 |
| Registry 손상/미지원 버전 | 초기화·빈 목록 반환·자동 backup 승격 없이 차단 |

복구 자동화는 제공하지 않는다. 운영자가 모든 Registry 호출 프로세스를 중단하고, Registry/lock/pending/descriptor를 별도 보존해 비교한 뒤 유효 snapshot과 경로·객체·ID를 확인해야 한다. 불명확한 임시 기록을 무조건 적용하거나 잠금만 삭제하지 않는다. 확인된 복구 이후에도 API가 다시 검증한다. Descriptor와 Registry가 완전한 원자적 트랜잭션이라는 가정은 하지 않는다. 이는 VM Manager 복구 기능이 아니다.

## 보안 범위와 제한

존재하지 않는 경로, 파일, 모든 입력 경로 요소의 symlink, `..`, 홈 및 홈의 상위 경로, `/`, device가 부모와 다른 mount root, Host 저장소와 겹치는 Vault, 등록 경로 중복/중첩을 거부한다. 조상 descriptor 및 하위 `.nidus`를 검사해 미등록 중첩도 보수적으로 거부한다. 하위 순회는 링크를 따라가지 않으며 100,000개 항목 제한, 읽기 실패 시 차단이다. 큰 트리나 `.nidus`라는 일반 하위 폴더도 거부될 수 있다.

객체 교체를 등록 중간과 저장 직전에 재검증한다. **Node의 경로 기반 API는 Native openat/dirfd 기반의 단일 원자적 경로 순회가 아니다.** 동일 사용자 악성 프로세스가 검사와 syscall 사이에 부모 디렉터리를 교체하거나 lock/Registry를 직접 변조하는 공격에 대해 완전한 방어를 주장하지 않는다. 이 Registry는 현재 동일 사용자 Host를 신뢰하는 등록 메타데이터이며 Agent 파일 권한을 실제로 발급하지 않는다. 파일 수정·삭제 Gateway에는 root-handle 기반 경로 순회와 작업별 직전 검증을 별도로 구현·검증해야 한다. 현재의 resolve 성공을 이후 쓰기 권한 토큰으로 사용하면 안 된다.

임시 디렉터리의 checkpoint 교체·프로세스 경쟁 테스트를 통과한 사실을 모든 나노초 단위 TOCTOU, 실제 전원 차단, 디스크 고장, 네트워크 파일시스템의 안전성 검증으로 확대하지 않는다. 파일시스템의 mkdir/link/rename/fsync 의미를 신뢰하는 로컬 저장소가 대상이다. 사용자 일반 파일을 수정·삭제하는 API는 없다.

## 검증 기록

과거 설계/evidence의 Node 174/Swift 46 등은 다른 M0 브랜치 결과다. 이번 결과로 재사용하지 않았다.

- 변경 전 실행: Node 169 중 137 PASS, 32 FAIL. 샌드박스가 mock HTTP 서버의 `listen 127.0.0.1`을 EPERM으로 차단했다. Swift는 캐시 쓰기 제한 때문에 manifest 빌드 실패, 테스트 미실행.
- 환경 제한 해소 후 최종 실행: `npm test` **191/191 PASS**(기존 169 + Vault 22), `swift test` **42/42 PASS**, TypeScript build PASS, `git diff --check` PASS. 최종 실패/skip은 0이다. Swift 코드에는 변경이 없으며 이후 변경은 Vault TypeScript/테스트/문서뿐이다.
- Vault 테스트는 모두 별도 `nidus-vault-test-*` 임시 디렉터리에서 실행한다. 실제 사용자 Vault를 수정하지 않는다.
- 최초 새 테스트 실행에서 permission 테스트의 cleanup 순서 오류 1건을 수정했고 최종 재실행으로 확인했다.
- NOT RUN: 실제 VM/M0, live Provider 호출, Keychain 통합, 앱 packaging/UI, 실제 전원 차단, 실제 cross-volume mount root, 악성 부모 교체의 완전한 TOCTOU 검증. 이번 범위의 완료 근거로 삼지 않는다.

M1b는 Environment 구성 모델, Mock VM Instance, Session 관계, 프로세스 간 실행 admission 및 전역 실행 슬롯을 구현한다. M1a의 Registry 변경 잠금은 실행 잠금이 아니다.

## 브랜치 및 전달 상태

시작 작업 트리는 clean이었다. 작업 브랜치는 `feature/vault-runtime-v2`를 유지한다. 시작/종료 `develop`은 `d5972bacbb1a41207ce5d15b25d09bcf82c942df`, `main`은 `723c03b59dcecaae27d9fe0a9f97b464c785d706`으로 불변이다. develop 병합, 기존 브랜치 삭제, reset, 원격 push/PR은 하지 않았다. 구현·테스트와 문서를 논리 단위로 커밋하고 사용자 검토를 기다린다.
