# 코드 리뷰 개선 검증 — 2026-10-24

작업 브랜치: `feature/code-review-improvements`. 시작 develop: `85ab4a8609e6a9f0a5a6a4064f02a346ffc2df5b`. develop/main에 병합하지 않으며 PR 검토 대상으로 제출합니다.

## 변경 경계

- `src/http.ts`, `src/errors.ts`: Anthropic 버전 지목 400과 인증/권한 오류 구분, 원문 비노출. 이미 유효한 `src/adapters/anthropic.ts`의 버전/인증/본문은 변경하지 않음.
- `src/pricing-snapshot.ts`: 기존 데이터 재검토, 공식 16개 정확한 ID 스냅샷. `src/pricing.ts`: 최고 요금 구간 기반 probe/usage 추정. 임의 이름·가격·스크래핑 없음.
- `src/health.ts`, `src/engine.ts`, `src/dashboard.ts`: 출력 한도 공유, 비용 추정 전달, 남은 예산·미확인 가격 승인 검사, 요청 전 로컬 context 평가.
- `src/context.ts`: 메타데이터 우선 한도, 공식 문서의 일부 정확한 ID 보완, UTF-8 기반 추정. 알려진 한도 초과 위험은 API/키 접근 전에 거부.
- `Models.swift`, `HealthChecks.swift`, `HealthChecksView.swift`, `HealthResultStore.swift`, `App.swift`: 예산 입력/모델별·전체 추정, 예약 선저장, 누계·미확인 비용·토큰 기록, 모델 정보에 비용 표시. 기존 기록 호환.
- `ChatPolicy.swift`, `ChatRooms.swift`: 검증 상태별 선택/첫 사용 안내/실패 사유/재검사, preflight 경고, 100개 자동 truncation 제거. 키 보안·Markdown 유지.

## 공식 자료 검증

- [Anthropic Versions](https://platform.claude.com/docs/en/api/versioning): `2026-10-21`은 유효한 최신 버전. Messages에서 temperature/top_p/top_k 제거됨; 기존 Adapter는 보내지 않으므로 유지.
- [Models](https://platform.claude.com/docs/en/api/http/models/list), [Messages](https://platform.claude.com/docs/en/api/http/messages/create): 같은 버전 헤더 사용. Models의 max_input_tokens/max_tokens를 보존함. 문서 검증과 실계정 성공은 별개.
- [OpenAI GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano): 정확한 ID의 입력/캐시/출력 요금과 문맥/출력 한도. Nano 페이지는 종료 상태이므로 가격 기록만으로 가용성을 만들지 않음. OpenAI Docs 스킬의 공식 문서 확인 절차 적용.
- [Anthropic 가격](https://platform.claude.com/docs/en/about-claude/pricing), [모델 ID](https://platform.claude.com/docs/en/models/overview): Sonnet/Opus 5.5와 Haiku 5.5의 정확한 ID 및 캐시/입력 구간별 요금. 기존 4.6 가격 재검토.
- [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing), [Models](https://ai.google.dev/api/models): 3.5 Flash-Lite, 2.5 Flash, 2.5 Flash-Lite의 표준 텍스트 요금, thinking 출력, 별도 캐시 저장비, 무료 티어 조건. API inputTokenLimit/outputTokenLimit를 우선.
- [DeepSeek 가격·모델](https://api-docs.deepseek.com/quick_start/pricing/): Flash/Pro의 peak/off-peak 요금과 시간 조건, 문맥/출력 한도. 명시된 두 레거시 Flash 이름은 동일 가격으로 매칭하고 목록 가용성은 API에 맡김.
- 공식 실시간 가격 API는 확인하지 못했으며 자동 스크래핑/갱신은 구현하지 않음. 수동 갱신은 snapshot의 정확한 ID·요금·조건·출처·checkedAt을 함께 수정하고 회귀 테스트 실행.

## 테스트 결과

| 실행 | 결과 |
| --- | --- |
| `npm test` | PASS 57 — 기존 52 + 새 리뷰 테스트 5 |
| `swift test` | PASS 25 — 기존 19 + 새 정책/예산 테스트 6 |
| `npm run test:keychain` | PASS 1 — 별도 UUID service의 합성 키만 사용하고 삭제 |
| `npm run build:app` | PASS — Swift release 및 Node/Runtime 포함 로컬 번들 |
| 번들 Node/Runtime ping, cwd `/private/tmp` | PASS — 새 모듈을 포함한 번들 로딩/응답 검증 |
| `NIDUS_LIVE=0 NIDUS_LIVE_CHAT=0 npm run test:live` | 8 SKIP / NOT RUN — 4개 Provider 모델 조회·유료 채팅 미실행 |
| 새 GUI 수동 클릭/실제 계정 채팅 | NOT RUN |

추가 검증: 두 Anthropic API의 버전 일치/제거된 파라미터 없음, 400 버전/일반 요청/401/403 분리와 비밀정보 비노출, 가격 exact match/미확인 null, 미승인·잘못된 예산 무호출, 실패 시 예약 유지, 예상보다 높은 사용량 후 중단, 누계 재시작 복원, 검증 4상태·첫 사용 동의·개별 재검사, 120/150개 대화 보존, 한글/이모지/system/output 문맥 추정, 초과 시 무호출.

초기 Swift 실행은 과거 fixture가 전부 가격 미확인이어서 새 정책에 의해 요청이 제외되어 FAIL했습니다. 기존 순차 실행 fixture에 합성 추정값을 명시하고 별도로 미확인 차단/승인 테스트를 추가한 뒤 PASS했습니다. 초기 TS 실행은 unsupported 모델의 빈 메시지 오류 우선순위 회귀 1건 FAIL; 기존 unsupported 우선 처리를 복원하고 전체 PASS했습니다. 실패 이력을 실제 API 실패나 성공으로 해석하지 않습니다.

## 제한 및 후속 검증

- 실제 Provider HTTP 요청·유료 검사는 하지 않았고 사용자 API Key도 읽지 않았습니다. Mock 성공은 실계정 호환성/권한 검증이 아닙니다.
- 예산은 **추정치에 따른 다음 호출 제한**이며 청구액 보장이 아닙니다. 캐시 쓰기·미보고 사용량은 비용 미확인, 실패도 예약을 유지합니다. 승인된 미확인 가격은 한 건 후 중단합니다. 계정 전체/다중 프로세스 예산 및 결제 내역 조회는 없음.
- 토큰은 tokenizer/API count 결과가 아닌 보수적 UTF-8 추정입니다. 알려진 한도는 일부 모델만 보완합니다. 과대 추정으로 조기에 막거나 Provider 오버헤드 때문에 실제로 거절될 수 있습니다. 사용자 대화는 자동 삭제하지 않습니다.
- 첫 사용 동의는 세션 단위이며 자동 검사 만료/외부 키 변경 감지는 기존처럼 없음. 기존 검사 기록에 가격/비용이 없으면 미확인으로 유지합니다.
- 새 GUI 수동 확인, 실제 키로 승인된 소수 모델 검증, 배포용 서명·공증/다른 Mac 실행은 후속 작업입니다. 번들 ping은 GUI 검증을 대신하지 않습니다.
