# Phase 4.1 — 사용자 설정 Tier Router

이 문서는 최초 Phase 4.1 구현 기록입니다. 이후 추가한 모델 Tier 재검증, 무료 상태와 모델별 승인,
드래그 순서 변경 및 schema 4는 [추가 개선 문서](Phase4_1_Free_Use.md)를 참고하세요.

2026-10-25 KST. 작업 브랜치 `feature/usage-ledger-budget-guard`.
Phase 3 장부·가격·예산 Guard와 Phase 4 엔진·전환 기록을 확장한다. develop에 병합하지 않는다.

## 사용 방법

툴바 **Tier 및 라우팅**에서 조회된 모델의 Tier를 변경하고, 난이도별 허용 Tier를 추가·제외하거나
위/아래로 이동한다. 모든 변경은 저장 성공 후 화면에 반영한다. 실패하면 오류를 보여주고 이전 값을 유지한다.
**기본 분류 복원**은 해당 모델의 사용자 변경만 해제한다. Unclassified를 직접 선택할 수도 있다.
Provider 모델 새로고침·재연결·앱 재시작은 Tier 및 정책을 초기화하지 않는다.

| Task Difficulty | 초기 Tier 순서 |
| --- | --- |
| Simple | 1 Lightweight → 2 General |
| Normal | 2 General → 1 Lightweight |
| Complex | 3 Advanced → 2 General |

빈 순서는 해당 난이도의 자동 호출을 비활성화한다. Complex를 `[3]`으로 제한하거나 Simple을 `[3,1]`로
설정할 수 있다. Tier는 사용자 작업 분류이며 가격·무료 여부·벤치마크 순위와 독립적이다.
기본값은 기존 `router.ts`의 검토된 모델 등급·출처를 재사용하고 신규 미분류 모델은 Tier 0으로 보존한다.
기본 분류 출처와 검증 시각 또는 사용자 지정 여부를 화면에 표시한다. 이번 변경에서 새로운 모델 성능이나
가격을 주장하거나 재검증하지 않았으며 기존 공식 자료 스냅샷을 사용한다.

**자동 라우팅에서 유료 API 사용 허용**의 초기값은 꺼짐이다. 기존 Phase 3·4 DB에도 이 기본값을 적용한다.
이 설정을 켜도 모든 예산 검사를 통과해야 한다. 수동 모델 호출은 기존 예산 Guard를 유지한다.
현재 검증된 무료 계정 할당량은 없으므로 무료 티어 지원 모델도 유료 상한으로 검사한다.

**사용량 및 예산**에서는 OpenAI/Anthropic/Gemini/DeepSeek 월간 한도 편집과 사용량을 우선 표시한다.
전체 월간·단일 요청 예산 편집은 **고급 설정**에 있으며 기존 값을 보존한다. Provider 0은 유료 차단,
미설정 Provider는 기존처럼 전체 한도를 상속한다. 전체·단일 요청 예산이 미설정이면 유료 호출을 차단한다.

```sh
nidus routing
nidus model-tier openai --model gpt-4.1-mini --tier 3
nidus model-tier openai --model gpt-4.1-mini --tier 0        # Unclassified
nidus model-tier openai --model gpt-4.1-mini --tier default  # 공식 자료 기반 기본값 복원
nidus routing-policy normal --tiers 2,1
nidus routing-policy complex --tiers 3
nidus routing-policy simple --tiers ''                     # 해당 난이도 비활성
nidus automatic-paid allow
nidus automatic-paid deny
nidus budget openai --usd 0
nidus chat --auto --difficulty normal
```

CLI와 SwiftUI는 같은 Engine·SQLite 설정을 사용한다. 설정 화면과 후보 조회는 유료 추론·모델 조회 API를
호출하지 않는다. 모델 목록 갱신은 기존 Provider 화면에서 명시적으로 실행한다.

## 선택과 전환

1. 난이도와 저장된 정책/버전을 읽는다.
2. Provider 캐시의 실제 모델만 후보로 구성한다. Tier 레코드는 모델 목록을 생성하지 않는다.
3. 미분류, 텍스트 비호환/미확인, 일시 제외, 가격/상한 미확인, 자동 유료 미허용, 예산 부족 후보를 제외한다.
   Tier 지정만으로 텍스트 호환성이나 가격이 검증되지는 않는다.
