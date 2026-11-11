# 모델 분류와 일괄 검사

## 구현 경계

- `src/classification.ts`: 저장된/조회된 Model의 메타데이터를 읽어 대표 용도, 근거, 확신 수준, 텍스트 검사 가능성을 계산합니다. 모델 목록 자체를 하드코딩하지 않습니다.
- `src/engine.ts`: 목록/상세 반환 시 `classification`을 추가합니다. 기존 버전의 캐시도 그대로 읽어 새 규칙을 적용합니다. `probe`는 저장된 모델 ID만 허용하고 서버에서 분류를 다시 확인합니다.
- `src/health.ts`: 고정 텍스트 probe, 타임아웃, 안전한 오류, 토큰 사용량 원본, 검사 시각/경과 시간을 반환합니다. 호환용 `stopProvider` 필드는 항상 false입니다. 생성된 본문은 검사 결과에 포함하지 않습니다.
- `src/dashboard.ts`: `probe` 호출에는 `confirmed: true`가 필요하며 추정 텍스트 모델에는 `allowInferred: true`도 필요합니다. UI 동의 표시는 서버 인증/보안 경계의 대체물이 아닙니다.
- `HealthChecks.swift`: Swift 순차 큐, 개수 제한, 중지 요청, 모델별 오류 격리. 429를 포함한 API 실패와 전달/응답 해석 오류 뒤에도 1초 간격으로 다음 모델을 검사합니다. 구 Runtime의 `stopProvider: true`도 큐를 차단하지 않습니다. 자동 재시도나 계정 전체 오류에 대한 자동 중단은 없으며, 사용자가 중지할 수 있습니다. 실행 중 같은 앱의 모델 갱신/키 교체/일반 채팅을 막습니다. 별도 CLI/다른 앱 프로세스까지 잠그지는 않습니다.
- `HealthChecksView.swift`: 실행 전 계획, 과금 확인, 진행률, 결과 검색/상태 필터. 기존 단일 요청 Runtime 프로세스 수명 관리를 그대로 사용하므로 전체 배치에 245초 제한을 적용하지 않습니다. 각 모델 요청은 독립된 watchdog을 갖습니다.

텍스트 probe의 성공 조건은 비어 있지 않은 텍스트 응답입니다. `OK`라는 특정 단어를 강제 채점하지 않으며 품질 평가가 아닙니다. API 접근·텍스트 엔드포인트의 작은 요청 하나만 확인합니다. 오류 시 사용량을 얻지 못하면 `null`이지 무료/0토큰이 아닙니다. 원본 사용량은 엔진 `ProbeResult.usage.providerUsage`에 유지되며 UI는 입력/출력만 표시합니다.

## 보수적 분류 규칙

1. API의 명시적 메서드/출력 모달리티: `bidiGenerateContent` → 라이브, embedding 메서드 → 임베딩, 명시적 image/video/audio **출력** → 해당 생성 유형.
2. 전문 모델 ID 패턴: image/imagen/dall-e, veo/sora/video, live/realtime/native-audio, tts/audio/whisper/transcribe/lyria/music, embedding, moderation. 모두 **추정**이며 텍스트 자동 검사에서 제외합니다. 전문 이름 패턴은 텍스트 채팅 일반화보다 우선합니다.
3. 일반 `predict`/`predictLongRunning`만으로 이미지나 영상을 확정하지 않습니다. `generateContent` 역시 텍스트 출력의 증거가 아닙니다.
4. Adapter가 API 메타데이터/계약으로 텍스트 채팅 지원을 확인한 경우 텍스트로 분류합니다. 그 외 알려진 텍스트 계열 이름은 추정 + 명시적 동의로만 검사합니다. 완전히 모르는 이름은 미확인/미검사입니다.

대표 용도는 하나이며 멀티모달 입출력 전체를 열거하는 스키마는 아닙니다. 기존 `capabilities.vision` 등은 별도로 보존합니다. 이름 패턴은 미래 모델에서 틀릴 수 있으므로 실제 지원을 확정하지 않습니다. 추정 텍스트 probe의 실패도 그 모델 자체가 고장났음을 의미하지 않습니다.

## 검사 기록 저장과 미검사 선택

