# Nidus

로컬 Agent Vault 안에서 요청·작업 계약·문맥 복구·권한 검사·실행·검증·보관을
연결하는 최소 Runtime입니다. 현재 Worker는 문서의 첫 세 비어 있지 않은 줄과
SHA-256을 추출하는 **결정적 evidence briefing**을 수행합니다. 생성형 AI 요약이나
임의의 자연어 업무 실행 기능은 아직 연결되지 않았습니다.

Python 3.9 이상과 Git이 필요합니다. 별도 패키지 설치나 API Key는 필요하지 않습니다.
macOS/Linux에서 저장소 루트의 터미널로 실행합니다.

```sh
python3 scripts/demo.py
```

별도 임시 Vault에서 실제 CLI 프로세스들을 실행합니다. 출력된 Vault 경로에 결과와
로컬 Git 이력이 남습니다. 실행 직후 종료하고 다시 실행하는 검증 경로도 포함합니다.

직접 사용할 때는 Library에 UTF-8 `.md`/`.txt` 원문을 넣고 다음 명령을 실행합니다.
`/path/to/vault`는 사용자 Vault의 실제 경로, `<task-id>`는 submit 결과의 id입니다.

```sh
python3 -m nidus --vault /path/to/vault init
python3 -m nidus --vault /path/to/vault submit "회의 기록 브리핑" --source notes.md --output results/brief.md --priority do-now
python3 -m nidus --vault /path/to/vault run <task-id>
python3 -m nidus --vault /path/to/vault show <task-id>
python3 -m nidus --vault /path/to/vault list
python3 -m nidus --vault /path/to/vault list --archive
```

기존 출력 파일은 Waiting으로 전환됩니다. `show`의 attention에서 대상과 영향을
검토한 후 명시적으로 결정합니다. 승인 후 파일이 달라지면 다시 승인을 요청합니다.

```sh
python3 -m nidus --vault /path/to/vault decide <task-id> approve
python3 -m nidus --vault /path/to/vault run <task-id>
# 또는 decide <task-id> reject: 원문을 보존하고 작업 취소
```

`run --execute-only`는 결과 저장 후 Verifying에서 멈춥니다. 다음 `run`이 검증을
재개합니다. Blocked는 `show`의 error와 history를 확인하고 원인을 고친 후 명시적으로
다시 run할 수 있습니다. Waiting/Completed/Cancelled는 run으로 자동 변경되지 않습니다.
Blocked CLI 종료 코드는 2이며 Waiting은 정상적인 판단 대기이므로 0입니다.

Vault의 `.nidus/state.sqlite3`에는 Home·Desk·Task Board·결정·체크포인트·감사 이력이
저장됩니다. 완료 작업은 활성 목록에서 빠지고 Archive에서 유지됩니다. Library는
`.nidus/` 밖의 사용자 일반 파일입니다. 승인된 덮어쓰기 전 기존 파일 버전도 Git에
보존합니다. Runtime은 관련 파일만 로컬 커밋하고 사용자의 무관한 staged 변경은
커밋하지 않습니다. Remote push는 없습니다. 실행 중인 Vault는 복사하지 마세요.

허용 도구는 제한된 파일 읽기/쓰기뿐입니다. 경로 탈출, 숨김 파일, 심볼릭 링크,
원문 덮어쓰기는 거부합니다. Shell·네트워크·Secret 접근 도구가 없으며, 외부 프로세스가
적대적으로 파일을 바꾸는 상황에 대한 OS sandbox는 제공하지 않습니다.

```sh
python3 -m unittest discover -s tests -v
PYTHONPYCACHEPREFIX=/tmp/nidus-pycache python3 -m compileall -q nidus tests scripts
git diff --check
```

제품 범위는 [PRD.md](PRD.md), 기술 구조는 [DESIGN.md](DESIGN.md), Slice와 Git 이력은
[current-plan.md](docs/plans/current-plan.md), 최종 결과는 [MVP_REPORT.md](MVP_REPORT.md)에
기록합니다. 개념 설계의 원본은 [v2](doc/Nidus_Conceptual_System_Design_v2.md)와
[변경 요약](doc/Nidus_Conceptual_System_Design_v2_changes.md)입니다.
