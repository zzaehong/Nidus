# Vault Runtime v2 개발 기준과 M1~M6 계획

작성: 2026-11-02. 이번 작업은 브랜치 분리·문서 이관·분석만 수행한다. 런타임, VM, Provider, Router, Usage Ledger 구현은 변경하지 않는다.

## 기준점 결정과 보존

| 항목 | 확인한 값 |
|---|---|
| 시작 브랜치 | feature/agent-runtime-vault-sandbox |
| 기존 feature HEAD | 6199f49a195669a765f6990fef5fd60ebc2371cf |
| 시작 작업 트리 | tracked/untracked 변경 없음 |
| 로컬 develop (시작/종료 유지 대상) | d5972bacbb1a41207ce5d15b25d09bcf82c942df |
| 로컬 origin/develop 추적 ref | 81ecb887cd2f2b8803ead55c0c50d945aacbf15a |
| 새 브랜치 / 기반 | feature/vault-runtime-v2 / 81ecb887cd2f2b8803ead55c0c50d945aacbf15a |
| main (변경 없음) | 723c03b59dcecaae27d9fe0a9f97b464c785d706 |

`git log 81ecb887cd..develop`에는 12개 커밋이 있다. `d5972ba`는 M0를 develop에 통합한 merge다. 차이는 59개 파일, 8,488행 추가/1,266행 삭제이며 다음을 포함한다.

- `5291342`: 초기 Phase 5–6 설계, `fd3efae`·`96de7bf`: native sandbox와 생명주기 진단.
- `518ae06`·`bbc3b44`·`c8de382`: VM/독립 Manager/복구 관측, `374b920`: Swift 복구 UI와 packaging.
- `7a61e22`: Provider Adapter 공통 검증과 engine 라우팅 계산 리팩터링. 이번 작업의 수정 금지 영역이며 통째로 가져오지 않는다.
- `bdd2727`·`074b1ee`·`a9a9c71`: 문서 정리·개발 지침·후속 준비. 최신 Vault 설계 `6199f49`는 로컬 develop에 포함되지 않는다.

따라서 최신 로컬 develop은 VM 도입 전 코드가 아니다. 사용자가 지정한 예외에 따라 `81ecb887cd`를 기반으로 새 브랜치를 만들었다. 최신 develop 기반을 요구하는 일반 Git Flow보다 이번 명시적 요청을 우선한다. 기존 브랜치 삭제/reset/rebase, cherry-pick, develop 병합, push/PR은 하지 않는다. develop을 이전 상태로 되돌린 것도 아니다.

원격 확인 `git ls-remote origin refs/heads/develop`는 sandbox에서 DNS 오류로 실패했으나, 네트워크 접근을 허용한 읽기 전용 재조회에서 `81ecb887cd2f2b8803ead55c0c50d945aacbf15a`를 확인했다. 원격 develop도 선택한 기준점과 동일하다. fetch/pull로 refs를 갱신하거나 로컬 develop을 변경하지 않았다.

## 선별 이관 목록과 읽는 순서

모든 이관 파일의 출처는 고정 커밋 `6199f49a195669a765f6990fef5fd60ebc2371cf`이고 바이트 그대로 복사한다.

1. [최신 Vault 설계](Phase5_6_Agent_Runtime_Vault_Sandbox.md): 앞부분 현재 설계를 v2 목표로 사용한다. 원문에 적힌 브랜치/기준 코드는 당시 출처다. v2 구현 상태와 기준점은 이 계획서를 따른다.
2. `docs/evidence/Phase5_6_M0_{Sandbox,Lifecycle,VM,VM_Manager,VM_Recovery,VM_User_Recovery}.json`: 6개 원본 결과. 설계의 상대 링크와 실패 근거를 보존하기 위한 기록 이관이다.
3. [VALIDATION.md](VALIDATION.md)와 [USER_GUIDE.md](USER_GUIDE.md): 설계→검증 이력→사용 안내의 참조를 유지하는 역사 스냅샷. **이 문서들의 M0 복구 UI/명령/기능은 v2 현재 코드에 존재하지 않는다.** v2 사용 가능 기능은 기반 코드와 기존 README를 기준으로 판단한다.

M0 실행 스크립트, Swift 복구 UI, build-app 변경, Provider 리팩터링은 이관하지 않는다. 역사 문서의 재현 명령은 기존 feature 커밋의 별도 checkout에서만 실행할 수 있다. 이관 evidence는 v2 실행 결과가 아니며 다시 생성하거나 기존 FAIL/UNCONFIRMED를 수정하지 않는다.

## 설계와 기반 코드의 차이

