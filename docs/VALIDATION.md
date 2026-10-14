# 검증 안내와 실행 이력

설치와 실행은 [README](../README.md), API와 정책은 [라우터 안내](ROUTER.md)를 참고하세요.

## 검증 실행

```sh
uv sync --locked
uv run --locked pytest -q
uv run --locked python -m compileall -q nidus_router tests/router
git diff --check
```

개발 환경은 `.python-version`의 Python 3.13과 `uv.lock`으로 재현합니다. `uv sync --locked`는 루트 `.venv`에 런타임과 기본 `dev` 그룹의 테스트 도구를 설치합니다.

테스트는 생성한 가짜 키, 임시 디렉터리, 모의 HTTP 응답을 사용합니다. 운영 OS 자격 증명 저장소나 실제 외부 AI 서비스를 사용하지 않습니다. 루프백 소켓 권한이 없는 환경에서는 `uv run --locked pytest -q --ignore=tests/router/test_http.py`로 오프라인 테스트만 실행할 수 있습니다.

브라우저 검증은 Playwright와 Chromium 또는 Chrome이 설치된 환경에서 별도 실행합니다.

```sh
# 터미널 1: 임시 데이터와 메모리 자격 증명만 사용하는 모의 서버
uv run --locked python tests/router/preview.py /tmp/nidus-router-preview-info.json

# 터미널 2: Node에서 playwright 패키지를 찾을 수 있어야 합니다.
# 기본 Chromium 대신 설치된 Chrome을 쓰려면 PLAYWRIGHT_CHANNEL=chrome을 지정합니다.
node tests/router/dashboard.cjs /tmp/nidus-router-preview-info.json
```

브라우저 검증은 로그인 → 연결·모델 등록 → 프롬프트 설정 → JSON 요청 → 기록 확인, 모델별 재정의, 유료 모델·예산 승인, 모바일 가로 넘침·JavaScript 오류를 확인합니다. 화면 캡처는 `/tmp/nidus-router-dashboard.png`, `/tmp/nidus-router-mobile.png`에 생성합니다. 검증 후 모의 서버를 종료하세요.

## 검증 이력

아래 결과는 각 시점의 실행 기록입니다. 이전 단계의 NOT RUN과 실패 기록은 이후 성공으로 덮어쓰지 않습니다. 최신 기능 검증은 마지막 Gemini 항목을 참고하세요.

2026-10-14 기능 브랜치 검증 결과 (Python 3.13, 임시 가상환경):

| 검증 | 결과 |
| --- | --- |
| 전체 자동 테스트 | **PASS — 59개** (오프라인 49개, 실제 루프백 HTTP·연결 취소 10개) |
| Chrome 브라우저 흐름 | **PASS** — 무료 호출, JSON, 개별 프롬프트, 유료 승인, 모바일 화면 |
| Python 컴파일·JavaScript 구문·Git 공백 검사 | **PASS** |
| 잠금 파일 검증·wheel/sdist 빌드·대시보드 파일 포함 확인 | **PASS** |
| 실제 외부 공급자 및 운영 OS 키 저장소 | **NOT RUN** — 실제 서비스 키 미사용 |

검증 구분:

- 자동 테스트: 모의 프로토콜, 실제 루프백 HTTP, 무료 우선·대체 정책, 예산 경쟁·재시작·월 경계, JSON, 인증·키 비노출, 클라이언트 취소.
- 브라우저 테스트: 모의 공급자를 사용하는 실제 UI 흐름.
- 실제 외부 API / 운영 OS 키 저장소 검증: **NOT RUN**. 사용자가 서비스 키를 등록한 후 대시보드에서 별도로 확인해야 합니다.

첫 버전은 단일 사용자·로컬 실행용입니다. OAuth, 멀티모달, 도구 호출, 대화 세션, JSON Schema 검증, 동시 모델 호출, 공개 OpenAI 호환 수신 API는 구현하지 않았습니다.

### 모델 자동 등록 기능 검증 (2026-10-14)

`feat/auto-model-onboarding`, Python 3.13, 기존 uv 개발 환경에서 검증했습니다. 위 첫 버전 검증 기록은 그대로 보존합니다.

- **PASS — 자동 테스트 90개:** 모의 응답과 실제 루프백 HTTP, 공급자별 목록·페이지네이션, 중복 방지·소멸·복귀, 동시 조회 공유·간격 제한, 설정 보존·구버전 DB 이전, 공식 주소·계정 요금 확인, 새 유료 모델 승인 대기·가격 변경 승인 해제, 지정 모델 우선·자동 대체, 스트리밍 오류·취소.
- **PASS — Chrome:** 키 등록 → 모델 자동 생성 → 목록 새로고침 → 프롬프트 → JSON 요청·기록, 모델 재정의, 유료 승인·예산, 지정 모델 연결 오류 후 무료 자동 대체, 모바일 가로 넘침·JavaScript 오류 없음.
- **PASS:** Python 컴파일, JavaScript 구문, Git 공백 검사, `uv build` wheel/sdist 생성 및 신규 모듈·정적 파일 포함.
- **NOT RUN:** 실제 외부 공급자와 운영 OS 자격 증명 저장소. 생성한 테스트 키와 모의 공급자만 사용했습니다.


### Gemini 계정 요금제 안내 개선 (2026-10-14)

검증 결과:

- **PASS — 자동 테스트 97개:** `uv run --locked pytest -q`. 계정 미확인 오류, 무료 확인 후 호출, 키 보존, 사용자 지정 주소와 수동 요금 보존을 추가 검증했습니다.
- **PASS — 실제 Gemini API / Chrome:** 사용자가 무료·미결제 프로젝트임을 확인한 기존 연결로 `gemini-3.1-flash-lite`를 지정해 호출했습니다. 2026-10-14 20:20 KST 요청 기록에서 같은 모델의 완료를 확인했습니다. 응답은 `{"status":"NIDUS_OK"}` 내용을 담은 텍스트이며 입력 23·출력 15토큰, 추정 비용 $0, 지연 2436ms였습니다. 본문 저장 꺼짐, 유료 승인 0개·예산 $0을 유지했습니다.
- **FAIL — 이전 실제 호출:** `gemini-2.5-flash-lite` 지정 호출에서 모델 없음 오류가 발생했습니다. 목록에 표시된다는 사실만으로 실제 호출 가능함을 보장하지 않습니다.
- **NOT RUN:** 이번 변경의 다른 공급자 실제 호출, 유료 호출, 실제 스트리밍 호출. 모의 회귀 테스트와 구분합니다.
