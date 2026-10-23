# API Connectivity MVP 아키텍처

현재 구현은 CLI → ConnectivityEngine → ProviderAdapter → HttpClient의 순서로 요청합니다. 엔진은 자격증명 저장소, 모델 캐시, 가격 레지스트리를 조합합니다. Provider별 인증 헤더·경로·페이지네이션·모델 메타데이터·요청 형식·사용량 정규화는 각 Adapter의 책임입니다.

| 경로 | 책임 |
| --- | --- |
| `src/types.ts` | 모델, 기능 상태, 채팅, 사용량, Adapter 공통 계약 |
| `src/adapters/` | OpenAI Responses, Anthropic Messages, Gemini generateContent, DeepSeek Chat Completions |
| `src/http.ts`, `src/errors.ts` | bounded HTTP 요청, 리다이렉트 거부, 응답 검증과 안전한 오류 |
| `src/engine.ts` | 연결 검증, 키 등록, 모델 갱신, 캐시와 가격 결합 |
| `src/storage.ts` | 비밀정보 없는 모델 목록의 원자적 파일 교체 |
| `src/credentials.ts`, `native/keychain.swift` | macOS Keychain과 명시적 환경변수 모드 |
| `src/pricing.ts` | 공식 출처를 가진 수동 가격 스냅샷과 정확한 ID 매칭 |
| `src/cli.ts`, `src/prompt.ts`, `bin/nidus.mjs` | 명령 검증, 숨김 키 입력, JSON 출력 |

`connect`는 새 키로 전체 모델 조회가 끝나기 전까지 저장소를 변경하지 않습니다. 목록은 메모리에 수집한 뒤 한 번에 교체하므로 중간 페이지 실패 시 일부 모델만 등록되지 않습니다. 키 교체 뒤 캐시 저장이 실패하면 기존 키를 복원합니다. 프로세스 강제 종료를 아우르는 두 저장소의 분산 트랜잭션은 아니므로 이 경우에는 다시 connect/refresh해야 합니다. 여러 CLI의 동시 키 교체를 직렬화하는 잠금은 MVP에 없습니다.

가격 레코드는 조회된 모델에만 매칭됩니다. 모델 ID가 가격 레지스트리에 없더라도 등록·채팅은 가능하며 가격만 미확인입니다. 기능 확인과 비용 확인은 독립적입니다. `unknown` 기능은 거부하지 않지만, API가 명시한 `unsupported` 기능은 거부합니다. Gemini처럼 메서드 지원만 확인되는 경우 일반 채팅 지원으로 단정하지 않습니다.

라이브러리는 `dist/index.js`와 생성된 타입 선언을 통해 사용할 수 있습니다. `ProviderAdapter`의 `listModels`, `getModel`, `chat`을 구현한 새 Adapter를 Engine에 주입할 수 있습니다. 테스트는 HttpClient 또는 Adapter·CredentialStore·ModelStore를 주입하여 외부 계정 없이 전체 흐름을 검증합니다. CLI에서는 임의 endpoint 설정을 노출하지 않습니다.

보안 경계: 키는 Keychain 또는 사용자가 주입한 환경에서 읽어 인증 헤더로만 전달합니다. macOS helper의 프로세스 인자는 비어 있으며 stdin/stdout Pipe로만 통신합니다. 오류 원문은 외부로 내보내지 않습니다. 모델 캐시는 key를 저장하지 않고, 일반적인 프롬프트/응답 로그도 만들지 않습니다. 모델 출력은 CLI stdout에 표시하므로 사용자가 리다이렉트한 경우의 파일 관리는 사용자 책임입니다.

현재 CLI는 단일 비스트리밍 텍스트 요청을 실행합니다. 멀티턴 메시지와 시스템 프롬프트는 라이브러리 계약에 제공됩니다. Tool Calling 기능 표시는 모델 메타데이터일 뿐 도구 실행을 의미하지 않습니다. 향후 기능을 위한 Agent/Router/Workflow 골격은 추가하지 않았습니다.
