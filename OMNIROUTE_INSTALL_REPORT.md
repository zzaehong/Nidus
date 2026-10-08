# OmniRoute 설치 결과 — 2026-10-08

상태: **설치 및 로컬 서버 실행 완료**. 실제 생성형 Task의 완료 검증은 별도입니다.

- 공식 npm 패키지 `omniroute@3.8.51` 설치.
- Node.js `v24.21.0`, npm `11.19.0`; 패키지 Node 요구사항 충족.
- 현재 사용자 fnm Node 설치 환경에 전역 설치했으며 시스템 Node나 shell 설정은 변경하지 않음.
- `omniroute --version`: `3.8.51`; CLI help 실행 성공.
- npm 11의 필수 설치 스크립트 차단은 공식 허용 목록을 이번 설치에서만 적용하여 해결.
- `OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray` 실행.
- `lsof`로 `127.0.0.1:20128` LISTEN 확인.
- 대시보드 `/`: HTTP 200. `/v1/models`, `/api/health/degradation`: 인증 없이 HTTP 401.
- 자동 시작 프로그램 등록, 외부 네트워크 공개, 계정 생성, 유료 결제는 하지 않음.
- OmniRoute 데이터/인증 설정은 저장소 밖 `~/.omniroute/`에서 관리. Key 값은 읽거나 출력하지 않음.

대시보드: http://127.0.0.1:20128

Nidus 기본 정책과 `model-policy.example.json`은 이 서버의 `/v1`을 사용합니다.
모델명 `nidus-free`는 **무료 Provider만 포함한 Combo를 Dashboard에서 만든 뒤** 사용하기
위한 명시적 이름입니다. 아직 생성된 Combo라는 뜻은 아닙니다. `auto`가 연결된 유료
Provider를 선택할 수 있으므로 기본 예제에서는 무조건적인 auto routing을 사용하지 않습니다.
원한다면 정상적으로 접근 가능한 특정 무료 모델 ID로 정책의 model 값을 교체할 수 있습니다.
Router 내부의 요금/Provider 설정을 Nidus가 자동 검증하는 기능은 없습니다.

다음 설정이 남아 있습니다.

1. Dashboard에서 관리자 초기 설정과 정상 무료 Provider 연결.
2. 무료 전용 `nidus-free` Combo 생성 또는 정책에 특정 무료 모델 ID 지정.
3. OmniRoute Endpoint Key를 Nidus 프로세스의 `NIDUS_MODEL_API_KEY` 환경변수로 제공.
   Key를 채팅, Task, Library, 정책 JSON 또는 Git에 넣지 않음.
4. 공개용 합성 문서로 `scripts/model_live.py` 실행하고 Completed 증거 확인.

```sh
# 서버가 종료됐을 때 다시 시작
OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray
# 서버 종료
omniroute stop
# Provider/Key 설정 후 Nidus Live 검증 (기존 실패 증거 보존)
python3 scripts/model_live.py --allow-synthetic-transmission --policy model-policy.example.json --evidence /tmp/nidus-omniroute-live.json
```

모델 실행 전 Nidus의 정확한 전송 승인·검증 경계는 그대로 적용됩니다.
전체 Model Gateway 상태와 남은 Live 검증은 MODEL_GATEWAY_REPORT.md에 기록합니다.
