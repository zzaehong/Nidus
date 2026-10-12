# 현재 계획 / Current plan

2026-10-12: Local GUI v1 구현, 자동 회귀, 실제 Chrome workflow 및 CLI 서버 재시작 검증 완료. 마지막 문서/evidence feature를 develop에 병합하고 전체 회귀·clean 상태를 확인한다. 최종 merge/HEAD는 완료 응답에 기록한다. main/release/원격 push/PR은 변경하지 않는다.

시작 develop: `fcd97115d02a50336922ede8722ffaeb539ab1ce` (fetch한 원격 develop `4d8c854`를 포함한 검증 완료 로컬 develop). 사용자 GUI 요구사항은 `6578da8`에 별도 보존했다.

| 실제 feature branch | 기능 / 검증 | develop 통합 |
|---|---|---|
| feature/gui-foundation | loopback server, Application projection, Runtime guard, CLI, 7 GUI tests; 기존 104+7 통과 | `22834e2` |
| feature/gui-dashboard | default-light Dashboard/Plan/Task/Attention/Archive/Settings 및 생성/실행/판단; 111 discovery 회귀 | `5406723` |
| feature/gui-evidence | 실제 HTTP workflow·보안·복구, 브라우저 검증과 수정, 정확한 시각, 문서; 119+7 및 Frontend 6 검증 | 최종 통합 단계 |

브랜치 이동 전 git status를 확인했고 feature commit → 테스트 → develop merge → 전체 discovery 회귀 뒤 다음 branch를 생성했다. 사후 이력 재작성은 없다. GUI는 Store를 직접 수정하지 않고 PlanRuntime/Runtime을 호출한다. task ready는 Runtime 값, 결정적 권한·완료·의존성·snapshot은 기존 Runtime 책임이다. 한 클릭은 한 bounded step이며 Scheduler/Worker 병렬 실행을 추가하지 않았다.

[GUI 보고서](../GUI_REPORT.md), [검증](../VALIDATION.md), [브라우저 증거](../evidence/gui-browser-review.json), [설계](../../DESIGN.md).

이전 다중 Task 조정은 `4499a50` / `3e48dd6` / `fcd9711` 병합으로 완료됐다. 기존 외부 모델 성공과 사용량은 [다중 Task 보고서](../MULTI_TASK_REPORT.md)에 보존한다. GUI 검증은 공개 합성/로컬 모델로 한정했다.

다음 권장 단계는 공개 가능한 실제 업무를 GUI에서 수행하며 usability·오류 설명·사람 판단 빈도를 측정하는 것이다. Pixel Office/직원 공간 표현은 같은 상태 모델 위의 별도 표현 계층으로 검토한다.

English: Local GUI v1 is implemented over the existing Runtime, with actual Chrome workflow and restart validation. Final integration rechecks 119 discovery + 7 HTTP/CLI tests, six frontend checks and compile/diff. Main and remotes are unchanged. Exact final HEAD and clean tree are reported at delivery.
