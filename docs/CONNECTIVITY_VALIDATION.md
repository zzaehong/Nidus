# API Connectivity MVP 검증 기록

- 일자: 2026-10-23 UTC
- 시작 develop: `28ecee758cf36a1f37df3ab60e92d193cf6dd0f1`
- 작업 브랜치: `feature/api-connectivity-mvp`
- 환경: macOS arm64, Node.js 24.21.0, npm 11.19.0

| 검증 | 결과 | 범위 |
| --- | --- | --- |
| `npm test` | PASS, 42 tests | strict TS, 4 Adapter, pagination, ID/기능 정규화, 모델 상세, 채팅 형식, 사용량, 인증·권한·잔액·Rate Limit·서버 오류, body timeout, 취소, redirect 거부, cache 재시작·갱신·실패 보존, credential rollback, 가격 exact match, CLI 전체 Mock 흐름 |
| `npm run test:keychain` | PASS, 1 test | 실제 Security.framework에 UUID로 분리된 synthetic 항목 생성·조회·교체·삭제. 기존 API 키 항목 접근 없음 |
| 숨김 키 입력 PTY 확인 | PASS | 가짜 20자 입력 뒤 길이만 출력; 입력 문자열은 터미널에 echo되지 않음 |
| `npm exec --offline -- nidus providers` | PASS | 빌드된 CLI로 네 Provider 반환 |
| 실제 OpenAI 모델/채팅 | NOT RUN | credential 및 opt-in 미제공 |
| 실제 Anthropic 모델/채팅 | NOT RUN | credential 및 opt-in 미제공 |
| 실제 Gemini 모델/채팅 | NOT RUN | credential 및 opt-in 미제공 |
| 실제 DeepSeek 모델/채팅 | NOT RUN | credential 및 opt-in 미제공 |

`npm run test:live` 실행 결과는 8 skipped이며 통과로 집계하지 않습니다. 성공한 Mock은 실제 계정 권한, 잔액, 모델 가용성 또는 응답 수신의 증거가 아닙니다.

중간 실패 기록: 초기 `npm install`은 sandbox DNS 제한(ENOTFOUND)으로 실패했고 승인된 재실행은 성공했습니다. 첫 Mock 실행은 quota 테스트 fixture에서 응답 헤더를 두 번 설정해 38 PASS/1 FAIL이었으며 fixture 수정 후 통과했습니다. 최초 CLI npm exec는 sandbox cache 쓰기 제한으로 실패했고 승인된 재실행은 성공했습니다.

미검증/제약: 실제 API 호출, 비-macOS 실행, 장시간 부하·동시 key rotation, 정식 배포 패키징. 가격은 수동 검토한 8개 ID의 스냅샷이며 자동 갱신과 전체 공급자 가격 커버리지를 주장하지 않습니다. macOS helper 재빌드 시 Keychain이 접근 승인을 다시 요구할 수 있습니다.
