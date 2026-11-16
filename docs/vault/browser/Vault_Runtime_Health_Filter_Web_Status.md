# Vault Runtime 검사 통과 모델 필터와 웹 검색 상태

2026-11-04 · feature/vault-runtime-v2

## 모델 선택

Vault Runtime은 기존 Dashboard와 같은 `HealthResultStore.application`의 `model-health.json`을 읽는다. 연결된 현재 텍스트 모델과 **동일 Provider + 모델 ID**의 저장된 검사 결과가 `passed`이고 text 유형인 경우만 선택 목록에 표시한다. 실패·미검사·연결 해제·비텍스트 모델은 제외하며, 검사 통과 모델이 없으면 임의의 모델로 대체하지 않는다.

실행 버튼을 누를 때 저장 기록을 다시 읽는다. 선택 모델의 기록이 실패로 변경되거나 삭제되면 실행을 중단한다. 그 사이 다른 모델이 통과해도 자동으로 다른 Provider/모델을 실행하지 않는다. 기록 손상 시에는 목록과 선택을 비우고 오류를 표시한다. 모델 새로 고침은 기존 검사 기록을 변경하지 않는다.

이는 UI의 텍스트 응답 검사 통과 조건이다. 과거 텍스트 검사 성공이 현재 API 권한·무료 이용·JSON 도구 프로토콜 준수·VM 도구 성공까지 보장하는 것은 아니다. 기존 계정 권한과 Tool 승인 검사는 별도로 유지한다.

## 웹 검색의 실제 상태

**현재 제품 웹 검색은 비활성이고 이번 변경도 실제 인터넷 검색을 활성화하지 않는다.** Browser 도구는 Registry에서 구현 완료로 광고되지 않고 VM은 오프라인이다. 이전 Chromium 검증은 합성 HTML의 오프라인 DOM 진단이었다. Browser Context, 실제 VM 네트워크 경계와 우회 방지 검증이 끝나지 않아 공개 웹 검색을 제품에서 사용할 수 없다. Host 웹 검색 API나 Host 브라우저로 이를 우회하지 않는다.

사용자가 최신 웹 정보를 요청해도 기존 LLM 지식은 실시간 검색 결과가 아니다. 이를 명확히 하기 위해:

- 화면에 별도 `웹 검색 · 현재 사용 불가` 영역을 표시한다.
- `웹 검색이 반드시 필요함`을 선택하면 UI에서 Agent 실행을 차단한다. Host 채널/Runtime의 `requiresWeb` 요청도 모델 호출 전에 `web_unavailable`로 종료한다.
- 모든 모델 경로(기존 네이티브 Tool Calling, Nidus JSON 방식)에 현재 웹 도구가 없고 오프라인 Shell로 우회할 수 없다는 지침을 전달한다.
- Agent 결과에 Host가 산출한 `webStatus`를 추가한다. 현재는 `unavailable`이며 화면은 `웹 검색 미수행 · 최신 웹 검증 결과 아님`을 모델 텍스트와 별도로 표시한다.
- 모델의 자연어 주장만으로 웹 검색 성공 상태를 만들지 않는다. 향후 구현된 browser tool의 실제 성공 결과가 있어야 `used`로 표시할 수 있다.

자연어 질문의 의도를 키워드로 자동 판정하는 기능은 넣지 않았다. 웹 필수 체크를 하지 않은 질문은 모델 호출이 발생할 수 있지만, 모델 지침과 Host 상태 표시로 인터넷 검증이 수행되지 않았다는 사실을 구분한다. 이 지침이 모델의 모든 잘못된 문장을 완전히 방지한다고 주장하지 않는다.

## 검증

- PASS: Node 321건, Swift 50건.
- PASS: 웹 필수 요청의 모델 호출 0건, Tool 실행 0건, scope 정리; Browser 광고 없음; 두 Provider 응답 경로의 웹 불가 지침; Host provenance 표시.
- PASS: Provider가 다르고 모델 ID가 같은 경우의 검사 구분, 성공 모델만 표시, 실패·미검사 제외, 실행 전 기록 변경 시 무실행·자동 모델 전환 금지, 손상 기록 차단.
- PASS: `npm run build:app`, `/Users/parkjaehong/Developer/Nidus/dist/Nidus.app` 생성.
- NOT_RUN: 실제 유료 Provider 호출, 실제 웹 검색, 자동 UI 클릭 검증. 기존 Browser/Network 안전성 Gate를 통과한 것으로 간주하지 않는다.

앱을 다시 연 뒤 모델 일괄 검사에서 성공한 기록이 있는 모델만 Vault Runtime 목록에 나타나는지 확인한다. 추가 검사 후에는 Vault Runtime의 새로 고침을 사용한다. 실제 웹 리서치는 M4 Browser/Network 구현 및 검증이 완료될 때까지 지원되지 않는다.
