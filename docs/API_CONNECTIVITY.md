# 아키텍처와 데이터 보관

현재 구현 경로는 **CLI / SwiftUI → ConnectivityEngine → ProviderAdapter → HttpClient**입니다. 추론은 공통 경로에서 실행 권한을 확인하고 SQLite에 요청을 기록한 뒤 전송·정산합니다. 모델 조회는 추론을 보내지 않습니다. Agent·Tool 실행은 아직 구현되지 않았으며 [별도 계획](Phase5_6_Agent_Runtime_Vault_Sandbox.md)에 따릅니다.

## 모듈 경계

| 모듈 | 책임 |
|---|---|
| `src/engine.ts` | 연결, 모델·가격 결합, 공통 실행, 계정 권한, 라우팅 |
| `src/adapters/`, `src/http.ts`, `src/errors.ts` | 인증·페이지네이션·요청 변환·토큰 정규화, 타임아웃·안전한 오류 |
| `src/credentials.ts`, `native/keychain.swift`, `src/storage.ts` | Keychain/환경 자격 증명, 모델 캐시 |
| `src/ledger.ts`, `src/pricing.ts`, `src/money.ts`, `src/provider-usage.ts` | SQLite 기록·정산·권한, 가격 스냅샷·정수 금액, 계정 조회 |
| `src/router.ts`, `src/routing-context.ts` | Tier 규칙 기반 선택, 별도의 읽기 전용 Context Builder |
| `src/classification.ts`, `src/nvidia-classification.ts`, `src/health.ts` | 용도 분류와 텍스트 probe |
| `src/cli.ts`, `src/dashboard.ts` | CLI 및 SwiftUI용 요청 인터페이스 |
| `Sources/NidusNativeApp/` | UI, 단발 Node 전달 계층, 채팅방·모델 검사 기록 |

Provider별 요청은 OpenAI `/responses`, Anthropic `/messages`, Gemini `:generateContent`, 나머지 OpenAI-compatible `/chat/completions`를 사용합니다. Cloudflare는 Account ID 기반 Models Search 및 `/ai/v1/chat/completions`를 사용하며 비텍스트 native run을 범용 변환하지 않습니다. 모델 ID는 공식 조회 값을 보존하며 가격·분류 표가 모델 목록을 생성하지 않습니다. `supported/unsupported/unknown` 기능 상태는 실제 계정 권한과 별개입니다.

모델 전체 페이지를 검증한 뒤 캐시를 원자적으로 교체합니다. 연결 시 키 저장 후 캐시 쓰기가 실패하면 키를 복구하지만, Keychain과 파일 시스템 전체의 분산 트랜잭션이나 동시 키 교체 잠금은 없습니다. 강제 중단 후 재연결이 필요할 수 있습니다.

## 실행 권한과 전달 계층

`ConnectivityEngine.execute()` 직전 `BEGIN IMMEDIATE`에서 계정·키 fingerprint·승인·모델 무료 지원·Tier·revision을 재검사하고 요청 기록 및 일회용 승인 소비를 처리합니다. 철회가 먼저 확정되면 전송하지 않지만 이미 승인·전송된 요청을 소급 취소하지 않습니다. 지출 한도나 비용 예약은 없습니다.

Dashboard는 stdin EOF 이후 JSON 요청을 받고 stdout에 `{result}` 또는 `{error}` 하나를 출력합니다. 요청마다 Node 자식 프로세스를 생성하며 키를 명령줄에 넣지 않습니다. stderr와 Provider 원문 오류는 앱 로그로 전달하지 않습니다. 입력 1 MiB, Swift 응답 32 MiB, Node 240초, Swift watchdog 245초 제한입니다. HTTP 기본 제한은 모델 조회 30초·채팅 120초이며 본문 읽기·전체 페이지 조회에도 적용합니다. 종료 시 TERM→1초 후 KILL을 사용합니다. **이 처리는 임의 Shell의 분리된 자식까지 종료한다는 보장이 아닙니다.**

수동 API 요청은 자동 재시도하지 않습니다. 자동 라우팅은 명시적 거절에만 Fallback합니다. HTTP 리다이렉트는 인증정보 전달을 막기 위해 거부합니다. CLI 성공은 JSON stdout, 오류는 안전한 JSON stderr이며 취소 종료 코드는 130입니다.

## 저장 위치와 개인정보

| 저장소 | 내용 |
|---|---|
| Keychain service `com.nidus.connectivity` | Provider별 키. Cloudflare 토큰과 Account ID. 동기화하지 않는 기기 전용 항목 |
| `~/.local/share/nidus/<provider>.json` | 모델 목록·확인 시각. 키·대화 없음 |
| `~/.local/share/nidus/usage.sqlite` | 요청·토큰·가격·비용·계정 권한·Tier·전환·Soft Budget |
| `~/Library/Application Support/Nidus/model-health.json` | 모델별 최신 검사 결과. 키·프롬프트·생성 본문 없음 |
| `~/Library/Application Support/Nidus/chat-rooms.json` | 채팅방과 메시지 본문. Usage Ledger와 별개 |

