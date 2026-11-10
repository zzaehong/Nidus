# 1단계 설계 — Model Gateway와 Model Assignment

상태: **설계 확정** (2026-11-10). 구현 전이다.

[CONCEPT.md](CONCEPT.md)를 구현하기 위한 첫 단계다. 여러 Provider의 API를 하나의 계약으로 묶고, 역할과 작업 난이도에 따라 모델을 배정하며, 사용량을 Vault별로 기록한다. 2단계(격리 작업 공간)와 3단계(AI Office)는 이 계층 위에 올라간다.

## 범위

포함한다.

- Provider 공통 요청·응답 계약 (텍스트, 도구 호출, 스트리밍)
- Provider별 어댑터와 도구 호출 정규화
- 역할·난이도 기반 Model Assignment
- Vault별 사용량 기록과 예산
- 위 기능을 확인하는 CLI

포함하지 않는다.

- 도구의 실제 실행(파일, Shell, 브라우저)과 권한 판단: 2단계
- Agent의 정체성, 맥락 복구, Task 관리: 3단계
- Vault 등록·무결성 검사: 1단계는 `.nidus/` 디렉터리 경로만 받는다
- 이미지·음성·임베딩 모델 호출

## 용어

### 역할

Agent 계층은 넷이다. Main은 CONCEPT의 Lead Manager 위에 놓인다.

| 역할 | 책임 | 모델 |
|---|---|---|
| `main` | 사용자와 직접 소통한다. Manager에게 목표를 전달하고 최종 결과물을 검토한다 | 고성능 |
| `lead-manager` | 여러 팀이 협업하거나 작업을 넘겨야 할 때 팀 사이를 조정한다 | 고성능 |
| `manager` | 팀장. 작업을 작은 실행 단위로 나눠 Worker에게 맡기고 결과를 검토한다 | 고성능 |
| `worker` | Manager의 지시를 받아 실제 작업을 수행한다 | 난이도에 따라 |

역할 목록은 코드에 고정하지 않고 배정표의 키로 둔다. 역할이 늘어도 계약은 바뀌지 않는다.

### 난이도

난이도는 **Worker가 수행하는 작업**의 난이도이며 `simple`, `normal`, `complex` 세 값이다. 작업을 지시하는 쪽(Manager 또는 Main)이 지시할 때 지정한다. Gateway는 요청 내용을 보고 난이도를 추측하지 않는다.

Worker가 스스로 더 높은 모델로 올라가지 않는다. 더 높은 모델이 필요하면 지시자가 난이도를 올려 다시 지시한다.

## 공통 계약

메시지 본문은 블록의 배열이다. 기존 계약은 문자열 하나였기 때문에 도구 호출을 담을 수 없었다.

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; content: string; isError: boolean }
  | { type: 'provider_state'; provider: ProviderId; data: unknown };

interface Message { role: 'user' | 'assistant'; content: ContentBlock[] }

interface ToolSpec { name: string; description: string; inputSchema: JsonSchema }

interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required' | 'none';
  maxOutputTokens?: number;
}

interface ModelResponse {
  provider: ProviderId;
  model: string;
  content: ContentBlock[];
  stopReason: 'end' | 'tool_call' | 'max_tokens' | 'refusal' | 'other';
  usage: Usage;
}
```

- `provider_state`는 Provider가 다음 요청에 그대로 돌려받아야 하는 불투명 데이터(추론 블록, 서명 등)를 담는다. 같은 Provider로 이어갈 때만 되돌려 보내고, 모델이 다른 Provider로 바뀌면 버린다. 이 규칙이 있어야 한 대화 안에서 모델을 바꿀 수 있다.
- `tool_call.input`은 어댑터가 `inputSchema`로 검증한 뒤 반환한다. 검증에 실패한 호출은 오류로 돌려준다.
- 도구 결과는 신뢰하지 않는 입력이다. Gateway는 결과를 모델에 전달만 하고 해석하지 않는다.
- 스트리밍은 `text_delta`, `tool_call`, `done` 세 이벤트로 통일한다. 스트리밍을 구현하지 않은 어댑터는 응답 전체를 `done` 하나로 내보낸다.

## 어댑터

도구 호출 형식은 네 갈래로 정규화한다.

| 구현 | 대상 Provider |
|---|---|
| Anthropic Messages | Anthropic |
| OpenAI Responses | OpenAI |
| Gemini generateContent | Gemini |
| Chat Completions 호환 | DeepSeek, Groq, Mistral, NVIDIA, Cloudflare |

어떤 모델이 도구 호출을 지원하는지는 모델 ID 목록을 코드에 적지 않는다. Models API가 알려 주는 값과 실제 왕복 검사 결과를 모델 캐시에 기록해 판단한다.

## Model Assignment

입력은 역할, 난이도(Worker일 때), 필요한 기능이다. 출력은 모델 하나와 선택 이유다.

```ts
assign({ role: 'worker', difficulty: 'simple', needs: { tools: true } })
// → { provider, model, reason }
```

배정표는 Vault의 `.nidus/models.json`에 둔다. 각 칸은 우선순위 순서의 후보 목록이다.

```json
{
  "version": 1,
  "roles": {
    "main": ["<provider>:<model>"],
    "lead-manager": ["<provider>:<model>"],
    "manager": ["<provider>:<model>", "<provider>:<model>"]
  },
  "worker": {
    "simple": ["<provider>:<model>", "<provider>:<model>"],
    "normal": ["<provider>:<model>"],
    "complex": ["<provider>:<model>"]
  }
}
```

선택 규칙은 다음과 같다.

1. 해당 칸의 후보를 순서대로 본다.
2. 키가 연결되어 있고, 모델이 캐시에 있으며, 필요한 기능을 지원하는 첫 후보를 고른다.
3. 첫 후보가 아닌 모델이 선택되면 그 이유를 사용량 기록에 남긴다.
4. 쓸 수 있는 후보가 없으면 실패한다. 다른 칸의 모델을 대신 쓰지 않는다.

Agent의 Home에는 모델을 기록하지 않는다(CONCEPT의 Home 항목). 모델은 호출할 때마다 이 배정표에서 정한다.

## `.nidus/` 배치

```text
.nidus/
├─ models.json          배정표 (Git 추적)
├─ budget.json          Vault 예산 (Git 추적)
├─ .gitignore           local/ 을 제외
└─ local/               Git 제외
   ├─ usage.sqlite      사용량 기록
   └─ models/           Provider별 모델 캐시
