# 격리 브라우저 DOM 조작 개선

기존 Chromium/CDP와 네트워크 broker, 작업별 VM 세션, Security Office 승인 경계를 유지한다. `browser_press`, `browser_select`, `browser_check`는 각각 명시적 승인을 요구한다. 선택·체크·입력은 조작 뒤 상태를 확인하고 실패 시 결과 미확인으로 종료한다. 클릭·키 입력은 전달만 확인하며 업무 성공을 보증하지 않는다. 임의 스크립트나 CDP 명령은 모델에 노출하지 않는다.

관찰은 label, aria-label/labelledby, placeholder, role, checked, readonly 및 option을 표시하고 입력·버튼을 링크보다 우선한다. snapshot과 DOM 객체를 검사하고 변경된 참조는 거부한다. 본문은 4,000자 단위로 `browser_read`와 nextOffset을 사용하며 최대 60,000자다. 동적 페이지는 네트워크와 DOM이 잠시 안정되는지 확인하고 안정되지 않으면 settled=false를 반환한다.

같은 출처의 보이는 iframe을 제한적으로 읽고 조작한다. 교차 출처 iframe, 다중 선택, 임의 탭 전환은 지원하지 않는다. 새 창은 차단하며 링크는 별도 `browser_open` 승인으로 열 수 있다. MutationObserver는 모든 시각적 변화나 숨겨진 내부 상태를 보증하지 않는다. 민감값은 일부 autocomplete 및 password 필드에서 가리며 사이트 스크립트의 입력 접근 자체를 막지는 않는다.

Atticus의 [atticus.py](https://github.com/SaarthurR/atticus-mac/blob/main/atticus.py)와 [ui/web.js](https://github.com/SaarthurR/atticus-mac/blob/main/ui/web.js)를 개념 참고했으며 코드는 복사하지 않았다. Atticus의 macOS 브라우저 직접 제어는 사용하지 않는다.

검증: Node 377 PASS, 실제 VM 합성 HTTPS fixture에서 한국어 검색·선택·체크·편집·키 입력·동적 변경·iframe·분할 읽기와 종료 PASS. 기존 승인 거부 시 요청 미전송 및 정리 PASS. 새 조작 승인 거부와 stale ID 거부는 Host fixture PASS. 실제 웹사이트·GUI 수동 조작은 NOT RUN. 상세 결과는 [DOM VM](../../evidence/browser-dom/dom-vm.json), [기존 VM 회귀](../../evidence/browser-dom/existing-vm.json)에 있다.
