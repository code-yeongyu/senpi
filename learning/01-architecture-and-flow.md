# 1장. Senpi 전체 구조와 실행 흐름

## 먼저 한 문장으로

Senpi는 **LLM 통신**, **에이전트 반복 실행**, **코딩 세션 관리**, **터미널 UI**를 서로 다른 패키지로 나누고, `coding-agent`가 이들을 하나의 프로그램으로 조립한 프로젝트다.

## 이 장에서 답할 질문

- Senpi는 왜 여러 패키지로 나뉘어 있을까?
- 사용자가 입력한 한 문장은 어떤 경로로 모델까지 전달될까?
- 모델이 `read`나 `bash`를 요청하면 누가 실행할까?
- `Agent`와 `AgentSession`은 무엇이 다를까?
- 처음 코드를 읽을 때 어느 파일부터 시작해야 할까?

## 1. 쉽게 이해하기: Senpi는 작은 조직이다

Senpi를 하나의 개발 조직이라고 생각해 보자.

- `packages/ai`는 여러 외부 업체와 대화하는 **통역팀**이다.
- `packages/agent`는 일을 한 단계씩 진행하는 **실무 담당자**다.
- `packages/coding-agent`는 파일, 세션, 확장 기능을 조율하는 **프로젝트 매니저**다.
- `packages/tui`는 현재 상황을 사용자에게 보여 주는 **상황판**이다.
- `packages/pty`는 오래 실행되는 명령을 관리하는 **터미널 운영팀**이다.
- `packages/protocol`, `client`, `server`는 다른 프로세스와 연결하는 **통신팀**이다.

각 팀이 분리되어 있기 때문에 `packages/agent`는 터미널 UI 없이도 사용할 수 있고, `packages/ai`는 코딩 에이전트가 아닌 다른 프로그램에서도 사용할 수 있다.

## 2. 핵심 패키지 지도

### `packages/ai`: 모델과 통신하는 계층

이 패키지는 OpenAI, Anthropic, Google처럼 서로 다른 API를 공통 인터페이스로 감싼다.

주요 책임은 다음과 같다.

- 모델과 provider 정보 표현
- user/assistant/tool 메시지 타입 정의
- streaming 응답을 공통 이벤트로 변환
- provider별 요청 형식과 인증 처리
- thinking, tool call, usage, stop reason 정규화
- timeout, rate limit, context overflow 같은 오류 분류

이 계층 위에서는 “Anthropic 응답인가 OpenAI 응답인가”보다 “assistant가 텍스트를 보냈는가, tool call을 보냈는가”가 중요해진다.

### `packages/agent`: LLM과 Tool을 반복 실행하는 계층

`Agent`는 현재 대화, 모델, tool 목록과 실행 상태를 가진다. `agentLoop()`는 assistant 응답에 tool call이 있으면 도구를 실행하고 그 결과를 다시 모델에게 전달한다.

이 패키지는 기본적으로 다음 질문에 답한다.

> 지금까지의 메시지와 사용할 수 있는 도구가 주어졌을 때, 모델을 호출하고 작업이 끝날 때까지 어떤 순서로 반복할 것인가?

파일 읽기나 Git 같은 코딩 도메인 지식은 거의 여기에 속하지 않는다.

### `packages/coding-agent`: Senpi 애플리케이션 본체

사용자가 실제로 실행하는 `senpi` CLI가 들어 있다.

- CLI 인자 해석
- 인증과 모델 선택
- 설정 파일 로딩
- 세션 생성·저장·복구
- `read`, `bash`, `edit`, `write` 같은 기본 도구
- extension 로딩과 이벤트 전달
- 동적 시스템 프롬프트
- compaction
- interactive, print, RPC, app-server 모드

소스 공부에서 가장 많은 시간을 쓰게 될 패키지다.

### `packages/tui`: 터미널 화면 계층

대화, editor, tool 진행 상태, footer와 overlay를 그린다. 매번 화면 전체를 새로 출력하지 않고 이전 프레임과 새 프레임의 차이만 반영하는 differential rendering을 사용한다.

### 보조 패키지