| 영역 | 81ecb887cd 코드 | 필요한 v2 구조 / 경계 |
|---|---|---|
| 식별·저장 | `src/storage.ts`는 ModelStore, `src/ledger.ts`는 사용량/계정/라우팅 저장 | Vault/Environment/Instance/Session/Task/Step/Invocation을 별도 모델로 정의. Ledger에 VM 상태를 넣지 않음 |
| Vault | 등록/이동/복사/중첩 검사와 `.nidus/vault.json` 없음 | 이동 가능한 descriptor와 Host 경로·동일성·실행 잠금 분리. 복제 ID는 자동 채택하지 않음 |
| Agent | `src/engine.ts`는 기존 텍스트 요청, `ChatRequest`는 user/assistant 문자열, `ChatResponse`는 text | 순차 Step와 Tool Call/Result/continuation, tool-only 응답을 다루는 별도 계약 필요 |
| Tool·권한 | 기존 계정 실행 권한과 추론 동의가 존재 | 정적 Registry·Schema·Permission Gateway, 일회성 승인과 파일 hash/policy revision 결합. 계정 승인은 Tool 승인이 아님 |
| Host 파일 | 제품 Vault Gateway 없음 | 루트 핸들/no-follow/링크·동일성·크기 검사와 승인된 Diff 적용. overwrite 경쟁 검증은 별도 |
| VM | Backend/Manager/Session/slot 없음 | Vault가 Environment 소유, Manager가 Instance 제어, VM Step만 Session/slot 사용. 현재는 계약/Mock만 가능 |
| 브라우저·이미지 | 공통 Tool 실행 계약 없음 | 브라우저는 VM에서 공개 검색/읽기, 이미지 생성은 Provider에서 수행. 각각 별도 승인, 저장은 Host 승인 |
| Swift/CLI | `Runtime.swift`는 단발 JSON 자식 실행, 직접 자식 종료 | Agent 전용 양방향 NDJSON과 취소/승인/이벤트 필요. 기존 단발 API 유지; 자식 종료를 VM 종료 증거로 쓰지 않음 |
| 감사·복구 | 기존 Usage Ledger와 실행 기록 | 별도 Vault 감사/Host Journal. 본문·키·쿠키 저장 금지, 자동 Task 재개 금지 |

Provider/Router/Usage Ledger는 기반 버전을 그대로 유지한다. M3의 실제 Provider Tool 정규화와 usage 확장은 **별도 범위 승인 전 진행 불가**다. 당장은 Mock port로 계약만 검증하며 모든 Provider 지원이나 과금 정확성을 주장하지 않는다.

## M0 재사용 분류

아래 경로는 새 브랜치의 파일이 아니라 **출처 커밋 6199f49의 경로**다. `git show 6199f49:<경로>`로 확인한다. 이번에는 코드 복사를 하지 않았다.

