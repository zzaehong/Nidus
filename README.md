# Nidus

Nidus는 API를 통해 AI 작업 계획을 만들고, 사용자의 검토와 승인 아래 문서 작업을 진행하는 로컬 업무 도구입니다. 백엔드는 Vault에 업무 기록을 보관하며, AI에 자료를 보내기 전에는 전송 범위를 확인하고 승인해야 합니다.

## 시작하기

Nidus를 내려받은 저장소 디렉터리에서 Python 3.9 이상으로 실행합니다. 먼저 저장소 바깥에 업무 파일을 둘 Vault 디렉터리를 준비한 다음 JSON API 서버를 실행하세요.

```sh
mkdir -p "$HOME/NidusVault"
python3 -m nidus --vault "$HOME/NidusVault" api
```

API는 기본적으로 `http://127.0.0.1:8765`에서 실행됩니다. 서버를 끄려면 실행 중인 터미널에서 `Ctrl-C`를 누릅니다. 서버는 loopback 주소에만 bind하며 원격 접속이나 계정 기능은 제공하지 않습니다. API는 `GET /api/overview`, `GET /api/plans/{id}`, `GET /api/tasks/{id}`, `POST /api/plan-setup`, `POST /api/plans`, Plan 실행·판단, Task 판단, 연결 관리 경로를 제공합니다. 상태 변경 요청에는 `/api/session`에서 받은 세션 토큰과 동일 출처 헤더가 필요합니다.

### 1. AI 연결하기

처음 사용하는 경우 `/api/connections`로 사용할 Provider를 등록하고 연결 확인을 요청합니다.

- **Google Gemini**: Gemini API Key를 입력합니다.
- **OmniRoute**: OmniRoute Endpoint와 Endpoint Key를 입력합니다. 기본 Endpoint는 로컬 OmniRoute 주소입니다.
- **호환 API**: OpenAI-compatible 서비스의 Endpoint와 API Key를 입력합니다. 인증이 필요 없는 로컬 서버도 등록할 수 있습니다.

연결 확인은 합성 테스트 요청을 Provider에 보내 일반 응답과 JSON 응답을 검증합니다. 두 기능을 확인한 모델만 Plan 추천에 사용할 수 있습니다. API Key는 macOS Keychain에 보관합니다. Provider 호출에는 요금이나 사용량 제한이 적용될 수 있습니다. 연결 단계에서 Vault 문서는 전송하지 않습니다. 자세한 입력 예시는 [AI 연결 안내](docs/CONNECTIONS.md)를 참고하세요.

### 2. 자연어로 Plan 만들기

`POST /api/plan-setup`에 원하는 결과를 평소 말하듯 전달해 구성 추천을 받습니다. 예를 들면 다음과 같습니다.

> Vault의 제품 조사 자료를 바탕으로 경쟁 제품의 기능과 가격을 비교하는 보고서를 만들어줘.

Nidus는 Vault의 `.md`와 `.txt` 문서 중 관련 자료를 찾고, 연결 확인을 마친 모델을 제안합니다. 이 추천 과정은 로컬에서 처리되며 요청이나 파일 내용을 AI Provider로 보내지 않습니다. 추천된 자료와 모델을 검토한 뒤 응답 내용을 `POST /api/plans`로 전달합니다. 관련 자료가 없어도 자료 없이 진행할 수 있습니다.

Plan 생성만으로 AI 작업이 시작되지는 않습니다. Plan의 `run` API를 한 단계씩 호출하고, 실제 AI 호출 전에는 전송할 요청·자료·모델을 조회해 검토하고 승인해야 합니다. Plan은 자동으로 끝까지 실행되지 않습니다. 유료 API 사용 시 비용이 발생할 수 있습니다.

## 작업 흐름

1. 자연어 요청과 제안된 자료·모델을 검토해 API로 Plan을 만듭니다.
2. Plan 실행 endpoint를 호출해 다음 단계를 시작합니다.
3. 주의가 필요한 요청을 조회해 정확한 범위를 확인하고 API로 승인하거나 거부합니다.
4. 결과와 검토 상태를 살펴본 뒤 다음 단계를 직접 호출합니다.

원본 자료는 보존합니다. 생성된 문서는 Vault에 저장됩니다. 실행 및 전송 승인 기록은 Plan 상세와 실행 기록에서 확인할 수 있습니다. 설정의 AI 연결은 자격증명을 관리하는 곳이고, 요청마다 모델 정책 JSON을 직접 작성할 필요는 없습니다.

## 데이터와 보안

- API 서버는 `127.0.0.1`에서만 열리며 Nidus의 업무 상태와 연결 정보는 Vault에 저장됩니다.
- 연결 자격증명은 macOS Keychain에 저장하고 Vault 데이터베이스에는 비밀 값 대신 참조만 보관합니다.
- Vault 검색 추천은 로컬 파일 경로와 내용을 사용하며 외부 전송을 하지 않습니다.
- 모델 호출은 사람이 승인한 자료와 요청 범위 안에서만 진행합니다. 연결 검사에는 짧은 합성 문구만 사용합니다.
- 파일 경로와 크기를 검증하며 숨김 파일, 심볼릭 링크, Vault 바깥 경로는 자료로 사용할 수 없습니다.

현재 Nidus는 macOS Keychain을 사용합니다. 외부 계정 로그인, 원격 사용자 인증, 자동 실행 스케줄러, 임의 도구 실행은 제공하지 않습니다.

## 개발 및 테스트

```sh
python3 -m unittest discover -s tests -q
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

테스트와 합성 데모는 저장소 밖의 격리 임시 Vault를 사용합니다. 위 테스트는 외부 AI Provider를 호출하지 않습니다. 실제 Provider 사용량이 발생할 수 있는 Live 검증은 별도 명령으로 관리합니다.

## 문서

- [요구사항](PRD.md): 제품 범위와 수용 기준
- [기술 설계](DESIGN.md): 현재 구현, 보안 및 복구 경계
- [AI 연결 안내](docs/CONNECTIONS.md): Provider 연결 및 검증 방식
- [개념 설계](docs/CONCEPT.md): 역할과 장기 설계
- [검증 이력](docs/VALIDATION.md): 테스트·실행 증거와 과거 한계
- [개발 Git 흐름](docs/git_flow.md): 브랜치, 커밋 및 통합 규칙
