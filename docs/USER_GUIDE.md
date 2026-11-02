# 사용 가이드

설치와 실행은 [README](../README.md), 데이터·전달 계층은 [아키텍처](API_CONNECTIVITY.md)를 참고하세요. 이 문서는 현재 동작만 설명합니다.

## Provider 연결

Provider 카드에서 키 발급 페이지를 열고 키를 입력합니다. 연결·새로고침·해제, 발견 모델 수, 마지막 조회 시각을 공통 화면에서 확인합니다.

| Provider ID | 키 발급·관리 | 추가 정보 |
|---|---|---|
| openai | [OpenAI](https://platform.openai.com/api-keys) | API Key |
| anthropic | [Anthropic](https://console.anthropic.com/) | API Key |
| gemini | [Google AI Studio](https://aistudio.google.com/apikey) | 프로젝트의 실제 결제 상태 확인 |
| deepseek | [DeepSeek](https://platform.deepseek.com/) | API Key |
| nvidia | [NVIDIA API Catalog](https://build.nvidia.com/) | 개발자 Hosted API와 자체 호스팅 구분 |
| groq | [GroqCloud](https://console.groq.com/keys) | Free/Developer 계정 구분 |
| mistral | [Mistral Studio](https://console.mistral.ai/) | 무료 실험 모드·유료 계정 구분 |
| cloudflare | [Cloudflare](https://dash.cloudflare.com/) | API Token + 32자리 hex Account ID |

```sh
nidus connect gemini
nidus connect cloudflare --account-id '<account-id>'
nidus models gemini --detail '<모델 ID>'
nidus pricing gemini
nidus disconnect gemini
```

`connect`는 전체 모델 조회에 성공한 뒤 키와 캐시를 저장합니다. 실패하면 기존 연결을 보존하며, 캐시 저장 실패 시 키 교체를 되돌립니다. `models`는 캐시를 사용하되 캐시가 없거나 `--refresh`이면 API를 조회합니다. 앱 시작은 캐시만 읽습니다. NVIDIA의 카탈로그 접근 성공은 키의 추론 권한 검증이 아니며, 다른 Provider도 모델 목록이 채팅 성공·잔액·무료 할당량을 보장하지 않습니다.

키·계정 변경 시 과금 유형을 재확인합니다. 모델 목록 새로고침은 사용자 Tier를 초기화하지 않습니다. CLI 환경 자격 증명은 `NIDUS_<PROVIDER>_API_KEY`와 `connect --env`를 사용하며, Cloudflare는 `NIDUS_CLOUDFLARE_ACCOUNT_ID`도 필요합니다. 활성 환경 키는 CLI에서 Keychain보다 우선하고 다른 계정 캐시 사용을 피하려고 모델을 재조회합니다. SwiftUI는 Keychain을 사용합니다.

## 계정 과금 유형과 실행 권한

연결 시 또는 **Routing Policy → 과금 유형 / 실행 권한**에서 설정합니다.

| 상태 | 호출 정책 |
|---|---|
| Free Only | 사용자 확인된 무료 전용 계정 + 공식 무료 지원 모델만 허용. 유료 전용·무료 지원 미확인·무료 사용 불가 모델은 차단 |
| Hybrid | 무료에서 유료로 전환될 수 있는 요청은 유료 가능 요청으로 판단. Provider 유료 승인 필요 |
| Paid Only | Provider 유료 승인 필요 |
| Unknown | 자동 호출·일괄 검사 차단. 수동 채팅·단일 검사는 요청별 위험 승인으로만 허용 |

유료 승인은 **해당 Provider의 현재·향후 모델 전체**에 적용합니다. 계정 확인은 사용자 선언이며 Billing API 검증이 아닙니다. 같은 키의 결제 설정이 바뀌어도 자동 감지하지 못하므로 설정을 갱신해야 합니다. 잘못된 Free Only 선언은 실제 과금으로 이어질 수 있습니다. 무료 티어의 존재·Rate Limit 헤더·잔액을 잔여 무료 할당량으로 해석하지 않습니다.

```sh
nidus billing gemini
nidus billing-set gemini --billing-type free_only --confirm-billing --accept-charge-risk
nidus billing-set openai --billing-type paid_only --allow-paid --confirm-billing --accept-charge-risk
# 유료 승인 철회: --allow-paid 없이 다시 저장
nidus billing-set openai --billing-type paid_only --confirm-billing --accept-charge-risk
# Unknown 계정의 수동 요청 한 번만 승인
nidus chat --provider gemini --model '<모델 ID>' --approve-once
```

실행 직전 공통 경로에서 현재 계정·키·권한·Tier를 다시 검사합니다. 이미 전송된 요청의 과금 취소는 보장하지 않습니다. `execution_permission` 오류의 reason으로 `account_unknown`, `provider_paid_not_approved`, `free_model_unverified`, `free_unavailable`, `account_changed` 등을 구분합니다. 금액 예산 부족 오류를 해결하기 위해 예전 `budget` 명령을 사용할 필요는 없습니다. 해당 명령과 비용 예약은 제거됐습니다.

## 모델 Tier와 자동 라우팅

**Model Tier**에서 Tier 1 Lightweight / Tier 2 General / Tier 3 Advanced를 배정합니다. 미분류는 Unclassified(0)이며 자동 선택하지 않습니다. Tier는 가격·무료 여부·벤치마크 순위와 독립적입니다. 조회된 모델만 표시하며 최신이라는 이유로 높은 Tier를 부여하지 않습니다.

**Routing Policy**에서 난이도별 허용 Tier를 드래그해 정렬하고 휴지통 버튼으로 제외합니다. 기본 순서는 Simple 1→2, Normal 2→1, Complex 3→2입니다. Tier 순서가 비용보다 우선하고 같은 Tier 내 후보를 먼저 탐색합니다. 사용자 설정은 재시작·모델 새로고침 후 유지됩니다.

```sh
nidus routing
nidus model-tier gemini --model '<모델 ID>' --tier 2
nidus model-tier gemini --model '<모델 ID>' --tier default
nidus routing-policy complex --tiers 3,2
nidus chat --auto --difficulty normal
```

Rate Limit·인증·모델 미지원 같은 명시적 거절은 허용 Tier 안에서 Fallback합니다. 타임아웃·네트워크·서버·응답 해석·저장 오류처럼 처리가 불명확하면 중단합니다. Free Only로 시작한 자동 요청은 유료 승인이 있어도 유료 후보로 전환하지 않습니다. 후보 조회는 추론을 호출하지 않습니다. 화면에서 실제 선택 모델·전환 사유·추정 비용을 확인합니다.

Model Tier의 무료 상태는 verified / unverified / unavailable / unsupported를 구분합니다. 공식 무료 지원 모델은 전체 선택해 상태를 기록할 수 있습니다. 일괄 저장은 순차 처리여서 일부 실패할 수 있고, 재시도 시 완료된 모델을 건너뜁니다. 이 기록은 Provider 유료 승인이나 Billing 검증을 대신하지 않습니다.

## 채팅과 모델 검사

채팅방은 Provider·모델을 바꾸며 대화 문맥을 이어갈 수 있습니다. 채팅방의 수동 모델 목록은 텍스트 호환 모델 중 저장된 검사 결과가 passed인 모델로 제한됩니다. 앱 채팅 기록에는 메시지 본문이 저장되므로 민감한 내용을 입력할 때 주의하세요. Usage Ledger와 모델 검사 기록에는 본문을 저장하지 않습니다. CLI `chat`은 stdin 또는 대화형 입력을 받는 단일 요청이며 기본 최대 출력은 1,024토큰입니다. `--max-output-tokens`, `--timeout-ms`로 조정합니다.

모델 용도는 API 메타데이터를 우선하고 이름 기반 분류는 추정으로 표시합니다. NVIDIA는 게시자·계열 규칙을 적용하되 임베딩·재정렬·안전성·OCR·탐지·보상 모델을 일반 채팅에서 제외합니다. 분류 개선은 기존 캐시에도 적용하며 Tier·무료 권한을 자동 부여하지 않습니다.

**모델 일괄 검사**는 다음 조건으로 실행합니다.

- 현재/전체 Provider의 텍스트 모델 대상. 추정 텍스트는 별도 동의, 비텍스트·완전 미확인은 제외.
- 과금 가능성 확인 필요. 기본 최대 20회, 설정 상한 500회. 출력 최대 256토큰, HTTP 30초, 요청 간 1초, 순차 실행.
- 기본은 미검사 모델만 검사. 성공·실패 모두 완료 기록이며 재검사하려면 옵션 해제.
- 오류는 해당 모델에 기록하고 다음 모델로 진행. 같은 모델 자동 재시도 없음. **중지**는 현재 요청 이후 다음 호출을 막음.
- 결과는 모델별 최신 기록. 모델 새로고침에는 유지하고 앱의 키 등록·변경·삭제 시도 전에 초기화. 과거 성공은 현재 가용성을 보장하지 않음.
- 손상된 기록은 덮어쓰지 않고 검사 시작을 막음. 저장 실패 시 메모리 결과는 남지만 재시작 복원은 보장하지 않음.

텍스트가 비어 있지 않으면 검사 성공이며 품질 평가가 아닙니다. 이미지·음성·영상·임베딩의 전용 실행 검사는 구현하지 않았습니다. 모델 목록은 창 안의 스크롤 영역에 표시됩니다.

## 사용량·비용·문제 해결

**사용량 및 비용**에서 요청·모델별 토큰, 추정·확인·미확인 비용, 과거 예약 기록을 확인합니다. Provider별 Soft Budget은 저장·수정·삭제 가능한 목표이며 실행 제한이 아닙니다. [비용 데이터 의미와 사용률](Phase4_4_Routing_Context.md)을 참고하세요.

```sh
nidus usage
nidus soft-budget gemini --usd 5.00
nidus soft-budget gemini --delete
nidus balance deepseek
nidus account openai
nidus account anthropic
```

조직 조회는 별도 세션 환경변수 `NIDUS_OPENAI_ADMIN_API_KEY` / `NIDUS_ANTHROPIC_ADMIN_API_KEY`가 필요합니다. 일반 추론 키로 대체하지 않으며 자동 조회·영속 저장하지 않습니다. 조직 보고서는 외부 사용량을 포함할 수 있어 로컬 요청 합계에 더하지 않습니다.

Runtime을 못 찾으면 Node가 활성화된 터미널에서 실행하거나 `NIDUS_NODE_PATH`를 지정합니다. `NIDUS_RUNTIME_ROOT`는 `dist/dashboard.js`가 있는 저장소 루트입니다. helper 누락은 `npm run build:keychain`, 번들 Node 갱신은 앱 재빌드가 필요합니다. 여러 앱·CLI에서 동시에 계정 키를 교체하는 것은 피하세요.
