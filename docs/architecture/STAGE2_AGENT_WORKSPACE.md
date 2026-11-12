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

### 구현 (2d)

- **형식**: git bundle. 들어갈 때는 Vault `HEAD`와 그 이력, 나올 때는 시작 커밋 이후의 커밋만 담는다(`src/workspace/sync.ts`).
- **통로**: 채널의 `workspace` 서비스(게스트 `127.0.0.1:3130`). 전송마다 호스트가 일회용 토큰을 만들어 제어 콘솔로 보내고, 게스트의 root 관리자(`scripts/vault-vm/workspace-sync.py`)가 그 토큰으로 연결한다. 세션 안의 프로그램은 제어 콘솔을 읽을 수 없다.
- **VM 안**: `/workspaces/<작업>`은 Vault의 캐시 디스크에 있어 VM을 다시 켜도 남는다(디스크가 없으면 메모리). 현재 작업의 작업 공간이 모든 Shell 세션의 `/workspace`이고 시작 디렉터리다. 브라우저는 읽기 전용으로 본다(`file:///workspace/...`). 작업 브랜치는 `nidus/<작업>`, 커밋 작성자는 `Nidus Worker`다. VM을 다시 켜면 `workspace-select`로 다시 연결한다.
- **권한**: 작업 공간 안의 git은 root가 아니라 세션 사용자(uid 1000)로, hook과 fsmonitor를 끄고 실행한다. 저장소 설정은 AI가 바꿀 수 있으므로 root가 그 코드를 실행하지 않게 한다.
- **나올 때**: 커밋하지 않은 변경은 마지막 커밋("작업 중 남은 변경")으로 묶는다. 호스트는 객체 검사(fsck)를 켜고 숨은 ref `refs/nidus/incoming/<작업>`로 받는다. 시작 커밋에서 이어지지 않는 이력은 거부한다. 사용자에게 커밋, 파일별 증감, diff(200KB까지)를 보여 주고, `.nidus/` 아래를 바꾸면 따로 경고한다(네트워크 허용 목록 등).
- **승인**: 사용자가 본 그 커밋일 때만 `nidus/<작업>` 브랜치를 만든다. 같은 이름의 브랜치가 있으면 덮어쓰지 않는다. 버리면 숨은 ref만 지운다. 모든 호스트 git 호출은 hook을 끈다.
- **한도**: 들어가는 bundle 256MiB, 나오는 bundle 128MiB. 캐시 디스크는 패키지 캐시, 브라우저 프로필과 함께 512MiB다.

## Agent 실행

Worker 한 명이 Task 하나를 수행하는 루프다. Manager와 Main, Task Board는 3단계에서 다룬다. 2단계에서는 사용자가 직접 지시하고 난이도를 고른다.

- 모델 호출은 `ModelGateway.send({ role: 'worker', difficulty })`로 한다. 모델 배정, 사용량 기록, 예산 경고가 그대로 적용된다.
- 도구는 Shell, 작업 공간 파일, 브라우저다. 모두 VM 안에서 실행되므로 승인이 없다.
- 실행 중 사건(모델 응답, 도구 호출과 결과, 승인 요청)은 앱으로 실시간 전달한다.
- 사용자는 언제든 중지할 수 있다. 중지하면 VM 안의 실행을 정리한다.
- 모델 호출 수, 도구 호출 수, 실행 시간에 상한을 둔다.

### 구현 (2e)

