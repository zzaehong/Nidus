# Vault와 영속 캐시의 장치 번호 변경 복구

## 원인

2026-11-05 로컬 및 iCloud Vault에서 `root_replaced`가 발생했다. 등록 당시와 현재의 inode 및 생성 시각은 같았지만 `stat.dev`가 달랐다. 기존 구현은 마운트 시점에 따라 달라질 수 있는 장치 번호를 영속 식별자로 비교해 동일 폴더를 교체된 것으로 판단했다. Vault 복구 후 실제 VM 시작에서 영속 캐시의 같은 비교로 `cache_disk_changed`도 확인했다.

## 수정

macOS에서는 등록 시 볼륨 UUID를 별도 기록하고, 이후 볼륨 UUID·inode·생성 시각으로 동일성을 확인한다. `device`를 무조건 무시하지 않는다. 다른 볼륨, 다른 inode/생성 시각, symlink/hardlink, 손상된 메타데이터와 Vault/Environment ID 변경은 계속 거부한다. 볼륨 UUID 조회가 실패하면 차단하며 이전 장치 번호 비교로 우회하지 않는다.

볼륨 UUID는 기존 native 파일 helper의 읽기 전용 연산으로 조회한다. 경로 구성 요소를 no-follow 디렉터리 FD로 열고, 조회 전후 root identity를 검사한다. Host 파일 도구에는 현재 마운트의 device를 반환하므로 실행 중 경로 교체 검사는 그대로 유지된다. 영속 캐시도 볼륨 UUID를 기록하고 파일 소유권·권한·크기·링크 수·inode·생성 시각을 계속 검사한다.

기존 UUID 없는 등록은 자동으로 장치 번호 변경을 수용하지 않는다. `VaultRegistry.rebindVaultDevice`는 사용자가 요청한 복구에서만 사용하는 라이브러리 API다. 기존 경로·inode·생성 시각·descriptor를 재검증하고 Registry 잠금 및 원자적 저장 경로로 갱신한다. 이전 볼륨 UUID가 없으므로 이전 볼륨과의 일치 자체를 소급 증명하는 기능은 아니다. 일반 조회·VM admission에서 이 복구를 자동 호출하지 않는다.

캐시의 명시적 `CacheDiskStore.rebindDevice`는 호출자가 VM 종료를 먼저 확인해야 한다. owner 잠금, 기존 디스크 식별자 및 상태 검사를 거치며 dirty 캐시는 복구하지 않는다. 캐시 포맷이나 내용 삭제, 실행 기록 초기화, 미확인 VM의 잠금 해제를 하지 않는다. macOS 외 환경의 UUID 없는 등록은 기존 device 비교를 유지한다.

## 적용과 검증

- PASS: 전체 Node 테스트 375개. 장치 번호 변경, 다른 볼륨 거부, legacy 명시 복구, inode·생성 시각·descriptor 변경 거부, 저장 직전 폴더 교체, dirty 캐시 거부를 포함한다.
- PASS: native helper와 로컬 앱 번들 빌드.
- PASS: 두 사용자 Vault의 등록 정보 백업 및 명시 복구, descriptor 바이트 보존 확인. iCloud descriptor 최초 읽기 지연 이후 재시도하여 검증했다.
- PASS: 기존 clean 캐시의 metadata 백업 및 복구. cache.raw의 inode·크기·생성/수정 시각은 복구 전후 동일했다.
- PASS: 수정된 앱 번들의 dashboard 경로에서 로컬·iCloud Vault 각각 `RUNNING`/ready 확인 후 `STOP_CONFIRMED`, 관리 서비스 정상 종료. 모델 요청과 사용자 작업은 실행하지 않았다.
- NOT RUN: 실제 재부팅 전후 E2E. 장치 번호 변경은 fixture에서 재현하고 현재 시스템의 기존 불일치는 직접 확인했다.
- NOT RUN: GUI 수동 클릭, Provider API 호출. SwiftUI 코드는 변경하지 않았다.

백업은 사용자 Host Registry 폴더에 보관하고 저장소에 넣지 않았다. 기존 실패 evidence와 VM 세션 이력은 보존한다. 앱 산출물은 `dist/Nidus.app`이며 새 프로세스부터 변경 코드가 적용된다.

검증 요약: [실제 VM 및 회귀 검사](../evidence/vault-device-identity/validation.json).
