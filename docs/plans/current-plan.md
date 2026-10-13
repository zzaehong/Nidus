# 현재 계획 / Current plan

2026-10-13: API 연결 최적화 Slice를 로컬 Git Flow로 통합한다. Gemini는 direct, OmniRoute는 gateway, Generic OpenAI-compatible은 compatible로 유지하며 OmniRoute와 Generic은 기존 `OpenAICompatibleAdapter`를 공유한다. Task/Plan policy와 Runtime은 그대로 유지한다.

Source of truth: 시작 `develop` HEAD `c17832c5959648826f1e731173c719a54cc0d8db`, fetch 후 동일한 `origin/develop`; 시작 `main` `d9bd9d0069cef5157a283bea2a0af365c99d44b6`. 수정된 `doc/prompt.md`는 docs commit으로 보존한다. `main`, release/hotfix, push, PR은 변경하지 않는다.

| 기능 브랜치 | 기능 commit | develop merge / 회귀 |
|---|---|---|
| feature/connection-kinds | 구현·테스트 commit은 Git history 참조 | connection kind, canonical record, Provider adapter dispatch 검증 |
| feature/omniroute-gateway | 구현·테스트·문서 commit은 Git history 참조 | OmniRoute identity, adapter reuse, GUI grouping, docs |
| feature/provider-adapter-interface | `963d3c3` ProviderAdapter + manifest adapter dispatch | 로컬 `--no-ff` merge, 전체 Python 135 PASS |
| feature/gemini-native-provider | `94a0b82` native Gemini adapter/UI; `5cf7864` discovery, probe, security 회귀 | docs/evidence와 사용자가 갱신한 prompt를 별도 문서 commit으로 기록한 뒤 로컬 `--no-ff` merge |

완료된 기반: `GeminiAdapter`는 공식 model metadata에서 `generateContent` 모델을 찾아 최대 5개 검사하고 일반/구조화 JSON 응답을 모두 통과시킨다. API Key는 Keychain에 보관하고 Gemini 요청 header로만 보낸다. 실제 Gemini credential이 없어 live 검증은 NOT RUN으로 기록되어 있다. 이번 Slice 최종 검증 결과는 아래 Validation history에 추가한다.

[연결 사용법/설계/한계](../CONNECTIONS.md), [검증 이력](../VALIDATION.md), [synthetic fixture](../evidence/gemini-native-synthetic.json), [live Gemini probe](../evidence/gemini-native-live.json).

이전 Connection Foundation v1 기록은 `7026e6a` merge와 historical OmniRoute evidence를 보존한다. v1 당시 이름순 최대 3개를 검사했던 제약은 generic OpenAI-compatible path에만 남아 있고 Gemini metadata-based discovery로 바뀌었다.

다음 권장 Slice 2: 후보 무료 Provider 하나의 공식 API·인증·quota/terms를 조사하고 native adapter 하나만 추가한다. 실제 API 검증은 사용할 수 있는 자격 증명과 synthetic-only payload가 있을 때만 수행하고, 가격은 공식적으로 신뢰 가능한 근거가 있을 때만 카탈로그에 기록한다.

2026-10-13 작업환경 분리 결정: 자동 생성된 source `.nidus/state.sqlite3` 체크포인트 커밋 28개는 소스 저장소 이력에서 제거한다. 전체 기존 Git refs와 DB snapshot은 `/Users/parkjaehong/Developer/nidus_vault/backups/source-cleanup-20261013-101721`에 보존했다. 모든 자동 테스트/합성 데모 Vault는 같은 폴더 아래 실행별 디렉터리를 사용하고, Store/GUI는 source 또는 source를 포함하는 상위 경로를 Vault로 거부한다. 기존 `/Users/parkjaehong/NidusVault`의 미커밋 `results/brief.md` 삭제와 `.DS_Store` untracked를 확인했으며 보존한다.
