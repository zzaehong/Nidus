# 현재 계획 / Current plan

## 한국어

통합 브랜치: `develop`. 안정 버전: `main`. 사용자 요청에 따라 Git Flow를 사용한다. 각 기능은 `develop`에서 만든 `feature/*`에서 구현·검증·커밋한 뒤 `develop`에 병합한다. 이번 작업은 원격 push/PR/main 병합을 포함하지 않는다. 사용자가 수정한 `doc/prompt.md`를 실행 기준으로 보존한다.

목표: Manager 계약 → Worker 실행/자기 점검 → 결정적 검증 → Manager APPROVE/REWORK/ESCALATE → 완료/재작업/사람 판단. 검토는 Manager 책임이며 별도 Verifier를 만들지 않는다.

| 기능 브랜치 | 범위 | 완료 조건 | 상태 |
|---|---|---|---|
| feature/workflow-contract | 계약, 역할 지침, 구조화된 제출, 역할별 정책 | 명시 계약 저장, 작업자에게 전달, 자기 점검 형식 검증 | 완료 |
| feature/manager-review | 독립 검토, 승인 바인딩, 완료 gate | APPROVE 없으면 완료 금지, 변경 시 무효 | 완료 |
| feature/rework-human-review | 재작업 이력/한도, 품질 판단 CLI | 재작업 재개, 한도/ESCALATE 사람 대기, 승인/재작업/취소 | 완료 |
| feature/workflow-validation | A–F/보안/회귀, 실제 합성 증거, 문서 | 53 offline + 5 HTTP, compileall/diff, 실제 Copilot APPROVE/Archive 증거 | 완료 |

명시 계약 입력과 기본 계약을 사용하며 계획 생성용 모델 호출은 추가하지 않는다. 기존 deterministic 브리핑과 legacy 작업은 호환 모드로 유지한다. 새 CLI generative 작업은 manager workflow가 기본이다. 역할은 Manager/Worker 두 책임이며 모델 선택과 분리한다. 전송은 작업자와 관리자 각각 정확한 prompt/policy snapshot 승인을 받는다. 변경된 재작업 prompt는 새 승인을 받는다.

검증: `python3 -m unittest discover -s tests -q`, `python3 tests/integration/model_http.py -v`, compileall, diff 검사. 공개 합성 자료의 실제 호출은 기존 연결과 명명된 환경 키만 사용하며 과거 evidence를 덮어쓰지 않는다. live 불가능 시 차단 근거를 보존하고 완료라고 주장하지 않는다.

## English

Integration: `develop`; stable: `main`. The user's current Git Flow request overrides historical main-only instructions. Implement each feature on `feature/*`, validate/commit, then merge into develop. No remote push/PR/main merge in this task.

Slices: contract/role prompts/submission → manager review/completion binding → bounded rework/human decisions → regression/live evidence/documentation. Managers own review; no separate verifier. Explicit/default contracts avoid an unnecessary planning model call. New CLI generative tasks use the managed workflow; deterministic extraction and legacy tasks remain compatible. Exact per-call transmission approval applies independently to worker, manager and revisions. Preserve historical live evidence and report blockers accurately.

### 실행 결과 / Execution result

네 기능 Slice를 각각 feature 브랜치에서 구현하고 develop에 통합했다. 원래 요청의 Git Flow가 prompt의 main-only 규칙보다 우선한다. 사용자 수정 prompt를 첫 기능 커밋에 보존했다. feature 브랜치는 기능별 변경을 검토할 수 있도록 유지한다. main과 원격은 이번 작업에서 변경하지 않았다.

검증: 53 offline / 5 HTTP tests PASS, compileall, diff 검사. 실제 Copilot 두 역할 실행에서 APPROVE → Completed, Active 0 / Archive 1. 실패한 Gemini 400과 JSON 형식 실패도 evidence에 보존했다. 현재 Provider 가용성과 과거 성공은 구분한다. 전체 조직, 계획 자동 생성, 의미 정확성 보장, 실제 모델 REWORK/ESCALATE 일반성은 주장하지 않는다. 상세 결과는 VALIDATION의 최신 절에 있다.

All four feature slices are integrated into develop with separate feature commits/merge commits. Preserve feature refs for review. main/remotes are unchanged by this task. 53 offline / 5 HTTP tests, compileall/diff passed. Real Copilot Worker and Manager completed with APPROVE, Active 0 / Archive 1; retain Gemini/JSON failures and historical provider evidence. Full organization, automatic planning and general semantic accuracy are not claimed.
