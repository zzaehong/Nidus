# M4 대화형 브라우저

기존 `feature/vault-runtime-v2`의 읽기 전용 브라우저 위에 추가한 기능이다. 사용자가 일반 사이트의 스크립트·필요 리소스를 허용하고 로그인·구매·제출은 별도 승인하도록 선택한 범위다.

## 동작

모델은 `browser_start`로 시작한 뒤 `browser_observe`, `browser_type`, `browser_click`, `browser_scroll`, `browser_back`, `browser_close`를 호출한다. 시작 페이지는 Host가 정한 Bing이다. 모델이 단계마다 URL을 만들거나 HTML 전체를 받을 필요가 없다. 같은 Chromium의 DOM·임시 쿠키·페이지 상태가 작업 종료까지 유지된다. 관찰 결과는 텍스트와 보이는 요소의 이름·ID·위치를 담는다. 텍스트 도구 호출 모델도 사용할 수 있고 비전 모델은 필수가 아니다.

현재 관찰의 snapshotId와 targetId만 조작할 수 있다. 게스트는 실제 DOM 객체 참조와 이름·링크·위치·hit-test를 다시 확인한다. 입력은 Chromium 키보드 이벤트, 클릭은 마우스 이벤트를 사용한다. 모델이 임의 JavaScript나 CDP 명령을 실행하는 도구는 제공하지 않는다.

## 네트워크 및 승인

VM에 NIC를 추가하지 않았다. Chromium의 요청을 CDP Fetch로 중단하고 Host 브로커가 요청마다 공개 HTTPS/443 주소·DNS·연결 상대를 확인한 뒤 응답을 돌려준다. HTML뿐 아니라 JavaScript·CSS·이미지 등도 이 경로를 사용한다. Shell은 계속 오프라인이다. Host의 인증키·쿠키 프로필을 브라우저에 전달하지 않는다.

세션 시작 승인과 클릭·입력·뒤로 가기 승인이 있으며, 비 GET/HEAD/OPTIONS 요청과 Authorization 요청은 실제 네트워크 전송 전에 별도 승인한다. 사용자 동작이 대기 중이지 않은 민감 요청은 거부한다. 승인은 단일 요청에 결합되고 60초 후 만료한다. 입력 승인은 텍스트를 표시하며 입력 중 사이트 스크립트가 읽을 수 있음을 알린다. GET도 상태를 바꾸는 사이트가 있으므로 클릭 승인을 생략하지 않는다. 로그인/구매를 의미적으로 완벽하게 판별한다고 주장하지 않는다.

분석·telemetry POST도 승인 대상이므로 일반 사이트에서 승인 요청이 많을 수 있다. 거부된 요청 수를 관찰 및 UI에 표시한다. 세션 최대 15분, 요청 300개, 응답 합계 16 MiB, 리소스 2 MiB, 요청 본문 64 KiB다. 페이지 내용은 신뢰할 수 없는 데이터다.

## 격리와 수명

한 작업이 VM 브라우저 슬롯을 소유하며 다른 작업/Shell과 동시 사용하지 않는다. Chromium renderer의 seccomp와 no-new-privileges를 확인한다. 작업 종료·취소 시 게스트 cgroup 정리 확인을 기다린다. 정리 실패는 성공 대신 UNCONFIRMED로 보고한다. 브라우저 프로필은 영속 Vault 캐시와 분리된다.

게스트 manifest의 `browserInteractiveVersion: 1`이 있어야 Agent에 새 도구가 노출된다. UI의 직접 URL/검색 테스트는 이전 읽기 전용 경로로 유지한다. 대화형 기능은 Agent 작업에서 사용한다.

## 검증 및 제한

- PASS: Node 350개, Swift 54개 (최종 재실행 로그 별도 기록).
- PASS: 실제 Apple VM/Chromium의 합성 HTTPS 응답 fixture — 외부 JS, 입력 유지, 클릭, GET 검색, stale ID 거부, 사설 주소 거부, POST 거부 시 미전송, 승인 시 1회 전송, 정리/VM 종료.
- PASS: 실제 공개 HTTPS 페이지를 Host 브로커로 받아 VM에서 렌더링. 최초 테스트는 제목 문자열을 본문에서 찾는 잘못된 assertion으로 FAIL; 해당 실패 evidence를 보존하고 제목 검사로 수정해 PASS.
- PASS: 실제 로컬 서비스→게이트웨이→VM→Bing의 세션 승인·관찰·검색어 입력·정리. 분석 POST는 테스트 승인 채널에서 거부했다.
- PASS: 새 게스트 이미지에서 기존 오프라인 작업공간 실행·격리·VM 재사용 회귀 검증.
- NOT RUN: 실제 NVIDIA NIM 모델의 전체 탐색, 실제 계정 로그인·구매, GUI 수동 클릭 검증.

단일 페이지의 보이는 DOM 요소를 우선 지원한다. 새 탭·복잡한 iframe·canvas·드래그·파일 업로드·다운로드·WebSocket·QUIC는 지원 범위 밖이다. 모든 사이트와 호환되는 일반 데스크톱 브라우저라고 주장하지 않는다. 제한된 응답 크기와 요청 예산, 승인 정책 때문에 일부 사이트는 부분 로드될 수 있다. 모델/VM 왕복 자체는 계속 필요하지만 URL/HTML 교환 대신 사용자 동작과 간결한 관찰 결과를 교환한다.

Evidence: `docs/evidence/m4-interactive/`. 재현 fixture: `node scripts/vault-vm/live-browser-verify.mjs <verified-assets-directory> <new-evidence-path>`.
