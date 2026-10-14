# Nidus

Nidus는 사용자의 로컬 환경에서 동작하는 AI Office를 지향합니다. 현재 구현은 **개인용 AI API Router**입니다. 여러 서비스의 API 키를 등록하고, 시스템 프롬프트를 적용해 하나의 전용 API로 입력과 출력을 관리합니다.

## 빠른 시작

Python 3.11 이상과 [uv](https://docs.astral.sh/uv/)가 필요합니다.

```sh
uv sync --locked
uv run --locked python -m nidus_router serve
```

브라우저에서 [로컬 대시보드](http://127.0.0.1:8787)를 엽니다. 첫 실행 시 터미널에 서로 다른 `admin` 토큰과 `api` 키가 한 번씩 표시됩니다. `admin` 토큰으로 로그인하고, `api` 키는 연결할 프로그램에서 사용하세요.

uv 없이 설치할 수도 있습니다. `python3.11`은 설치한 3.11 이상 실행 파일로 바꿀 수 있습니다.

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m nidus_router serve
```

1. **연결과 모델:** OpenAI·Anthropic·Gemini 또는 OpenAI 호환 서비스의 키를 등록하고 모델을 추가합니다.
2. **요금 분류:** 신규 모델은 ‘요금 미확인’으로 차단됩니다. 계정의 실제 요금 조건에 따라 무료/유료를 지정합니다.
3. **프롬프트:** 공통 시스템 프롬프트와 텍스트/JSON 응답 형식을 설정합니다. 필요한 모델에는 개별 프롬프트를 설정합니다.
4. **라우팅과 예산:** 무료 모델의 순서를 정합니다. 유료 모델은 요율을 입력하고 허용 모델·월간 USD 예산을 별도로 승인합니다.
5. **개요:** 빠른 테스트로 실제 호출을 확인한 뒤 프로그램을 연결합니다. 이 테스트도 같은 요금·예산 정책을 사용합니다.

공급자 키는 macOS Keychain, Windows Credential Manager, Linux Secret Service 중 사용 가능한 OS 저장소에만 보관합니다. 지원 저장소가 없거나 잠겨 있으면 키 등록이 실패하며 평문 파일로 대체하지 않습니다.

## 프로그램에서 사용하기

호출용 키를 `NIDUS_ROUTER_API_KEY` 환경변수로 제공하세요. `.env` 파일은 자동으로 읽지 않습니다.

```sh
curl http://127.0.0.1:8787/api/v1/generate \
  -H "Authorization: Bearer $NIDUS_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"input":"오늘 정말 즐거웠어","model":"auto","stream":false}'
```

```python
import json
import os
from urllib.request import Request, urlopen

request = Request(
    "http://127.0.0.1:8787/api/v1/generate",
    data=json.dumps({"input": "오늘 정말 즐거웠어"}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["NIDUS_ROUTER_API_KEY"],
        "Content-Type": "application/json",
    },
)
with urlopen(request, timeout=180) as response:
    result = json.load(response)
print(result["output"])
```

`model`을 생략하면 무료 우선 자동 선택입니다. `GET /api/v1/models`에서 받은 ID로 특정 모델을 지정할 수도 있습니다. `output`은 텍스트 모드에서 문자열, JSON 모드에서 검증된 JSON 값입니다. 텍스트에서 `stream: true`를 사용하면 SSE로 응답합니다.

## 운영과 검증

설정과 요청 기록은 기본 `~/.local/share/nidus-router/router.sqlite3`에 저장합니다. 본문 저장은 기본적으로 꺼져 있고 기록은 30일 후 삭제합니다. 공급자의 실제 청구액과 라우터의 추정 비용은 다를 수 있습니다.

```sh
# 관리자 토큰 또는 호출용 키 재발급: 기존 값은 즉시 무효화됩니다.
uv run --locked python -m nidus_router reset-admin
uv run --locked python -m nidus_router rotate-api-key

# 사용자 데이터는 Git 저장소 밖 경로만 사용할 수 있습니다.
uv run --locked python -m nidus_router --data-dir /absolute/path/outside/repository serve --port 8787

# 모의 공급자와 루프백 HTTP를 사용하는 전체 테스트. 외부 AI API 호출 없음.
uv sync --locked --extra test
uv run --locked pytest -q
```

- [라우터 API·정책·검증 안내](docs/ROUTER.md)
- [Git Flow](docs/Git_Flow.md): 최신 `develop`에서 기능 브랜치 생성 → 검증·한글 커밋 → 로컬 `develop`에 `--no-ff` 병합 → 회귀 테스트. 이번 작업 브랜치는 사용자 지정 `feat/ai-api-router`입니다.
- [장기 제품 개념](docs/CONCEPT.md)

첫 버전은 단일 텍스트 입력을 처리합니다. OAuth, 도구 호출, 이미지·음성, 대화 이력, 여러 모델 동시 실행, OpenAI 호환 수신 API와 과거 Vault 런타임은 포함하지 않습니다.