4. **사용자 Tier 순서 → 같은 Tier의 낮은 비용(검증된 0원 포함) → 확인된 최신 날짜 → Provider/ID**로 정렬한다.
   80%/90% 예산 상태에서도 Tier 순서가 최우선이다. 날짜는 같은 Tier·비용의 보조 기준이다.
5. 현재 Tier의 사용 가능한 다른 모델/Provider를 먼저 시도하고, 소진되면 다음 허용 Tier를 시도한다.
   명시적 거절 오류의 전환과 타임아웃·네트워크·취소·응답 해석 오류의 중단은 Phase 4 정책을 유지한다.
6. 실제 호출 직전 예약 트랜잭션에서 전체/Provider/단일 예산과 정책 버전·유료 허용을 재검사한다.
   후보 조회 중 설정이 변경되면 오래된 계획으로 실행하지 않고 차단한다. 사용자가 다시 전송하면 새 정책을 사용한다.

Tier 순서는 요청 시작 때 계획하며, 다른 프로세스에서 예산이 정산되어 새로 사용 가능해진 후보를 같은
요청 중 재탐색하지 않는다. 미확인 실패 비용은 0으로 바꾸지 않고 예약을 유지한다. 요청별 모델 전환의
비용과 제한은 기존 장부에서 독립적으로 관리한다.

전환 로그와 채팅 결과에 실제 Tier를 추가한다. 기존 로그·채팅에는 Tier가 없으므로 이전 기록으로 표시한다.
전환 사유, 실제 모델, 토큰, 예약 상한·응답 사용량 기반 추정 비용을 함께 표시한다. 키·프롬프트·응답 본문을
Tier 설정이나 라우팅 로그에 저장하지 않는다.

## 저장 및 마이그레이션

SQLite schema 3은 DDL과 초기 설정 삽입을 트랜잭션으로 실행한다.

- `model_tiers`: Provider+정확한 Model ID, Tier 0/1/2/3, 출처, 검증 시각, 사용자 수정 여부, 변경 시각.
  발견 모델의 기본값을 최초 조회 시 저장하며 새로고침은 기존 배정을 덮어쓰지 않는다.
- `routing_settings`: 난이도별 순서 JSON, 자동 유료 허용, 변경 버전. 개별 설정 변경은 버전을 증가시킨다.
- `budgets`, `requests`, `route_events`, `model_health` 등 기존 테이블과 기록은 유지한다.

schema 1/2에서 schema 3으로 업그레이드하며 이후 구버전 앱은 newer-schema 오류로 열기를 거부한다.
모델 기본값이 후속 코드에서 바뀌어도 저장된 배정은 유지된다. **기본 분류 복원**으로 최신 코드의 기본값을
명시적으로 적용할 수 있다. 예산 변경은 기존 예산 이력에 기록한다.

## 검증 및 한계

- PASS: `npm test` 91개. Phase 3·4 회귀와 Tier 정책·보존·예산·전환·마이그레이션·별도 SQLite 연결의 정책 취소 경쟁.
- PASS: `swift test --scratch-path /tmp/nidus-phase41-build` 27개. 기존 24개와 설정 전송·저장 상태·채팅 Tier 표시 3개.
- PASS: `npm run build:app` macOS release 개발 번들 빌드.
- PASS: `git diff --check`.
- NOT RUN: 실제 Provider API 호출, 실제 유료 사용, 신규 화면 수동 클릭, 다른 Mac 실행 및 서명·공증.

초기 회귀 실행은 89 PASS / 1 FAIL이었다. 기존 테스트가 모델 등급만 변경하고 독립 Tier 값을
그대로 둔 fixture를 수정한 뒤 최종 전체 테스트가 통과했다. 기존 실패 검증 이력은 숨기지 않는다.

입력 전체 용량 기반의 보수적인 예약 상한, 가격 스냅샷 만료, 실제 무료 할당량 미확인은 Phase 3·4의
제약을 유지한다. 사용자가 Tier를 배정해도 미확인 가격 모델은 자동 호출하지 않는다. 로컬 Guard는
Provider의 최종 청구나 Nidus 외부 사용량을 절대적으로 제한하지 않는다.

OmniRoute의 Tier 분리 개념을 사용자 요구사항 수준에서 참고했다. 외부 라우터 코드·종속성·서비스를
도입하지 않았다. 자동 난이도 분류, 모델 벤치마크, Agent/Tool Runtime, Vault/Sandbox/OpenClaw,
자동 충전은 추가하지 않았다.
