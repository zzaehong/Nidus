# M4 개발 환경·Workspace·Browser·Network

검증일: 2026-11-03. 브랜치: `feature/vault-runtime-v2`.

**M4 잔여 기능 전체는 미완료다.** 이번 구현에서 오프라인 Python/Node 개발 환경을 실제 앱에 연결했다. Workspace Host 계약과 Guest 반입·변경 회수는 각각 검증했지만 제품 연결은 미완료다. Chromium은 오프라인 DOM 진단만 통과했으며 인터넷 Browser 도구는 비활성이다. Vault별 영속 디스크/캐시는 아직 구현하지 않았다.

기존 M0/M4 Evidence는 변경하지 않았다. 새 결과는 `docs/evidence/m4-development/`에 저장했다. 과거 Node 289건/Swift 45건의 성공을 새 기능의 성공으로 간주하지 않았으며 아래 결과는 이번 실행 결과다.

## 개발 이미지 및 리소스

공식 Alpine 3.24 aarch64 저장소의 219개 패키지를 `scripts/vault-vm/development.lock.json`에 URL, 버전, SHA-256, 크기와 함께 고정했다. 다운로드 패키지 총량은 427,017,611 bytes다. `development-image.py`는 APK를 검증·추출하며 Host에서 패키지 설치 스크립트를 실행하지 않는다. setuid/setgid를 제거하고 필요한 BusyBox 링크를 명시적으로 생성한다.

| 도구 | 실제 실행 확인 버전 |
|---|---|
| Python / pip | 3.14.10 / 26.1.2 |
| Node.js / npm | 24.22.1 / 11.12.1 |
| Git | 2.54.0 |
| Bash | 5.3.9 |
| curl | 8.23.0 |
| GCC | 15.2.0 |
| Chromium | 패키지 156.0.8078.79-r0, 오프라인 DOM 실행 확인 |

빌드 절차:

```sh
python3 scripts/vault-vm/development-image.py build CACHE --output ROOT
NIDUS_VM_BUILD_ASSETS=ASSETS NIDUS_VM_DEVELOPMENT_ROOT=ROOT npm run build:app
```

`CACHE`는 고정 APK 보관 디렉터리, `ROOT`는 새로 생성할 개발 루트, `ASSETS`는 기존 고정 kernel/initramfs 입력 디렉터리다. Runtime은 이미지를 다운로드하지 않는다. APK post-install과 전체 APK 의존성 버전 solver를 구현한 것은 아니다. 공식 TLS 배포에서 취득한 고정 SHA-256을 검증하며 별도 APK 서명 검증은 미구현이다. 모든 219개 패키지의 모든 기능을 검증한 것은 아니다.

newc/gzip의 timestamp, UID/GID, 순서를 정규화한다. 개발 계층 캐시는 manifest 주장만이 아니라 실제 경로·모드·파일 내용 해시에 결합된다. 전체 패키지 재추출을 두 번 수행한 bit-for-bit 이미지 비교는 NOT_RUN이며, 결정적 archive 단위 테스트만 PASS다.

| 범위 | 제한 |
|---|---|
| 기존 기본 VM | 2 vCPU / 512 MiB, 기존 경로 유지 |
| 명시적 development 이미지 VM | 2 vCPU / 3 GiB |
| 개발 Shell Session | memory 512 MiB / pids 64 / CPU 1코어 |
| Browser 진단 Session | memory 1 GiB / pids 256 / CPU 1코어 |
| 시간 | Guest 상한 120초, 앱 Shell 30초 |
| 출력 | stdout/stderr 각 32 KiB |
| 파일/임시 공간 | RLIMIT 파일 16 MiB, `/sessions` tmpfs 전체 32 MiB |

개발 initrd는 약 423 MiB이며 앱은 약 601 MiB다. 대규모 빌드나 패키지 설치에 충분한 디스크 정책은 아직 제공하지 않는다. pip/npm은 기본 오프라인이며 인터넷 설치는 사용할 수 없다. 패키지는 이미지에 포함되어 VM 실행마다 다시 설치하지 않는다. 이 이미지 빌드 캐시는 **Vault별 영속 개발 패키지 캐시가 아니다.**