- **도구** (`src/workspace/tools.ts`): `shell`, `read_file`, `write_file`(30KB까지, 더 크면 이어 쓰기), `list_files`, `web_search`(한글 질의는 네이버, 그 밖은 Bing 기본; Google은 CAPTCHA가 잦아 지정할 때만), `browser_open`·`observe`·`read_more`·`click`·`type`·`press`·`select`·`scroll`·`back`·`switch_tab`·`ask_user`, `finish`. 브라우저 도구는 마지막 관찰의 스냅샷을 알아서 쓰므로 모델은 요소 번호만 준다. 요소가 바뀌었으면 오류와 함께 새 관찰을 돌려준다. 페이지 내용은 "신뢰할 수 없는 외부 데이터"로 표시하고, 시스템 프롬프트도 그 안의 지시를 따르지 말라고 한다.
- **루프** (`src/workspace/worker.ts`): 시간 상한은 없다(사용자가 중지한다). 모델 호출 200회, 도구 호출 600회는 폭주 방지용이다. 모델 호출 한 번은 5분까지 기다린다. 일시적인 Provider 오류는 다시 시도하고, 속도 제한은 같은 슬롯의 다른 후보로 바꾸거나 오래 기다린다([3단계 문서](STAGE3_AI_OFFICE.md) 참고).
- **대화 압축** (`src/workspace/compact.ts`, 2026-11-13): 모델 호출마다 대화 전체를 보내므로, 긴 작업은 단계마다 느리고 비싸진다(무료 엔드포인트는 2만 6천 토큰에 2분 가까이 걸렸다). 호출 전에 두 단계로 줄인다. (1) **비우기**: 최근 도구 결과(4개, 합쳐 4만 자 안, 마지막 하나는 항상)는 그대로 두고, 그보다 오래된 결과가 합쳐 3만 자를 넘으면 한꺼번에 "비움: 도구 이름, 길이, 첫 200자, 필요하면 다시 실행" 표시로 바꾼다. 오래된 큰 도구 입력(써 넣은 파일 내용 등 2천 자 넘는 값)도 길이만 남긴다. 모델 호출 없이 하고, 묶어서 하므로 그 사이에는 대화 앞부분이 그대로라 프롬프트 캐시가 유지된다. 도구 호출과 결과의 짝은 그대로 남는다. (2) **요약**: 비운 뒤에도 6만 자가 넘으면 같은 Worker 칸의 모델이 마지막 6개 메시지를 뺀 앞부분을 요약한다(지시와 완료 조건, 한 일과 확인한 것, 현재 상태, 경로·값·URL, 남은 문제, 다음 단계). 대화는 [지금까지 받은 모든 지시 + 요약] + 최근 턴이 된다. 요약이 실패해도 작업은 계속하고, 다섯 번 뒤에 다시 시도한다. 요약 뒤에는 새 턴이 쌓여야 다시 요약한다. 앱의 진행 기록에 "대화 압축"으로 나온다.
- **Shell 시간**: 명령 하나는 기본 120초, 최대 30분. 개발 서버처럼 계속 도는 명령은 백그라운드 서비스(`start_service`, `stop_service`, `service_log`, 최대 4개)로 띄우며, Shell·브라우저와 함께 돈다. 로그는 `/workspace/.git/nidus-logs/`. Shell 세션 한도는 메모리 1GiB, 프로세스 256.
- **승인 대기**: 네트워크 승인은 30분까지 기다린다. 승인을 기다리다 브라우저가 페이지를 포기했으면, 답을 받은 뒤 같은 페이지를 다시 연다. 페이지 이동은 3분까지 기다린다. 출력이 잘리면 이어서 하라고 한다. 이어서 지시하면 같은 대화와 작업 공간에서 계속한다.
- **Workspace Service** (`src/workspace/service.ts`): Vault 하나에 상주하는 엔진 프로세스. 앱과 줄 단위 JSON으로 통신한다(명령: `open`, `gitInit`, `start`, `stop`, `run`, `cancel`, `collect`, `approve`, `discard`, `takeOver`, `handBack`, `input`, `answer`, `allowAll`; 사건: `status`, `frame`, `control`, `tabs`, `approval`, `network`, `worker`, `review`, `log`). 작업을 시작하면 Vault를 VM으로 가져오고, 끝나면 결과를 자동으로 가져와 검토로 띄운다. 승인하거나 버리면 VM 안의 작업 공간을 지운다. 현재 작업은 `.nidus/local/workspace.json`에 남겨 앱을 다시 켜도 이어진다. VM 디스크는 Vault 폴더가 아니라 `~/Library/Application Support/Nidus/workspaces/<Vault ID>`에 둔다. 앱이 끝나면(입력이 닫히면) VM을 정상 종료한 뒤 끝난다.
- **상주에 맞춘 정리**: VM 출력의 수명 전체 상한(8MB)을 없앴다(초당 4MB와 줄 길이 상한은 유지). Shell 명령 길이를 48KB로 늘렸다(VM 헬퍼의 제어 줄 64KB 안). 게스트 개발 환경에 빠져 있던 BusyBox 명령(`base64`, `dirname`, `tail`, `seq`, `du` 등)을 부팅 때 모두 연결한다.
- **Provider 특이점**: NVIDIA의 모델은 한 턴에 도구 호출이 둘 이상일 때 추론 내용(`reasoning_content`)을 되돌려 보내면 HTTP 500을 낸다(deepseek-v4.1-flash, 2026-11-12 확인). 그 경우에만 추론 내용을 보내지 않는다.

## 앱

`Nidus.app`에 **작업** 탭을 추가한다.

- 지시 입력과 난이도 선택
- 실시간 로그 (모델의 말, 실행한 명령과 출력)
- 브라우저 화면과 개입 버튼
- 네트워크 승인 요청
- 결과 변경 내역과 Vault 반영 버튼

