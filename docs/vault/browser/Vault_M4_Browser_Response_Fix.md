# 브라우저 후속 모델 응답 실패 진단 및 초기 승인 개선

사용자 로그에서 browser_start와 browser_type은 성공했고, 다음 모델 단계가 provider_invalid_response로 종료됐다. 원본 Provider 응답은 제공되지 않아 정확한 실패 형식을 확정할 수 없다. 현재 NVIDIA NIM 경로는 native function calling 대신 nidus-text JSON 프로토콜을 사용한다.

## 변경

- JSON 전체를 감싼 단일 json 코드블록은 제거한 후 기존 전체 구조·도구·인자 검증을 수행한다. 설명문에서 JSON을 추출하거나 잘린 JSON을 보정하지 않는다.
- 오류 원인을 응답 잘림, 필터링, 빈 응답, JSON 구문, 응답 구조, 호출 구조, 도구/인자 검증, 크기 제한으로 나누어 최종 UI에 표시한다. 원본 응답이나 비밀값은 출력하지 않는다.
- 모델 지침에 호출 키는 name/arguments뿐이며 과거 호출 ID나 승인 필드를 복사하지 않도록 명시했다.
- 오류가 난 단계의 도구를 실행하지 않고, Provider 자동 재시도 및 이전 도구 재실행을 추가하지 않았다.
- 초기 navigate 및 observe/scroll 중 발생하는 민감 네트워크 요청은 승인창 없이 차단한다. 초기 페이지의 자동 POST 때문에 승인을 반복해서 요구하지 않는다. 클릭·입력·뒤로 가기 동작 중 민감 요청은 계속 별도 승인한다. POST 데이터 로드가 필수인 일부 사이트에는 제한이 생길 수 있다.

## 검증

- PASS: Node 353개, 앱 빌드.
- PASS: 실제 Google 시작·검색어 입력·화면 변경·정리. 승인 순서는 session, interaction, network-sensitive였다. 시작 단계의 반복 전송 승인 요청은 없어졌고 입력 중 민감 전송 승인은 유지됐다.
- NOT RUN: 실제 NIM 원본 응답 재현, Swift 테스트 재실행(이번 변경에 Swift 소스 변경 없음).

이 변경이 보고된 NIM 응답의 정확한 원인을 재현·해결했다고 주장하지 않는다. 재발 시 표시되는 text_protocol_* 진단으로 다음 원인 분석을 좁힐 수 있다.