| 분류 | 기존 코드·검증 | 재사용 내용 / 적용 조건 |
|---|---|---|
| 보안 로직 선별 이식 후보 | `scripts/agent-vm/workspace.py`: `root_fd`, `read_file`, `filename`, `digest` | 디렉터리 핸들 순회, O_NOFOLLOW, 단일 링크 일반 파일, 1MiB, 읽기 전후 identity 검사. flat-file 제한과 이름 기반 차단을 일반 Vault 보안으로 확대 해석 금지; 언어/플랫폼 이식 시 동등 테스트 필요 |
| 승인·반영 원칙 재사용 | 같은 파일의 `export_file`, `proposal`, `apply_new_file`, `create_file` | 입력/결과 hash와 별도 승인, 종료 확인, O_EXCL 신규 파일 생성. overwrite/delete/재귀 merge/부모 교체 경쟁을 해결한 구현 아님. bool 승인 인자는 제품 Permission Gateway로 교체 필요 |
| 상태 판정 후보 | `scripts/agent-vm/lifecycle.py`: `reconcile` | 기록 손상·run 불일치·framework 불일치 거부, 요청과 종료 증명 분리, STOP_UNCONFIRMED 차단. Vault/Instance/generation/Session ID 및 bounded journal 검증 추가 필요 |
| admission 원칙 재사용 | `scripts/agent-vm/manager_probe.py`: `begin_run`, `require_stopped` | flock 배타 진입, 실행 전 fsync, 미확인 시 apply/cleanup/new-execution 거절. 단일 진단 Registry를 제품으로 복사하지 않고 Host Registry의 전역·Vault별 제약으로 재설계 |
| 생명주기 패턴만 재사용 | `scripts/agent-vm/VMProbe.swift` | 독립 소유자, 중복 start/stop 억제, heartbeat/deadline, requestStop→forceStop→callback/stopped 확인. 실제 VM 구현은 M4까지 이식 금지; Manager 사망 종료 증명은 여전히 없음 |
| 복구 정책 후보 | `scripts/agent-vm/recovery.py`: `snapshot`, `boot_proof`, `integrity`, `audit`, `control` | boot 증거와 파일 무결성 구분, 채널 상실 차단, 최소 메타데이터. 단순 앱 재시작/시간 경과로 잠금 해제 금지. flat inventory·동일 사용자 IPC 한계, 실제 재부팅 E2E 미검증 |
| UI 패턴 후보 | `Sources/NidusNativeApp/VMRecovery.swift`, `tests/NidusNativeAppTests/VMRecoveryTests.swift` | 안전 종료 버튼 가용성, busy/실패 알림, 잠금 상태. Python 진단 bridge·경로 의존은 제거하고 v2 ID/서비스로 연결; 이번에는 이관 안 함 |
| 단위 검증 재사용 | `test_workspace.py`, `test_lifecycle.py`, `test_manager.py`, `test_recovery.py` (모두 `scripts/agent-vm/`) | stale 승인, symlink/hardlink/교체, 종료 판정, 손상 기록·재진입·boot/inventory 조건을 새 계약의 테스트 벡터로 이식 |
| 실측 fixture만 재사용 | `scripts/agent-sandbox/{descendant.c,lifecycle.c,network.c,lifecycle.mjs}`, `scripts/agent-vm/{guest-init.sh,probe.py,manager_probe.py,reliability_probe.py,recovery_probe.py}`, `tests/agent-sandbox-probe.test.mjs` | setsid/double-fork/Worker·Manager 사망, heartbeat/패킷 관측과 판정 테스트. 자체 만료와 유한 무활동을 종료 증거로 계산하지 않음 |
| 제품 채택 제외 | PGID만의 종료 전략, 진단용 assets/prepare/entitlement, 실행별 VM 소유와 진단 packaging | 실패 전략은 회귀 사례로만 유지. base image 배포·서명·업데이트·Session 격리의 제품 검증을 대신하지 않음 |

M0 전체는 미통과다. Manager 사망 후 UNCONFIRMED, 외부 네트워크·일반 파일 merge·실제 재부팅/UI E2E의 미검증을 유지한다. 기존 Node/Swift 회귀 PASS도 새 VM 안전 인증으로 승격하지 않는다.

## M1~M6 개발 순서와 완료 조건

기본 순서 M1 → M2 → M3 → M4 → M6. M5 감사/안전은 M1부터 각 단계에 포함하고 M6 최소 화면은 해당 API와 함께 연결한다. 아래는 후속 계획이며 이번 변경의 구현 완료 목록이 아니다.

| 단계 | 작업 범위와 의존성 | 완료 조건 / 보류 조건 |
|---|---|---|
| M1 Vault Foundation | descriptor, Host Registry, ID/경로 동일성, Environment 설정, Mock Instance·Session·잠금. 기존 M0는 legacy로 분리 | 등록/이동/복사 충돌/중첩·루트 거부, 손상 시 차단, 앱·CLI 동시 admission, 전역 1 Run/1 VM과 Vault 1 VM 모델 검증. 실제 부팅 없음 |
| M2 Registry·Permission·Host Gateway | M1 기반 정적 Tool 정의, Schema, 승인 만료/소비/취소, 제한 읽기와 별도 Diff 쓰기 | 위조 target/approved 거부, stale hash/정책 변경 차단, 승인 전 쓰기 0. overwrite/rename 경쟁 방어 미검증 기능은 비활성; Host Tool의 VM 부팅 0 |
| M3 Single Agent | M2 기반 Mock 추론/Tool port, 순차 Step loop, 제한·취소·결과 unknown. Provider/image 계약과 지원표 준비 | tool-only/ID 대응/continuation/중복 호출/외부 부작용 unknown 테스트. 실제 Adapter·Router·Ledger 수정은 별도 승인 전 보류; 이미지 생성·저장 승인 분리 |
| M4 Vault VM Backend | M1~M3, 독립 Manager/Session/slot, 지연 부팅·정리·유휴 종료, Shell/테스트/VM 실제 browser | 구현 착수는 후속 범위. image·network broker·서명 결정, setsid/double-fork·세션 오염·우회·충돌 실VM 검증. 불명확 시 quarantine, 슬롯 미반환, 안전 게이트 미충족이면 제품 비활성 |
| M5 Logging·Safety | 별도 ExecutionEvent/Host Journal, ID 연결, 차단·중단 UI 정보 | 중복 이벤트·감사 실패·Secret 비저장, 손상/미확인 시 부작용 차단, 자동 재개 금지. 기존 M0 결과는 불변 |
| M6 SwiftUI·CLI | 같은 Gateway를 쓰는 Vault/Step/Tool/Diff/승인/취소/이력, Agent NDJSON | 지연·중복 승인, 연결 상실, 앱 종료, 비대화형 승인 거절. Mock E2E/실VM/수동 UI/packaging/기존 기능 회귀를 구분 기록 |

