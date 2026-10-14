# AGENTS.md

이 문서는 Nidus 저장소에서 작업하는 AI 개발 에이전트를 위한 기본 지침이다.

작업 전에 반드시 현재 `develop` 브랜치와 이 문서를 확인한다.

---

## 1. Nidus의 목적

Nidus는 단순한 AI 챗봇이나 여러 모델을 묶은 인터페이스가 아니다.

궁극적으로는 사용자의 로컬 환경 안에서 지속적으로 활동하는 **AI Office**를 만드는 것이 목표다.

핵심 개념은 다음 문서를 기준으로 한다.

- `docs/CONCEPT.md` — Nidus의 핵심 철학, Agent Vault, AI Office
- `README.md` — 현재 프로젝트의 간단한 설명
- `docs/Git_Flow.md` — Git 작업 규칙

`docs/CONCEPT.md`는 장기적인 제품 방향을 설명한다.
이를 현재 구현 상태라고 가정하지 않는다.

---

## 2. 현재 개발 단계

현재 Nidus는 기존 구현을 정리하고 처음부터 다시 구축하는 단계다.

개발 순서는 다음과 같다.

```text
1. AI API Routing Core
        ↓
2. Nidus Backend API
        ↓
3. Frontend Dashboard
        ↓
4. AI Office Runtime 확장
```

현재 우선순위는 **AI API Routing Core**다.

AI Provider를 안정적으로 호출하고,
모델을 선택하고,
오류를 처리하고,
fallback을 수행하며,
결과를 공통 형식으로 반환하는 기반을 먼저 검증한다.

Backend와 Frontend는 Routing Core가 충분히 검증된 이후 만든다.

---

## 3. 현재 구현으로 간주하지 말 것

과거 Nidus에는 다음과 같은 기능이 존재했지만 현재 구현으로 간주하지 않는다.

- Plan / Task Runtime
- Manager / Worker 실행 시스템
- Local GUI
- Connection Registry
- Model Catalog
- Vault Runtime
- Backend API
- Dashboard
- SQLite 상태 저장
- Keychain integration
- Dynamic Organization

Git history에 과거 코드가 남아 있더라도 이를 복원하거나 재사용하는 것을 기본값으로 삼지 않는다.

필요한 기능은 현재 요구사항을 기준으로 다시 설계한다.

---

## 4. 설계 원칙

### 작은 단위부터 만든다

아직 필요하지 않은 기능을 미리 구현하지 않는다.

특히 현재 Routing 단계에서는 다음을 조기에 추가하지 않는다.

- Database
- Web Server
- GUI
- Agent Runtime
- Manager / Worker
- Scheduler
- Queue
- Vector DB
- 대형 Plugin Framework
- 복잡한 Dependency Injection 구조

먼저 가장 작은 실행 가능한 구조를 만들고 실제 동작을 검증한다.

### 계층을 분리한다

향후 구조는 기본적으로 다음 방향을 따른다.

```text
Frontend
    ↓
Nidus Backend
    ↓
AI Routing Core
    ↓
Provider Adapter
    ↓
External AI API
```

Routing Core가 Backend나 Frontend 구현에 의존하지 않도록 한다.

### Provider와 Protocol을 구분한다

Provider의 정체성과 API protocol 구현은 같은 개념이 아니다.

예:

```text
Gemini
→ Native Gemini API

OmniRoute
→ Gateway
→ OpenAI-compatible protocol 사용 가능

기타 Provider
→ OpenAI-compatible protocol 재사용 가능
```

공통 protocol을 사용한다고 Provider identity를 잃지 않는다.

---

## 5. Routing 기본 원칙

AI Employee나 상위 Agent가 직접 모델 이름을 선택하는 구조를 기본값으로 만들지 않는다.

상위 계층은 필요한 능력을 요청하고 Router가 실행 후보를 선택한다.

```text
Agent / Backend
→ Capability Requirement
→ Router
→ Connection + Model
```

실제 모델 후보의 identity는 다음 조합으로 취급한다.

```text
(connection_id, model_id)
```

같은 모델 이름이라도 다른 Connection을 통해 호출된다면 서로 다른 실행 후보다.

초기 Router는 규칙 기반으로 구현한다.
AI 기반 routing, JEV, 복잡한 cost optimization은 후속 단계다.

