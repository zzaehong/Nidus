# NVIDIA Budget Guard 차단과 무료 설정 보완

2026-10-25 / feature/usage-ledger-budget-guard

## 확인된 원인

사용자 SQLite를 읽기 전용으로 조사했다. NVIDIA 요청 60건 모두 `unknown_price_or_bound`. NVIDIA provider_plans와 model_free_use 기록은 없었다. 따라서 무료 계정/모델 승인이 없는 요청이 유료 가격 경로에 들어가 차단됐다. 기존 무료 지원 목록의 `meta/llama-3.1-8b-instruct`는 현재 조회된 85개 모델에 없었다. 용도 분류 개선만으로 해결되지 않는 별도의 설정·검토 목록 문제였다.

## 변경

- NVIDIA 연결 화면에 **무료 개발자 API 설정** 진입점을 추가했다.
- 현재 조회된 모델 중 공식 Free Endpoint 확인 모델만 보여주고 사용자가 사용할 모델을 선택한다. 선택 초기값은 비어 있다.
- 현재 키의 무료 개발자 계정 권한과 선택 모델의 무료 지원 확인, 과금 위험 동의 후 계정 Free 상태와 선택 모델의 verified/approved를 하나의 SQLite 트랜잭션에 저장한다.
- 저장은 추론/모델 검사를 실행하지 않으며 Tier나 자동 유료 허용을 변경하지 않는다. 자동 라우팅은 기존처럼 별도 Tier 배정이 필요하다.
- 계정 설정 미등록은 `nvidia_free_setup_required`로 안내한다. 미승인 모델과 키 변경은 서로 다른 사유로 구분한다.
- 기존 승인 편집 및 철회는 Tier 및 라우팅 화면에서도 가능하다. 키 재연결/해제는 기존 무료 확인을 초기화한다.

## 새로 확인한 Free Endpoint

2026-10-25 공식 모델 페이지에서 호스팅 API와 정확한 ID, 무료 엔드포인트 안내를 확인했다. 카탈로그에서 실제 발견된 경우에만 사용자가 승인할 수 있다.

- [nvidia/nemotron-3.5-super-vl-120b-a12b](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b)
- [nvidia/nemotron-3.5-lightning-30b-a3b](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b)
- [nvidia/nemotron-3-ultra-550b-a55b](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b)
- [deepseek-ai/deepseek-v4.1-flash](https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash)

이 네 모델은 사용자 기존 캐시에 존재한다. 전체 NVIDIA 모델을 무료로 처리한 것은 아니다. 다른 모델은 별도의 공식 무료 지원 검토가 필요하다. 호스팅 개발자/평가 API와 유료 기업 배포/자체 호스팅은 구분한다. [NVIDIA 개발자 프로그램 조건](https://docs.api.nvidia.com/nim/docs/product).

## 검증 및 한계

- Node Mock/회귀 137 PASS: 미설정 원인 재현, 선택한 4개 모델 무료 실행·토큰 기록, 미동의/미발견/미검토 모델 거절, 모델별 승인 범위, 키 변경, 429 Fallback.
- Swift 테스트 34 PASS. 앱 빌드 PASS (`dist/Nidus.app`).
- 실제 무료/유료 API 호출, UI 수동 조작: NOT RUN.
- 사용자 실제 계정 설정/승인은 변경하지 않았다. 사용자 확인은 실제 Billing 조회 결과가 아니며 잘못된 설정은 과금 위험이 있다. 잔여 할당량은 만들거나 추측하지 않는다.
- DB 스키마 변경 없음. 기존 사용량·예산·승인·Tier 기록을 보존한다.
