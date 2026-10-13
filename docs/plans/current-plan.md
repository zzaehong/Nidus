# 현재 개발 상태

이 문서는 현재 동작과 최근 통합 상태만 요약합니다. 세부 요구사항은 [PRD](../../PRD.md), 구조는 [DESIGN](../../DESIGN.md), 작업 절차는 [Git 흐름](../git_flow.md), 실행 검증의 역사와 한계는 [VALIDATION](../VALIDATION.md)을 기준으로 확인합니다.

## 자연어 Plan 구성

새 Plan 화면에서 사용자가 자연어 요청을 입력하면 로컬 Vault의 Markdown/text 자료와 정상 검증된 AI Connection 모델을 추천합니다. 사용자는 추천을 검토·수정한 뒤 Plan을 만듭니다. 추천 단계에서 요청이나 파일 내용은 외부로 전송되지 않습니다. 모델 호출은 Plan을 만든 뒤 실행을 시작하고 정확한 전송 범위를 승인해야 진행됩니다. 일치하는 자료가 없을 때는 빈 Source 목록으로 Plan을 만들 수 있습니다.

새 Plan은 선택한 Connection에 묶인 route policy를 저장합니다. 기존 Plan과 CLI 정책은 자동 변경되지 않습니다. 현재 Worker/Review/Final 정책은 Planning 모델 정책을 상속하며, 역할별 자동 모델 라우팅과 Plan 전체 자동 실행은 구현하지 않았습니다.

## 테스트 원칙

자동 테스트와 합성 데모는 저장소 작업 파일과 분리된 격리 Vault에서 실행하고, 소스 저장소에 Runtime 체크포인트를 만들지 않습니다. 기본 회귀 명령은 README의 개발 및 테스트 절을 따릅니다. Live Provider 검증은 별도 작업이며 테스트 결과에 포함하지 않습니다.
