# M4 Vault 영속 디스크와 패키지 캐시

## 범위와 정책

Vault ID + 기존 Environment ID별 Host 전용 512 MiB sparse RAW 디스크를 사용한다. Host Vault는 연결하지 않는다. 이미지에는 고정된 개발 도구가 있고, 데이터 디스크에는 캐시만 저장한다. 세션의 `/work`, `/tmp`, `/home`, 환경변수와 프로세스는 기존처럼 초기화된다.

Host 위치: Vault Registry 디렉터리 아래 `vm-runtime/cache-disks/<vaultId>-<environmentId>/`. `cache.raw`, 소유자/용량/파일 객체/상태를 담는 `metadata.json`, 배타적 `owner/` 디렉터리가 있다. Registry 및 Usage Ledger와 별개다. 디렉터리 0700, 파일 0600, no-follow 및 하드링크·객체 동일성 검증을 적용한다.

게스트의 ext4 데이터 디스크를 `nosuid,nodev,noexec`로 마운트한다. 신뢰된 supervisor만 디스크 장치와 소유권 marker에 접근한다. 세션에는 패키지 하위 디렉터리만 `/cache`로 제공한다. `PIP_CACHE_DIR=/cache/pip`, `npm_config_cache=/cache/npm`이며 네트워크는 계속 차단된다. 패키지 다운로드 기능을 추가한 것은 아니다. 오프라인 wheel/tarball을 명시적으로 저장하여 재사용할 수 있다.

캐시는 신뢰할 수 없는 이전 실행 데이터다. Host에 실행하거나 복사하지 않으며, 캐시 내용 자체가 다음 명령의 실행 권한을 부여하지 않는다. 각 Shell 실행 승인은 계속 필요하며 `/cache`의 변경이 지속됨을 승인 화면에 표시한다. 사용자 명령이 `/cache`에 임의 데이터를 쓰는 것을 내용만으로 Secret인지 판별하지는 않는다. Nidus는 Provider Key, Host 인증 파일, 기존 브라우저 프로필을 전달하지 않는다.

## 장애와 삭제

디스크 소유권을 획득하고 `dirty` 상태를 fsync한 뒤 VM을 시작한다. 새 디스크만 한 번 포맷한다. 기존 디스크는 `e2fsck -fn` 검사를 통과해야 마운트하며 자동 복구나 재포맷하지 않는다.

게스트에 활성 실행이 없어야 정상 종료를 진행한다. `sync` → cache bind 해제 → ext4 unmount → 신뢰된 `NIDUS_CACHE_CLEAN` 이벤트와 실제 VZ 종료 확인이 모두 있어야 Host가 `clean`으로 기록한다. VZ 종료만 확인되고 게스트 디스크 해제가 확인되지 않았다면 디스크는 `dirty`로 남는다. 앱/Manager 장애로 owner가 남으면 PID나 시간만으로 회수하지 않는다.

UI의 캐시 삭제는 명시적인 확인을 거치며, Controller는 전체 VM 정지와 실행 대기열 비어 있음을 다시 확인한다. `STOP_UNCONFIRMED` 또는 살아 있는 소유권 잠금은 삭제로 우회할 수 없다. 정상 종료가 확인된 dirty 캐시는 사용자가 삭제하고 새로 만들 수 있다. Host 원본 파일은 삭제하지 않는다. 중단된 생성/metadata 교체는 안전 차단한다.

## 구현 경로

- `src/vault/cache-disk.ts`: 저장 구조, 식별, 잠금, dirty/clean, 상태·삭제.
- `native/vault-vm.swift`: 검증된 RAW 디스크의 virtio-block 연결. Apple Framework의 디스크 잠금과 충돌하는 별도 flock은 사용하지 않는다. Host Store와 VM 서비스 소유권 잠금이 선행한다.
- `scripts/vault-vm/cache-modules.py`: 기존 boot kernel과 정확히 일치하는 공식 패키지에서 ext4와 의존 모듈만 추가. 패키지 전체 SHA-256과 내부 kernel SHA-256을 모두 확인한다.
- `scripts/vault-vm/init.sh`, `child.py`: 검사·마운트·cache 제한 노출·해제.
- `SharedVMController`: VM 생명주기와 디스크 상태 결합. `cacheStatus(vaultId)`, `clearCache(vaultId)`.
- SwiftUI: 상태와 Host 실제 할당량 조회, 정지 상태에서 삭제 확인.

[Apple 디스크 연결 API](https://developer.apple.com/documentation/virtualization/vzdiskimagestoragedeviceattachment/init(url:readonly:cachingmode:synchronizationmode:)-36gc5)를 사용하며 `.uncached` 및 `.full` 동기화 정책을 설정한다. 게스트 캐시 해제 증거는 별도로 요구한다.

## 검증

개발 빌드는 cache 지원 manifest가 있는 경우에만 디스크를 활성화한다. 기존 M4 Evidence는 보존한다.

2026-11-04 검증 결과:

- PASS: `npm test` — 330개, 실패 0. 최초 제한 환경에서는 Swift module cache 접근이 차단되어 빌드가 중단되었으며, 허용된 실행 환경에서 재실행하여 통과했다.
- PASS: `swift test` — 52개, 실패 0.
- PASS: `npm run build:vm`, `npm run build:app` — 네이티브 helper 빌드·로컬 서명 및 macOS 개발 앱 번들 생성. 앱 번들은 배포 서명하지 않았다.
- PASS: [실제 VM 검증](../evidence/Vault_Cache_Real_2026-11-04.json) — 재부팅 후 파일 및 오프라인 pip wheel/npm tarball 재사용, 임시 홈·세션 초기화, Vault 간 격리, 캐시 삭제 후 재생성, 강제 종료 뒤 dirty 재사용 차단. 7개 실행 모두 종료 코드 0 및 cleanup 확인.
- PASS: [장애 검증](../evidence/Vault_Cache_Failures_2026-11-04.json) — ext4 superblock 손상 시 자동 복구·포맷 없이 차단, Manager SIGKILL 뒤 STOP_UNCONFIRMED 및 소유권 잠금 유지, 시작·삭제 거부. 합성 장애 테스트 디렉터리는 종료 미확인 정책에 따라 보존했다.
- NOT RUN: GUI 수동 조작 검증. Swift 화면 관련 테스트는 위 테스트에 포함된다.

실제 VM 테스트는 합성 Vault와 테스트 코드의 명시적 프로그램 승인을 사용했다. Provider 인증 정보나 사용자 Vault는 사용하지 않았다. 네트워크 패키지 다운로드는 지원 범위 밖이다.
