# 모델 분류와 일괄 검사

## 구현 경계

- `src/classification.ts`: 저장된/조회된 Model의 메타데이터를 읽어 대표 용도, 근거, 확신 수준, 텍스트 검사 가능성을 계산합니다. 모델 목록 자체를 하드코딩하지 않습니다.
- `src/engine.ts`: 목록/상세 반환 시 `classification`을 추가합니다. 기존 버전의 캐시도 그대로 읽어 새 규칙을 적용합니다. `probe`는 저장된 모델 ID만 허용하고 서버에서 분류를 다시 확인합니다.
- `src/health.ts`: 고정 텍스트 probe, 타임아웃, 안전한 오류, 토큰 사용량 원본, 검사 시각/경과 시간과 Provider 중단 여부를 반환합니다. 생성된 본문은 검사 결과에 포함하지 않습니다.
- `src/dashboard.ts`: `probe` 호출에는 `confirmed: true`가 필요하며 추정 텍스트 모델에는 `allowInferred: true`도 필요합니다. UI 동의 표시는 서버 인증/보안 경계의 대체물이 아닙니다.
- `HealthChecks.swift`: Swift 순차 큐, 개수 제한, 중지 요청, Provider별 오류 차단. 실행 중 같은 앱의 모델 갱신/키 교체/일반 채팅을 막습니다. 별도 CLI/다른 앱 프로세스까지 잠그지는 않습니다.
- `HealthChecksView.swift`: 실행 전 계획, 과금 확인, 진행률, 결과 검색/상태 필터. 기존 단일 요청 Runtime 프로세스 수명 관리를 그대로 사용하므로 전체 배치에 245초 제한을 적용하지 않습니다. 각 모델 요청은 독립된 watchdog을 갖습니다.

텍스트 probe의 성공 조건은 비어 있지 않은 텍스트 응답입니다. `OK`라는 특정 단어를 강제 채점하지 않으며 품질 평가가 아닙니다. API 접근·텍스트 엔드포인트의 작은 요청 하나만 확인합니다. 오류 시 사용량을 얻지 못하면 `null`이지 무료/0토큰이 아닙니다. 원본 사용량은 엔진 `ProbeResult.usage.providerUsage`에 유지되며 UI는 입력/출력만 표시합니다.

## 보수적 분류 규칙

1. API의 명시적 메서드/출력 모달리티: `bidiGenerateContent` → 라이브, embedding 메서드 → 임베딩, 명시적 image/video/audio **출력** → 해당 생성 유형.
2. 전문 모델 ID 패턴: image/imagen/dall-e, veo/sora/video, live/realtime/native-audio, tts/audio/whisper/transcribe/lyria/music, embedding, moderation. 모두 **추정**이며 텍스트 자동 검사에서 제외합니다. 전문 이름 패턴은 텍스트 채팅 일반화보다 우선합니다.
3. 일반 `predict`/`predictLongRunning`만으로 이미지나 영상을 확정하지 않습니다. `generateContent` 역시 텍스트 출력의 증거가 아닙니다.
4. Adapter가 API 메타데이터/계약으로 텍스트 채팅 지원을 확인한 경우 텍스트로 분류합니다. 그 외 알려진 텍스트 계열 이름은 추정 + 명시적 동의로만 검사합니다. 완전히 모르는 이름은 미확인/미검사입니다.

대표 용도는 하나이며 멀티모달 입출력 전체를 열거하는 스키마는 아닙니다. 기존 `capabilities.vision` 등은 별도로 보존합니다. 이름 패턴은 미래 모델에서 틀릴 수 있으므로 실제 지원을 확정하지 않습니다. 추정 텍스트 probe의 실패도 그 모델 자체가 고장났음을 의미하지 않습니다.

## 공식 문서 확인 (2026-10-24)

- [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list): 목록만으로 엔드포인트/모달리티 호환성을 확정하지 않습니다.
- [OpenAI 모델 카탈로그](https://developers.openai.com/api/docs/models): 텍스트 외 이미지·Realtime·speech/transcription 등 전문 모델이 별도로 존재합니다. OpenAI Docs 스킬의 공식 문서 확인 절차를 사용했으며, 이름 추정은 공식 메타데이터로 위장하지 않습니다.
- [Gemini Models](https://ai.google.dev/api/models): supportedGenerationMethods, generic prediction과 long-running prediction의 구분.
- [Gemini Live](https://ai.google.dev/gemini-api/docs/live-api): 실시간 입력과 세션 기반 상호작용으로 일반 텍스트 POST와 검사 경로가 다릅니다.
- [Gemini Video](https://ai.google.dev/gemini-api/docs/video): 전용 영상 생성 경로가 필요합니다. 이미지 생성 가이드의 추가 조회는 도구 timeout이 발생했으며, 이번 작업에서 이미지 호출 구현을 검증했다고 주장하지 않습니다.
- [DeepSeek Models](https://api-docs.deepseek.com/api/list-models/): 반환되는 입력/출력 모달리티 메타데이터를 이용합니다.
- [Anthropic Models](https://platform.claude.com/docs/en/api/models/list): 기존 Adapter의 모델/기능 계약을 유지합니다.

## 검증

시작 develop `7bfd88ff47f898ec1f0b7de3df29d4b30b322d40`, 브랜치 `feature/model-health-checks`.

- PASS `npm test`: 52개 (기존 45 + 분류, 미지원/미동의 무호출, probe 한도·사용량·오류·동의·캐시 경계 7개).
- PASS `swift test`: 13개 (기존 7 + 큐 계획/중복/개수 제한, 순차 실행, Provider 오류 격리, 중지/동시 작업 방지, 실행 동의, 결과 무효화 6개).
- PASS `npm run build:app`: Node/Runtime을 포함한 release 로컬 앱 번들 재생성. 이번 변경의 GUI 수동 검증을 대체하지는 않습니다.
- `npm run test:live`: 8개 skip / NOT RUN (명시적 opt-in 없음).
- 실제 유료 API probe: NOT RUN. 사용자의 기존 API 키를 자동으로 사용하지 않았습니다.
- 새 일괄 검사 화면의 수동 GUI 조작: NOT RUN. 이전 대시보드 GUI 검증과 이번 기능의 컴파일/상태 테스트를 혼동하지 않습니다.
- 이미지/영상/라이브/음성/임베딩 실제 검사기: 미구현. 비용·시간 한도, 샘플 입력과 전용 응답 검증, 비동기 작업 정리, 라이브 세션 종료를 포함해 후속 구현해야 합니다.
