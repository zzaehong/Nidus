# 현재 계획 / Current plan

[한국어](#한국어) · [English](#english)

## 한국어

### 현재 상태

Integration: `feat/model-gateway`. 오프라인 MVP, Gateway, Copilot/Gemini/NVIDIA 실제 생성, 주입 장애 Fallback, 활성 Pool은 완료됐다.
진행 중 제품 구현 Slice나 현재 Blocker는 없다. 무료 청구 검증, 일반 Agent 자율성, 개념 설계의 GUI/Manager 등은 완료로 표시하지 않는다.
이 파일은 현재 상태와 다음 작업만 관리하고 세부 실행 결과는 [검증 보고서](../VALIDATION.md)를 단일 출처로 사용한다.

### 이번 문서 정리

Feature: `docs/consolidate-bilingual`. 완료: 기존 Markdown 18개를 안내 문서 6개 + 작업 지시 1개로 통합했다.

| 단일 문서 | 역할 |
|---|---|
| README.md | 설치 전제, 빠른 체험, 직접 작업, 모델 연결, 승인·복구, 테스트 |
| PRD.md | 요구사항·AC-01–08·MG-AC-01–06·PV-AC-01–04 |
| DESIGN.md | 현재 구현·소유권·상태·보안·복구·모델 경계 |
| docs/CONCEPT.md | v1/v2/changes의 장기 책임 모델과 미확정 선택 |
| docs/VALIDATION.md | MVP·Gateway·Provider·설치·Blocker 보고서의 최신 상태와 실패 이력 |
| docs/plans/current-plan.md | 현재 상태, 이번 변경과 다음 작업 |

모든 문서는 같은 파일에 한국어/영어를 둔다. 사용자 작업 지시 `doc/prompt.md`는 원문을 보존하고 영문을 덧붙이며 사용자의 기존 수정과 함께 미커밋 상태로 둔다.
JSON 실행 증거·정책·코드·키는 변경하지 않는다. 이전 문서는 Commit `d8ab677`에서 조회한다.
검증: 상대 링크/앵커 존재, 양언어 절, 오래된 문서 참조, README 오프라인 명령의 임시 Vault 실행, diff 검사.
링크/앵커·양언어 검사, 오프라인 데모, README 직접 실행과 생성형 승인 대기/거절 검증을 통과했다. 기존 증거/정책/코드 변경은 0건이다.
문서 정리를 위해 새 모델 호출이나 전체 제품 회귀를 반복하지 않는다. 코드 변경 시 관련 회귀를 따로 실행한다.

### 개발 이력과 다음 단계

오프라인 `feat/nidus-mvp` → Gateway 설계/생성형 실행/보강 → OmniRoute 설치 → Copilot Live → 다중 Provider 검증 → Gemini/NVIDIA 활성화 순으로 통합했다.
주요 Commit/실행 증거는 VALIDATION의 개발 이력 표에 보존한다. 완료된 Slice를 다시 진행 중으로 되돌리지 않는다.
다음 제품 작업은 사용자가 선택한다. 재사용 시 README의 Pool 정책을 명시적으로 선택하고 자료를 검토한 뒤 전송 승인한다.
Remote push/PR/main/develop merge는 이번 범위가 아니다. `.DS_Store` 등 무관한 사용자 파일과 prompt 원문을 보존한다.

## English

### Current status

Integration: `feat/model-gateway`. Offline MVP, Gateway, real Copilot/Gemini/NVIDIA generation, injected-fault fallback and the active pool are complete.
No product implementation slice or current blocker remains. Free-billing verification, general agent autonomy and conceptual GUI/managers are not marked complete.
This file owns only current state/next work; [validation](../VALIDATION.md) is the single source for execution details.

### Documentation consolidation

Feature: `docs/consolidate-bilingual`. Complete: reduced 18 Markdown files to six guides plus one instruction file.

| Canonical document | Responsibility |
|---|---|
| README.md | Prerequisites, quick start, direct work, models, approval/recovery, tests |
| PRD.md | Requirements, AC-01–08, MG-AC-01–06, PV-AC-01–04 |
| DESIGN.md | Implementation, ownership, state, security, recovery, model boundary |
| docs/CONCEPT.md | v1/v2/changes long-term responsibility model and open decisions |
| docs/VALIDATION.md | Current status/history from MVP/Gateway/provider/install/blocker reports |
| docs/plans/current-plan.md | Current status, this change and next work |

Each document contains Korean/English in the same file. Preserve the original user instructions in `doc/prompt.md`, append English, and leave it uncommitted with the user's existing edits.
Do not change JSON evidence/policies/code/keys. Retrieve earlier documents at commit `d8ab677`.
Verify relative links/anchors, both language sections, obsolete references, README offline commands in a temporary vault and diff checks.
Link/anchor/language checks, offline demo, README direct execution and generative wait/reject boundary checks passed. Existing evidence/policy/code changes: zero.
Do not make new live calls or repeat full product regression for documentation cleanup; run relevant regression separately if code changes.

### History and next steps

Integrated offline `feat/nidus-mvp` → Gateway design/generative execution/hardening → OmniRoute installation → Copilot live → multi-provider validation → Gemini/NVIDIA activation.
VALIDATION retains important commits/evidence in its history table. Do not reopen completed slices.
The user selects the next product task. For reuse, explicitly choose the README pool policy, inspect inputs and approve transmission.
Remote push/PR/main/develop merge is outside this scope. Preserve unrelated `.DS_Store` files and original prompt instructions.
