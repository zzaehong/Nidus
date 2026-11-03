# Vault Runtime 모델 선택·VM 상태 개선

2026-11-04, `feature/vault-runtime-v2`.

후속 변경: 현재 Vault Runtime 선택 목록은 연결된 텍스트 모델 중 저장된 동작 검사에 통과한 모델만 표시한다. [검사 통과 필터와 웹 검색 상태](Vault_Runtime_Health_Filter_Web_Status.md)를 참조한다.

## 문제 및 수정

기존 화면은 OpenAI 두 모델을 하드코딩하고 Agent 채널도 OpenAI로 고정했다. 이제 `agent-models` Host API가 저장된 Provider 연결 및 모델 카탈로그에서 선택 목록을 제공한다. Provider와 모델 ID를 함께 전달하므로 서로 다른 Provider의 같은 모델 이름도 구분한다. 연결이 없거나 카탈로그가 비어 있으면 기본 OpenAI 모델을 임의로 선택하지 않는다.

일반 채팅에 사용할 수 있는 연결된 텍스트 모델은 같은 Nidus Tool Dispatcher와 VM Admission/승인 경로를 사용한다. 이미지 생성·임베딩·실시간 전용 모델은 텍스트 Agent 실행에서 제외한다. 카탈로그 조회는 모델 API나 유료 생성 API를 호출하지 않는다. 저장된 모델 목록이 오래됐다면 Provider 설정에서 갱신해야 한다. 목록에 표시되는 것은 실제 API 접근 성공을 다시 확인했다는 뜻이 아니다.

- 검토된 기존 OpenAI Tool Calling 모델은 기존 네이티브 경로 유지.
- 그 외 텍스트 모델은 기존 Provider 텍스트 Chat Adapter를 통한 `nidus-text-v1` JSON 프로토콜 사용. 모든 Provider의 네이티브 Tool Calling을 구현했다고 주장하지 않는다.
- 모델 출력 전체가 유효한 JSON/허용 도구/Schema일 때만 Tool 요청으로 정규화한다. 승인·실행 대상 위조, 미구현 도구, 잘린 응답, 잘못된 JSON은 도구 실행 전에 차단한다.
- 실제 명령은 계속 Vault VM에서만 실행하고 개별 Host/UI 승인이 필요하다. 모델은 승인할 수 없다.
- 모델이 JSON 지시를 준수하지 않으면 해당 Task는 실패한다. 자동 다른 Provider 전환이나 자동 부작용 재시도는 하지 않는다.
- 기존 계정 권한·비용 정책·Usage Ledger를 사용한다. API 호출은 성공했지만 도구 형식이 잘못된 경우 API 사용량은 그대로 기록하고 도구 실행만 차단한다.
- 모델 변경 시 UI의 데이터 전송/비용 확인 Toggle을 초기화한다.

## VM 현황

화면에서 다음 항목을 표시하고 2초마다 갱신한다.

- 활성 VM 없음 / 활성 VM 1개 / 상태 확인 불가 또는 종료 미확인.
- 부팅·실행·유휴·작업 수행·종료 확인 상태와 Generation.
- 실제 VM 소유 Vault 이름과 ID, VM Instance ID, 활성 Session, 대기 수.
- 선택 Vault와 실제 VM 소유 Vault가 다를 때 안내.
- 최근 5개 실행의 상태와 cleanup 확인 여부, 마지막 확인 시각.

Host 서비스 `summary` RPC는 전체 감사 기록 대신 최근 5개만 전송한다. 기존 서비스가 이 메서드를 모르면 기존 status RPC와 호환된다. 서비스에 연결되지 않고 journal을 읽은 경우 기록 기반이라는 점을 표시하며 실행 중 상태를 안전하게 STOP_UNCONFIRMED로 투영하는 기존 정책은 유지한다. 상태 조회 실패 때는 이전 값을 현재 상태로 표시하지 않는다.

종료 버튼은 실행·대기가 없는 확인된 RUNNING 상태에서만 사용할 수 있고, 실제 VM 소유 Vault를 확인 대화상자에 표시한다. UI 제한과 별개로 기존 Host Admission 검증도 유지한다. 서비스나 VM을 강제로 재시작하거나 잠금을 삭제하지 않았다.

## 검증

- PASS: Node 전체 315건, Swift 전체 47건.
- PASS: 8개 Provider 텍스트 경로의 fixture 테스트, 연결된 카탈로그/비텍스트 제외, Provider 구분, 위조·잘린 응답 거부, Usage 기록·무재시도, 10,000개 기록의 bounded 상태 요약, 기존 daemon 호환.
- PASS: 실제 개발 VM에서 fixture NVIDIA 요청 거부 시 미부팅 → fixture NVIDIA 승인 후 Python 결과 4 → fixture Gemini 요청으로 동일 Instance/Generation 재사용 → cleanup 및 정상 종료. 5개 검사. Provider 응답과 승인은 합성 fixture이며 실제 사용자 승인·실제 Provider 성공으로 표시하지 않는다. Ledger도 테스트 전용 메모리 DB다.
- PASS: 개발 앱 빌드. 기존 개발 VM Image/initrd와 Helper를 유지한다.
- NOT_RUN: 실제 유료 Provider API 호출(별도 승인 없이 수행하지 않음).
- NOT_RUN: 자동 UI 클릭 검토. CUA가 `Sky Computer Use native pipe startup failed`로 연결되지 않았다. Swift UI 모델 테스트와 실제 화면 조작 검증은 구분한다.

실제 VM Evidence: `docs/evidence/Vault_Model_Relay_VM_2026-11-04.json`.

## 사용자 검토

산출물: `/Users/parkjaehong/Developer/Nidus/dist/Nidus.app`.

실행 중인 Task를 마무리한 뒤 앱을 종료하고 새 번들을 다시 연다. 기존 앱이나 VM을 자동으로 강제 종료하지 않았다. Vault Runtime의 새로 고침으로 연결 모델 목록을 확인한다. 모델 선택과 데이터 전송/비용 확인 후 Agent를 실행할 수 있으며 계정 실행 권한은 기존 정책을 따른다. 형식 미준수 모델은 도구를 실행하지 않고 오류로 끝날 수 있다.

VM 현황 카드에서 소유 Vault·Instance·활성 Session·갱신 시각을 확인한다. 선택 Vault를 바꾸더라도 실행 중인 VM의 소유 Vault는 바뀌지 않는다. 종료 미확인 상태에서는 기존과 동일하게 새 실행을 차단한다.

이번 변경은 Browser 인터넷, Host 파일 쓰기, 영속 캐시 등 기존 M4 미완료 기능을 활성화하지 않는다. develop/main 병합이나 원격 push는 수행하지 않는다.