각 Session은 새 PID/mount namespace, UID/GID 1000, no_new_privs, 읽기 전용 bin/lib/usr, 새 home/tmp/work를 사용한다. guest CPU topology만 읽기 전용으로 노출하며 cgroup 제어 경로는 노출하지 않는다. cgroup.kill 및 populated=0 확인 후에만 정리 완료를 반환한다. VM은 네트워크 장치·Host 공유 마운트·영속 개발 디스크가 없다.

## Workspace 데이터 흐름

`src/vault/workspace.ts`의 `WorkspaceGateway`:

- `prepare`: 명시적으로 선택한 파일만 기존 Native Host File Gateway로 읽는다. 최대 32개, 파일당 64 KiB, 총 512 KiB. 재읽기, Vault identity와 Environment ID 검증을 수행한다.
- `transferApproved`: 신뢰된 Host 콜백이 승인한 뒤 원본 파일 hash/객체 버전을 다시 검증한다. Vault/Execution/Snapshot/만료/내용 hash를 결합하며 일회용 payload를 반환한다. 거부·취소·승인 응답 없음·내용 변경·중복 소비를 차단한다.
- `review`: Host가 보관한 원본 Snapshot과 일치하는 기준만 허용하고 선택된 기존 파일 수정/삭제 Diff 및 Host 충돌 여부를 반환한다. `hostApplyEnabled`는 항상 false다.
- `finishExecution`: 해당 Task의 Snapshot과 소비 기록을 정리한다. Snapshot은 메모리 한정, 5분 만료, 최대 16개다. 자동 재개·영속 Snapshot은 지원하지 않는다.

Secret, 설정, `.nidus`, symlink/hardlink 정책은 기존 Native Gateway를 유지한다. `package.json` 등 기존 보호 정책에 걸리는 파일도 아직 허용하지 않았다. 임의 프로젝트 전체를 복제하는 방식이 아니다.

Guest `workspace.py`는 root 전용 제어 채널에서 bounded chunk와 SHA-256으로 payload를 검증한다. `/snapshot`에는 root 소유 읽기 전용 기준 파일, `/work`에는 Session UID 소유 작업 복사본을 만든다. 종료 시 cgroup 정리 후 선택 파일의 내용·삭제 여부를 회수한다. symlink/hardlink/특수 파일/바이너리/크기 초과를 거부한다. 중단된 staging은 같은 VM에서 자동 재사용하지 않는다.

**실제 Host Gateway → 제품 승인 → Admission → Guest 반입 → Diff UI의 통합은 아직 없다.** Host API 테스트와 실제 Guest synthetic payload 테스트는 별도다. 신규 VM 파일 수집도 미지원이다. 기존 파일 조건부 교체/삭제와 모든 제품 Host 쓰기는 계속 비활성이다. Host 원본을 VM에 직접 마운트하지 않는다.

## Chromium 및 네트워크

