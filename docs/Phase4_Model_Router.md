# Phase 4 — Task-Aware Model Router

2026-10-24, `feature/usage-ledger-budget-guard`에서 Phase 3 위에 구현. `develop` 병합하지 않음.

## 실행과 정책

SwiftUI 채팅방의 **자동 라우팅**을 켜고 Simple / Normal / Complex를 선택한다. 기본값 Normal,
기존 방은 수동 모드로 복원한다. 수동 Provider/모델 선택과 기존 검사 화면은 유지한다.
**후보·예산 확인**은 저장된 모델 목록과 SQLite만 읽으며 Provider API·토큰 계산 API를 호출하지 않는다.
실제 전송 시 같은 정책으로 재검사하므로 사전 조회 결과는 승인이나 예약이 아니다.

```sh
nidus chat --auto --difficulty simple
nidus chat --auto                         # Normal
nidus chat --auto --difficulty complex
nidus chat --provider openai --model gpt-4.1-mini  # 기존 수동 경로
nidus usage                              # routing 배열: 최근 200개 전환 이벤트
```

CLI `--auto`와 수동 Provider/모델/예산 예외 옵션을 함께 지정할 수 없다. SwiftUI `auto-chat`과
CLI는 `ConnectivityEngine.autoChat`을 공유한다. 난이도 분류를 위한 추가 LLM 호출은 없다.

1. 캐시에 실제 발견된 모델만 후보로 구성한다. 가격/등급 레코드는 모델 목록을 생성하지 않는다.
2. 정확한 Provider+ID의 검토된 등급, 텍스트 호환성, 일시 제외 상태, 가격과 안전한 상한,
   전체/Provider/단일 요청 예산을 검사한다. unknown 등급·가격은 자동 후보에서 제외한다.
3. Simple: lightweight → general → advanced. Normal: general → advanced. Complex: coding 및
   reasoning 특성이 검토된 advanced만 허용한다. 예산 부족으로 Complex를 경량 모델에 보내지 않는다.
4. 검증된 0원 상한을 최우선으로 하고 적합 등급에 100점 단위의 규칙 점수를 준다. 이 숫자는
   벤치마크·성공률·속도 측정치가 아니다. 동일 등급에서는 낮은 예약 상한, 확인된 최신 날짜,
   Provider/ID 순으로 결정한다. 날짜는 비용까지 동일한 후보의 동률을 해소하며 등급을 넘지 않는다.
   날짜 미확인은 최신으로 취급하지 않는다.
5. 전체 또는 후보 Provider 예산 80%부터 호환 등급 내에서 낮은 비용을 등급 순서보다 먼저 비교한다.
   90% saving 상태에서도 검증된 무료 후보가 항상 유료 후보보다 우선한다. 100%는 유료 요청 차단.
6. 실행 직전 `chat → execute → reserve`에서 `BEGIN IMMEDIATE` 트랜잭션으로 재검사·예약한다.
   후보 조회가 동시에 성공해도 실제 예약은 예산을 중복 사용하지 못한다.

현재 확인된 무료 계정 할당량 또는 무조건 무료 가격 레코드는 **없다**. Gemini 무료 티어 지원을
실제 무료 잔량으로 간주하지 않는다. 무료 우선 정책은 검증된 0원 상한 후보에 적용할 수 있도록
구현하고 Mock으로 검증했으며, 현 등록 모델은 모두 유료 상한으로 검사한다.

## 모델 정보와 출처

등급은 공급자의 모델 계열 설명에 근거한 Nidus의 작업 분류이며 공급자 간 객관적 성능 순위가 아니다.
`modelProfile`은 출처 URL·검증 시각·출시일·업데이트일을 보존한다. 업데이트일은 모두 미확인(null).
자동 전환용 프로필은 아래 8개 ID만 검토했으며 새 모델의 발견과 수동 선택은 계속 지원한다.