모델 캐시/DB 생성 권한은 파일 0600·디렉터리 0700입니다. 키는 요청 중 메모리에 존재하며 JavaScript 문자열의 완전한 소거를 보장하지 않습니다. helper가 없으면 평문 저장으로 대체하지 않습니다. CLI 출력 리다이렉트나 사용자 백업의 보관 책임은 별도입니다.

SQLite는 schema 8, WAL, synchronous=FULL, busy_timeout 5초를 사용합니다. schema 7의 계정 권한·일회용 승인·권한 이벤트와 schema 8의 `soft_budgets`를 추가하면서 이전 요청·예산·예약·Tier·전환 기록을 보존했습니다. 과거 예약과 호환용 예산 필드는 실행 정책이 아닙니다. 신규 요청은 `reserved=0`, `bound=NULL`, `settlement=tracking`으로 기록합니다.

## 가격·사용량·정산

금액은 정수 nano-USD(1 USD = 10⁹), JSON은 소수 문자열입니다. 가격은 정확한 Provider+Model ID의 공식 자료 수동 스냅샷이며 `checkedAt`과 출처·조건을 보존합니다. 모델 새로고침은 가격 갱신이 아닙니다. 미검토 가격은 unknown이며 실제 무료 할당량을 추정하지 않습니다.

입력·출력·캐시 가격을 구분하고 출력에 포함된 추론 토큰을 중복 합산하지 않습니다. Anthropic 입력은 uncached+cache read+cache write, Gemini 출력은 후보+thinking 토큰입니다. 복잡한 조건을 확정 단일 가격으로 표시하지 않습니다. 캐시 쓰기 TTL을 모르면 비용을 미확인으로 유지하고 DeepSeek 시간 조건은 보수적 추정과 원래 조건을 함께 보존합니다.

요청별 가격 스냅샷이 있어 현재 가격 변경으로 과거 비용을 재계산하지 않습니다. 실패·취소·타임아웃·강제 종료 후 사용량을 모르면 비용은 null이며 자동으로 0원 처리하거나 재시도하지 않습니다. 응답 누락·pending 기록을 자동 정산하지 않습니다. DB에는 키·프롬프트·응답 본문·임의 Provider 오류를 저장하지 않습니다.

OpenAI/Anthropic 조직 사용량·비용 조회는 별도 Admin 환경변수만 사용합니다. DeepSeek는 공식 USD balance를 조회하며 임의 환산하지 않습니다. Gemini 및 조회를 연결하지 않은 Provider는 잔량을 생성하지 않습니다. 조직 집계는 요청별 비용으로 배분하지 않습니다. `UsageLedger.reconcile`은 신뢰 가능한 요청별 청구 증거의 확장 지점이며 현재 조직 조회가 이를 자동 호출하지 않습니다.

세부 비용 집계·Soft Budget 계약은 [Routing Context](Phase4_4_Routing_Context.md), 정책·명령은 [사용 가이드](USER_GUIDE.md), 과거 변경·테스트는 [검증 이력](VALIDATION.md)에 모았습니다. 가격·모델별 공식 출처는 `src/pricing.ts`, `src/providers.ts`, `src/nvidia-classification.ts`와 UI의 출처 필드가 기준입니다. 문서 정리 과정에서 공식 자료를 새로 검증한 것은 아닙니다.

## Phase 5–6 확장 설계 — 미구현 계약

[갱신된 설계](Phase5_6_Agent_Runtime_Vault_Sandbox.md)는 Provider와 실행 도구를 분리한다. 기존 텍스트 API/Router/Usage Ledger를 유지하면서 Adapter는 Tool Calling 형식을 공통 호출로 정규화하고, Agent Runtime과 Unified Tool Registry/Permission Gateway가 실제 실행을 결정할 예정이다. 현재 `ChatRequest`/`ChatResponse`는 텍스트 중심이며 Tool 실행 계약이나 이미지 API가 이미 구현됐다는 의미가 아니다.

실행 대상은 **Host 파일 Gateway / Vault 소유 VM Gateway / Provider Tool Gateway**다. Shell·브라우저 검색/탐색은 VM 내부에서, 이미지 생성은 Provider API에서 처리한다. 검색 API는 도입하지 않는다. 텍스트 추론·Host 작업·이미지 API는 VM slot을 사용하지 않는다. 이미지 저장도 별도의 Host 변경 승인과 사용량·비용 기록을 거치며 가격 미확인은 null이다.

Vault는 VM Environment를 보유하고 실제 Instance는 독립 Manager가 제어한다. 초기 활성 VM/Session 상한과 장애 격리는 Host Registry에서 관리할 계획이다. 기존 M0의 Run 중심 metadata·복구 UI는 검증용 구현이며 Vault별 공유 VM·Session 재사용을 검증한 것으로 취급하지 않는다. 이번 변경에는 코드·DB migration·Provider endpoint 변경이 없다.
