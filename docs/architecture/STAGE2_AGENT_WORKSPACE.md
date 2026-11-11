# 2단계 설계 — Agent Workspace

상태: **설계 확정, 구현 중** (2026-11-11). 구현 상태는 문서 끝의 표를 따른다.

[CONCEPT.md](CONCEPT.md)의 Workshop에 해당한다. AI가 코드를 만들고 고치고 지우며, 브라우저로 검색하고 결과를 확인하는 공간이다. [1단계 Model Gateway](STAGE1_MODEL_GATEWAY.md) 위에서 동작한다.

## 원칙

**VM 안은 자유, VM 밖은 통제.**

사용자와 AI가 같은 컴퓨터를 쓴다. AI의 작업은 사용자의 작업과 충돌하지 않도록 격리하고, 사용자는 언제든 그 안을 보고 개입할 수 있어야 한다.

- VM 안에서 AI는 승인 없이 Shell을 실행하고, 파일을 고치고, 브라우저를 조작한다.
- 통제는 VM의 경계 세 곳에만 둔다.

| 경계 | 통제 |
|---|---|
| 네트워크 | VM에서 밖으로 나가는 연결은 호스트의 프록시 하나만 거친다. 처음 보는 도메인은 사용자가 승인해야 나간다 |
| 파일 | VM의 작업 결과는 사용자가 변경 내역을 보고 승인해야 Vault에 들어간다 |
| 비밀 | API 키는 VM에 넣지 않는다. 모델 호출은 호스트의 Gateway가 한다 |

이전 설계의 "요청마다 호스트가 중계하고 조작마다 승인"은 폐기한다. 그 설계는 일반 사이트가 제대로 열리지 않았고, VM 안의 개발 서버를 볼 수 없었고, 사용자가 화면을 조작할 수 없었다.

## 구성

```text
Nidus.app ──────────────── 작업 지시, 실시간 로그, 브라우저 화면과 조작, 승인
    │
Workspace Service (호스트, 상주)
    ├─ Agent Runner ─────── Worker 루프. 모델 호출은 Model Gateway로
    ├─ Egress Proxy ─────── VM의 유일한 외부 통로. 도메인 규칙과 승인
    ├─ Workspace Sync ───── Vault ↔ VM 작업 복사본
    └─ VM Manager ───────── 기존 Apple Virtualization VM 수명 관리
            │
Workspace VM (Vault당 하나)
    ├─ Shell, 개발 도구 ── 제한 없이 실행
    ├─ Chromium ─────────── AI가 조작하고, 화면은 앱으로 스트리밍
    └─ /workspace ───────── Vault의 작업 복사본
```

## 네트워크

VM에는 네트워크 장치를 달지 않는다. 대신 virtio 콘솔에 전용 포트(`nidus.egress`) 하나를 두고, 그 끝에 호스트의 Egress Proxy가 있다. VM 안에서는 브라우저와 Shell 도구가 모두 이 프록시를 쓰도록 설정한다. 게스트 설정을 우회해도 다른 통로가 없으므로, 통제는 게스트가 아니라 호스트에서 성립한다.

```text
VM 안의 프로그램 ─ HTTP(S)_PROXY=127.0.0.1:3128
  └ egress-relay.py (게스트, 127.0.0.1:3128)
      └ virtio 콘솔 포트 "nidus.egress" ─ 연결 여러 개를 한 줄로 다중화
          └ VM 헬퍼(Swift)가 상속받은 소켓
              └ EgressChannel (호스트) ─ 연결마다 스트림으로 분리
                  └ EgressProxy ─ 규칙, 승인, 차단
```

- 다중화 프레임은 `종류 1B | 스트림 4B | 길이 4B | 내용`이다. 스트림·방향마다 256KiB까지만 응답 없이 보낼 수 있고, 받는 쪽이 실제로 소비한 만큼 다시 허용한다. 한 연결이 느려도 다른 연결이 막히지 않게 하기 위해서다.
- 처음에는 virtio socket(vsock)을 쓰려 했으나, 게스트 커널에 vsock 모듈이 없고 고정해 둔 커널 패키지는 Alpine 저장소에서 내려가 구할 수 없었다. 콘솔 다중 포트는 커널에 내장돼 있어 이것으로 바꿨다.
- virtio 콘솔은 부하가 걸리면 "호스트 연결 끊김" 상태를 잠깐씩 보고한다(빈 읽기, 쓰기 실패). 중계기는 이를 끊김이 아닌 일시 상태로 보고 재시도하며, 30초 넘게 이어질 때만 종료한다. 종료하면 부팅 스크립트가 다시 띄우고, 호스트는 새 HELLO를 받으면 기존 스트림을 모두 정리한다.

