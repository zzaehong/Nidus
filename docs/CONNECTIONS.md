# Provider Connection Foundation v1

2026-10-13. 지원 유형은 **OmniRoute**와 **Generic OpenAI-compatible API** 두 가지다. 두 manifest가 같은 `OpenAICompatibleAdapter`를 사용한다. Gemini/Anthropic native API, OAuth, 자동 역할별 라우팅, GUI v2, 동적 조직은 구현하지 않았다.

## 연결 방법

`python3 -m nidus --vault "$vault" gui` 실행 후 **설정 → AI 연결**에서 Provider를 선택한다. OmniRoute 기본 Endpoint는 `http://127.0.0.1:20128/v1`이다. 호환 API는 Base URL을 입력한다. Key를 입력하고 **연결 확인**을 누르면 먼저 설정을 저장하고 공개 합성 문구로 모델 탐색과 응답을 검사한다. 모델 ID나 Policy JSON은 입력하지 않는다. 인증이 없는 로컬 서버는 Key를 비워 둔다. Probe에도 Provider 사용 요금이 발생할 수 있다.

연결 카드는 상태·사용 가능 모델 수·응답 검증을 표시한다. **연결 테스트**로 재검사하며, **관리 및 상세 정보**에서 Endpoint 수정·Key 교체·삭제가 가능하다. 기존 Key는 다시 표시하지 않는다. 빈 Key로 교체할 때는 교체 체크박스를 선택한다. 설정 변경은 Catalog와 이전 Probe 표시를 초기화하고 다시 `configured`로 만든다. 삭제는 Keychain 항목, 현재 연결 metadata, Catalog association을 지우며 과거 Task/Plan audit는 유지한다. env 호환 연결을 삭제해도 사용자 환경변수는 변경하지 않는다.

이 연결은 아직 기존 Plan/Task의 policy를 대체하지 않는다. 업무 실행은 기존 정책과 전송 승인 경계를 그대로 사용한다. 이번 설정을 완료했다고 기존 Plan이 자동으로 이 연결을 사용하는 것은 아니다.

## 아키텍처 감사와 경계

기존 `Gateway`는 Task/Plan 메시지·전송 snapshot·승인 대상 policy·route fallback·비용 metadata와 강하게 결합되어 있다. 이 부분은 유지했다. `ChatCompletions`의 bounded response parsing, no proxy/no redirect, HTTP 오류 taxonomy를 재사용한다. 공통 HTTP 부분만 `request_bytes`로 추출하고 명시적인 메모리 내 secret 전달 인자를 추가했다. 기존 호출은 계속 env reference를 해석한다.

새 계층은 `ProviderRegistry → ConnectionRegistry → OpenAICompatibleAdapter → ChatCompletions`다. Manifest는 표시 이름, 인증 유형, 기본 주소, 수정 가능 여부, Key label, protocol, discovery 지원 여부를 정의한다. 복잡한 plugin framework는 없다. Registry가 UUID 기반 불변 `conn_…`와 `cred_…`를 생성한다. GUI의 연결 API는 이 Registry를 호출하며 업무용 `Application/Runtime`과 분리된다. Probe는 Task/Plan을 만들지 않는다. 향후 Route Broker가 이 경계를 통합한다.

## Credential 저장과 보안

GUI 입력은 macOS `Security.framework`의 generic-password Keychain에 보관한다. Python `ctypes` 호출이므로 shell, subprocess argv, `.env` 파일을 거치지 않는다. service는 `org.nidus.provider-connections.v1`, account는 불투명 credential reference다. Python 문자열의 완전한 메모리 zeroization을 보장하지는 않으며 조회 버퍼는 API 사용 직후 해제한다. Keychain 접근이 거부되면 평문 저장으로 우회하지 않는다. 새 GUI 연결의 Linux/Windows secret backend는 미지원이다.

