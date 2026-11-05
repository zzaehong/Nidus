# 설정 UI 개선 (2026-10-26)

- 툴바의 Model Tier와 Routing Policy를 별도 메뉴로 분리했다.
- 기존 Provider 상세의 과금 유형/실행 권한 편집 카드는 Routing Policy에서 관리한다. API Key 등록 시 계정 확인 절차는 유지한다.
- 설정, 계정 확인, Provider 상세 안내 문구에 세로 확장 및 줄바꿈을 적용했다.
- Model Tier에서 조회된 공식 무료 지원 모델을 전체 선택하거나 개별 선택하여 무료 상태를 기록할 수 있다. 전체 선택은 검색 필터와 무관하게 전체 조회 목록에 적용하며 저장 전 대상 목록을 표시한다.
- NVIDIA 무료 계정 확인에도 전체 선택/선택 해제를 추가했다.
- 난이도별 Tier 조정기에서 위로/아래로 버튼을 제거하고 드래그 핸들, 작업 적합성 설명, 오른쪽 휴지통 버튼을 배치했다. 기존 등급 의미(Tier 1 Lightweight, Tier 2 General, Tier 3 Advanced)와 드롭 검증은 유지한다.

## 저장 동작과 제한

무료 상태 일괄 기록은 기존 `free-use-set` 경로를 순차 호출한다. 전체 작업은 단일 트랜잭션이 아니며 일부 저장 뒤 실패할 수 있다. 이 경우 완료 개수와 오류를 표시하고 재시도 시 완료한 모델은 건너뛴다. 상태 값을 바꾸면 새 상태를 모든 선택 모델에 다시 저장한다.

모델별 상태 기록은 Provider 유료 실행 승인을 부여하지 않는다. 실제 무료 할당량 또는 Billing 상태를 자동 확인하지 않으며, 기존 실행 권한 검사는 유지한다. DB 스키마와 라우팅 알고리즘 변경은 없다.

## 검증

- PASS: `npm test` — 157개 Mock/회귀 테스트.
- PASS: `swift test --scratch-path /tmp/nidus-phase43` — 40개 테스트. 전체 선택의 미확인 모델 제외, 저장 중 실패, 미완료 모델 재시도, 유료 승인 미변경을 추가 검증했다.
- PASS: `npm run build:app` — `dist/Nidus.app` 생성(로컬 개발용 서명 없는 번들).
- PASS: `git diff --check`.
- 개발 중 Swift 컴파일 오류와 새 테스트 fixture 오류를 수정한 뒤 위 결과를 재확인했다. 최초 sandbox 내 Swift 실행은 컴파일러 캐시 접근 제한으로 실행되지 않아 권한 확장 후 실행했다.
- NOT RUN: 실제 무료/유료 API 호출, 실제 앱 창의 수동 시각 검증.

작업 브랜치: `feature/usage-ledger-budget-guard`. develop 시작/종료 HEAD: `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b`. main: `723c03b59dcecaae27d9fe0a9f97b464c785d706` (변경 없음). develop 병합은 승인 대기이며 원격 push/PR은 수행하지 않았다.

## 목록 영역 크기 제한 후속 수정

Model Tier / Routing Policy의 스크롤 영역을 GeometryReader가 제공하는 창 내부 크기로 제한하고, 카드 너비를 스크롤바 여백을 제외한 가용 너비에 맞췄다. NVIDIA 무료 모델 목록도 높이 220pt의 고정된 내부 스크롤 영역과 지연 생성 목록으로 변경했다. Tier 편집 요소는 세로로 배치하여 카드의 최소 가로 폭이 커지는 문제를 줄였다. 설정 창 크기는 화면의 사용 가능 영역을 넘지 않도록 상한을 적용했다.

검증: Swift 40개 테스트 PASS, 앱 빌드 PASS, diff 검사 PASS. 실제 앱 창에서 대량 목록을 이용한 수동 시각 검증 및 실제 API 호출은 NOT RUN. UI 크기 변경만 있으므로 Node 테스트는 재실행하지 않았다.

## Gemini Provider 화면 재현 및 수정 (2026-10-27)

사용자가 지적한 화면은 Model Tier가 아닌 Gemini Provider 화면이었다. 이전 설정 화면 수정만으로 이 문제는 해결되지 않았다. 저장된 Gemini 모델 60개를 표시하는 실제 앱에서 상단 제목·검색 영역과 사이드바가 창 밖으로 밀리는 현상을 재현했다.

`App.swift`의 NavigationSplitView 상세 영역에 GeometryReader를 두어 ProviderView의 크기를 실제 할당된 공간으로 제한했다. 내부 HSplitView와 모델 목록 패널도 남은 공간 높이에 맞췄다. 기존 List 선택, 키보드 탐색 및 분할선은 유지한다. Model Tier에는 이번 추가 변경을 적용하지 않았다.

검증: Swift 40개 테스트 PASS, macOS 앱 빌드 PASS, diff 검사 PASS. 수정 앱을 재실행하고 저장된 Gemini 60개 모델의 초기 표시 및 아래쪽 스크롤을 실제 화면에서 확인했다. 제목·검색창·목록·상세 정보가 창 안에서 유지되고 목록 내부 스크롤이 동작했다. 실제 API 호출 및 모델 새로고침은 수행하지 않았다. 모든 화면 크기/다중 모니터 조합은 검증하지 않았다.
