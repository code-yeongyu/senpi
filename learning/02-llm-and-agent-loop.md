# 2장. LLM 통신과 Agent Loop

## 먼저 한 문장으로

`packages/ai`가 서로 다른 모델 API를 같은 언어로 번역하고, `packages/agent`가 그 공통 언어를 이용해 **모델 호출 → Tool 실행 → 결과 전달**을 반복한다.

## 이 장에서 답할 질문

- Provider와 API adapter는 무엇이 다른가?
- Streaming 중에는 어떤 이벤트가 흐르는가?
- Agent Loop는 언제 도구를 실행하고 언제 종료하는가?
- 여러 Tool Call은 어떻게 처리되는가?
- 잘못되거나 멈춘 모델 응답을 어떻게 복구하는가?

## 1. 쉽게 이해하기: 통역사와 작업 진행자

식당 주문에 비유해 보자.

- 사용자는 원하는 일을 말한다.
- Agent는 지금까지의 주문과 사용할 수 있는 작업 목록을 정리한다.
- AI 계층은 그 내용을 각 식당이 이해하는 양식으로 번역한다.
- 모델은 답변하거나 “재료 창고를 확인해 달라”는 작업 요청을 보낸다.
- Agent Loop는 요청을 실행하고 결과를 모델에게 다시 알려 준다.

여기서 AI 계층은 **번역과 통신**, Agent Loop는 **일의 진행 순서**를 책임진다.

## 2. 공통 메시지 모델

Provider마다 실제 JSON 형식은 다르지만 Senpi 내부에서는 공통 메시지를 사용한다.

### User message

사용자의 텍스트나 이미지 입력이다.

### Assistant message

모델의 출력이다. 단순 문자열 하나가 아니라 여러 content block을 가질 수 있다.

- 일반 text
- thinking/reasoning
- tool call
- provider 전용 content

### Tool result message

Tool 실행 결과다. 어떤 tool call에 대한 결과인지 식별자가 함께 들어간다.

이 구조 덕분에 Agent Loop는 provider별 wire JSON을 직접 알 필요가 없다. 주요 타입은 [`packages/ai/src/types.ts`](../packages/ai/src/types.ts)에서 시작해 볼 수 있다.

## 3. Model, Provider, API adapter

세 용어를 분리해야 한다.

### Model

실제로 선택하는 모델 하나를 표현한다.

- provider ID
- model ID
- 사용할 API 종류
- context window
- max tokens
- 입력 modality
- reasoning 지원 여부
- 비용과 호환성 metadata

### Provider

모델을 제공하고 인증·endpoint 설정을 공급하는 주체다. 같은 OpenAI-compatible API를 쓰더라도 OpenRouter와 로컬 서버는 서로 다른 provider가 될 수 있다.

### API adapter

공통 Senpi context를 특정 wire protocol로 변환하는 구현이다.

예를 들어 여러 provider가 `openai-completions` adapter를 공유할 수 있다. 반대로 같은 OpenAI 계열이라도 Chat Completions와 Responses는 서로 다른 adapter를 사용한다.

```text
Model
 ├─ provider: 어디에 요청할지
 └─ api: 어떤 요청 형식으로 말할지
```

Provider 정의는 [`packages/ai/src/providers`](../packages/ai/src/providers), API adapter는 [`packages/ai/src/api`](../packages/ai/src/api)에 모여 있다.

## 4. Streaming 이벤트

LLM 응답은 완성된 문장 하나가 한 번에 도착하지 않는다. 작은 이벤트가 계속 도착한다.

개념적인 흐름은 다음과 같다.

```text
start
→ text_start
→ text_delta
→ text_delta
→ text_end
→ done
```

Thinking과 Tool Call도 비슷한 start/delta/end 수명주기를 가진다. Tool argument가 JSON이라면 streaming 중에는 아직 닫히지 않은 부분 JSON일 수 있다.

AI adapter의 책임은 provider 원본 event를 공통 event로 바꾸고, 최종적으로 완전한 `AssistantMessage`를 만드는 것이다. UI는 delta event를 받아 즉시 화면을 갱신할 수 있고, Agent Loop는 최종 message에서 tool call을 찾는다.

