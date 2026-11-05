# 브라우저 신뢰성 P0–P2

## P0: CAPTCHA 감지와 안전한 중단

Host가 알려진 Google `/sorry/` 주소, 다국어 확인 문구, 보이는 challenge DOM 신호 등을 검사한다. 페이지 스크립트 존재만으로 CAPTCHA를 판정하지 않는다. 감지하면 도구 코드와 작업 webStatus를 `captcha_required`로 설정하고 작업은 FAILED로 종료한다. 동일 배치의 나머지 도구와 후속 모델 호출을 실행하지 않으며, 브라우저는 finally에서 정리한다. 살아 있는 LiveBrowser 객체도 challenge 감지 이후의 동작을 거부한다. CAPTCHA 본문을 성공한 검색 결과로 반환하지 않는다.

UI는 일반 브라우저에서 직접 확인하거나 공식 문서 URL/문서 내용을 제공해 새 작업을 시작하도록 안내한다. CAPTCHA 자동 풀이·우회·자동 재검색·자동 재개는 없다. 현재 VM 안에서 사용자가 직접 해결한 뒤 재개하는 기능은 구현하지 않았다.

판정은 휴리스틱이다. 알려지지 않은 challenge는 놓칠 수 있고 확인 문구를 포함한 일부 페이지에서 보수적으로 중단할 수 있다. CAPTCHA를 설명하는 일반 문서의 단순 키워드 언급은 중단하지 않는 회귀 테스트를 둔다. 시각적으로만 표시된 모든 challenge를 보장하지 않는다.

## P1: Unicode 및 언어

입력은 Chromium Input.insertText를 사용하고 검색 query의 Unicode를 유지한다. URL 인코딩은 UTF-8 percent encoding을 사용하며 잘못된 surrogate 입력을 거부한다. 기본 browser locale은 ko-KR이며 언어 목록은 ko-KR, ko, en-US, en, ja, zh-CN이다. 언어 설정이 해당 언어 검색 결과 제공을 보장하지는 않는다.

기존 Google 읽기 전용 검색에 남아 있던 Bing 전용 DOM 선택자를 수정했다. Google `#search`/`#rso`와 이전 Bing 구조를 읽고 본문 fallback을 사용한다. challenge 판정용 본문을 검색 결과 본문과 별도로 검사한다. 어휘 관련성 검사는 NFC 및 Intl.Segmenter를 적용하고 CJK 부분 문자열도 확인한다. 이는 의미상 관련성이나 사실 검증이 아니며 모든 조사·어미·동의어를 해결하지 않는다.

한국어·영어·일본어·중국어 각각 입력→폼 제출→검색 URL decode→본문/링크 파싱을 실제 VM의 합성 페이지로 검증했다. `&`와 `+`가 query와 혼동되지 않는 것도 확인했다. 읽기 전용 Google DOM fixture도 네 언어로 별도 검증했다. 최초 언어 목록 검증 실패를 보존했으며 CDP acceptLanguage에 quality 문자열 대신 언어 목록을 넘기도록 수정한 후 통과했다.

## P2: 공식 URL 직접 접근과 실패 분류

`browser_open({url})`은 브라우저가 없으면 지정한 공개 HTTPS URL에서 바로 시작한다. Google을 먼저 방문하지 않는다. 기존 세션에서는 해당 주소를 별도 승인받아 연다. 승인 화면에 정확한 목적지를 표시하고 같은 네트워크 경계를 적용한다. 모델 지침은 사용자가 제공한 공식 문서 URL을 우선하도록 한다. URL이 로드됐다는 이유만으로 ‘공식’이라고 인증하지 않는다.

검색엔진이 해당 query에 결과가 없다고 명시하면 `search_no_results`/`no_results`, 접근 차단·오류는 `search_failed`, CAPTCHA는 `captcha_required`로 구분한다. 결과 없음 문구는 Google/Bing 검색 URL에서만 판정한다. 검색 실패나 한 query의 결과 없음은 실제 정보 부재가 아니며, UI 및 최종 응답에서 이를 명시한다. 기존 HTTP 오류 코드와 어휘 불일치 코드도 보존한다.

## 검증

- PASS: Node 367개, Swift 55개, 앱 빌드 및 게스트 hash.
- PASS: 실제 VM의 네 언어 입력·인코딩·browser language·본문/링크 결과.
- PASS: 실제 VM 합성 CAPTCHA에서 감지 및 후속 동작 거부; Agent fixture에서 한 번의 model/tool 호출 후 종료 및 cleanup.
- PASS: 실제 공개 `https://www.python.org/doc/`를 browser_open으로 직접 조회, 검색엔진 방문 없이 세션 승인 1회, 종료 확인.
- NOT RUN: 실제 NVIDIA NIM 전체 작업, 네 언어 각각의 실시간 Google 검색, 모든 CAPTCHA 제품/형식, GUI 수동 확인.

Evidence: `docs/evidence/m4-browser-reliability/`. 실제 VM 재현: `node scripts/vault-vm/reliability-verify.mjs <verified-assets> <new-output.json>`.