앱과 엔진 사이에는 계속 연결된 통로가 필요하다. 1단계의 "요청마다 프로세스 하나" 브리지는 설정 화면에 계속 쓰고, 작업 탭은 상주하는 Workspace Service와 줄 단위 JSON으로 양방향 통신한다.

### 구현 (2f)

- `Sources/Nidus/WorkspaceSession.swift`: 서비스 프로세스를 띄우고 사건을 화면 상태로 바꾼다. 앱을 끝낼 때 서비스가 VM을 정상 종료할 때까지(최대 30초) 기다린다.
- `Sources/Nidus/WorkView.swift`: 작업 탭. VM 시작·종료, 개입/돌려주기, 주소·탭(개입 중), 네트워크 승인 카드, 지시 입력과 난이도, "모든 사이트 허용", 진행 기록(모델의 말, 도구 호출과 결과, 비용), 결과 검토(커밋, 파일 증감, diff, `.nidus/` 경고, 승인/버리기). Vault가 Git 저장소가 아니거나 커밋이 없으면 만들 것인지 묻는다. 선택한 난이도에 Worker 모델이 없으면 알린다.
- `Sources/Nidus/BrowserScreen.swift`: 화면 프레임을 그리고, 개입 중에는 마우스(클릭, 드래그, 오른쪽 클릭, 스크롤)와 키보드를 보낸다. 입력기(한글)로 조합한 글자는 완성된 텍스트로, 일반 키는 키 입력으로, ⌘ 단축키는 Ctrl로, ⌘V는 Mac 클립보드 텍스트로 보낸다.
- `Nidus.app` 번들에 작업 공간 엔진, VM 이미지, VM 헬퍼, 볼륨 확인 헬퍼를 넣는다(약 630MB).

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
| 2d | 작업 공간 Git 동기화 | 구현, 실제 VM 검증 (아래) |
| 2e | Gateway 기반 Worker 루프와 Workspace Service | 구현, 실제 모델·VM으로 확인 (아래) |
| 2f | 앱의 작업 탭 | 구현, 앱에서 VM 실행·작업·승인 화면 확인 (아래). 사람의 직접 조작은 NOT RUN |

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

### 2d 검증 (2026-11-12)

`node scripts/vault-vm/workspace-sync-verify.mjs dist/vm-assets docs/evidence/stage2-workspace/sync-vm.json`. Vault는 스크립트가 만든 임시 저장소이고, AI의 작업은 스크립트가 보낸 Shell 명령이다. 결과: [sync-vm.json](../evidence/stage2-workspace/sync-vm.json).

| 항목 | 결과 |
|---|---|
| Vault의 커밋된 상태가 VM으로 감 | PASS |
| Shell이 `/workspace`에서 작업 브랜치로 시작, 커밋 안 한 변경과 무시된 파일(`.nidus/local`)은 없음, uid 1000 | PASS |
| AI가 고치고 커밋하고, 작업 공간의 스크립트를 실행하고, 일부는 커밋하지 않고 둠 | PASS |
| 브라우저가 작업 공간 파일을 읽기 전용으로 엶 | PASS |
| VM을 다시 켜도 작업 공간이 남고 다시 연결됨 | PASS |
| 결과가 숨은 ref로 돌아오고(커밋 안 한 변경 포함), 아직 브랜치가 아님 | PASS |
| 승인하면 `nidus/<작업>` 브랜치가 생기고, 사용자의 현재 브랜치와 작업 디렉터리는 그대로 | PASS |
| 바뀐 것이 없는 작업은 가져올 것이 없음 | PASS |
| 같은 작업 이름으로 다시 가져오기는 거부(작업을 덮어쓰지 않음) | PASS |
| VM 종료 확인 | STOP_CONFIRMED |

이 저장소(Nidus, `HEAD` 이력 1.7MB)를 가져오는 데 0.26초가 걸렸다. 2b·2c 검증도 바뀐 게스트에서 다시 모두 PASS였다. 테스트 페이지(`npm run workspace:playground`)에 작업 공간 패널을 붙였다.

### 2e·2f 확인 (2026-11-12)

- **실제 모델로 끝까지**: 임시 Vault에서 서비스에 "웹에서 Python 최신 안정 버전을 찾아 파일에 적고 커밋" 지시. `gemini-3.6-flash`(배정은 `gemini-3.5-flash`)가 Bing 검색 → python.org 열기 → 파일 작성 → 커밋 → `finish`(한국어 요약)까지 약 63초. 무료 등급 속도 제한(429)은 재시도로 넘겼다. 결과가 검토로 돌아오고 승인으로 브랜치가 생겼다. 승인은 스크립트가 했다.
- **NVIDIA**: `deepseek-v4.1-flash`는 첫 호출에 50~70초가 걸렸고, 두 번째 호출이 HTTP 500으로 실패했다. 원인(여러 도구 호출 + 추론 되돌려 보내기)을 따로 재현해 고쳤지만, 그 뒤에도 NVIDIA 무료 엔드포인트가 간헐적으로 500·시간 초과를 내서 끝까지 가는 확인은 하지 못했다.
- **앱**: 실제 앱 바이너리를 테스트 Vault로 띄워 작업 탭에서 VM 시작, 작업 실행, 브라우저 화면, 승인 카드, 진행 기록이 나오는 것을 화면 캡처로 확인했다(자동 실행용 임시 코드로 진행, 커밋에서 제외). 앱을 끝내면 서비스가 VM을 정상 종료하고 디스크가 `clean`으로 반납됐다. 번들 안의 서비스로 VM 시작·종료도 확인했다.
- **NOT RUN**: 사람이 앱에서 직접 개입·마우스·키보드·한글 입력하는 것. 같은 입력 경로는 테스트 페이지와 실제 VM 검증(2c)에서 확인했지만, 앱의 입력기 처리 코드는 사람이 써 봐야 한다.
- 단위 테스트 443개, Swift 테스트 59개 PASS. 2b·2c·2d 실제 VM 검증을 바뀐 게스트에서 다시 돌려 모두 PASS.

## 확인이 필요한 위험

- 처리량은 연결 하나에 약 7MB/s다. 게스트 중계기가 Python이고 콘솔 포트를 거치기 때문이다. 패키지 설치와 웹 탐색에는 충분하지만 큰 파일 내려받기는 느리다.
- Shell은 아직 명령마다 새 격리 세션(최대 120초, 메모리 512MiB)이다. 작업 공간은 2d에서 세션 사이에 공유되지만, 오래 도는 개발 서버는 아직 띄워 둘 수 없다. 2e에서 바꾼다.
- 승인을 기다리는 동안 Chromium이 먼저 포기할 수 있다(약 1분, "took too long to respond"). 승인 뒤 AI가 다시 열면 된다. 프록시의 승인 대기는 120초다.
- Provider마다 도구 사용 품질과 속도가 크게 다르다. NVIDIA 무료 엔드포인트는 느리고 간헐적으로 실패하며, Gemini 무료 등급은 속도 제한이 잦다.
- 작업 공간이 들어 있는 캐시 디스크가 512MiB라 큰 저장소나 `node_modules`가 많은 작업은 모자랄 수 있다.
- 화면 스트림은 간단한 페이지에서 15fps(상한)를 냈다. 이미지가 많은 페이지는 프레임이 커서(예시 페이지 정지 화면 약 37KB) egress와 채널 대역폭(약 7MB/s)을 나눠 쓴다.
- 상주 브라우저가 도는 동안에는 Chromium 샌드박스를 위해 VM 안의 사용자 네임스페이스가 열려 있다. Shell 세션도 그동안 네임스페이스를 만들 수 있다. "VM 안은 자유" 원칙 안의 일이지만, 이전 설계의 제한이 풀린 것이다.
- **CAPTCHA**: 같은 VM 브라우저로 검색했을 때 네이버, Bing, DuckDuckGo는 CAPTCHA 없이 결과가 나왔고 Google 검색만 CAPTCHA가 떴다(2026-11-11). Google은 headless Chromium의 자동화 표시를 보는 것으로 보인다. 자동화 표시를 감추는 변경은 탐지 우회에 해당해 하지 않았다. 대신 Worker의 검색 도구(2e)는 CAPTCHA가 덜 뜨는 검색엔진을 기본으로 쓰고, Google이 필요하면 사용자가 CAPTCHA를 푼다. 프로필이 유지되므로 사용자가 개입 중 Google에 로그인해 두면 덜 뜰 수 있다(미확인).
- Chromium 배경 통신은 확인된 것만 막았다. 버전이 바뀌면 새 통신이 생길 수 있고, 그때는 승인 요청으로 드러난다.
- 브라우저 조작 API는 호스트 코드로만 있다. 앱 화면(보기, 개입 버튼, 입력 전달)은 2e의 Workspace Service와 2f의 작업 탭에서 붙인다.
- UDP 기반 프로토콜(QUIC 등)은 프록시를 지나지 못한다. 브라우저는 TCP로 내려가도록 설정한다.
