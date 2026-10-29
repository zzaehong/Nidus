# Nidus

TypeScript API 엔진과 SwiftUI macOS 앱입니다. Provider 모델 탐색, 텍스트 채팅, 사용자 설정 Tier 라우팅, 사용량·비용 기록을 제공합니다.

**지원 Provider:** OpenAI, Anthropic, Gemini, DeepSeek, NVIDIA NIM, Groq, Mistral AI, Cloudflare Workers AI.

**현재 상태:** API 연결·채팅·라우팅은 구현되어 있습니다. Agent Runtime·Vault·Shell·브라우저는 Phase 5–6 설계 및 M0 검증 단계이며 사용할 수 없습니다. M0에서 분리된 자식 프로세스 종료 실패가 확인되어 실행 backend를 채택하지 않았습니다.

## 시작하기

Node.js 22.13 이상, npm, macOS 13 이상과 Swift 5.9 이상의 개발 도구가 필요합니다. Keychain helper 빌드에는 `swiftc`가 필요합니다.

```sh
npm ci
npm run build:app
open dist/Nidus.app
```

앱에서 Provider 선택 → **API Key 등록 / 변경** → 계정 과금 유형 확인 → 모델 조회 순서로 연결합니다. Cloudflare는 Account ID도 필요합니다. 모델 조회 성공은 모든 모델의 실행 권한이나 무료 사용을 보장하지 않습니다.

개발 실행:

```sh
npm run build
npm run build:keychain
swift run NidusNativeApp
```

앱 번들은 현재 머신의 Node를 포함하는 로컬 개발용입니다. 배포 서명·공증과 다른 Mac에서의 실행은 검증하지 않았습니다.

## CLI

전역 설치 없이 `npm exec --offline -- nidus <명령>`을 사용하거나, `npm link` 후 아래처럼 실행합니다.

```sh
nidus providers
nidus connect gemini
nidus models gemini
nidus models gemini --refresh
nidus chat --provider gemini --model '<조회된 모델 ID>'
nidus chat --auto --difficulty normal
nidus usage
nidus routing-context --difficulty normal
nidus soft-budget gemini --usd 5.00
nidus --help
```

채팅·모델 응답 검사는 실제 API 요청이며 비용이 발생할 수 있습니다. 키를 명령줄 인자나 저장소에 넣지 마세요.

## 실행 권한과 비용

- 계정 상태는 **Free Only / Hybrid / Paid Only / Unknown**으로 관리합니다. 현재 확인 정보는 사용자 선언이며 공식 Billing 검증이 아닙니다.
- Free Only는 공식 무료 지원 모델만 허용합니다. Hybrid·Paid Only는 Provider 유료 승인이 필요합니다. Unknown은 자동 실행을 차단하며 수동 요청별 승인을 제공합니다.
- **금액 Budget Guard와 비용 예약은 없습니다.** Soft Budget은 참고용 월간 목표이며 초과해도 실행을 막지 않습니다.
- 비용·사용량 미확인은 `null`입니다. 사용자 무료 선언에 따른 추정 0원은 Provider가 확인한 청구 금액이 아닙니다.

## 문서

| 문서 | 내용 |
|---|---|
| [사용 가이드](docs/USER_GUIDE.md) | 연결, 계정 권한, 채팅, Tier, 모델 검사, CLI |
| [아키텍처](docs/API_CONNECTIVITY.md) | 공통 실행 경로, 저장소, 가격·사용량, 보안 경계 |
| [Routing Context](docs/Phase4_4_Routing_Context.md) | JSON v2 계약, 비용 완전성, Soft Budget |
| [Agent·Vault 계획](docs/Phase5_6_Agent_Runtime_Vault_Sandbox.md) | Phase 5–6 계약, 마일스톤, M0 중단 조건 |
| [검증 이력](docs/VALIDATION.md) | 단계별 결과, 실패·미검증 항목, M0 evidence |
| [제품 개념](docs/CONCEPT.md) | 장기 방향과 AI Office 개념 |
| [작업 지침](docs/AGENTS.md) · [Git Flow](docs/Git_Flow.md) | 저장소 작업·검증·병합 규칙 |

## 테스트

```sh
npm test                 # TypeScript 빌드 + Mock/회귀 테스트
swift test               # Swift 상태·전달 계층 테스트
npm run test:keychain    # 별도 테스트 항목에 가짜 키 저장·삭제
npm run test:live        # opt-in 없으면 실제 API 테스트 skip
```

최근 기록된 검증은 Node 171개·Swift 42개 PASS, 앱 빌드 PASS입니다. **M0 보안 검증은 별도로 FAIL**이며 실제 Provider 호출 성공을 의미하지 않습니다. 상세 조건과 재현 방법은 검증 이력을 참고하세요.