| ID | 등급 | 확인된 출시일 | 공식 출처 |
| --- | --- | --- | --- |
| gpt-4.1-mini, gpt-4.1-mini-2025-04-14 | lightweight | 2025-04-14 | [OpenAI 발표](https://openai.com/index/gpt-4-1/) |
| claude-sonnet-4-6 | general | 2026-02-17 | [Sonnet 발표](https://www.anthropic.com/news/claude-sonnet-4-6) |
| claude-opus-4-6 | advanced | 2026-02-05 | [Opus 발표](https://www.anthropic.com/news/claude-opus-4-6) |
| gemini-3.5-flash-lite | lightweight | 미확인 | [Google 모델 목록](https://ai.google.dev/gemini-api/docs/models) |
| gemini-2.5-flash | general | 미확인 | [Google 모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash) |
| deepseek-flash | general | 미확인 | [DeepSeek 모델·가격](https://api-docs.deepseek.com/quick_start/pricing/) |
| deepseek-v4-pro | advanced | 미확인 | [DeepSeek 모델·가격](https://api-docs.deepseek.com/quick_start/pricing/) |

확인 시점은 2026-10-24 UTC. 별칭의 숫자 접미사, API created, 지식 cutoff, 모델 카드 수정일을
공식 출시일로 추측하지 않는다. 입력·출력·캐시 가격과 무료 티어 정보는 Phase 3 가격 레코드를 그대로
재사용한다. 모델별 최근 실행/검사 상태는 SQLite에 보존하며 목록 조회만으로 사용 성공을 주장하지 않는다.

## 전환과 데이터

Rate Limit은 모델을 Retry-After(정수 초) 동안 제외한다. 헤더가 없으면 60초다. 모델 없음/호환성 오류도
60초 제외한다. 인증·권한·키 없음·잔액 부족은 해당 요청에서 Provider 전체를 제외하고 60초 동안
다음 요청의 후보에서도 제외한다. 키 재연결 성공은 Provider 제외 상태를 해제한다.
각 후보는 한 번만 실행하며 자동 예산 예외는 허용하지 않는다.

타임아웃·네트워크·취소·잘못된 응답·서버 오류·저장 실패는 전환을 중단한다. 명시적 거절에 대해 다음
후보를 실행하더라도 사용량이 없었던 이전 호출의 예약을 임의로 0원 정산하지 않는다. 따라서 오류가
이어지면 잔여 예산이 감소하고 다음 후보도 차단될 수 있다. 실패 응답의 사용량이 있으면 기존 장부가 정산한다.

SQLite schema 2는 기존 schema 1 장부를 유지하고 `route_events`, `model_health`를 추가한다.
전환 로그는 route ID, 시각, 최초 선택/다음 선택 모델, 전환 사유 코드, 실행 상태, 예산 판정과
예약 상한, 성공한 요청의 ledger ID만 기록한다. 프롬프트·키·Provider 오류 본문을 저장하지 않는다.
프로세스가 중단되면 selected 이벤트와 pending 예약을 남기며 자동 재실행/만료 정산하지 않는다.

SwiftUI는 실제 응답 모델, 전환 사유, 예약 상한, 응답 토큰 기반 추정 비용, 예산 상태를 표시한다.
대화 본문은 기존 채팅 저장소에만 보관한다. 이전 SwiftUI 검사 이력 JSON은 보존하며 자동 라우터의
SQLite 상태로 임의 승격하지 않는다. Phase 4 이후 공통 실행 경로의 성공/실패가 SQLite 상태를 갱신한다.

## 입력 예약 검토와 제약

[Anthropic 토큰 계산 문서](https://platform.claude.com/docs/en/build-with-claude/token-counting)는
계산 결과를 estimate로 설명하며 무료 별도 API를 제공한다. 후보 선정 시 실제 API를 호출하지 않는
요건과, 추정치만으로 하드 상한을 완화하지 않는 요건 때문에 이번에는 연결하지 않았다.
검증된 로컬 tokenizer의 전체 요청 framing·시스템 오버헤드·모델별 청구 상한도 증명하지 못했으므로
문자 수 heuristic을 안전한 상한으로 사용하지 않는다.

입력 컨텍스트 전체 예약은 유지한다. Gemini/DeepSeek는 reasoning을 포함한 출력 용량 전체도 유지한다.
화면의 **예약 상한**은 예상 청구액이 아니며 작은 요청도 과도하게 차단할 수 있다. 전송 후 토큰 기반
추정 비용은 별도로 표시한다. 가격 스냅샷은 기존 30일 유효기간을 따른다.

로컬 예산은 Nidus를 통한 요청 통제이며 Provider 최종 청구·외부 사용량의 절대 한도를 보장하지 않는다.
새 모델 자동 등급 추정, 벤치마크 생성, Agent/Tool 실행, 자동 충전은 구현하지 않는다.

## 통합 검증

2026-10-24, 실제 유료 호출 없이 검증:

- PASS: `npm test` 80개. 기존 Phase 3 테스트 68개와 라우터 12개.
- PASS: `swift test --scratch-path /tmp/nidus-phase4-build` 24개. 기존 21개와 라우팅 저장/표시 3개.
- PASS: `npm run build:app` macOS release 개발 번들 빌드.
- PASS: `git diff --check`.
- NOT RUN: 실제 Provider 추론, 실제 계정 무료 할당량 검증, 신규 화면의 수동 클릭 검증,
  코드 서명·공증·다른 Mac 실행. 실제 API 비용을 발생시키는 검증은 실행하지 않음.

Mock 범위: 난이도·최신성·unknown·검증된 무료 vs 무료 티어, 전체/Provider 예산과 80/90/100%,
Rate Limit/cooldown 복원, 인증/권한/잔액 오류, 타임아웃/네트워크 중복 실행 방지,
동시 예약 및 Phase 3 별도 프로세스 예약 경쟁, schema 1 마이그레이션, CLI/SwiftUI 공통 정책,
수동 채팅 유지, 기존 Provider Adapter·장부·대시보드 회귀.
