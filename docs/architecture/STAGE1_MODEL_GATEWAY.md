# 1단계 설계 — Model Gateway와 Model Assignment

상태: **구현됨** (2026-11-11), 실제 API 검증 전이다. 코드는 `src/gateway/`에 있다.

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
  | { type: 'tool_call'; id: string; name: string; input: unknown; inputError?: string }
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
- `tool_call.input`은 어댑터가 `inputSchema`로 검증한다. 모르는 도구이거나 입력이 스키마에 맞지 않으면 응답을 버리지 않고 그 블록에 `inputError`를 붙여 반환한다. 이미 토큰을 쓴 응답이므로, 호출자는 실행하지 않고 오류 `tool_result`로 답해 모델이 고치게 한다.
- 도구 결과는 신뢰하지 않는 입력이다. Gateway는 결과를 모델에 전달만 하고 해석하지 않는다.
- 스트리밍은 `text_delta`, `tool_call`, `done` 세 이벤트로 통일한다. 현재는 네 형식 모두 응답을 한 번에 받아 이 이벤트로 내보낸다. 토큰 단위 스트리밍은 아직 구현하지 않았다.
- `toolChoice: 'required'`는 Anthropic에서 `auto`로 보낸다. 최신 Claude 모델이 강제 도구 호출을 거부하기 때문이다. 반드시 호출해야 하면 프롬프트에 적는다.

## 어댑터

도구 호출 형식은 네 갈래로 정규화한다.

| 구현 | 대상 Provider |
|---|---|
| Anthropic Messages | Anthropic |
| OpenAI Responses | OpenAI |
| Gemini generateContent | Gemini |
| Chat Completions 호환 | DeepSeek, Groq, Mistral, NVIDIA, Cloudflare |

어떤 모델이 무엇을 할 수 있는지는 모델 ID 목록을 코드에 적지 않고 실제 호출로 검사한다(`nidus gateway verify`, 앱의 모델 검사). 검사는 두 가지를 따로 판정한다.

- **텍스트**: 일반 메시지에 텍스트로 답하는가.
- **도구**: 도구 호출 → 결과 전달 → 최종 답의 왕복이 되는가. 통과하면 텍스트도 통과로 본다.

통과와 실패는 `.nidus/local/models/checks.json`에 기록한다. 속도 제한, 시간 초과, 서버 오류처럼 모델 탓이라고 단정할 수 없는 결과는 기록하지 않고 미검사로 둔다.

역할에 따라 필요한 능력이 다르다. Main, Lead Manager, Manager는 계획·지시·검토를 텍스트로 하므로 텍스트 검사를 통과하면 된다. Worker는 실제 작업을 하므로 도구 검사까지 통과해야 한다. 앱의 후보 추가 화면은 이 기준을 통과한 모델만 보여 준다.

배정 자체는 검사 기록을 강제하지 않는다. `models.json`을 직접 고쳐 넣은 미검사 모델도 선택되며, 도구가 필요한 호출이면 선택 이유에 `tools unverified`로 표시한다. Models API가 미지원이라고 명시한 모델만 제외한다.

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

### 모델 상태와 동시 시도 (2026-11-12 추가)

무료 Provider는 같은 모델이 몇 분씩 답하지 않거나 계속 실패한다. 실제 사용 기록(하루 53건)에서 1순위 모델이 성공해도 평균 88초가 걸렸고, 시간 초과로 Main 호출마다 5분을 버렸고, 이름이 잘못된 모델(`not_found`)은 Worker를 바로 실패시켰다. 그래서 Gateway가 모델의 최근 상태를 보고 고른다.