- 앱은 `~/Library/Application Support/Nidus/model-health.json`에 버전 1 스냅샷을 저장합니다. 폴더 생성 권한 0700, 파일 권한 0600, 원자적 파일 교체를 사용합니다. Provider + 모델 ID별 **최신** 성공/실패 기록이며 전체 실행 이력 데이터베이스가 아닙니다.
- 각 요청 완료 직후 저장하여 중지/종료 전까지 완료된 결과를 유지합니다. 시각·상태·안전한 사유·소요 시간·입출력 토큰 수와 Provider/모델/분류만 저장하며 키·프롬프트·생성 본문을 포함하지 않습니다. 전달/해석 실패는 일반화한 사유로 기록합니다.
- 실행 큐와 저장 기록을 분리합니다. 다른 Provider를 검사하거나 중지해도 기존 기록을 잃지 않습니다. 대기·실행 중·미지원·한도 제외·사용자 중지 상태는 완료 기록이 아닙니다.
- UI 기본 `미검사 모델만 검사`는 성공/실패 기록이 없는 대상만 호출합니다. 저장된 행은 이전 상태와 시각으로 표시하되 요청 한도를 소비하지 않습니다. 옵션을 끄면 재검사하여 최신 결과를 교체합니다. 실패도 검사 완료이므로 자동 재시도하지 않습니다.
- 모델 새로고침에는 기록을 보존하고, 앱의 키 등록/변경/삭제 **시도 전** 해당 Provider 기록을 초기화합니다. 초기화 저장 실패 시 키 변경도 진행하지 않습니다. 삭제됐다 다시 조회된 동일 ID도 기존 기록을 유지하므로 필요하면 재검사합니다.
- 읽기 실패/알 수 없는 버전은 기존 파일을 보존하고 검사 시작을 막습니다. 저장 실패는 경고하며 메모리 결과는 유지하지만 재시작 복원을 보장하지 않습니다.
- 단일 앱 인스턴스 기준입니다. 다른 앱 인스턴스의 동시 쓰기 병합, CLI/Keychain 외부 키 변경 감지, 검사 결과 자동 만료는 미구현입니다. 외부 키 변경 후에는 앱에서 키를 다시 등록하거나 기존 모델도 재검사해야 합니다. 과거 성공은 현재 동작을 보장하지 않습니다.

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

### 실패 후 계속 검사 수정 (2026-10-24)

시작 develop `2c9ddbc0efc9768838d870b76187d9f5a00a720c`, 브랜치 `feature/health-check-continue`.

- 첫 429로 Provider 전체를 건너뛰던 동작을 제거했습니다. 인증·쿼터·전달 오류도 해당 행에 기록하고 다음 모델로 진행합니다. 제한된 계정의 후속 요청이 성공한다고 보장하지는 않습니다.
- 검사 버튼 tooltip과 검사 창 설명에 대상·실패 후 진행·과금 가능성을 명시했습니다. 분류 규칙과 비텍스트 검사 범위는 변경하지 않았습니다.
- PASS `npm test`: 52개. 모든 probe 오류 코드의 `stopProvider: false`와 안전한 오류 보존을 검증했습니다.
- PASS `swift test`: 15개. 60개 중 대상 24개/첫 429 시 성공 23·실패 1·미검사 36, 구 Runtime 중단 힌트 무시, 잘못된 응답/전달 실패 후 진행, 사용자 중지와 개수 제한을 검증했습니다.
- PASS `npm run build:app`: 로컬 unsigned 번들을 재생성했습니다.
- 최초 제한 환경 실행은 Mock HTTP listen EPERM 및 Swift 캐시 접근 차단으로 FAIL. 필요한 권한으로 재실행하여 위 PASS를 확인했습니다.
- 실제 API 호출 및 GUI 수동 조작: NOT RUN. Mock/상태 테스트와 컴파일 검증이며 실제 계정의 429 해소를 검증한 것은 아닙니다.

### 검사 결과 영구 저장 (2026-10-24)

시작 develop `94f27ace774204ec641abe9d74befbd49c59ccd6`, 브랜치 `feature/persistent-health-results`.

- PASS `swift test`: 19개. 파일 저장/새 Dashboard 인스턴스 복원, 성공·실패 제외와 요청 한도, 재검사 갱신, 중지 전 즉시 저장, 새로고침 유지, Provider별 키 변경 초기화, 손상 파일 보존 및 저장 실패 표시를 포함합니다.
- PASS `npm test`: 기존 Runtime Mock 52개 회귀 테스트.
- PASS `npm run build:app`: 로컬 unsigned 앱 번들 재생성.
- 실제 API·수동 GUI 재시작 검증: NOT RUN. 복원은 임시 디렉터리를 사용하는 자동 테스트로 검증했으며 사용자 키와 실제 기록을 읽거나 수정하지 않았습니다.
