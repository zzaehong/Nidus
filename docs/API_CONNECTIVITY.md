# API Connectivity MVP 아키텍처

현재 구현은 CLI → ConnectivityEngine → ProviderAdapter → HttpClient의 순서로 요청합니다. 엔진은 자격증명 저장소, 모델 캐시, 가격 레지스트리를 조합합니다. Provider별 인증 헤더·경로·페이지네이션·모델 메타데이터·요청 형식·사용량 정규화는 각 Adapter의 책임입니다.

macOS 대시보드는 SwiftUI → 요청별 Node 자식 프로세스(`dist/dashboard.js`) → 동일한 ConnectivityEngine 경로를 사용합니다. Swift에 Provider HTTP 구현이나 모델 목록을 복제하지 않습니다.

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
| `src/dashboard.ts` | 단일 요청/응답 JSON envelope, 캐시 전용 읽기, 기존 엔진 호출 |
| `Sources/NidusNativeApp/Runtime.swift` | Node/Runtime 탐색, 비동기 프로세스와 Pipe 수명, 오류/타임아웃 |
| `Sources/NidusNativeApp/Models.swift` | Codable 응답, Provider별 독립 상태, 연결 결과의 모델 자동 반영 |
| `Sources/NidusNativeApp/App.swift` | SwiftUI 서비스·모델·가격·응답 화면, AppKit 보안 키 입력 |
| `scripts/build-app.mjs`, `native/Info.plist` | 현재 머신용 Node 포함 로컬 앱 번들 |

`connect`는 새 키로 전체 모델 조회가 끝나기 전까지 저장소를 변경하지 않습니다. 목록은 메모리에 수집한 뒤 한 번에 교체하므로 중간 페이지 실패 시 일부 모델만 등록되지 않습니다. 키 교체 뒤 캐시 저장이 실패하면 기존 키를 복원합니다. 프로세스 강제 종료를 아우르는 두 저장소의 분산 트랜잭션은 아니므로 이 경우에는 다시 connect/refresh해야 합니다. 여러 CLI의 동시 키 교체를 직렬화하는 잠금은 MVP에 없습니다.

가격 레코드는 조회된 모델에만 매칭됩니다. 모델 ID가 가격 레지스트리에 없더라도 등록·채팅은 가능하며 가격만 미확인입니다. 기능 확인과 비용 확인은 독립적입니다. `unknown` 기능은 거부하지 않지만, API가 명시한 `unsupported` 기능은 거부합니다. Gemini처럼 메서드 지원만 확인되는 경우 일반 채팅 지원으로 단정하지 않습니다.

라이브러리는 `dist/index.js`와 생성된 타입 선언을 통해 사용할 수 있습니다. `ProviderAdapter`의 `listModels`, `getModel`, `chat`을 구현한 새 Adapter를 Engine에 주입할 수 있습니다. 테스트는 HttpClient 또는 Adapter·CredentialStore·ModelStore를 주입하여 외부 계정 없이 전체 흐름을 검증합니다. CLI에서는 임의 endpoint 설정을 노출하지 않습니다.

보안 경계: 키는 Keychain 또는 사용자가 주입한 환경에서 읽어 인증 헤더로만 전달합니다. macOS helper의 프로세스 인자는 비어 있으며 stdin/stdout Pipe로만 통신합니다. 오류 원문은 외부로 내보내지 않습니다. 모델 캐시는 key를 저장하지 않고, 일반적인 프롬프트/응답 로그도 만들지 않습니다. 모델 출력은 CLI stdout에 표시하므로 사용자가 리다이렉트한 경우의 파일 관리는 사용자 책임입니다.

현재 CLI는 단일 비스트리밍 텍스트 요청을 실행합니다. 멀티턴 메시지와 시스템 프롬프트는 라이브러리 계약에 제공됩니다. Tool Calling 기능 표시는 모델 메타데이터일 뿐 도구 실행을 의미하지 않습니다. 향후 기능을 위한 Agent/Router/Workflow 골격은 추가하지 않았습니다.

## macOS 전달 계층과 상태

각 작업은 하나의 자식 프로세스를 사용하며 stdin EOF 이후 `{method, provider, ...}`를 처리하고 stdout에 `{result}` 또는 `{error}`를 한 번 출력한 뒤 종료합니다. 이전 폐기 구현의 상주 JSON-RPC 세션을 재도입하지 않았습니다. 키는 stdin으로만 전달하고 명령줄에 포함하지 않습니다. stderr는 JSON 파서에 합치지 않으며 앱 로그로도 전달하지 않습니다. 이 선택은 디버깅 출력을 제한하는 대신 비밀정보의 의도치 않은 로그 기록을 줄입니다.

입력 1 MiB, 앱 측 응답 32 MiB 제한이 있습니다. 기존 HTTP 타임아웃(모델 조회 30초, 채팅 120초) 외에 Node 작업 240초, Swift watchdog 245초를 적용합니다. 종료·비정상 응답·비정상 exit는 오류로 반환합니다. 시간 초과 시 TERM 후 1초 내 종료하지 않으면 KILL하고 Pipe를 정리합니다. 앱 종료 시 실행 중인 작업을 종료합니다. 수동 요청 취소 버튼은 제공하지 않습니다.

시작 시 `ping` 성공 후에만 엔진 준비 상태를 표시합니다. 이후 `cached`로 네 Provider의 로컬 모델 목록을 읽되 API/Keychain을 건드리지 않습니다. `connect`의 Models API 결과를 UI에 직접 반영하므로 별도 수동 새로고침이 필요하지 않습니다. 공급자별 busy 상태로 같은 앱 내 중복 작업을 막고, 응답은 요청 당시 Provider에만 기록합니다. 다른 CLI/앱 프로세스와의 동시 키 교체 잠금은 없으므로 계정 교체는 한 곳에서 수행해야 합니다.

가격 상세와 원본 데이터에는 기존 출처·확인시각·조건을 유지합니다. 응답 테스트는 단일 요청이며 전송마다 대화 이력을 누적하지 않습니다. 사용량 원본은 엔진 응답에 보존되고 화면에는 입력/출력/합계만 표시합니다. 키·프롬프트·응답을 앱 설정에 저장하지 않습니다. `.app`은 로컬 개발 번들이며 코드 서명, 공증, 업데이트와 배포 보안은 별도 후속 작업입니다.
