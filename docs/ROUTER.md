# Nidus Router 0.1

## 현재 구조

```text
직접 만든 프로그램 → 전용 API → Router → 공급자별 어댑터 → AI 서비스
                                  ↑
로컬 대시보드 → 관리 API → 설정·승인·월간 예산
```

`nidus_router`는 독립 패키지입니다. 라우팅 코어는 FastAPI나 대시보드를 참조하지 않습니다. `develop`은 과거 구현을 정리한 기준 브랜치이므로 기존 런타임을 복원하거나 통합하지 않았습니다.

- `router.py`: 요청 설정 스냅샷, 후보 선택, 프롬프트, 출력 검증, 대체 호출, 비용·기록.
- `providers.py`: OpenAI Chat Completions, Anthropic Messages, Gemini GenerateContent, 사용자 지정 OpenAI 호환 프로토콜.
- `store.py` / `secrets.py`: SQLite 설정·원장·기록과 OS 자격 증명 저장소.
- `app.py` / `boundary.py`: 전용 API, 관리자 세션, 로컬·동일 출처 경계, 연결 종료 감지.
- `static/`: 외부 CDN 없이 제공하는 한국어 대시보드.

OmniRoute의 연결·모델·라우팅 분리 구조를 참고했으며 실행 엔진이나 코드를 가져오지는 않았습니다.

## 전용 API

모든 `/api/v1/*` 요청에는 `Authorization: Bearer <호출용 키>`가 필요합니다. 관리자 토큰은 사용할 수 없습니다.

### `POST /api/v1/generate`

```json
{"input":"분석할 입력","model":"auto","stream":false}
```

| 필드 | 의미 |
| --- | --- |
| `input` | 필수 비어 있지 않은 문자열. 최대 100,000자이며 UTF-8로 128 KiB 이하 |
| `model` | `auto` 또는 라우터가 발급한 모델 ID. 기본 `auto` |
| `stream` | 텍스트 SSE 요청 여부. 기본 `false` |

그 밖의 필드는 거부합니다. 전체 HTTP 요청 본문 상한은 512 KiB입니다. 서버에 대화 이력을 저장하거나 자동으로 이전 문맥을 붙이지 않습니다.

성공 예시:

```json
{
  "request_id": "request-identifier",
  "model": "router-model-identifier",
  "output": {"category": "positive"},
  "usage": {
    "input_tokens": 10,
    "output_tokens": 3,
    "estimated_cost_usd": 0
  }
}
```

텍스트 모드의 `output`은 문자열입니다. JSON 모드에서는 객체·배열·문자열·숫자·불리언·null 등 유효한 JSON 값을 반환합니다. `usage`는 최종 모델의 값이며 알 수 없는 토큰은 `null`입니다. 대체 호출을 포함한 전체 시도 비용은 요청 기록과 예산 원장에서 확인합니다.

실패 응답에는 `request_id`, `error.code`, `error.message`가 있습니다. 공급자 원문 오류·인증 헤더·키는 반환하지 않습니다.

| HTTP | 주요 코드 |
| --- | --- |
| 401 / 403 | `unauthorized`, `forbidden`, `paid_not_approved` |
| 402 | `budget_exceeded` |
| 404 | `not_found` |
| 409 | `configuration_conflict` — 설정 변경 또는 삭제 대상 참조 충돌 |
| 413 / 422 | `invalid_request`, `unknown_pricing`, `json_stream_not_supported` |
| 502 / 503 | `invalid_output`, `authentication_failed`, `provider_request_rejected`, `provider_unavailable`, `rate_limited`, `credential_unavailable`, `no_available_model` |

### `GET /api/v1/models`

활성 연결의 활성 모델을 `{"models":[{"id":"...","name":"...","pricing":"free"}]}` 형태로 반환합니다. 목록에 있어도 미확인 요금·유료 미승인·예산 부족이면 호출할 수 없습니다.

### 텍스트 SSE

```sh
curl -N http://127.0.0.1:8787/api/v1/generate \
  -H "Authorization: Bearer $NIDUS_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"input":"짧은 인사말을 써줘","stream":true}'
```

- `delta`: `request_id`, `model`, 텍스트 조각 `text`.
- `done`: 일반 성공 응답과 동일한 전체 결과·사용량.
- `error`: 일반 실패 응답과 동일한 오류. 이후 스트림 종료.

첫 조각 전 실패는 일반 HTTP 오류 또는 허용된 대체 호출로 처리합니다. 첫 조각을 전달한 뒤에는 다른 모델로 바꾸지 않습니다. 이 단계의 오류는 HTTP 상태를 바꿀 수 없으므로 SSE `error`로 확인해야 합니다. 클라이언트 연결 종료 시 첫 응답 대기 중인 호출과 진행 중인 스트림 모두 취소합니다.

## 프롬프트와 응답 검증

- 공통 시스템 프롬프트가 기본값입니다. 모델의 `prompt_override`가 `null`이면 공통값을 사용하고, 문자열이면 빈 문자열을 포함해 공통값을 대체합니다.
- JSON 모드는 전체 공통 설정입니다. 실제 모델 프롬프트 뒤에 JSON만 출력하라는 지침을 덧붙입니다. 사용자의 입력은 별도의 user 메시지로 전달합니다.
- 요청 시작 시 설정·모델·연결 스냅샷을 고정합니다. 대체 모델에는 해당 모델의 프롬프트를 적용합니다. 대시보드에서 실제 적용 프롬프트를 펼쳐 볼 수 있습니다.
- JSON 모드에서 스트리밍을 요청하면 공급자 호출 전에 거부합니다.
- 잘린 응답, 빈 텍스트, JSON 외 설명, Markdown 코드 블록, 중복 JSON 키, NaN·Infinity·오버플로 숫자를 거부합니다. JSON Schema나 응답 내용의 사실성은 검증하지 않습니다.
- 출력 오류는 자동 수정·재시도하지 않습니다. 공급자 응답 상한은 4 MiB입니다. 모델당 제한 시간은 기본 60초, 출력 상한은 기본 1,024토큰입니다.

