# Nidus 작업 지침

Nidus 저장소에서 작업하기 전에 반드시 [Git Flow 문서](Git_Flow.md)를 읽고 그 규칙을 따른다. 이 문서는 브랜치 생성, 커밋, 테스트, 병합, 원격 반영의 기준 문서다.

## 기본 원칙

- 최신 `develop`에서 `feature/<name>` 브랜치를 만든 뒤 작업한다.
- 변경사항은 검증 가능한 논리 단위로 나누어 커밋한다.
- 커밋 메시지는 한글 접두어(`기능:`, `수정:`, `테스트:`, `문서:`, `정리:` 등)를 사용한다.
- 관련 테스트를 실행하고 결과를 실제 상태 그대로 기록한다. 실행하지 못한 테스트는 `NOT RUN`으로 남긴다.
- 관련 변경을 하나의 완결된 feature 작업으로 모아 논리 단위로 커밋한다. 개별 커밋이나 작은 수정 직후에 `develop`으로 병합하지 않는다.
- feature 범위를 구현·검증한 뒤 변경 요약, 커밋, 테스트 결과를 보고하고 사용자의 **명시적인 develop 병합 승인**을 기다린다. 승인 전에는 feature 브랜치에만 둔다.
- 승인된 feature만 `develop`에 `--no-ff`로 병합하고, 병합 후 회귀 테스트를 실행한다. 승인 이후 feature 내용이 바뀌면 다시 승인을 받는다.
- 사용자가 직접 수정한 파일, 기존 기록, 검증 evidence는 임의로 삭제하거나 되돌리지 않는다.
- `main`, `release/*`, `hotfix/*`, 원격 저장소, 강제 push는 사용자가 명시적으로 요청한 경우에만 변경한다.
- 비밀키, 런타임 데이터베이스, 임시 파일을 저장소에 커밋하지 않는다.

## 작업 시작 점검

```bash
git status
git branch --show-current
git fetch
git switch develop
git pull --ff-only
git log -1 --oneline
```

미커밋 변경사항이 있으면 먼저 상태를 확인하고 보존한다. `reset --hard`, 강제 복원, `stash drop`, history rewrite로 사용자 변경을 제거하지 않는다.

## 완료 보고

최종 보고에는 시작과 종료 시점의 `develop` HEAD, 사용한 feature 브랜치, 주요 커밋, 실행한 테스트 결과(`PASS`/`FAIL`/`NOT RUN`), 병합 승인 대기 여부, `main` 변경 여부, 원격 반영 여부, 작업 트리 상태를 포함한다.
