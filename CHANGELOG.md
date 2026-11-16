# 변경 기록

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르고, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. 1.0 전이므로 부(minor) 버전이 올라갈 때 호환이 깨질 수 있습니다.

## [0.2.0] — 2026-11-16

CONCEPT.md의 AI Office를 향한 첫 큰 판. 모델을 고르는 기반(1단계), AI가 일하는 격리 작업장(2단계), 일을 나누는 조직과 기억(3단계 전반)을 `Nidus.app` 하나에 담았습니다. 설계는 `docs/architecture/`의 STAGE1·STAGE2·STAGE3 문서에 있습니다.

### 추가

- **Model Gateway (1단계)**: Provider 9곳(OpenAI, Anthropic, Gemini Free, Gemini Paid, DeepSeek, NVIDIA NIM, Groq, Mistral, Cloudflare Workers AI)을 한 계약으로 호출. 역할(Main·Lead Manager·Manager)과 Worker 난이도(단순·보통·복잡)별 모델 배정, 후보 순서대로의 대체, 도구 호출 정규화, 모델 상태 기억(실패가 잦거나 느린 모델은 쉬게 함)과 동시 시도, 사용량·비용·월 예산 경고.
- **Gemini Free / Paid 분리와 할당량**: 무료와 유료를 다른 Provider로 두고 유료 자동 전환을 금지. 모델별 RPM·TPM·RPD를 이 Vault의 호출 수와 Google 관측값으로 나란히 표시, 429의 구조화된 내용으로 쉬는 시간 결정, 제한 직접 입력. Google Cloud 조회는 gcloud 로그인 하나로(Cloud Quotas·Monitoring·Billing).
- **모델 배정 자동 채우기와 제외**: 검사 통과 모델로 모든 칸을 채우되 적용 전에 계획을 보여 줌. 작업 기록과 Main 대화의 "이 AI의 작업이 마음에 들지 않나요?"로 역할·난이도·모델을 확인하고 그 칸 또는 Vault 전체에서 제외.
- **Agent Workspace (2단계)**: Vault마다 하나의 격리 VM, 사이트 단위 승인 프록시, 호스트에서 조작·개입할 수 있는 VM 상주 브라우저(화면 스트리밍), git bundle로 Vault↔VM 동기화와 승인 뒤 `nidus/<작업>` 브랜치 반영, Worker 도구 루프와 상주 Workspace Service.
- **AI Office (3a·3b·3c)**: Main이 요청마다 팀을 짜고 계획을 세워 사용자 승인 뒤 실행, Manager 지시·검토, Task 병렬 진행, Main 최종 보고. 기억: Home(상설 직원), Desk(맥락 복구), Library(검색·기록; 프로젝트·결정·교훈 문서). Main 탭에서 직접 대화하고 일을 맡김.
- **Dream Sequence**: 쌓인 교훈·결정을 합치고 Archive로 보관하며, 모순은 사용자에게 알림. 프로젝트 뒤 자동 실행.
- **사용자 문서 연결·분류**: 노트 전체를 읽고(크면 카드로 나눠) 연결·이동을 제안하며, 고른 것만 적용.
- **프로젝트 결론**: 프로젝트가 끝나면 Main이 Task 산출물을 바탕으로 사용자의 질문에 맞는 답을 대화에 내고, 결과 파일 링크(`nidus://library/…`)를 붙임. 링크는 실제 파일과 대조해 바로잡거나 "파일 없음"으로 표시.
- **Library 탭(읽기 전용)**: 파일 트리, Markdown·HTML 미리보기, 내용 검색. 고치기는 Obsidian으로.
- **앱 전반**: 직원 탭, 작업 탭(진행 기록·네트워크 승인·결과 검토), 사이드바 결정 대기 배지, Cloudflare Account ID 자동 조회(계정이 하나일 때).

### 바뀜

- 이전 대시보드는 `Nidus Base.app`(`com.nidus.base`)으로 이름을 바꿔 그대로 둠. 새 앱은 `Nidus.app`(`com.nidus.app`).
- 이전 `gemini:` 배정은 `gemini-free:`로 한 번 자동 이전(키는 Keychain에서 복사).

### 알려진 제한

- 실제 환경에서 확인하지 못한 것: Cloud Quotas API를 켠 뒤의 실제 `quotaInfos` 응답(Monitoring·Billing은 실측), 실제 Gemini Paid 호출, 실제 429 본문 형식, Gemini 외 Provider의 할당량.
- 무료 Provider(Gemini Free, NVIDIA)는 429·시간 초과가 잦습니다. 칸마다 서로 다른 Provider 후보를 두세요(자동 채우기가 그렇게 섞습니다).
- 모델이 "파일을 만들었다"처럼 사실과 다른 말을 하는 것은 프롬프트로 줄일 뿐 없앨 수 없으므로, 링크·결과 파일은 엔진이 사실로 교정합니다. 그 밖의 서술은 사용자가 결과 파일로 확인해야 합니다.
- 앱은 서명·공증하지 않은 로컬 개발용 번들입니다. 최근 화면 변경(Library 트리, 사이드바 배지, 자동 채우기 창)은 코드와 빌드로만 확인했습니다.
- Meeting Room, Inbox, Security Office 정책 계층, Manager's Office, Idea Bank·Rest Room, Red Team, VM Task 병렬·Lead Manager 분리는 아직 없습니다.

## [0.1.0] — 2026-10-22

- 첫 공개 판: Provider 대시보드(지금의 Nidus Base), 모델 분류와 일괄 동작 검사, Provider를 바꿔가며 이어가는 채팅방, CLI, Pricing Registry.
