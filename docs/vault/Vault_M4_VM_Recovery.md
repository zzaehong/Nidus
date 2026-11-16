# VM 관리 서비스 유실 복구

사용자에게 `STOP_UNCONFIRMED`와 `vm_manager_unavailable`이 표시됐으며, 확인 시 관리 서비스와 VM helper 프로세스는 없었지만 owner 및 control.sock, 종료 미확인 기록이 남아 있었다. 최근 작업 기록은 cleanupConfirmed였다. 기존 UI는 이 상태에서 실행과 종료를 모두 차단하고 복구 경로를 제공하지 않았다.

## 명시적 cold recovery

VM 현황의 ‘종료 상태 복구…’에서 설명을 확인하고 실행한다. 관련 서비스나 VM helper 프로세스가 살아 있으면 거부한다. 프로세스 목록 확인 실패도 거부하며 PID 추측이나 프로세스 강제 종료를 하지 않는다. 두 차례 프로세스 검사를 하고, 디렉터리 identity와 상태 파일이 변경되지 않았는지 확인한 후 기존 vm-runtime 디렉터리를 같은 부모의 고유 archive 경로로 rename한다. 경로·파일 소유권·권한 검증과 recovery lock을 사용한다. 서비스 시작은 recovery lock이 있으면 거부한다.

기존 상태·owner·세션·dirty cache·중간 기록은 삭제하거나 성공으로 고치지 않는다. 새 런타임은 새 generation/history/cache를 사용한다. 원래 Vault 파일과 Provider 설정은 변경하지 않고 이전 작업을 재실행하지 않는다. 새 실행의 가능성을 확인하는 복구이며 과거 guest cleanup을 증명하는 작업은 아니다. 관련 프로세스가 살아 있거나 상태가 계속 바뀌는 상황을 강제 해제하는 기능은 제공하지 않는다.

현재 사용자 런타임에 이 복구를 적용한 뒤 실제 VM 시작 RUNNING, 종료 STOP_CONFIRMED, 관리 서비스 shutdownConfirmed를 확인했다. 원래 기록/캐시는 `~/.local/share/nidus/vaults/vm-runtime-archive-cd50b80c-357c-479a-b473-48a4e74eea8f`에 보관했다. 런타임 데이터와 토큰은 저장소에 복사하지 않았다.

## 실행파일 교체 개선

macOS 충돌 보고서에 Nidus 번들 Node의 `SIGKILL (Code Signature Invalid)`가 반복 기록돼 있었다. 기존 build-app은 번들 실행파일을 copyFile로 같은 inode에 덮어썼다. 실행 중인 서명된 코드에 영향을 줄 수 있는 경로라, 임시 새 파일에 복사한 뒤 rename으로 교체하도록 수정했다. VM helper도 별도 파일로 컴파일·서명한 뒤 교체한다. 충돌의 단일 원인을 독립적으로 재현했다고 주장하지 않는다.

합성 번들 Node를 실행한 채 전체 앱을 빌드한 뒤 같은 프로세스의 생존과 출력 진행을 확인했다. 기존 매핑 inode가 보존되는 단위 테스트도 추가했다. 변경 후 앱을 다시 실행하면 새 UI를 사용할 수 있다.

## 검증

- PASS: Node 359개, Swift 55개, 앱 빌드.
- PASS: 실제 차단 상태 복구와 새 VM 시작·정상 종료.
- PASS: 동작 중인 프로세스/검사 실패/동시 상태 변경/symlink/recovery lock에서 복구 거부, 기존 캐시·기록 보존.
- PASS: 앱 재빌드 중 합성 번들 Node 생존.
- NOT RUN: 복구 버튼 GUI 수동 클릭.

Evidence: `docs/evidence/m4-vm-recovery/`.
