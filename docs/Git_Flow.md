# Nidus Git Flow

Nidus 저장소의 기본 Git 작업 규칙이다.

별도 지시가 없는 모든 개발 작업은 이 문서를 따른다.

---

## 1. Branch 역할

```text
main
└─ 검증된 안정 버전

develop
└─ 다음 버전 통합

feature/*
└─ 일반 기능 개발

release/*
└─ 릴리스 준비

hotfix/*
└─ main 긴급 수정
```

일반 개발은 다음 흐름을 따른다.

```text
latest develop
↓
feature/*
↓
구현 / 테스트
↓
commit
↓
develop --no-ff merge
↓
전체 회귀 테스트
```

`main`, `release/*`, `hotfix/*`는 사용자의 명시적 요청 없이 수정하지 않는다.

---

## 2. 작업 시작

작업 전에 현재 저장소 상태를 확인한다.

```bash
git status
git branch --show-current
git fetch
git checkout develop
git pull --ff-only
git log -1 --oneline
```

최신 `develop`을 source of truth로 사용한다.

미커밋 변경이 있으면 임의로 삭제하거나 되돌리지 않는다.

다음과 같은 작업으로 사용자 변경을 제거하지 않는다.

```text
git reset --hard
강제 restore / checkout
stash drop
불필요한 history rewrite
```

충돌하거나 판단이 필요하면 먼저 현재 상태를 보고한다.

---

## 3. Feature 개발

새 기능은 최신 `develop`에서 시작한다.

```bash
git checkout develop
git checkout -b feature/<name>
```

Branch 이름은 기능 목적이 드러나도록 작성한다.

예:

```text
feature/connection-kinds
feature/omniroute-gateway
feature/gemini-native-provider
```

Branch 수를 늘리는 것이 목적은 아니다.

서로 독립적으로 구현·검증할 가치가 있는 기능만 분리한다.

다음 Feature가 이전 Feature에 의존한다면 반드시 이전 Feature를 `develop`에 병합한 뒤 최신 `develop`에서 시작한다.

---

## 4. Commit

변경사항은 논리적인 단위로 나누어 commit한다.

모든 커밋 메시지는 기본적으로 **한글로 작성한다.**

권장 형식:

```text
기능: Gemini Native Provider 연결 추가

수정: 구조화 응답 실패 후 다음 모델 후보 계속 검사

리팩터링: Provider Adapter와 Connection Registry 의존성 분리

테스트: Direct와 Gateway 연결 동시 등록 검증

문서: API 연결 구조와 책임 경계 정리

정리: 개발 소스에서 런타임 DB 추적 제외
```

필요하면 다음 접두어를 사용한다.

```text
기능:
수정:
리팩터링:
테스트:
문서:
정리:
병합:
```

`feat:`, `fix:`, `docs:` 같은 영문 Conventional Commit 형식은 기본 규칙으로 사용하지 않는다.

`수정`, `update`, `changes`, `작업 완료`처럼 의미가 불분명한 메시지도 피한다.

모든 변경을 마지막 하나의 giant commit으로 몰지 않는다.

---

## 5. 테스트와 병합

기본 작업 단위는 다음과 같다.

```text
구현
↓
관련 테스트
↓
한글 commit
```

Feature 완료 후 관련 테스트를 통과하면 `develop`에 통합한다.

```bash
git checkout develop
git merge --no-ff feature/<name> \
  -m "병합: <기능명>을 develop에 통합"
```

Feature branch에서 테스트가 성공했더라도 merge 후 `develop`에서 회귀 테스트를 다시 실행한다.

```text
Feature test PASS
↓
develop merge
↓
develop regression PASS
```

실패한 테스트를 성공으로 기록하지 않는다.

실행하지 못한 테스트는 `NOT RUN`으로 표시하고 이유를 남긴다.

---

## 6. 사용자 변경과 기록 보호

사용자가 직접 수정한 파일과 현재 작업과 무관한 변경은 보존한다.

임의로 삭제하거나 작업 편의를 위해 되돌리지 않는다.

과거의 실패 기록, 검증 evidence, 실행 결과도 프로젝트 기록으로 취급한다.

새로운 결과를 만들기 위해 과거 기록을 성공 결과처럼 수정하지 않는다.

Runtime DB, 임시 파일, Secret, 테스트 실행 상태 등이 소스 저장소에 의도치 않게 commit되지 않도록 확인한다.

---

## 7. main / Remote

사용자의 별도 요청이 없다면 작업 완료 범위는 다음까지다.

```text
feature/*
↓
local develop merge
```

기본적으로 수행하지 않는다.

```text
main 수정 또는 merge
git push
remote branch 생성
Pull Request 생성/병합
release/tag 생성
force push
history rewrite
```

원격 반영이나 `develop → main` 통합은 사용자가 명시적으로 요청했을 때만 수행한다.

---

## 8. 작업 완료 확인

완료 전에 확인한다.

```text
관련 테스트 PASS
develop merge 완료
develop 회귀 테스트 PASS
의도하지 않은 파일/Secret 없음
main 변경 없음
working tree 상태 확인
```

최종 보고에는 최소한 다음을 포함한다.

```text
Starting develop HEAD

사용한 feature branch

주요 한글 commits

develop merge commit

실행한 테스트
- PASS
- FAIL
- NOT RUN

Final develop HEAD

Main HEAD
- unchanged 여부

Remote
- push / PR 여부

Working tree
- clean 또는 남은 변경

Known limitations
```

Commit hash와 테스트 결과는 실제 Git 상태에서 확인한 값만 보고한다.

---

## 핵심 원칙

```text
최신 develop에서 시작한다.

일반 기능은 feature/*에서 개발한다.

논리 단위로 commit한다.

커밋 메시지는 한글로 작성한다.

검증 후 --no-ff로 develop에 병합한다.

병합 후 전체 회귀 테스트를 수행한다.

사용자 변경과 과거 기록을 보존한다.

별도 요청 없이 main과 remote를 변경하지 않는다.
```