## 5. `Agent`가 보관하는 상태

[`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)의 `Agent`는 대략 다음 상태를 가진다.

- system prompt
- message history
- 현재 model
- reasoning/thinking level
- 등록된 tool
- 현재 streaming 여부
- 현재 assistant message
- 오류 상태
- steering/follow-up queue

`Agent.prompt()`는 새 사용자 입력을 받고 loop를 시작한다. `Agent.continue()`는 새 사용자 입력 없이 현재 대화에서 실행을 이어 간다.

## 6. Agent Loop의 정상 경로

핵심 구현은 [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)의 `runLoop()`다.

### 6.1 사용자 메시지를 context에 추가한다

새 요청이라면 user message를 event로 내보내고 현재 context에 넣는다.

### 6.2 모델을 호출한다

`streamAssistantResponse()`가 system prompt, messages, tools, reasoning 설정을 stream function에 전달한다.

### 6.3 Assistant message를 완성한다

Streaming event가 올 때마다 다음 일이 함께 진행된다.

- message 내용 누적
- `message_update` event 발생
- usage와 stop reason 수집
- abort와 timeout 감시

### 6.4 Tool Call을 찾는다

최종 assistant content에서 `toolCall` block을 골라낸다.

Tool call이 없다면 보통 현재 turn은 종료된다. Tool call이 있다면 각 call에 맞는 tool을 찾아 실행한다.

### 6.5 Tool Result를 context에 넣는다

결과는 `ToolResultMessage`로 바뀌어 message history에 추가된다. 다음 provider 호출에서 모델은 자신이 요청한 작업의 결과를 볼 수 있다.

### 6.6 다시 모델을 호출한다

Tool을 실행했으므로 loop가 한 번 더 돈다. 모델이 추가 tool을 요청하면 반복하고, 최종 텍스트만 반환하면 끝난다.

```text
User
  ↓
Assistant(tool call)
  ↓
Tool result
  ↓
Assistant(tool call 또는 final text)
```

## 7. 순차 실행과 병렬 실행

한 assistant message에 여러 tool call이 포함될 수 있다.

### 순차 실행

앞의 결과가 뒤 작업에 영향을 주거나 실행 모드가 순차로 지정된 경우 하나씩 실행한다.

### 병렬 실행

서로 독립적인 여러 읽기나 검색은 동시에 실행할 수 있다. Senpi의 `executeToolCallsParallel()`은 실행을 동시에 진행하면서도 최종 tool result의 순서는 원래 tool call 순서와 맞도록 관리한다.

병렬 실행에서 구분할 것이 두 가지다.

- **실제 완료 시점**: 빠른 tool이 먼저 끝날 수 있다.
- **대화에 기록되는 순서**: 모델이 보낸 tool call 순서를 보존해야 한다.

순서를 보존하지 않으면 provider의 tool-call/result pairing 규칙을 깨거나 재현하기 어려운 transcript가 생길 수 있다.

## 8. Steering과 Follow-up

Agent가 실행되는 동안 사용자가 새 메시지를 입력할 수 있다.

### Steering message

현재 작업 방향을 바꾸는 메시지다. 다음 provider 호출 전에 context로 들어갈 수 있다.

예:

```text
그 파일은 건드리지 말고 테스트만 확인해 줘.
```

### Follow-up message

현재 작업이 자연스럽게 끝난 뒤 이어서 수행할 메시지다.

Agent Loop는 종료하려는 시점에 두 queue를 확인한다. Compaction이나 abort 도중 queue를 꺼냈다가 실행이 실패하면 메시지를 잃지 않도록 복원해야 한다.

## 9. Timeout과 Abort

Provider 호출이 영원히 기다리게 두면 전체 session이 멈춘다. Senpi는 몇 가지 시간을 구분한다.

- 요청을 보냈는데 첫 event가 오지 않는 stream-start timeout
- event가 오기 시작했지만 다음 event가 오래 오지 않는 idle timeout
- Tool 자체의 timeout
- 사용자가 명시적으로 중단하는 abort

AbortSignal은 provider와 tool에 전달된다. 중요한 점은 “중단을 요청했다”와 “하위 process가 실제로 사라졌다”가 항상 같지는 않다는 것이다. Agent Loop는 사용자가 더 기다리지 않도록 자신의 wait를 해제하면서도 terminal 계층이 남은 process를 정리할 수 있게 해야 한다.

## 10. 이상한 모델 응답 복구

실제 모델은 항상 완벽한 메시지를 만들지 않는다.

### 빈 assistant 응답

텍스트도 tool call도 없는 응답은 그대로 끝내면 사용자는 아무 결과를 받지 못한다. 모델과 상황에 따라 제한된 복구 요청을 시도한다.

### 잘린 Tool Call

stop reason이 `length`인데 tool argument가 도중에 잘렸다면 실행하면 위험하다. Senpi는 해당 call을 실패 결과로 바꾸고 모델이 다시 판단하게 한다.

### Text Tool Call

Native function calling을 지원하지 않는 모델은 XML이나 특수 문법으로 tool call을 텍스트에 출력할 수 있다. [`packages/ai/src/tool-call-middleware`](../packages/ai/src/tool-call-middleware)가 이를 공통 tool call event로 복구한다.

### Tool pair 불일치

Compaction이나 provider 변환 뒤 tool call과 result 쌍이 깨질 수 있다. Provider 요청 직전 sanitizer와 compaction repair 단계가 orphan pair를 정리한다.

## 11. Event를 기준으로 읽기

Agent Loop를 이해할 때 함수만 따라가기 어렵다면 event 순서로 읽는다.

```text
agent_start
└─ turn_start
   ├─ message_start
   ├─ message_update ...
   ├─ message_end
   ├─ tool_execution_start ...
   ├─ tool_execution_end ...
   └─ turn_end
agent_end
```

Tool이 여러 번 이어지면 `turn_start`부터 `turn_end`까지가 반복된다. Interactive UI, session 저장, extension은 이 event들을 관찰해 각자의 일을 한다.

## 12. 소스 읽기 경로

1. [`packages/ai/src/types.ts`](../packages/ai/src/types.ts): message와 stream event 타입
2. [`packages/ai/src/model.ts`](../packages/ai/src/model.ts): model 표현
3. [`packages/ai/src/api-registry.ts`](../packages/ai/src/api-registry.ts): adapter 등록과 조회
4. [`packages/ai/src/api/anthropic-messages.ts`](../packages/ai/src/api/anthropic-messages.ts) 또는 [`openai-responses.ts`](../packages/ai/src/api/openai-responses.ts): 실제 adapter 하나
5. [`packages/agent/src/types.ts`](../packages/agent/src/types.ts): Agent event와 tool 타입
6. [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts): public state와 prompt 진입점
7. [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts): `runLoop()`, `streamAssistantResponse()`, `executeToolCalls*()`

API adapter는 처음에 하나만 선택해서 읽는 것이 좋다. 모든 provider를 동시에 보면 공통 구조보다 예외 처리만 눈에 들어온다.

## 13. 확인 문제

1. Provider와 API adapter를 별도로 표현하는 이유는 무엇인가?
2. Streaming event와 최종 `AssistantMessage`는 어떤 관계인가?
3. Tool result를 user message가 아니라 별도 message로 기록하는 이유는 무엇인가?
4. 병렬 tool 실행에서도 결과 순서를 보존해야 하는 이유는 무엇인가?
5. stream-start timeout과 idle timeout은 어떻게 다른가?
6. Steering과 follow-up 중 현재 작업 방향을 바꾸는 것은 어느 쪽인가?

## 14. 추적 실습

`agent-loop.ts`에서 아래 흐름에 서로 다른 색의 표시를 해 본다.

1. Provider 호출 경로
2. Assistant message 누적 경로
3. Tool call 실행 경로
4. Tool result 삽입 경로
5. 종료 판단 경로
6. Steering/follow-up queue 경로

그다음 “Tool이 없는 정상 답변”과 “Tool을 한 번 사용하는 답변”을 각각 종이에 event 순서로 적는다.

[이전 장: 전체 구조와 실행 흐름](01-architecture-and-flow.md) · [다음 장: Coding Agent, 세션과 Tool](03-coding-agent-session-tools.md)