- 프록시는 HTTPS 터널(CONNECT)과 일반 HTTP를 처리한다. HTTPS 내용은 열어 보지 않는다. WebSocket도 같은 터널로 지나간다.
- 판단 단위는 **사이트**(등록 가능한 도메인)다. `www.naver.com`, `search.naver.com`, `nlog.naver.com`은 모두 `naver.com` 하나로 묻는다. 페이지 하나가 같은 사이트의 여러 호스트에 연결하기 때문이다(네이버 첫 화면: 도메인 단위 18번 → 사이트 단위 2번). 사이트는 [Public Suffix List](https://publicsuffix.org)로 정한다: `co.kr`, `github.io` 같은 공용 접미사는 사이트가 아니므로 `alice.github.io` 승인이 `bob.github.io`를 열지 않는다. 목록은 `src/workspace/public-suffix-list.ts`에 넣어 두고 `scripts/update-public-suffix.mjs`로 갱신한다.
- HTTPS 안의 내용이 읽기인지 보내기인지는 구분할 수 없다.
- 규칙은 Vault의 `.nidus/network.json`에 둔다.

```json
{ "version": 1, "allow": ["github.com", "*.npmjs.org"], "deny": [], "macPorts": [5432] }
```

**localhost는 두 가지다.** VM 안에서 띄운 개발 서버(`localhost:3000`)는 VM 자신의 주소라서 프록시를 거치지 않고 바로 열린다(`NO_PROXY=localhost,127.0.0.1,::1,.localhost`). VM 안에서 **사용자의 Mac**에 있는 서비스는 `host.nidus:<포트>`로 부른다. 이 이름은 프록시로 가고, 프록시가 Mac의 `127.0.0.1:<포트>`로 연결한다. 프록시에 `localhost`나 `127.x`가 직접 들어와도 Mac으로 취급한다.

연결 요청이 오면 다음 순서로 판단한다.

1. **사용자 Mac의 localhost**(`localhost`, `127.0.0.0/8`)는 **포트 단위로** 승인받는다. Mac의 포트들은 서로 무관한 서비스(사용자의 개발 서버, DB, 다른 앱의 로컬 API)라서 도메인처럼 한 번에 열지 않는다. "항상 허용"한 포트는 `macPorts`에 저장한다. "모든 도메인 허용"은 Mac에 적용되지 않는다. 프록시 자신과 Nidus 서비스의 포트는 항상 거부한다.
2. 그 밖의 로컬 이름(`.local`, `.internal` 등)과 사설·링크 로컬 대역 IP는 항상 거부한다. 공유기, 프린터, 회사 내부 서버처럼 사용자 주변 네트워크에 VM이 닿지 못하게 한다.
3. `deny`에 있으면 거부한다.
4. `allow`에 있거나, 이번 작업에서 이미 허용했으면 연결한다.
5. 그 외에는 사이트 단위로 사용자에게 묻는다. 답은 **이번 작업만 허용**, **이 Vault에서 항상 허용**(규칙에 `naver.com`과 `*.naver.com`을 추가), **거부** 중 하나다. 거부도 그 사이트 전체에 적용된다. 답이 없으면 일정 시간 뒤 거부한다.

사용자는 작업 단위로 "이번 작업은 모든 도메인 허용"을 켤 수 있다. 검색처럼 여러 사이트를 돌아다니는 작업에서 승인 요청이 쏟아지는 것을 피하기 위한 것이며, 작업이 끝나면 꺼진다. 1번의 포트 승인과 2번의 차단은 이때도 유지된다.

DNS는 호스트가 조회하고, 확인한 주소로만 연결한다. 조회 결과에 사설 주소가 섞여 있으면 거부한다.

## 브라우저

VM 안의 Chromium을 쓴다. VM 안에서 띄운 개발 서버(`localhost`)를 바로 열 수 있어야 하기 때문이다. 필요해지면 브라우저만 VM 밖 별도 환경으로 옮길 수 있다.

- **AI의 조작**: 열기, 관찰, 클릭, 입력, 스크롤, 키 입력, 뒤로 가기, 탭 전환. 조작마다 묻는 승인은 없다. 기존의 DOM 관찰 코드는 재사용한다.
- **실시간 화면**: Chromium의 화면 스트림을 앱으로 보낸다. 정지 화면을 1초마다 찍던 방식을 대체한다.
- **사용자 개입**: 앱의 브라우저 화면에서 클릭하고 입력하면 그대로 VM 브라우저에 전달된다. 개입 상태는 둘이다.

| 상태 | AI | 사용자 |
|---|---|---|
| AI 조작 중 | 브라우저 도구 사용 | 화면 보기, **개입** 버튼 |
| 사용자 조작 중 | 브라우저 도구가 대기 | 직접 조작, **AI에게 돌려주기** 버튼 |

- 로그인, CAPTCHA처럼 AI가 넘지 못하는 화면은 작업을 실패로 끝내지 않고 사용자 개입을 요청한다.
- 브라우저 프로필(쿠키, 로그인 상태)은 Vault별 VM 디스크에 남는다.

개입 범위는 브라우저다. Shell은 실시간 출력 보기와 작업 중지로 다룬다.

### 구현 (2c)

```text
호스트                                          VM
WorkspaceBrowser ── CDP ── EgressChannel ═══ 콘솔 포트 ═══ 중계기 :3129 ── browser-bridge ── Chromium
 (src/workspace/browser.ts)  "browser" 서비스                                 (디버깅 파이프)
                                                                                    │ 웹 요청
Egress Proxy ◄═════════════ EgressChannel ═══ 콘솔 포트 ═══ 중계기 :3128 ◄──────────┘
```

- **조작은 호스트가 한다.** VM 안에는 Chromium과, 그 디버깅 파이프를 채널에 잇는 다리(`scripts/vault-vm/browser-bridge.mjs`)만 둔다. 2b의 다중화 채널에 서비스 이름을 붙여(OPEN 프레임 내용, 비면 egress) 브라우저 연결을 구분한다. VM에서 오는 CDP 메시지는 신뢰하지 않는다: 크기 상한 16MiB, 형식이 틀리면 연결을 끊는다.
- **상주한다.** 브라우저는 Shell 세션과 동시에 돈다(`/run/busy` 대신 `/run/browser`). 세션 한도는 최대 24시간, 메모리 1.5GiB, CPU 2개다.
- **화면**: `Page.startScreencast`(JPEG, 1280×800). 프레임 확인 응답을 늦춰 초당 프레임을 제한한다(기본 15).
- **AI 조작**: 관찰, 읽기, 열기, 뒤로/앞으로/새로고침, 스크롤, 대기, 클릭, 입력, 키, 선택, 체크, 새 탭/탭 전환/탭 닫기, 사용자에게 요청. 요소는 기존과 같이 관찰 시점의 스냅샷 ID로 지정한다. 열 수 있는 주소는 `http`, `https`, `file`, `about:blank`다.
- **사용자 개입**: `takeOver()`로 사용자 조작 상태가 되면 AI 조작은 대기하고, 사용자의 마우스·휠·키·텍스트(한글 등 조합 입력)·주소 이동·탭 전환이 그대로 전달된다. `handBack()`으로 돌려준다. AI 조작 중에는 사용자 입력을 받지 않는다.
- **CAPTCHA**: 관찰에서 CAPTCHA가 보이면 실패 대신 사용자 조작 상태로 바꾸고(`reason: captcha`), 돌려받으면 다시 관찰한다. AI는 `askUser`로 직접 요청할 수도 있다(로그인 등).
- **프로필**: Vault의 캐시 디스크가 있으면 그 안(`/persistent/browser`)에 둔다. 브라우저는 `Browser.close`로 정상 종료해 쿠키를 디스크에 쓴 뒤 끝난다.
- **Chromium 자체 통신 차단**: 업데이트 확인, 맞춤법 사전, 기본 검색엔진 미리 연결 같은 Chromium의 배경 통신은 사용자가 열지 않은 사이트의 승인 요청으로 나타난다. 실행 옵션, 관리 정책(`/etc/chromium/policies/managed`), 프록시 우회 목록(우회하면 VM 안에서 바로 실패)으로 막았다. 승인 요청에는 페이지가 실제로 연 주소만 남는다.
- **글꼴**: 게스트에 Open Sans만 있어 한글·일본어·중국어가 빈칸으로 그려졌다. Noto Sans CJK(Regular, Bold, OFL)를 넣었다. 고정 주소와 해시는 `scripts/vault-vm/fonts.lock.json`, 내려받기는 `fetch-fonts.py`다.

## 작업 공간

AI는 Vault 원본이 아니라 VM 안의 복사본에서 작업한다.

- **들어갈 때**: Vault의 Git 저장소에서 커밋된 상태를 VM의 `/workspace`로 가져간다. `.nidus/local/`과 Git이 무시하는 파일은 가져가지 않는다. 사용자가 커밋하지 않은 변경은 포함되지 않는다.
- **작업 중**: AI는 `/workspace`에서 자유롭게 파일을 만들고 고치고 지우며, 작업 브랜치에 커밋한다.
- **나올 때**: 작업 브랜치의 변경 내역을 호스트로 가져와 사용자에게 보여 준다. 승인하면 Vault 저장소에 **브랜치로** 들어간다(`nidus/<작업 이름>`). 사용자의 작업 디렉터리와 현재 브랜치는 건드리지 않는다. 병합은 사용자가 한다.

Vault에 Git이 필수인 이유(CONCEPT의 Security Office)가 여기서 쓰인다. AI의 변경은 항상 브랜치 단위로 구분되고 되돌릴 수 있다.

## Agent 실행

Worker 한 명이 Task 하나를 수행하는 루프다. Manager와 Main, Task Board는 3단계에서 다룬다. 2단계에서는 사용자가 직접 지시하고 난이도를 고른다.

- 모델 호출은 `ModelGateway.send({ role: 'worker', difficulty })`로 한다. 모델 배정, 사용량 기록, 예산 경고가 그대로 적용된다.
- 도구는 Shell, 작업 공간 파일, 브라우저다. 모두 VM 안에서 실행되므로 승인이 없다.
- 실행 중 사건(모델 응답, 도구 호출과 결과, 승인 요청)은 앱으로 실시간 전달한다.
- 사용자는 언제든 중지할 수 있다. 중지하면 VM 안의 실행을 정리한다.
- 모델 호출 수, 도구 호출 수, 실행 시간에 상한을 둔다.

## 앱

`Nidus.app`에 **작업** 탭을 추가한다.

- 지시 입력과 난이도 선택
- 실시간 로그 (모델의 말, 실행한 명령과 출력)
- 브라우저 화면과 개입 버튼
- 네트워크 승인 요청
- 결과 변경 내역과 Vault 반영 버튼

앱과 엔진 사이에는 계속 연결된 통로가 필요하다. 1단계의 "요청마다 프로세스 하나" 브리지는 설정 화면에 계속 쓰고, 작업 탭은 상주하는 Workspace Service와 줄 단위 JSON으로 양방향 통신한다.

## 기존 코드

| 대상 | 처리 |
|---|---|
| VM 수명 관리, 저널, 장애 복구 (`native/vault-vm.swift`, `src/vault/vm-*`, `shared-vm`) | 재사용. 소켓 장치를 추가한다 |
| 게스트 이미지 빌드 (`scripts/vault-vm/`) | 재사용. 프록시 중계기와 브라우저 설정을 추가한다 |
| DOM 관찰과 조작 (`scripts/vault-vm/browser-*.mjs`) | 재사용. 승인 결합을 걷어낸다 |
| 주소 판정 (`src/vault/network-policy.ts`의 `publicIPv4`) | 재사용 |
| 요청별 중계 (`src/vault/live-network.ts`), 조작별 승인, CAPTCHA 시 실패 | 폐기 |
| 승인된 파일 복사와 diff 반영 (`src/vault/workspace.ts`) | Git 브랜치 방식으로 대체 |
| 일회성 Agent 실행기 (`src/agent/runtime.ts`) | Gateway 기반 Worker 루프로 대체 |
| Vault 등록부 (`src/vault/registry.ts`) | `.nidus/` 기준으로 정리. 2단계 범위에서는 VM 디스크 위치 결정에만 쓴다 |

## 구현 순서와 상태

| 단계 | 내용 | 상태 |
|---|---|---|
| 2a | Egress Proxy: 도메인 규칙, 승인, Mac localhost 포트 승인, 사설 주소 차단 | 구현, 단위 테스트 |
| 2b | VM과 프록시를 콘솔 포트로 연결, 온라인 Shell. VM 안 루프백은 프록시 제외 | 구현, 실제 VM 검증 (아래) |
| 2c | 브라우저 자유 조작, 화면 스트리밍, 사용자 개입 | 구현, 실제 VM 검증 (아래). 앱 화면은 2f |
| 2d | 작업 공간 Git 동기화 | 예정 |
| 2e | Gateway 기반 Worker 루프와 Workspace Service | 예정 |
| 2f | 앱의 작업 탭 | 예정 |

### 2b 검증 (2026-11-11)

`node scripts/vault-vm/egress-verify.mjs dist/vm-assets <결과.json>`으로 실제 VM을 부팅해 확인했다. 승인은 사람이 아니라 스크립트에 고정한 시험 정책이 답했다. 결과: [egress-vm.json](../evidence/stage2-egress/egress-vm.json).

| 항목 | 결과 |
|---|---|
| Shell 세션에 프록시 설정이 들어감 | PASS |
| 처음 보는 도메인을 승인 후 HTTPS 접속, 같은 작업에서 재접속 시 다시 묻지 않음 | PASS |
| 거부한 도메인은 403 | PASS |
| 사설 주소는 묻지 않고 차단 | PASS |
| VM 안 개발 서버(`localhost:8765`)는 프록시를 거치지 않음 | PASS |
| Mac 서비스(`host.nidus:<포트>`)는 포트 승인 후 연결 | PASS |
| PyPI에서 `pip download`, npm 레지스트리 조회 | PASS |
| 20MB 다운로드 (약 7MB/s) | PASS |
| VM 종료 확인 | STOP_CONFIRMED |

원본 빌드 재료(고정 Alpine 이미지와 패키지)가 남아 있지 않아, 기존 `dist/vm-assets`에 층을 덧붙여 만들었다(당시 `egress-layer.py`, 지금은 `scripts/vault-vm/workspace-layer.py`). 재료가 있으면 `prepare.py`가 같은 파일을 넣어 처음부터 만든다. 처음부터 다시 만드는 경로는 NOT RUN이다.

**아직 제품에 연결하지 않았다.** 앱과 VM 서비스는 Egress Proxy 없이 VM을 띄우므로 지금도 오프라인으로 동작한다. 승인 요청을 앱에 띄우는 일은 2e·2f에서 한다.

### 2c 검증 (2026-11-11)

`node scripts/vault-vm/workspace-browser-verify.mjs dist/vm-assets docs/evidence/stage2-browser`로 실제 VM과 게스트 Chromium을 띄워 확인했다. 네트워크 승인은 고정 시험 정책이, 사용자 입력은 스크립트가 앱과 같은 방식으로 보냈다. 결과: [browser-vm.json](../evidence/stage2-browser/browser-vm.json), 화면 [example.jpg](../evidence/stage2-browser/example.jpg), [user-input.jpg](../evidence/stage2-browser/user-input.jpg).

| 항목 | 결과 |
|---|---|
| 브라우저가 Shell과 별도로 뜨고 채널로 연결됨 (약 1.3초) | PASS |
| Mac 페이지(`host.nidus`)를 포트 승인 후 열기 | PASS |
| AI가 폼에 입력하고 Enter로 제출 | PASS |
| 새 탭으로 열리는 링크는 앞으로 오고, 닫으면 돌아옴 | PASS |
| 공개 사이트를 프록시 승인 후 열기 | PASS |
| 거부한 사이트는 오류 페이지로 관찰됨 (중단 없음) | PASS |
| VM 안 개발 서버(`localhost:8765`)는 프록시 없이 열림 (Shell 세션과 동시 실행) | PASS |
| 움직이는 페이지의 화면 스트림: 약 15fps(상한), 프레임당 약 7KB, 1280×800 | PASS |
| 사용자 개입: AI 조작 중 입력 거부, 개입 중 AI 대기, 클릭·키 입력·한글 입력 반영, 돌려준 뒤 AI 계속 | PASS |
| 프로필(쿠키)이 브라우저 재시작 후 유지 | PASS |
| 프로필이 같은 디스크로 VM을 다시 띄운 뒤 유지 | PASS |
| 승인 요청은 실제로 연 주소 셋뿐 (Chromium 배경 통신 없음) | PASS |
| VM 종료 확인 | STOP_CONFIRMED |

2b 검증(`egress-verify.mjs`)도 바뀐 게스트에서 다시 돌려 10개 모두 PASS였다.

**직접 써 보기**: 앱 작업 탭(2f) 전까지는 `npm run workspace:playground`로 확인한다. 실제 VM을 띄우고 이 Mac의 `127.0.0.1`에 테스트 페이지를 연다(주소의 토큰 필요). 화면 보기, 개입과 돌려주기, 마우스·키보드·한글 입력, 네트워크 승인, AI 조작 흉내, VM Shell 명령을 쓸 수 있다. 페이지 포트는 프록시 예약 포트라 VM 안에서 닿지 않는다. "항상 허용"한 사이트와 브라우저 프로필 디스크는 `dist/playground`에 남는다.

## 확인이 필요한 위험

- 처리량은 연결 하나에 약 7MB/s다. 게스트 중계기가 Python이고 콘솔 포트를 거치기 때문이다. 패키지 설치와 웹 탐색에는 충분하지만 큰 파일 내려받기는 느리다.
- Shell은 아직 기존 구조(명령마다 새 격리 세션, 최대 120초, 메모리 512MiB)다. 오래 도는 개발 서버와 공유 작업 공간은 2d·2e에서 바꾼다.
- 화면 스트림은 간단한 페이지에서 15fps(상한)를 냈다. 이미지가 많은 페이지는 프레임이 커서(예시 페이지 정지 화면 약 37KB) egress와 채널 대역폭(약 7MB/s)을 나눠 쓴다.
- 상주 브라우저가 도는 동안에는 Chromium 샌드박스를 위해 VM 안의 사용자 네임스페이스가 열려 있다. Shell 세션도 그동안 네임스페이스를 만들 수 있다. "VM 안은 자유" 원칙 안의 일이지만, 이전 설계의 제한이 풀린 것이다.
- **CAPTCHA**: 같은 VM 브라우저로 검색했을 때 네이버, Bing, DuckDuckGo는 CAPTCHA 없이 결과가 나왔고 Google 검색만 CAPTCHA가 떴다(2026-11-11). Google은 headless Chromium의 자동화 표시를 보는 것으로 보인다. 자동화 표시를 감추는 변경은 탐지 우회에 해당해 하지 않았다. 대신 Worker의 검색 도구(2e)는 CAPTCHA가 덜 뜨는 검색엔진을 기본으로 쓰고, Google이 필요하면 사용자가 CAPTCHA를 푼다. 프로필이 유지되므로 사용자가 개입 중 Google에 로그인해 두면 덜 뜰 수 있다(미확인).
- Chromium 배경 통신은 확인된 것만 막았다. 버전이 바뀌면 새 통신이 생길 수 있고, 그때는 승인 요청으로 드러난다.
- 브라우저 조작 API는 호스트 코드로만 있다. 앱 화면(보기, 개입 버튼, 입력 전달)은 2e의 Workspace Service와 2f의 작업 탭에서 붙인다.
- UDP 기반 프로토콜(QUIC 등)은 프록시를 지나지 못한다. 브라우저는 TCP로 내려가도록 설정한다.
