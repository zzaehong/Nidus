# 남아 있는 가설에 대한 결정

오프라인 Runtime은 구현 및 검증이 완료되었다. 그러나 원래 미션의 더 강한 가설인
**실제 생성형 AI Employee가 계획을 세우고 작업을 수행하는 것**은 아직 검증되지 않았다.
현재 저장소에는 모델 Runtime, 모델 Adapter, Credential 또는 Provider 설정이 존재하지 않는다.
또한 `ollama`와 `llama-cli`는 PATH에 존재하지 않는다.

결정론적 추출 작업을 AI의 판단으로 조용히 재해석해서는 안 된다.
실제 Provider를 선택하는 순간 새로운 네트워크/데이터 전송/Secret 경계가 생성된다.
기존 프롬프트는 보안 모델 또는 승인 정책이 변경되는 경우 반드시 작업을 중단하도록 요구하며,
임의의 유료 서비스 사용이나 외부 데이터 전송도 금지하고 있다.

다음 Slice를 진행하기 위해 필요한 인간의 결정은 다음과 같다.

- 로컬 모델 Host를 선택하거나,
- 명시적으로 승인된 외부 Provider를 선택하고,
- 어떤 데이터의 전송을 허용할지,
- Credential을 어떻게 처리할지 결정해야 한다.

API Key는 Task Context에 직접 입력하거나 Vault에 Commit해서는 안 된다.

현재까지의 작업은 로컬 Feature Branch와 Integration Branch에 안전하게 Commit되어 있다.
어떠한 모델 서비스도 생성되지 않았고,
외부로 데이터가 전송되지 않았으며,
Conceptual Design 문서 역시 변경되지 않았다.