---

## 6. Secret과 API Key

API Key와 Credential은 절대 다음 위치에 저장하지 않는다.

- Source code
- Git
- Markdown 문서
- 테스트 fixture
- 로그
- 오류 메시지
- API 응답
- Prompt

개발 및 Live 검증에서는 환경 변수 등 명시적인 credential source를 사용한다.

Secret을 필요 이상으로 전달하지 않는다.

---

## 7. 테스트 원칙

### Python 개발 환경

- 프로젝트 환경과 의존성 관리는 기존 개발 환경의 **uv**를 사용한다.
- `.python-version`의 Python 3.13과 `uv.lock`을 기준으로 `uv sync --locked`를 실행한다. 각 checkout의 `.venv`를 사용하며 전역 Python에 프로젝트 패키지를 설치하지 않는다.
- 테스트 도구는 `pyproject.toml`의 기본 `dev` dependency group으로 관리한다. `uv run --locked pytest -q`로 테스트하고 `uv run --locked nidus-router serve`로 실행한다.
- 의존성은 `uv add` / `uv add --dev` / `uv remove`로 변경하고 `pyproject.toml`과 `uv.lock`을 함께 커밋한다.
- 가상환경 수동 활성화나 별도의 pip 설치 절차를 기본 안내로 추가하지 않는다. `uv build`를 사용하며 빌드 백엔드는 패키지 관리 도구와 별개다.

### 검증 구분

Provider integration은 fixture 테스트와 실제 API 테스트를 구분한다.

다음 표현을 정확히 사용한다.

```text
PASS
FAIL
NOT RUN
```

Synthetic fixture 성공을 실제 Provider 성공으로 기록하지 않는다.

외부 API를 실제 호출한 경우에만 Live 검증 성공으로 기록한다.

오류 처리, fallback, structured output, secret leakage도 별도 검증한다.

---

## 8. 문서 원칙

문서는 실제 상태를 설명해야 한다.

아직 구현하지 않은 기능을 구현된 것처럼 작성하지 않는다.

장기 아이디어와 현재 구현을 구분한다.

```text
CONCEPT
→ 장기 철학과 제품 방향

현재 기술 문서
→ 실제 구현된 구조와 계약
```

새 기능을 만들 때 필요한 최소한의 설계 문서만 추가한다.

문서가 코드보다 앞서 복잡해지지 않도록 한다.

---

## 9. Git 작업

모든 Git 작업은 반드시 다음 문서를 따른다.

`docs/Git_Flow.md`

특히:

- 최신 `develop`에서 작업 시작
- 일반 기능은 `feature/*`에서 개발
- 논리 단위로 commit
- 커밋 메시지는 한글로 작성
- 검증 후 `develop`에 `--no-ff` merge
- merge 후 회귀 테스트
- 사용자의 기존 변경 보존
- 별도 요청 없이 `main` 수정 금지
- 별도 요청 없이 push / PR / release 금지

저장소의 실제 현재 상태를 source of truth로 사용한다.

---

## 10. 작업 전 확인

작업을 시작하기 전에 확인한다.

```text
현재 develop HEAD
working tree 상태
관련 문서
현재 구현 존재 여부
이번 작업의 정확한 범위
```

과거 Git history만 보고 현재 파일이나 기능이 존재한다고 가정하지 않는다.

---

## 11. 작업 완료 보고

완료 후 최소한 다음을 보고한다.

```text
무엇을 구현했는가

무엇을 구현하지 않았는가

변경된 주요 파일

테스트 결과
- PASS
- FAIL
- NOT RUN

실제 외부 API 검증 여부

Known limitations

사용한 branch / commit / merge

최종 develop 상태
```

확인하지 않은 내용을 성공으로 추정하지 않는다.

---

## 핵심 원칙

```text
Nidus의 철학은 유지한다.

과거 구현에는 얽매이지 않는다.

현재 develop이 source of truth다.

작은 기반부터 실제로 검증한다.

Routing → Backend → Frontend 순서를 지킨다.

복잡성을 미리 만들지 않는다.

Secret을 보호한다.

테스트와 실제 검증을 구분한다.

Git 작업은 docs/Git_Flow.md를 따른다.
```