- **상태는 사용 기록에서 읽는다**(`usage.sqlite`, 최근 24시간). 앱을 다시 켜도 이어진다. 모델마다 연속 실패 수, 마지막 오류, 최근 성공 10건의 중간 응답 시간.
- **쉬게 하기**: 모델에 관한 실패(시간 초과, 서버 오류, 속도 제한, 네트워크, 느림, 할당량, 모델 없음)가 이어지면 1·3·9·27·81분, 최대 2시간 쉰다. 모델이 없거나 지원하지 않으면 하루, 할당량 소진은 1시간. 성공하면 기록이 끝난다. 사용자가 멈춘 호출과 요청 자체의 잘못(`invalid_request`)은 세지 않는다. 쉬는 모델은 같은 칸에 다른 후보가 있는 동안 건너뛴다. 모두 쉬고 있으면 원래 순서대로 쓴다.
- **동시 시도(hedging)**: 호출이 평소 시간의 2.5배(20~60초, 모르면 45초) 안에 답하지 않으면 같은 칸의 다음 후보에게도 보내고, 먼저 온 답을 쓴다. 늦은 첫 모델은 '느림'으로 기록되어 뒤로 밀리고, 쓰지 않은 보조 호출은 기록에 불리하게 남지 않는다. 다른 후보가 없으면 그냥 기다린다. 결과에는 `hedged` 경고가 붙는다.
- **모델 오류에서 후보 바꾸기**: `not_found`·`unsupported`·`quota`·`invalid_response`는 기다려도 낫지 않으므로, 호출하는 쪽(`sendWithRetry`)이 같은 칸의 다른 후보로 바로 바꾼다.
- **앱**: 모델 배정 화면의 후보마다 평소 응답 시간, 또는 쉬는 이유와 남은 시간을 보여 준다. "선택됨"은 쉬는 모델을 뺀 실제 선택이다.

확인: 사용자의 배정(모두 NVIDIA, deepseek 1순위)을 복사한 Vault에서 같은 종류의 요청이 계획부터 최종 보고까지 3분 4초에 끝났다. deepseek의 서버 오류 뒤 Worker는 deepseek를 건너뛰었고, `not_found` 모델은 다음 후보로 넘어갔고, 45초 동안 답하지 않은 deepseek 대신 nemotron의 8초짜리 답을 썼다.

## `.nidus/` 배치

```text
.nidus/
├─ models.json          배정표 (Git 추적)
├─ budget.json          Vault 예산 (Git 추적)
├─ .gitignore           local/ 을 제외
└─ local/               Git 제외
   ├─ usage.sqlite      사용량 기록
   └─ models/           Provider별 모델 캐시, 도구 호출 검사 결과
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

## 명령

```sh
nidus gateway init                                   # .nidus/ 생성
nidus gateway connect <provider>                     # 키 등록, 모델 목록 조회
nidus gateway models <provider> [--refresh]
nidus gateway assign --role worker --difficulty simple --tools
nidus gateway ask --role manager                     # 배정된 모델에 한 번 질의 (과금 가능)
nidus gateway verify <provider> <model-id>           # 텍스트·도구 호출 검사 (과금 가능)
nidus gateway usage [--month YYYY-MM]
```

모든 명령은 `--vault <dir>`를 받는다. 생략하면 현재 디렉터리를 Vault로 본다.

## 앱

`Nidus.app`(`com.nidus.app`, Swift 타깃 `Nidus`)이 이 Gateway의 화면이다. 요청마다 Node 프로세스를 하나 띄워 `dist/gateway/bridge.js`에 JSON 요청을 stdin으로 보내고 결과를 stdout으로 받는다. API 키도 stdin으로만 전달한다.

기존 Provider 대시보드는 `Nidus Base.app`(`com.nidus.base`)으로 이름을 바꿔 따로 유지한다. 두 앱은 Keychain의 키를 함께 쓴다.

2단계에서 에이전트 실행과 격리 환경 모니터링을 붙이려면 요청마다 프로세스를 띄우는 방식 대신 계속 연결된 양방향 통로가 필요하다.

## 알려진 제한

- 토큰 단위 스트리밍이 없다.
- 배정된 모델 호출이 실패해도 다음 후보로 자동 전환하지 않는다. 후보 전환은 키, 모델 목록, 기능 지원 여부로만 정한다.
- 가격표(`src/pricing.ts`)에 없는 모델은 비용을 모른다. 이 호출은 예산 집계에서 빠지고 `cost_unknown` 경고가 붙는다.
- 텍스트와 도구 호출만 다룬다. 이미지 입력은 계약에 없다.