현재 구현은 macOS에서 실제 검증한 SecKeychain API를 사용한다. Apple이 deprecated로 표시한 API이므로 향후 SecItem API로의 이전을 검토한다. [Apple 조회 API](https://developer.apple.com/documentation/security/seckeychainfindgenericpassword(_:_:_:_:_:_:_:_:)), [Apple 수정 API](https://developer.apple.com/documentation/security/seckeychainitemmodifyattributesanddata(_:_:_:_:)).

`EnvironmentCredentialProvider`는 `env:NIDUS_…_API_KEY` 또는 `_TOKEN` 형태를 읽는 호환 경로다. 새 GUI에서는 env reference를 입력받거나 env 파일을 만들지 않는다. DB에는 `credential_ref`만 기록한다. URL/name, 발견 모델 ID, 응답 모델명/본문에 현재 Key 원문이 섞이면 거부한다. 응답 본문은 Catalog/evidence에 저장하지 않는다. HTTP 오류 body는 읽지 않으며 GUI 연결 오류는 안전한 코드만 반환한다. HTTP 원격 주소, URL userinfo/query/fragment를 거부하고 loopback HTTP/원격 HTTPS만 허용하며 redirect와 시스템 proxy를 사용하지 않는다. TLS 검증은 기본값을 유지한다.

## Probe와 상태

| 상태 | 의미 |
|---|---|
| configured | 저장됨. 사용 가능성 미검증 |
| probing | 명시적 검사 진행 중 |
| ready | 최소 한 모델에서 정확한 일반 응답과 JSON 응답 모두 검증 |
| degraded | 일시적 오류, 후보 없음, 또는 chat 성공/구조화 검증 실패 |
| blocked | 인증/접근/요청 등 설정 또는 응답 검토가 필요한 실패 |

Probe는 endpoint 검증 → `GET /models` → 최대 3개 후보의 짧은 generation → 성공 후보의 `json_object` 검증 순서다. 각 HTTP timeout은 10초, generation 최대 출력은 64 tokens다. 일반 응답은 정확히 `READY`, 구조화 응답은 JSON을 파싱하여 정확히 `{"status":"READY"}`인지 검사한다. 한 번의 성공은 모든 모델이나 장기 안정성, 모든 JSON Schema의 지원을 보장하지 않는다. 후보는 모델 ID 정렬순 최대 3개이며 품질·가격을 추정하지 않는다. 자동 재시도/백그라운드 상태 갱신은 없다.

인증/접근 실패는 다른 모델로 blind fallback하지 않는다. 429는 `rate_limited`, 503은 `provider_unavailable`, timeout/network도 기존 `ModelError`와 동일한 코드를 사용한다. 구조화 요청에서 400 등 프로토콜 오류가 나면 실제 오류와 unverified capability를 남기며 “지원됨”으로 추측하지 않는다.

Discovery의 `supported`는 manifest 선언이고 `status=not_run/success/failed`는 실제 실행 결과다. `/models` 실패 시 해당 연결에서 **과거 발견한 ID만** 후보로 재사용한다. 인증 오류이면 재사용하지 않는다. 새 연결에 후보가 없으면 degraded로 남기며 모델명을 만들어내지 않는다. manual model ID UI는 없다. 성공한 discovery에서 사라진 기존 모델은 `unknown`으로 바뀐다.

## Catalog와 영속성

기존 SQLite에 `connections`, `model_catalog` 테이블을 추가했다. 업무 schema와 policy는 변경하지 않았다. Catalog key는 `(connection_id, model_id)`이며 발견 시각, availability, chat/structured_output 검증 결과, 최근 probe/성공/실패 시각, latency, actual model, token metadata를 보관한다. 가격/context/free quota는 근거가 없어 `null`(unknown)이다. availability는 unknown/available/temporarily_unavailable/rate_limited/authentication_failed/unsupported를 구분한다.

재시작하면 metadata와 reference를 복구하고 secret은 Keychain/env에서 다시 조회한다. 중단된 probing은 degraded/probe_interrupted로 정리한다. Store의 기존 프로세스 잠금으로 검사와 수정이 충돌하지 않게 한다. Keychain과 SQLite 사이에 분산 트랜잭션은 없으며 OS 또는 DB 실패 시 ready 상태를 유지하지 않도록 먼저 상태를 무효화한다. Keychain에 없는 키는 새 키 입력으로 복구할 수 있다.

API: GET `/api/connections`는 manifest와 연결/Catalog를 반환한다. POST `/api/connections`는 provider/base_url/secret/name으로 생성한다. POST `/api/connections/ID/{probe,update,delete}`는 재검사·설정 변경·삭제다. 기존 Host/Origin/session token 경계를 그대로 적용한다. 조회는 Key를 반환하지 않는다.

## 검증과 한계

- 전체 Python discovery 133개, 기존 HTTP integration 7개, frontend 10개 통과. 신규 14개에 fake Provider/GUI HTTP, 오류 분류, no redirect, 재시작, secret echo·저장·로그 방지, Key 손실 복구가 포함된다.
- [실제 Keychain](evidence/connection-keychain.json): 합성 키 put/get/replace/delete/exists/missing PASS. 임시 항목 삭제 완료.
- [실제 OmniRoute](evidence/connection-omniroute-live.json): 2개 모델 발견, 요청 `gh/gpt-4o-mini`, 응답 `gpt-4o-mini`, 일반/구조화 응답 PASS. 일반 응답 latency 1,152 ms, 14 tokens. 개인 Vault 자료 전송 없음.
- [브라우저 검증](evidence/connection-gui-review.json): 합성 fixture로 설정 화면·재검사·관리 disclosure 확인. 실제 Keychain/OmniRoute 검증과 별개다.

재현 명령:

```sh
python3 -m unittest discover -s tests -q
python3 tests/integration/model_http.py -q
python3 tests/integration/plan_http.py -q
node tests/gui_frontend.js
PYTHONPATH=. python3 scripts/credential_check.py
PYTHONPATH=. python3 scripts/connection_live.py --allow-synthetic-transmission \
  --credential-env-file /path/to/existing.env --evidence /tmp/new-connection-evidence.json
```

Live harness는 기존 env 파일을 읽기만 하고 값을 출력하지 않는다. endpoint/key가 없으면 NOT RUN이다. Fake HTTP 성공은 실제 Provider 성공으로 집계하지 않는다. Generic 호환 서비스 각각의 실접속(OpenAI/NIM/LM Studio 등), Linux/Windows Keychain backend, OAuth/native API, 자동 모델 선택, scheduler/GUI v2는 검증·지원 범위 밖이다. 다음 단계는 검증된 Connection/Catalog를 소비하는 제한적인 Route Broker다.