| 패키지 | 역할 |
|---|---|
| `packages/pty` | 오래 살아 있는 shell/PTY session과 screen buffer |
| `packages/senpi-codemode` | persistent eval kernel과 `eval` tool |
| `packages/protocol` | 원격 세션용 CBOR 메시지 계약 |
| `packages/client` | protocol을 사용하는 원격 client |
| `packages/server` | 여러 session을 제공하는 server runtime |
| `packages/storage/sqlite-node` | SQLite 기반 session storage |
| `packages/evals` | 실제 `AgentSession`을 이용한 행동 평가 |

## 3. 패키지 의존 방향

의존성은 대체로 아래에서 위로 흐른다.

```text
packages/ai
    ↑
packages/agent
    ↑
packages/coding-agent ───→ packages/tui
         │
         ├───────────────→ packages/pty
         ├───────────────→ packages/protocol / client
         └───────────────→ packages/senpi-codemode
```

여기서 중요한 규칙은 아래 계층이 위 계층을 몰라야 한다는 것이다. 예를 들어 `packages/ai`가 `InteractiveMode`를 import한다면 계층이 뒤집힌다. 반대로 `coding-agent`가 `pi-ai`의 모델과 메시지 타입을 사용하는 것은 자연스럽다.

## 4. `senpi` 실행부터 화면 표시까지

### 4.1 CLI 부트스트랩

첫 진입점은 [`packages/coding-agent/src/cli.ts`](../packages/coding-agent/src/cli.ts)다.

이 파일은 가능한 한 가벼운 작업만 한다.

1. 프로세스 이름과 환경을 초기화한다.
2. `--version`처럼 즉시 끝낼 수 있는 명령을 처리한다.
3. 설치 상태에 문제가 있으면 self-update bootstrap을 확인한다.
4. 실제 CLI 로직이 있는 `cli-main.ts`를 별도 프로세스로 실행한다.

`cli-main.ts`는 HTTP dispatcher와 inspector 관련 초기화를 한 뒤 `main()`을 호출한다.

### 4.2 `main()`이 실행 환경을 조립한다

[`packages/coding-agent/src/main.ts`](../packages/coding-agent/src/main.ts)의 `main()`은 큰 조정 함수다.

대략 다음 순서로 일한다.

```text
CLI 인자 파싱
→ 실행 모드 결정
→ migration과 설정 로딩
→ 프로젝트 신뢰 여부 확인
→ 인증·모델 runtime 준비
→ 세션 선택 또는 생성
→ extension과 resource 준비
→ AgentSession 생성
→ Interactive / Print / RPC 실행
```

`main()`에 기능 정책을 직접 추가하기보다, 필요한 서비스를 만들고 적절한 실행 모드로 넘기는 coordinator로 보는 것이 좋다.

### 4.3 세션 서비스를 만든다

`createAgentSessionServices()`는 설정, 모델, resource loader처럼 세션 생성에 필요한 재료를 준비한다. `createAgentSessionFromServices()`는 그 재료로 실제 세션을 만든다.

이렇게 둘로 나누면 CLI뿐 아니라 RPC나 app-server도 같은 조립 로직을 재사용할 수 있다.

### 4.4 `Agent`와 `AgentSession`을 만든다

