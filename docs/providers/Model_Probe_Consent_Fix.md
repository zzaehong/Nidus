# 모델 동작 검사 free_model_unverified 수정

2026-11-04 · feature/vault-runtime-v2

`free_model_unverified`는 모델 응답 실패가 아니라 Nidus 무료 요금 메타데이터에서 실행을 허용하지 못한 로컬 권한 거절이다. 기존 일괄 검사 UI는 과금 가능성을 확인받았지만 backend의 요청별 동의 토큰으로 연결하지 않아 Free Only의 미확인 모델 검사도 차단했다.

## 변경

- 확인된 일괄 검사만 `probeRiskAccepted: true`를 전달한다. backend는 실제 검사 callback에서 `account_unknown` 또는 `free_model_unverified`인 경우 한 Provider·모델·probe 요청에 결합된 1회 동의를 발급한다.
- 토큰은 기존 credential fingerprint, account revision, task, model, 5분 만료, 일회용 조건을 유지하고 요청 기록 트랜잭션에서 소비한다.
- 단일 검사도 free_model_unverified 차단 후 개별 과금 위험 확인으로 1회 실행할 수 있다. 일반 채팅에는 이 예외를 적용하지 않는다.
- 예외 실행은 유료 가능 요청으로 기록한다. 알려진 가격은 추정 비용을 계산하고, 가격이 없으면 비용 미확인으로 남긴다. 무료 0원으로 바꾸지 않는다.
- Free Only, Provider 유료 승인, 모델 무료 인증 상태는 그대로다. 검사 성공을 무료 이용 증거로 사용하지 않는다.
- `provider_paid_not_approved`, `free_unavailable`, 승인 없음·재사용·다른 모델/task/키·revision 변경·만료는 계속 차단한다.
- 요청은 기존 `Reply with OK.`, 최대 출력 256토큰, timeout 30초이다. 실패한 모델의 자동 재시도나 다른 모델 Fallback은 없다.

UI 확인 문구에 무료 지원 미확인·유료 전용 모델도 이번 검사 1회에 한해 과금 가능성을 승인함을 명시했다. 계정의 일반 실행 정책을 바꾸지 않는다는 점도 표시한다.

## 검증

- PASS: Node 319건, Swift 48건.
- 신규 회귀: 동의 없는 검사 미전송, 명시적 검사 1회 허용, Free Only/paidAllowed 보존, 유료 가능 비용 기록, 일반 채팅 차단, token model/task/key/revision/expiry/replay 차단, Provider 실패 무재시도, Unknown/알려진 무료/무료 소진 상태 구분.
- PASS: `npm run build:app`. 산출물 `/Users/parkjaehong/Developer/Nidus/dist/Nidus.app`.
- NOT_RUN: 실제 유료 Provider API와 실제 UI 클릭 검증. Provider/권한 응답은 테스트 fixture이며 사용자 계정·Secret·권한 설정을 변경하지 않았다.

앱을 다시 연 뒤 모델 일괄 검사에서 대상 개수와 과금 안내를 확인하고 실행한다. 이 예외가 없는 일반 채팅·Agent의 Free Only 제한을 해제하려면 별도로 사용자가 계정 실행 정책을 결정해야 한다. 이번 수정은 이를 자동 변경하지 않는다.
