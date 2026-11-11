# macOS API Dashboard 검증

기준: 2026-10-23, macOS arm64, Node 24.21.0, 로컬 Xcode Swift toolchain.

- 시작 develop: `b0ad6724f485799430ae6dd657b3d671d16b2197`
- 작업 브랜치: `feature/macos-api-dashboard`
- 이전 MVP 검증 기록: [CONNECTIVITY_VALIDATION.md](CONNECTIVITY_VALIDATION.md), 변경 없이 보존.

## PASS

- `npm test`: 45개. 기존 42개 + 대시보드 connect→자동 모델 반영→캐시→refresh→detail→pricing→chat→disconnect Mock 흐름, 잘못된 입력 거부, 실제 Node 자식 프로세스의 JSON 응답/키 비노출.
- `swift test`: 7개. Provider별 자동 모델 반영과 상태 격리, 인증 실패 표시/busy 해제, 시작 실패·재시도, 경로/helper 검사, stdout/stderr 분리, 비정상 종료·응답 오류, 타임아웃 TERM→KILL 및 종료 후 요청 거부.
- `npm run test:keychain`: 1개. 별도 UUID 테스트 service에서 가짜 키 생성/조회/변경/삭제. 기존 사용자 키는 사용하지 않음.
- `swift build`, `swift run NidusNativeApp`: 컴파일 및 실행. 단독 Swift 실행 파일은 UI 검사 도구에서 앱으로 찾지 못했으며, 이후 `.app` 번들로 화면 검사.
- `npm run build:app`: release Swift 실행 파일 + Node + Runtime + helper 포함 로컬 번들 생성.
- 실제 `dist/Nidus.app` 실행: 창 렌더링, OpenAI/Claude/Gemini/DeepSeek 서비스 표시, 엔진 준비 완료, Gemini 캐시 상태를 재확인 필요로 표시하는 것을 접근성 트리와 스크린샷으로 확인.
- `git diff --check`: 공백 오류 없음.

## NOT RUN / 제한

- 실제 Models API 4개 + 실제 채팅 API 4개: opt-in과 명시적 인증정보/모델 설정 없음. `npm run test:live`는 8개 skip, 성공으로 간주하지 않음.
- GUI에서 실제 키 입력→Keychain 저장→라이브 모델/응답 표시: 미검증. 저장된 Gemini 캐시가 있다는 사실은 이번 버전의 라이브 인증 검증이 아님.
- 키 입력의 시스템 비밀번호 제안 팝업 억제: AppKit secure field에 contentType nil 및 automaticTextCompletion false 적용, 실제 입력 수동 검증은 미완료.
- UI 검사 도구에서 사용자 상태 변경 경고와 장시간 응답 지연이 발생하여 서비스 클릭/키 시트의 수동 검증은 완료하지 못함. 성공으로 기록하지 않음.
- 다른 Mac, Intel, 최소 OS 버전, 배포 서명/공증 및 App Sandbox: 미검증. 현재 `.app`은 로컬 개발 번들.
- 같은 Provider의 다른 CLI/앱 프로세스 동시 키 교체 잠금, 수동 요청 취소, 스트리밍, 멀티턴 UI는 미구현. 기존 엔진의 취소 인터페이스/멀티턴 계약은 유지.

## 후속 검증

사용자가 앱에 본인의 API 키를 입력하여 네 Provider별 연결·모델 목록·새로고침·유료 채팅을 검증해야 합니다. 키는 채팅이나 저장소로 전달하지 않습니다. 배포 전 코드 서명·공증, 번들 Node 보안 업데이트와 대상 macOS/CPU별 실행을 검증해야 합니다.
