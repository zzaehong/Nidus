# Nidus

TypeScript API 엔진과 SwiftUI macOS 앱입니다. Provider 모델 탐색, 텍스트 채팅, 사용자 설정 Tier 라우팅, 사용량·비용 기록을 제공합니다.

**지원 Provider:** OpenAI, Anthropic, Gemini, DeepSeek, NVIDIA NIM, Groq, Mistral AI, Cloudflare Workers AI.

**현재 상태:** API 연결·채팅·라우팅은 구현되어 있습니다. Phase 5–6 M0에서는 Apple Virtualization 기반 Linux VM, 독립 VM Manager, 장애 알림·사용자 복구 경로를 구현했습니다. **M0 전체 보안 검증은 아직 미통과**이며, 제품 Agent Runtime·Vault·Shell·브라우저는 사용할 수 없습니다. 현재 결과를 통합하고 M1~M6 개발을 준비하되, 검증되지 않은 Shell 실행을 활성화하지 않습니다.

## Phase 5–6: 남은 문제와 다음 단계

- **Manager 사망 후 VM 종료 확정:** SIGKILL 이후 파일·네트워크 활동 중단은 반복 관측했지만, 종료를 확정할 공개 API 근거는 확보하지 못했습니다. `STOP_UNCONFIRMED`를 유지하며 재실행·원본 반영·자료 삭제를 차단합니다. 시간 경과·PID 소멸·프로세스 재시작만으로 해제하지 않습니다.
- **실제 재부팅·앱 장애·UI 검증:** 호스트 부팅 ID 변경과 파일 무결성 정책은 Mock으로 검증했습니다. 실제 Mac 재부팅, SwiftUI 앱 crash, 복구 화면의 수동 조작·시각 검증은 미완료입니다. Framework 종료 오류도 실제 내부 장애가 아닌 fault injection으로 검증했습니다.
- **Workspace 및 네트워크 범위:** 승인된 최상위 파일 복사와 신규 파일 반영만 제한적으로 검증했습니다. 일반 재귀 merge·기존 파일 덮어쓰기·디렉터리 경쟁 조건, 외부 네트워크 허용 정책, 다른 Vault 동시 실행 격리는 추가 검증이 필요합니다. 현재 제품 실행 제한은 유지합니다.
- **복구 UI의 제한:** 앱의 **VM 복구**에서 M0 Registry를 직접 선택합니다. 살아 있는 Manager의 신뢰 가능한 채널이 있을 때만 종료를 요청할 수 있습니다. 이전 Registry에 Vault ID나 사전 파일 inventory가 없으면 추측하지 않으며, 재부팅만으로 잠금을 풀지 않습니다. 복구 bridge는 시스템 Python을 필요로 하고, 사용할 수 없으면 안전하게 차단합니다.
- **배포·지원 범위:** VM prototype은 macOS 27.0.1 / Linux ARM64 진단 이미지에서 검증했습니다. 일반 개발 toolchain, macOS 게스트, 다른 OS·기기, 제품 배포 서명·공증은 검증하지 않았습니다. 앱 자체의 최소 macOS 버전과 VM prototype의 검증 환경은 다릅니다.

다음 개발 브랜치는 `feature/agent-runtime-vault-m1-m6`입니다. Vault → Tool/권한 → 단일 Agent → 격리 Shell → 실행 감사 → SwiftUI 통합 순서로 준비합니다. **이번 develop 통합은 M0 통과나 제품 Shell 활성화 승인이 아닙니다.** 위 항목을 후속 검증 과제로 유지하고, Phase 7 Memory·Task 자동 재개는 포함하지 않습니다.

상세 설계와 실패 기록은 [Phase 5–6 문서](docs/Phase5_6_Agent_Runtime_Vault_Sandbox.md), 최신 실제 VM·Mock 결과는 [사용자 복구 Evidence](docs/evidence/Phase5_6_M0_VM_User_Recovery.json)를 참고하세요. 기존 FAIL·UNCONFIRMED·NOT_RUN 기록은 보존합니다.

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

최근 기록된 검증은 Node 174개·Swift 46개·Python M0 정책 테스트 21개 PASS, 앱 빌드 PASS입니다. 최신 실제 VM 복구 검증은 2 PASS / 1 UNCONFIRMED이며, 장애 차단 정책의 PASS를 VM 종료 확정으로 해석하지 않습니다. **M0 전체 자격은 미통과**이고 실제 Provider 호출 성공을 의미하지 않습니다. 상세 조건과 재현 방법은 검증 이력을 참고하세요.
