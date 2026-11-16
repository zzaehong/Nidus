# Google 기본 검색과 브라우저 실시간 보기

대화형 브라우저 시작 페이지와 읽기 전용 `browser_search`의 기본 검색 엔진을 Google로 변경했다. 직접 검색은 `https://www.google.com/search?q=...&hl=ko`를 사용한다. Google 결과의 `/url?q=` 및 `/url?url=` 링크는 공개 HTTPS 검증 후 실제 목적지로 반환한다. 이전 Bing 링크 해석은 과거 결과 호환을 위해 유지한다. Google 검색창의 textarea 입력도 지원한다.

## 실시간 화면

Agent 작업 UI에 보기 전용 화면 영역을 추가했다. 작업이 브라우저 세션을 소유하는 동안 약 1초 간격으로 Chromium viewport를 JPEG로 캡처한다. 해상도는 800×563 정도이며, 이동·입력·스크롤 결과를 표시한다. 네트워크 대기 및 사용자 승인 대기와 별도 경로를 사용한다. VM 부하나 페이지 상태에 따라 갱신이 늦을 수 있으며 마지막 수신 시각을 표시한다. 동영상 수준의 프레임 속도를 제공하지 않는다.

경로는 guest CDP `Page.captureScreenshot` → 기존 VM 직렬 채널 → LiveBrowser의 별도 frame 응답 → 인증된 로컬 `live-frame` 요청 → Agent Host/UI 채널 → SwiftUI 이미지다. 이 요청은 모델 도구가 아니며 모델 입력·대화 기록에 이미지를 추가하지 않는다. 제품은 프레임을 디스크에 저장하지 않고 최신 화면만 UI 메모리에 유지한다. 종료·오류·화면 수신 실패 시 화면을 제거한다. 화면에서 직접 조작하는 기능은 추가하지 않았다. 이전 직접 URL 조회는 실시간 보기 대상이 아니다.

Vault/task 소유권을 확인하며 동시 캡처는 하나로 제한한다. 프레임은 base64 90,000자 이내로 제한하고 JPEG signature를 확인한다. 화면 트래픽 예산을 일반 도구 출력 예산과 분리해 지속 갱신이 기존 4/8 MiB 한도를 소진하지 않도록 했다. 기존 클릭·입력·민감 전송 승인 및 오프라인 Shell 정책은 유지한다.

## 검증

- PASS: Node 전체 351개, Swift 전체 55개.
- PASS: 실제 VM 합성 페이지의 JPEG 수신 및 클릭 후 화면 변경, 기존 입력/제출 승인 경계와 정리.
- PASS: 실제 Google 시작 페이지, 로컬 서비스·게이트웨이를 통한 화면 수신, 검색어 textarea 입력 후 화면 변경, 세션 종료 후 null 반환.
- Swift 테스트: 프레임을 이벤트 로그에 넣지 않음, 완료 시 이미지 제거, 잘못된 이미지 거부.
- NOT RUN: 실제 NIM 모델 전체 탐색, 앱 GUI 수동 조작, 15분 연속 화면 갱신 부하 테스트.

Evidence는 `docs/evidence/m4-browser-screen/`에 있다. 실제 캡처 이미지는 로컬 임시 경로에서 확인했으며 저장소에는 커밋하지 않았다. CDP 참고: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot
