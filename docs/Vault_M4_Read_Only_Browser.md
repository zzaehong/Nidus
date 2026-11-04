# M4 제한적 인터넷과 읽기 전용 브라우저

2026-11-04. 공개 HTTPS 페이지 읽기와 Bing HTML 검색을 승인 UI·Agent 도구·실제 VM에 연결했다. 대화형 웹사이트 조작이나 일반 인터넷 연결을 구현한 것으로 해석하지 않는다. 기존 오프라인 Browser 실패 기록과 M4 Evidence는 보존한다.

## 사용 범위

- `browser_navigate`: 표시된 공개 HTTPS 주소에 대한 GET 1회 승인 후 VM Chromium에서 제목·본문·링크를 읽는다.
- `browser_search`: 검색어를 Bing에 보내는 GET 1회를 승인받는다. 초기 검색 로케일은 `en`, 지역은 `US`다. 결과 링크를 여는 작업은 별도 승인이다.
- `browser_read_page`: 같은 Vault·현재 작업에서 이미 읽은 pageId만 메모리에서 조회한다. 네트워크 요청은 없고 작업 종료 시 폐기한다.
- 직접 브라우저 실행은 Provider를 호출하지 않는다. Agent에서 사용하면 반환된 페이지 내용이 선택한 Provider에 전달된다.
- 웹 필수 작업은 실제 성공한 브라우저 결과가 없으면 `web_not_used`로 실패한다. 모델의 자연어 주장은 조회 성공 근거가 아니다.

로그인, 쿠키 전달, 폼 제출, JavaScript, 다운로드, 자동 리디렉션, 추가 리소스 요청, HTTP 및 IPv6 transport는 지원하지 않는다. Shell과 패키지 설치는 계속 오프라인이다. 검색 차단·CAPTCHA·사이트 구조 변경·검색 결과 관련성은 외부 사이트에 의존한다. 이번 검증에서 DuckDuckGo는 HTTP 202, Brave는 HTTP 429를 반환했다. 이를 검색 성공으로 처리하거나 다른 엔진으로 자동 우회하지 않는다.

## 강제 경계

VM에는 NIC와 Host 원본 Vault 마운트가 없다. VM이나 페이지에서 Host에 네트워크 요청을 전달하는 통로도 없다. Host 서비스가 승인된 URL 하나만 HTTPS GET으로 읽고, 제한된 응답을 기존 검증된 Snapshot 전송 경로로 보낸다. URL 문자열 필터만 적용한 NAT/프록시가 아니다.

`network-policy.ts`는 요청마다 DNS를 확인하고 공개 IPv4 한 주소에 연결을 고정한다. TLS hostname 검증과 실제 peer 주소 검사를 유지한다. 사설망·loopback·metadata·예약 주소·다른 포트·URL 인증 정보·CONNECT·임의 헤더는 허용하지 않는다. Host 인증 정보와 브라우저 프로필은 전달하지 않는다. 응답 압축·Content-Disposition·비텍스트 응답을 거부하고 전체 요청 제한은 10초다. 브라우저 입력은 UTF-8 텍스트 최대 256 KiB, 출력 본문은 최대 16,000자, 링크는 최대 40개이며 전체 JSON 출력은 28,000 bytes 이하다. 작업별 보관 페이지는 최대 20개다.

브라우저 작업도 공용 VM FIFO와 기존 승인·취소·cgroup 정리 정책을 따른다. 승인 URL 및 도구를 Host 제안에 묶으며, 실행 전 환경 변경·취소·승인 만료를 검사한다. 네트워크 실패는 브라우저 성공으로 처리하지 않는다. 게스트 정리를 확인하지 못하면 기존 STOP_UNCONFIRMED 정책이 적용된다.

브라우저에는 매 실행 새 Chromium Context·프로필과 임시 홈을 제공하고 영속 `/cache`를 노출하지 않는다. CDP pipe로 제어하며 공개 디버깅 포트는 없다. 스크립트 비활성화, CSP, 모든 URL 차단, Fetch 요청 거절, 다운로드 거부를 함께 적용한다. 페이지가 다른 자원을 요청하더라도 VM에 인터넷 연결이 없다. 반환된 링크는 Host에서 다시 검사하며, Bing의 링크 래퍼는 대상 주소를 추출할 뿐 자동 방문하지 않는다.

페이지 내용과 링크는 신뢰할 수 없는 데이터다. UI와 Agent 지침에 이를 명시한다. 페이지의 문구가 실행 권한이나 추가 네트워크 승인을 부여하지 않는다.

## Chromium sandbox와 이미지

기존 개발 환경의 상위 chroot가 user namespace 생성을 막았다. 부팅 시 tmpfs를 mount root로 전환하고 개발 이미지 레이어를 bind mount한다. Browser supervisor와 세션에는 각각 pivot_root를 적용한 뒤 이전 root를 해제한다. Shell의 user namespace 차단은 유지하며 Browser 정리 후 namespace 한도를 다시 0으로 설정한다.

Chromium은 비특권 UID로 실행하고 renderer의 `Seccomp: 2`, `NoNewPrivs: 1`을 실제 `/proc`에서 확인해야 결과를 반환한다. `--no-sandbox`를 사용하지 않는다. 번들 Chromium의 별도 GPU 프로세스는 seccomp syscall 오류로 실패했으므로 GPU와 소프트웨어 rasterizer를 끄고 `--in-process-gpu`를 사용한다. 이는 renderer sandbox를 끄는 설정이 아니며, 모든 Chromium 프로세스에 개별 sandbox가 있다고 주장하지 않는다.

새 이미지에는 `browserSnapshotVersion: 1`이 있어야 제품 도구를 광고한다. 정식 빌드는 `prepare.py`에 포함된다. 기존 개발 이미지 갱신용 `overlay.py SOURCE DESTINATION`은 입력 manifest의 kernel/initrd SHA-256을 확인하고 별도 출력에 신뢰된 supervisor 레이어를 추가한다. 게스트 코드를 Host에서 실행하거나 파일을 다운로드하지 않는다.

검증한 이미지:

- Kernel: `256d5fff4bb892edcb9218c1e6353e388bc3646e65f76c2bc9d958b635d1b00e`
- Base initrd: `416ba6860e63fe5f50957c3ef55215241bea7bd945f058d96ae8c75710627eb0`
- Browser initrd: `e3206148acd0951942ed06a8a6bf7455e451af1c8496f846c595d0d8877017e9`

참고: [Linux unshare](https://man7.org/linux/man-pages/man2/unshare.2.html), [switch_root](https://man7.org/linux/man-pages/man8/switch_root.8.html), [CDP Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/), [CDP Browser](https://chromedevtools.github.io/devtools-protocol/tot/Browser/).

## 검증 결과

| 항목 | 결과 | 근거 |
|---|---|---|
| 전체 Node 테스트 | PASS 340, 실패 0 | 승인·URL/DNS/TLS pinning·응답 제한·페이지 범위·웹 완료 판정 포함 |
| Swift 테스트 | PASS 53, 실패 0 | Browser 승인 범위·출처·미조회 상태 표시 포함 |
| 앱 빌드·번들 이미지 검증 | PASS | [최종 검증 요약](evidence/m4-browser/Validation_Summary.json), 로컬 개발 번들이며 배포 서명 없음 |
| 실제 HTTPS 읽기와 검색 | PASS | [Browser HTTPS/Search](evidence/m4-browser/Browser_HTTPS_Search_PASS.json) |
| 스크립트·사설 주소·file URL·프로필/캐시 접근 제한 | PASS | 같은 Evidence의 합성 악성 HTML 및 격리 검사 |
| 제품 승인 채널 | PASS | [거부 시 실행 0, 승인 후 조회](evidence/m4-browser/Product_Approval_Channel.json) |
| 영속 캐시 회귀 | PASS | [Cache regression](evidence/m4-browser/Cache_Regression_PASS.json) |
| Workspace 회귀 | PASS | [Workspace regression](evidence/m4-browser/Workspace_Regression_PASS.json) |
| GPU 별도 프로세스 초기 실험 | FAIL, 기록 보존 | [GPU seccomp failure](evidence/m4-browser/Chromium_GPU_Seccomp_Failure.json) |
| 초기 CDP Context 정리 | FAIL 후 수정 | [Context disposal failure](evidence/m4-browser/Context_Disposal_Failure.json) |
| GUI 실제 클릭·유료 Provider 웹 복합 E2E | NOT RUN | 자동 승인은 사용자 클릭 증거가 아니다 |

실제 VM 테스트는 합성 Vault와 프로그램 승인을 사용했다. 사용자 Vault나 Provider 인증 정보를 사용하지 않았다. 모든 최종 실VM 검사에서 STOP_CONFIRMED를 확인했다. VM root 변경 회귀는 동일 root/supervisor 구성에서 수행했으며 마지막 Browser 전용 Snapshot 반환 생략 변경은 최종 Browser 및 제품 승인 채널 검사에 포함했다.

## 앱에서 확인

`dist/Nidus.app`은 로컬 개발 앱이다. 기존 서비스가 떠 있으면 활성 작업을 끝내고 VM 종료 확인 후 화면의 서비스 갱신 기능으로 구버전 서비스를 종료한다. 종료 미확인 잠금은 삭제하지 않는다. 새 앱에서 테스트 Vault를 선택하고 **제한적 인터넷 · 읽기 전용 브라우저** 영역에 HTTPS 주소나 검색어를 넣는다. **주소 읽기…** 또는 **웹 검색…**을 누르면 정확한 GET 주소와 전송 범위가 표시된다. 승인 후 제목·본문·조회 시각·출처 링크가 표시된다. Agent에서는 같은 도구가 개별 승인을 요청한다.

작업은 기존 캐시·Workspace 구현에 의존하므로 `feature/vault-runtime-v2`에서 이어갔다. 시작 develop은 `d5972bacbb1a41207ce5d15b25d09bcf82c942df`이며 병합 승인 전까지 변경하지 않는다. main 및 원격 push/PR은 변경 범위 밖이다.

## 사용자 NIM 테스트 후 보완 — 검색 불일치와 모델 시간 초과

사용자가 DeepSeek 4.1 Flash로 표시된 NIM 모델에서 `Mac mini M6 specs`를 검색했으나, 제목과 달리 본문에는 Enterprise AI 보안 결과가 반환되고 다음 모델 호출은 `provider_timeout`으로 종료됐다고 보고했다. 같은 URL의 공개 HTTPS 응답을 재조회했을 때도 검색 제목은 유지되지만 본문에는 Windows Group Policy 결과가 있었다. 불일치는 VM 입력 이전의 HTML에서 확인됐다. 검색 서버 또는 응답 경로 중 어디서 발생했는지는 확정하지 않았다.

앞선 Browser HTTPS/Search PASS는 전송·DOM 추출·링크 반환의 성공을 보여 줄 뿐, 검색 관련성이나 조사 품질을 입증하지 못했다. 이전 기록은 보존하며 의미를 이 범위로 정정한다.

- 검색 결과 본문·링크 제목에 검색어 핵심 단어가 최소 2개(단일 단어 검색은 1개) 일치하지 않으면 `browser_search_unrelated`로 거부한다. 검색 제목은 검사에서 제외한다. 거부한 본문은 모델에 전달하거나 성공 페이지로 보관하지 않는다.
- 이는 보수적인 단순 어휘 검사다. 같은 단어를 포함한 무관한 결과는 통과할 수 있고, 번역·동의어·한국어 활용형 결과는 잘못 거부될 수 있다. 사실 검증 또는 의미상 관련성 보증이 아니다. 막히면 검색어를 바꾸거나 공식 출처 URL을 별도 승인받아 읽어야 한다.
- NIM Agent 호출만 요청 제한을 30초에서 120초로 늘렸다. 다른 Provider는 30초를 유지한다. 사용자 취소와 전체 작업 제한은 유지하고 자동 재시도하지 않는다. 실제 NIM 호출 지연의 원인을 확정하거나 모델 응답 성공을 보증하는 변경이 아니다.
- `provider_timeout`에 모델 호출 실패 설명을 추가하고, Host UI의 조회 성공 표시도 내용 정확성·조사 완료와 구분했다.

검증: 전체 Node PASS 343, Swift PASS 53. [실제 검색 HTML의 VM 재생 및 불일치 차단](evidence/m4-browser/Search_Mismatch_Regression.json) PASS, STOP_CONFIRMED. 실제 NIM 호출은 수행하지 않았고 비용도 발생시키지 않았다. 사용자 화면의 모델명만 확인했으며 정확한 API 모델 ID와 live 후속 호출 성능은 미검증이다. 개발 앱 빌드 결과는 후속 보완 요약에 기록한다.
