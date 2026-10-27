# NVIDIA NIM 용도 분류 개선

2026-10-25 / `feature/usage-ledger-budget-guard`

## 원인 및 변경

기존 NVIDIA 모델 조회는 대부분 `chat: unknown`을 반환했고 공통 분류기에 NVIDIA 텍스트 계열 규칙이 없었다. 임베딩 모델의 `embedqa`, 안전성 모델의 `guard`도 충분히 구분하지 못했다.

- 공식 LLM API 문서에서 확인한 정확한 ID에 출처·확인 시각을 제공한다.
- 알려진 게시자/모델 계열은 `inferred`(추정)로 표시한다. 모르는 게시자의 유사 이름까지 적용하지 않는다.
- 임베딩, reranking, guard/safety, reward, detector, 문서 parse/OCR를 텍스트 계열보다 먼저 분류한다. 영상 탐지기를 영상 생성기로, 이미지 입력 VLM을 이미지 생성기로 취급하지 않는다.
- SwiftUI에 검색 재정렬, 문서 추출/OCR, 탐지/판별, 보상 평가 필터와 분류 근거 링크를 추가한다.
- 캐시를 읽을 때 재분류하므로 앱 재시작 시 기존 모델 목록에도 적용된다. 모델 조회 API를 다시 호출하거나 캐시·Tier·예산·무료 승인을 초기화할 필요가 없다.
- 분류 규칙은 모델 목록을 생성하지 않는다. 새로운 Tier나 가격을 부여하지 않으며 자동 무료 사용 승인을 하지 않는다. 신규 텍스트 분류만으로 검사 요청을 실행하지 않고 opt-in을 유지한다. 전문 모델은 텍스트 검사와 자동 채팅 후보에서 제외한다.

## 로컬 캐시 평가

사용자 로컬 캐시의 모델 ID/기존 capability만 읽어 비교했다. 키 조회, Provider API 호출, 사용자 파일 변경 없음.

85개 모델 중 미확인 77개 → 5개. 변경 후: 텍스트 60, 임베딩 10, 모더레이션 5, 문서 추출 3, 탐지 1, 보상 평가 1, 미확인 5.

미확인 유지: `google/diffusiongemma-26b-a4b-it`, `meta/muse-glimmer-30b`, `nvidia/cosmos-reason2-8b`, `nvidia/ising-calibration-1.5-31b`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`. 이름만으로 일반 텍스트 채팅 호환성을 확정하지 않는다.

## 검증

- Node Mock/회귀: 133 PASS. 공식/추정 분리, 전문 모델 우선 분류, VLM, 잘못된 게시자, 캐시 재분류, 미승인 호출 차단 검증.
- Swift 회귀: 33 PASS.
- macOS 앱 빌드: PASS (`dist/Nidus.app`).
- 실제 API 호출, UI 수동 조작: NOT RUN.

## 공식 근거

- [NVIDIA LLM API 및 모델 목록](https://docs.api.nvidia.com/nim/reference/llm-apis)
- [Retrieval API](https://docs.api.nvidia.com/nim/reference/retrieval-apis)
- [NV-CLIP](https://docs.api.nvidia.com/nim/reference/nvidia-nvclip)
- [Nemotron Parse](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-parse), [Parse 2.0](https://docs.api.nvidia.com/nim/re/reference/nvidia-nemotron-parse-2_0), [3.5 Parse](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-parse)
- [NVIDIA VLM 목록](https://github.com/NVIDIA-AI-IOT/live-vlm-webui/blob/main/docs/usage/list-of-vlms.md)

분류는 용도 안내이며 현재 모델의 접근 권한·엔드포인트 호환성·무료 사용 가능성·벤치마크 순위를 보장하지 않는다. 계열 규칙의 새 버전은 추정으로 남고 공식 개별 검토가 필요할 수 있다.