## 모델 선택과 비용

`auto`는 활성 모델의 무료 그룹을 먼저 시도하고 유료 그룹으로 넘어갑니다. 같은 그룹에서는 `priority`가 작은 순서이며 동률은 모델 ID 순서입니다. ‘요금 미확인’은 제외하고 미승인 유료 후보는 호출하지 않습니다.

모델을 직접 지정하면 그 모델과 명시적으로 설정한 `fallback_ids`만 순서대로 시도합니다. 대체 모델의 대체 목록으로 재귀 확장하지 않습니다. 각 후보는 한 번만 시도합니다. 유료 모델 직접 지정에도 사전 승인이 필요합니다.

인증 오류, 한도 초과, 네트워크·타임아웃·5xx는 대체를 허용합니다. 잘못된 공급자 요청, 리다이렉트, 출력 검증 오류는 중단합니다. 인증 실패를 숨기지 않고 시도 기록에 남깁니다.

무료 분류는 사용자가 해당 연결·모델의 계정 요금을 확인해 지정합니다. 서비스 이름이나 모델 목록을 근거로 무료라고 자동 판단하지 않습니다. 무료 한도 이후 공급자가 자동 과금하는 계정은 무료 분류가 비용을 차단해 주지 않습니다.

유료 사용은 모델 목록과 전체 월간 USD 예산을 별도 승인해야 합니다. 요율이 없으면 승인할 수 없습니다. 공급자·주소·키 또는 모델·연결·요금 조건이 바뀌면 기존 유료 승인을 해제합니다. 승인은 화면에서 확인한 조건의 지문에 묶여 있어, 오래된 화면으로 달라진 요금을 승인할 수 없습니다. 공통 프롬프트 저장으로 유료 승인이 추가되는 일도 없습니다.

호출 전 입력 UTF-8 바이트 수와 프레이밍 여유 256, 출력 토큰 상한, 등록 요율로 비용을 추정합니다. 금액은 정수 나노달러로 관리하고 `BEGIN IMMEDIATE` 트랜잭션으로 월별 예산을 예약합니다. 동시에 들어온 요청도 같은 잔액을 중복 사용할 수 없습니다.

완료 신호와 사용량을 모두 받은 호출은 보고된 사용량으로 정산합니다. 실패·취소·중단·사용량 누락 등 청구 여부가 불명확한 유료 호출은 예약액을 유지합니다. 클라이언트 취소는 공급자의 이미 발생한 과금을 취소하지 않습니다. 모델 가격과 비용은 사용자 등록값에 따른 추정이며 실제 청구 상한을 보증하지 않습니다.

월 경계는 `Asia/Seoul`입니다. 이전 달에 시작한 호출은 완료가 다음 달이어도 이전 달 예약에 정산합니다. 기록 삭제·보관 기간 만료·서버 재시작으로 원장을 초기화하지 않습니다.

## 보관과 접근 제어

- 서버는 `127.0.0.1`에만 바인딩합니다. 요청의 클라이언트 주소·Host를 검사하며 프록시 전달 헤더를 신뢰하지 않습니다.
- 대시보드 관리 변경에는 같은 Origin과 관리자 세션이 필요합니다. 쿠키는 HttpOnly, SameSite=Strict, 유효기간 8시간입니다. 호출용 Bearer 키로 관리 API에 접근할 수 없습니다.
- 첫 실행의 관리자 토큰·호출용 키는 한 번 출력하고 DB에는 해시만 보관합니다. 공급자 키는 OS 자격 증명 저장소에만 저장하고 DB에는 참조만 보관합니다.
- `--data-dir`은 Git 저장소 외부여야 합니다. 기본 `~/.local/share/nidus-router` 디렉터리는 소유자 전용 권한이며 OS 키 저장소의 이름 공간도 이 경로에 연결됩니다. 데이터 디렉터리를 이동하면 공급자 키를 다시 등록해야 합니다.
- 본문 저장은 기본 꺼짐입니다. 켜면 이후 시작하는 요청의 입력과 성공 결과를 기록합니다. 설정은 요청 시작 시 고정되므로 진행 중인 요청에는 기존 설정을 사용합니다.
- 기본 30일 보관이며 조회·요청 기록 시와 실행 중 매시간 만료 기록을 정리합니다. 삭제는 SQLite 레코드 삭제이며 디스크 포렌식 수준의 안전 삭제를 제공하지 않습니다.
- 요금 원장에는 본문이나 키를 저장하지 않습니다. 로그 삭제 후에도 월간 예산을 유지하기 위해 별도로 보존합니다.
- 외부 공급자는 HTTPS를 사용해야 합니다. 로컬 테스트·로컬 모델을 위한 루프백 HTTP는 허용합니다. 리다이렉트와 환경변수 HTTP 프록시는 사용하지 않습니다.

관리 API의 OpenAPI 문서는 관리자 로그인 후 `/admin/openapi.json`에서 조회할 수 있습니다. `/admin/test`도 실제 호출 API와 같은 Router를 사용합니다.

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

첫 버전은 단일 사용자·로컬 실행용입니다. OAuth, 멀티모달, 도구 호출, 대화 세션, 공급자 자동 모델 검색, JSON Schema 검증, 동시 모델 호출, 공개 OpenAI 호환 수신 API는 구현하지 않았습니다.