```

- Git은 AI가 잘못한 작업을 되돌리기 위한 수단이다. 설정 파일은 추적해서 되돌릴 수 있게 하고, 바이너리 DB와 캐시는 `local/`에 모아 제외한다.
- `local/`은 Git에는 없지만 Vault 디렉터리를 통째로 옮기면 따라간다.
- API 키는 Vault에 두지 않는다. macOS Keychain에 기기 단위로 저장하고 여러 Vault가 함께 쓴다.

## 사용량과 예산

호출 한 번마다 한 줄을 기록한다.

| 항목 | 내용 |
|---|---|
| 시각, 결과 | 성공, 실패, 취소 |
| 역할, 난이도 | 배정 입력 |
| Agent, Task | 2·3단계에서 채운다. 1단계는 비워 둘 수 있다 |
| Provider, 모델, 선택 이유 | 배정 출력 |
| 토큰 | 입력, 출력, 캐시 읽기, 캐시 쓰기, 추론 |
| 비용 | 가격을 모르면 0이 아니라 비워 둔다 |

이 기록으로 역할별·난이도별 토큰과 비용을 집계한다. 난이도 배정이 실제로 비용을 줄였는지는 이 집계로 확인한다.

예산은 Vault 단위다. 예산을 넘으면 경고만 하고 호출은 계속한다. 같은 API 키를 여러 Vault가 쓸 때의 키 전체 상한은 두지 않는다.

## 기존 코드 재사용

| 대상 | 처리 |
|---|---|
| `src/http.ts`, `src/errors.ts` | 그대로 가져온다 |
| `src/adapters/`의 모델 조회, 인증, 사용량 정규화 | 가져오고, 요청·응답 변환은 새 계약에 맞춰 다시 쓴다 |
| `src/credentials.ts`, `native/keychain.swift` | 그대로 가져온다 |
| `src/pricing.ts`, `src/money.ts` | 그대로 가져온다 |
| `src/ledger.ts` | SQLite 접근 방식만 가져오고 스키마는 새로 만든다 |
| `src/router.ts`, `src/routing-context.ts` | 쓰지 않는다. 배정표로 대체한다 |
| `src/engine.ts` | 쓰지 않는다. Gateway로 대체한다 |

가져오는 파일은 한 줄에 여러 문장이 압축된 부분을 풀어 쓴다.

## 완료 기준

- 네 갈래 어댑터 각각에서 도구 호출 왕복(호출 → 결과 전달 → 최종 답)이 실제 API로 성공한다.
- 한 대화 도중 Provider를 바꿔도 이어서 응답한다.
- 역할과 난이도를 바꿔 호출하면 배정표대로 모델이 선택되고, 후보가 없으면 실패한다.
- 호출 기록이 `.nidus/local/usage.sqlite`에 남고 역할별·난이도별 집계가 나온다.
- 단위 테스트는 HTTP를 주입해 외부 계정 없이 통과한다.

## 결정 사항

- **예산을 넘으면 경고만 한다.** 호출을 막지 않는다. 경고는 호출 결과와 사용량 집계에 함께 표시한다.
- **과금 동의·무료 플랜 승인 절차는 1단계에 넣지 않는다.** 기존 엔진의 Provider별 과금 유형 확인과 무료 모델 승인은 가져오지 않는다. 필요해지면 Security Office 정책으로 다시 설계한다.