M4 전 결정: guest image/toolchain 배포, session 격리와 cleanup 근거, 브라우저/검색엔진, network 강제 경계, OS·서명 범위. warm reuse 정리를 증명하지 못하면 전체 VM 종료 확인 후 다음 Instance를 시작한다. Phase 7 Memory/RAG/Task 재개와 Phase 8 Multi-Agent/스케줄러는 범위 밖이다.

## 첫 구현 단계: M1a (후속 작업)

첫 단위는 **VM을 실행하지 않는 Vault 등록·식별·저장 기반**이다.

- 제안 파일: `src/vault/types.ts`, `src/vault/registry.ts`, `tests/vault-registry.test.mjs`. 실제 파일은 이번에 만들지 않는다.
- `.nidus/vault.json`에는 schemaVersion/vaultId/displayName/createdAt/environmentId만 둔다. Host 전용 Registry에 canonical root·device/inode·등록 상태·revision을 보관한다. 활성 VM 핸들·Secret은 descriptor에 넣지 않는다.
- 최소 API: register/list/resolve/unregister와 이동·복제 충돌 판정. 해제는 Registry 등록만 제거하며 Vault 파일을 지우지 않는다. symlink 우회, 홈·파일시스템 루트, 중첩/중복 등록, 손상/미지원 schema를 거부한다.
- 등록 저장은 배타 잠금과 원자적 기록·복구 정책을 설계하고, 부분 기록/충돌 시 fail-closed. Host Registry 저장 경로와 `.nidus` 손상 처리 정책은 M1a 시작 시 명시적으로 확정한다. 기존 Usage DB migration은 없다.
- 테스트: 임시 fixture 등록/재로드/해제 원본 보존, 이동 후 동일성, 복사된 ID 충돌, 동시 등록, 경로 교체, 기록 손상. 실패 시 기존 descriptor/Registry를 덮어쓰지 않는지 확인한다.
- M1b에서 Environment/Mock Instance/Session 관계와 프로세스 간 admission을 추가한다. M1a만 끝내고 M1 전체 완료로 표시하지 않는다.
- 제외: 실제 VM·Shell·browser, Provider 호출/Tool adapter, Router/Usage 변경, M0 복구 코드 이식, 자동 Task 복원, develop 병합.

## 이번 작업 검증

문서/기록 동일성과 기준 코드 불변성, 기존 refs 보존, Markdown 상대 링크·JSON 파싱을 검사한다. 결과는 아래에 실제 실행 후 기록한다. M0 진단은 실행하지 않으며 새 evidence를 만들지 않는다.

| 검사 | 결과 |
|---|---|
| 이관 9개 파일과 6199f49 원본 바이트 비교 | PASS |
| M0 evidence JSON 6개 파싱 / 상대 파일 링크 | PASS |
| 기반 대비 src/Sources/scripts/tests/native/schemas 및 패키지 설정 불변 | PASS |
| 기존 feature/develop/main HEAD 보존 | PASS |
| `npm test` (TypeScript build 포함) | PASS: 169/169. 최초 sandbox 실행은 localhost listen EPERM으로 137 PASS/32 FAIL; 접근 허용 후 재실행 exit 0 |
| `swift test` | PASS: XCTest 42/42. 최초 sandbox 실행은 compiler cache 쓰기 제한으로 빌드 실패; 접근 허용 후 재실행 exit 0 |
| VM/M0 진단·실제 Provider API·Keychain 통합·앱 packaging·수동 UI | NOT RUN: 문서 전용 작업이며 기존 evidence 재생성/외부 호출을 하지 않음 |

위 테스트 수는 VM 이전 기반의 회귀 결과다. 기존 M0 feature의 174 Node/46 Swift와 범위가 다르며 기존 검증 기록을 대체하지 않는다. 실행 로그는 `/private/tmp/nidus-v2-{node,swift}-{test,retest}.log`에 두고 커밋하지 않는다. develop 병합은 요청대로 수행하지 않으며 승인 대기 절차를 시작하지 않는다. main과 원격 변경, push/PR 없음.