[`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)의 `createAgentSession()`은 다음을 연결한다.

- `ModelRuntime`
- `SettingsManager`
- `SessionManager`
- `ResourceLoader`
- 기본 Tool과 extension Tool
- `Agent`
- `AgentSession`

`Agent`와 `AgentSession`을 혼동하기 쉽다.

| 객체 | 쉬운 표현 | 주요 책임 |
|---|---|---|
| `Agent` | 모델과 도구를 돌리는 엔진 | 메시지 상태, streaming, tool loop, abort |
| `AgentSession` | 코딩 작업의 감독자 | 저장, extension, prompt, compaction, 모델 변경, UI event |

`Agent`만으로도 모델과 tool을 반복 실행할 수 있지만, 프로젝트 규칙을 읽고 세션을 저장하며 compaction하는 것은 `AgentSession`의 책임이다.

### 4.5 실행 모드가 사용자와 연결한다

`main()`은 환경에 따라 하나를 선택한다.

- 터미널에서 실행하면 `InteractiveMode`
- `--print` 또는 pipe 환경이면 print mode
- `--mode json`이면 JSON event stream
- `--mode rpc`이면 JSONL RPC
- `app-server` 명령이면 app-server

모드는 표현과 입출력 방식을 책임지고, 실제 agent 실행은 같은 session runtime을 공유한다.

## 5. 사용자 요청 한 번의 전체 흐름

사용자가 다음과 같이 입력했다고 해 보자.

```text
package.json을 읽고 프로젝트 이름을 알려줘.
```

실행 흐름은 다음과 같다.

1. `InteractiveMode`가 editor 입력을 받는다.
2. 입력을 `AgentSession.prompt()`로 전달한다.
3. `AgentSession`이 extension hook과 동적 system prompt를 준비한다.
4. `Agent`가 user message를 대화 context에 추가한다.
5. `agentLoop()`가 `pi-ai` streaming 함수를 호출한다.
6. provider adapter가 공통 context를 실제 API payload로 바꾼다.
7. 모델이 `read({ path: "package.json" })` tool call을 보낸다.
8. `agentLoop()`가 tool call을 찾아 실행한다.
9. coding-agent의 read tool이 파일 내용을 반환한다.
10. tool result가 대화 context와 session log에 기록된다.
11. `agentLoop()`가 tool result를 포함해 모델을 다시 호출한다.
12. 모델이 최종 텍스트 답변을 보낸다.
13. `InteractiveMode`가 streaming 결과를 TUI component로 표시한다.
14. assistant message가 session에 저장된다.

핵심은 **모델이 직접 파일을 읽는 것이 아니라, 읽어 달라는 구조화된 요청을 만들고 Senpi가 실행한다**는 점이다.

## 6. 핵심 객체 관계

```text
main
 └─ AgentSessionRuntime
     ├─ AgentSession
     │   ├─ Agent
     │   ├─ SessionManager
     │   ├─ ExtensionRunner
     │   ├─ ResourceLoader
     │   └─ ModelRuntime
     └─ Mode
         ├─ InteractiveMode → TUI
         ├─ PrintMode
         ├─ RpcMode
         └─ AppServer
```

이 그림을 기억하면 파일을 읽다가 길을 잃었을 때 현재 코드가 어느 책임에 속하는지 다시 판단할 수 있다.

## 7. 첫 번째 소스 읽기 경로

처음부터 파일 전체를 외우려 하지 말고 다음 순서로 함수 경계만 따라간다.

1. [`packages/coding-agent/src/cli.ts`](../packages/coding-agent/src/cli.ts)
2. [`packages/coding-agent/src/cli-main.ts`](../packages/coding-agent/src/cli-main.ts)
3. [`packages/coding-agent/src/main.ts`](../packages/coding-agent/src/main.ts)의 `main()`
4. [`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)의 `createAgentSession()`
5. [`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)의 생성자와 `prompt()`
6. [`packages/agent/src/agent.ts`](../packages/agent/src/agent.ts)의 `prompt()`
7. [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts)의 `agentLoop()`와 `runLoop()`

첫 회독에서는 오류 복구 분기를 건너뛰고 정상 경로만 표시해도 충분하다.

## 8. 확인 문제

1. `packages/ai`가 파일을 직접 수정하지 않는 이유는 무엇인가?
2. `Agent`와 `AgentSession` 중 세션 저장을 책임지는 쪽은 어디인가?
3. Interactive와 RPC가 같은 Agent 실행 구조를 공유할 수 있는 이유는 무엇인가?
4. 모델이 `bash` tool call을 만들었을 때 실제 명령을 실행하는 주체는 누구인가?
5. 새로운 provider를 추가할 때 TUI 코드부터 수정하면 안 되는 이유는 무엇인가?

## 9. 작은 실습

다음 함수에 편집기 bookmark를 걸고, 호출 관계만 화살표로 적어 본다.

- `main()`
- `createAgentSessionServices()`
- `createAgentSessionFromServices()`
- `createAgentSession()`
- `AgentSession.prompt()`
- `Agent.prompt()`
- `agentLoop()`

목표는 세부 구현이 아니라 “CLI가 Agent Loop까지 어떻게 도달하는가”를 자기 말로 설명하는 것이다.

[다음 장: LLM 통신과 Agent Loop](02-llm-and-agent-loop.md)