Chromium은 실제 Linux ARM64 VM에서 합성 HTML의 제목/본문 DOM을 출력했고 cgroup 정리도 확인했다. 매번 새 임시 profile을 사용했다. 공식 [Headless 문서](https://developer.chrome.com/docs/automation-and-testing/headless-cli)와 [Linux sandbox 구조](https://chromium.googlesource.com/chromium/src/+/master/sandbox/linux)를 참고했다.

현재 guest는 unprivileged user namespace를 금지하고 setuid도 제거한다. 진단은 `--no-sandbox`를 사용했으며 Chromium 자체 sandbox 안전성을 증명하지 않는다. Guest UID/PID/mount/cgroup/VM 격리는 유지했지만 이를 외부 웹용 Browser 완료 근거로 대체하지 않았다. CDP 기반 Context, 검색/탐색/본문 Tool, profile 수명주기와 실제 UI 승인은 아직 미구현이다. Browser는 Agent에 광고하지 않는다.

`src/vault/network-policy.ts`는 **제품에 연결되지 않은 후보 HTTPS GET 모듈**이다. URL 및 DNS A 응답 검증 후 IP를 고정해 TLS hostname 검증을 유지하고 실제 peer 주소를 검사한다. IPv6 transport, CONNECT, 임의 헤더/쿠키 전달을 지원하지 않는다. 응답은 제한된 텍스트 형식/512 KiB이며 Content-Disposition, 압축 응답을 거부한다. redirect URL을 검증하고 자동 추적하지 않는다. DNS 포함 전체 10초 및 socket inactivity 8초 제한을 둔다.

후보 모듈 단위 테스트 4건과 공개 `https://example.com/` GET은 PASS다. 이것은 Guest Browser 네트워크 검증이 아니다. Guest 중계 채널, Tool별 네트워크 권한, 실제 DNS rebinding/redirect/IPv6/WebSocket/WebRTC/QUIC/download 우회 검증은 NOT_RUN이다. Shell과 Browser의 인터넷 경로는 활성화하지 않았다.

## 테스트 및 Gate

Gate의 FAIL은 전체 완료 조건 미충족을 뜻하며, 아래 개별 테스트 PASS를 취소하거나 미완료를 성공으로 표시하지 않는다.

| Gate | 결과 | 근거와 잔여 |
|---|---|---|
| A Development | FAIL | 실제 개발 도구·리소스 PASS, Vault 영속 캐시 미구현 |
| B Workspace | FAIL | Host API 및 Guest 반입/회수 각각 PASS, 제품 통합·영속 상태 미구현 |
| C Browser | FAIL | 오프라인 DOM/정리 PASS, Chromium sandbox·CDP Context·Browser Tools 미완료 |
| D Network | NOT_RUN | 후보 Host 모듈만 검증; 실제 Browser egress 게이트 미검증 |
| E Agent | FAIL | 기존 Host read → 실제 VM Shell Mock Agent PASS, 개발 Workspace/Browser 복합 작업 미완료 |
| F App | FAIL | 실제 개발 앱 빌드/시작/번들 채널 PASS, 신규 전체 화면 연결·실제 UI 검토 미완료 |

이번 실행 결과:

- **PASS Node 302 / 302**, Swift **45 / 45**. M1a/M1b, Provider/Router/Ledger 기존 회귀 포함. 실제 유료 Provider API 호출은 0건이다.
- **PASS 실제 개발 VM 14 시나리오**: 도구 버전, Python/Node JSON, Python/Node 단위 테스트, Git/GCC, background/setsid, 다음 Session 파일 격리, double-fork, 권한/Host/cgroup/오프라인 경계, 취소, timeout, Snapshot 반입/수정 회수, Chromium offline DOM. 동일 VM에서 순차 실행했으며 모두 cleanup confirmed.
- **PASS 실제 Admission 8 시나리오**: VM Instance 재사용, 서로 다른 OS 프로세스 FIFO, 취소 정리, Mock Agent의 Host read → 실제 VM Shell, 다른 Vault 전역 제한, VZ 종료, 종료 후 다른 Vault 전환, Manager SIGKILL 후 재진입 차단. 마지막은 실제 종료를 추정하지 않고 STOP_UNCONFIRMED를 유지한다.
- **PASS 앱 번들 채널 3 시나리오**: 거부 시 VM 미부팅, fixture 승인 후 Python/Node/UID1000 실제 실행, VZ 종료. 프로그래밍된 fixture 결정이며 실제 사용자 승인으로 기록하지 않았다.
- **PASS 앱 빌드와 프로세스 시작**: `open` 성공 및 새 앱 프로세스 확인. 화면 클릭·사용자 승인 체감 검증은 NOT_RUN.
- **NOT_RUN** 실제 인증된 Provider E2E, 영속 캐시 복구/삭제/격리, 공개 웹 Browser, 전체 네트워크 우회, 실제 UI 승인 클릭, 새 프로필의 전용 force-stop 실패 주입.

초기 실패도 새 Evidence로 보존했다: 개발 cgroup mount/app link 누락, Chromium GPU 초기화 및 pids 한도, 취소 시 `completed`로 보고하던 경쟁 조건. 취소는 자식 종료 직후 제어 채널 취소 marker를 다시 검사하도록 수정했고 실제 회귀를 재실행했다. UI 자동화는 `Sky Computer Use native pipe startup failed`로 연결되지 않았다. 이를 UI PASS로 표시하지 않았다.

## 직접 검토할 앱

산출물: `/Users/parkjaehong/Developer/Nidus/dist/Nidus.app`

로컬 개발 번들이며 배포용 notarization은 없다. 번들 내부 Node, `nidus-vault-vm`, `nidus-vault-files`, 개발 Image/initrd를 실제 채널 테스트에서 사용했다. `vm-assets/manifest.json`의 profile은 `development`이다.

1. 앱의 Vault Runtime 개발 검토 화면을 연다.
2. 테스트용 **새 빈 디렉터리**를 Vault로 등록한다. 개인 Vault를 자동 검증 대상으로 쓰지 않는다.
3. Shell 입력에 `python3 --version; node --version; python3 -c 'print(2+2)'`를 넣고 “Shell 제안 · API 호출 없음”을 선택한다.
4. 명령/Vault/hash를 확인하고 승인 또는 거부한다. 거부하면 새 VM이 부팅되지 않아야 한다.
5. 승인하면 버전과 결과 `4`가 표시된다. 별도 명령을 실행해 같은 VM/Generation을 유지하는지 상태를 조회한다.
6. `sleep 20`으로 취소를 검토하고 종료 확인 결과를 확인한다.
7. “VM 종료 요청” 후 STOP_CONFIRMED를 확인한다. STOP_UNCONFIRMED이면 자동 lock 삭제나 재실행을 하지 않는다.

이 앱에서 승인된 오프라인 Python/Node Shell과 기존 Agent Shell 흐름은 검토할 수 있다. 현재 UI는 Vault 프로젝트를 VM으로 보내지 않는다. Browser/인터넷/Host 쓰기/영속 캐시가 가능한 앱으로 오해해서는 안 된다.

## 남은 작업 및 Git

M4 안에서 먼저 해결해야 할 항목: 실제 Workspace 승인·Admission·Diff UI 통합, Vault별 영속 디스크와 dirty/정상 종료 검증·삭제 정책, Chromium sandbox 및 CDP Context, Guest/Host network enforcement와 우회 테스트, Browser 실제 승인·Agent 복합 E2E. 이를 M4 완료로 간주해 M5/M6로 넘기지 않는다.

M5/M6 검토 항목: 권한 UX 개선, 개발 이미지 배포/업데이트/서명 체계, 리소스 설정 UI, 장시간 운영·디스크 quota 검증. Manager 사망 자동 복구, Phase 7 Memory, Phase 8 스케줄러는 구현하지 않았다.

주요 커밋:

- `6d05f7d`: 고정 개발 이미지·Guest Workspace·초기 실제 Evidence.
- `93b9196`: Host Workspace 승인/검토 API 및 Native 임시 Vault 테스트.
- `8f2b95b`: 비활성 HTTPS 후보 모듈 및 별도 검증.
- `28fab0f`: 앱 개발 프로필 연결, 취소 사유 수정, 실제 회귀 및 번들 검증.

시작/종료 develop: `d5972bacbb1a41207ce5d15b25d09bcf82c942df`. main: `723c03b59dcecaae27d9fe0a9f97b464c785d706` 유지. develop 병합, 브랜치 삭제, reset, push/PR은 수행하지 않았다. 사용자 검토용 개발 산출물이며 M4 전체 완료 승인을 요청하는 상태는 아니다.

## 2026-11-04 잔여 작업 — 승인 Workspace 앱 연결

**M4 전체는 아직 미완료다.** 이번 변경으로 개발 이미지의 선택 파일 Workspace를 Host 서비스 → 실제 VM → Diff 검토 → SwiftUI까지 연결했다. Browser/인터넷, 영속 패키지 캐시·디스크, Host 변경 반영은 완료로 표시하지 않는다.

### 구현 및 사용 경로

- `run_project(command, paths)`는 신뢰된 코드가 정의하는 VM Tool이다. `paths`는 줄바꿈으로 구분한 최대 32개 Vault 상대 파일 경로다. 개발 이미지인 경우에만 Agent 채널이 광고한다.
- 서비스가 Native Host File Gateway로 Snapshot을 만들고 승인에 경로·바이트 수·Snapshot 해시를 포함한다. 명령 감사 해시는 명령과 Snapshot 해시에 함께 결합된다. 모델에게 승인 토큰을 전달하지 않는다.
- 실제 실행 직전에 원본 내용·객체 동일성을 다시 확인한다. 변경되면 실행하지 않는다. 실행 전 검증 실패는 이미 실행된 세션의 종료 미확인과 구분한다.
- 직렬화된 서비스가 제한된 chunk/ACK/전체 SHA-256 프로토콜로 파일을 전달한다. 게스트의 읽기 전용 `/snapshot`과 쓰기 가능한 `/work`는 Host 원본과 별개다. 실행 완료 후 cgroup 정리를 확인하고 선택 파일의 변경/삭제안을 반환한다.
- 반환 데이터는 불신 데이터로 다시 검증한다. 새로운 파일 반출은 지원하지 않는다. Diff가 출력 한도를 넘으면 명시적 검토 오류를 반환한다. Host 원본 자동 변경·삭제는 없다.
- SwiftUI Shell 영역 아래 Workspace 입력란에 상대경로를 한 줄씩 입력하고 명령을 제안한다. 승인 화면에서 파일 목록·Snapshot 해시를 확인한다. 결과 영역의 `workspaceReview`에서 Diff와 충돌 여부를 검토한다.
- Snapshot은 세션별 임시 데이터다. 영속 캐시나 디스크 구현으로 간주하지 않는다. 보호 파일 정책에 따라 `package.json` 등 일부 설정 파일은 계속 거부된다.

### 새 검증 결과

| 검증 | 결과 | 근거/한계 |
|---|---|---|
| 전체 Node 회귀 | PASS 324 | `/private/tmp/nidus-m4-remaining-node-final-2.log`; 이전 기준 321과 구분 |
| Swift 회귀 | PASS 51 | Workspace 승인 표시 테스트 추가; 이전 기준 50 |
| 실제 Workspace 왕복 | PASS | `evidence/m4-remaining/workspace-final-real.json` |
| 동일 VM/Generation 2회 재사용 | PASS | 위 Evidence, 매번 원본 Snapshot으로 시작 |
| Host 원본 보존, Diff, cgroup cleanup, VM 전체 종료 | PASS | 합성 임시 Vault만 사용, STOP_CONFIRMED |
| 실제 사용자 승인 클릭 | NOT_RUN | 자동 테스트의 프로그램 승인은 사용자 승인 증거가 아님 |
| 실제 유료 Provider + Workspace E2E | NOT_RUN | 호출하지 않음 |
| Chromium namespace sandbox | FAIL | 5회 실제 VM 진단, 아래 설명 |
| Browser 검색/DOM + 네트워크 보안 통합 | NOT_RUN / 비활성 | URL 정책 단위 테스트를 실제 브라우저 격리로 주장하지 않음 |
| 영속 캐시·디스크 | 미구현 | 고정 개발 도구 이미지와 별개 |
| Host 변경 반영 | 비활성 | Native 조건부 교체·삭제 검증이 선행되어야 함 |

### Browser 잔여 원인과 다음 조치

실제 Linux VM에서 Chromium sandbox 경로를 진단했다. 초기 mount 구성 오류를 수정한 뒤에도 Chromium은 `No usable sandbox`, user namespace 생성은 `Operation not permitted`로 실패했다. 정확한 커널/초기 rootfs/namespace 원인은 아직 확정하지 않았다. `--no-sandbox`로 우회해서 인터넷 도구를 활성화하지 않았다.

실험 patch와 다섯 번의 실패 Evidence를 `evidence/m4-remaining/`에 별도 보존했다. namespace 허용 범위를 늘리는 실험 변경은 제품 이미지에서 제외했다. 기존 M0/M4 Evidence는 수정하지 않았다. 과거 `--no-sandbox` 오프라인 DOM 성공은 Chromium sandbox 또는 공개 웹 격리 성공을 의미하지 않는다.

다음 작업은 정식 guest root filesystem/namespace 구성에서 Chromium sandbox를 검증하고, CDP 요청을 Host의 제한된 HTTPS GET 경로에 연결한 후 DNS·redirect·IPv6·WebSocket·Shell 우회 실험을 수행하는 것이다. 참고한 1차 문서는 [CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/), [clone의 user namespace 제한](https://man7.org/linux/man-pages/man2/clone.2.html), [pivot_root](https://www.man7.org/linux/man-pages/man2/pivot_root.2.html)다. 현재 VM에는 여전히 NIC가 없고 Browser 도구는 광고하지 않는다.

### 직접 검토

1. 개발 앱 `dist/Nidus.app`을 실행한다. 기존 앱/VM이 열려 있다면 활성 실행 종료와 VM STOP_CONFIRMED를 확인하고 앱을 다시 실행한다. 기존 종료 미확인 Journal을 삭제해서 우회하지 않는다.
2. 개인 프로젝트 대신 `main.py`에 `print(1)`만 넣은 별도 테스트 Vault를 등록한다.
3. Workspace 입력에 `main.py`, Shell 명령에 `python3 main.py; printf 'print(2)\n' > main.py`를 입력한다.
4. 파일 목록과 명령의 승인 요청을 확인한다. 거부 시 실행되지 않아야 한다.
5. 승인하면 stdout `1`, 변경 Diff, `hostApplyEnabled:false`를 확인한다. Host 파일은 `print(1)`이어야 한다.
6. 다시 실행하여 VM Instance/Generation은 같고 작업 파일은 원본 Snapshot으로 초기화되는지 확인한다.
7. 모델 검사 통과 모델의 Agent에 같은 작업을 요청할 수 있다. Provider 사용량 과금은 별도이며 이번 자동 검증에는 포함하지 않았다.
8. Browser/웹 검색은 계속 비활성이다. 이 빌드는 웹 리서치 완료 빌드가 아니다.

이번 구현 커밋: `ac14292`. 개발 앱 빌드 및 번들 Image/initrd SHA-256, VM/File Helper 포함 검사는 PASS이며 `open dist/Nidus.app` 요청도 성공했다. 실제 화면 클릭·승인 조작은 NOT_RUN이다. 최종 검증 요약은 `evidence/m4-remaining/validation-summary.json`에 보존했다. Tool 식별자 결합 보완 후 관련 Node 23개도 다시 통과했다.

Gate 판정: A는 기존 개발 도구 실행 PASS이나 영속 캐시 미완료, B는 선택된 기존 파일 Snapshot/실행/Diff 범위 PASS(Host 반영 비활성), C는 sandbox FAIL, D는 실제 Browser 네트워크 NOT_RUN/비활성, E는 Workspace 도구 연결 PASS이나 실제 Provider·웹 복합 E2E NOT_RUN, F는 빌드·번들 검사 PASS이나 실제 UI 조작 NOT_RUN이다. 이 범위를 넘어 M4 완료 또는 웹 브라우저 제어 완료로 해석해서는 안 된다.
