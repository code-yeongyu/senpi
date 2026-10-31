# 3장. Coding Agent, 세션과 Tool

## 먼저 한 문장으로

`AgentSession`은 범용 `Agent`에 프로젝트 설정, 세션 저장, 코딩 Tool, Extension과 Compaction을 연결해 실제 코딩 에이전트로 만드는 중앙 조정자다.

## 이 장에서 답할 질문

- CLI 옵션은 어떻게 실제 session 설정으로 변환될까?
- `AgentSession`은 왜 필요한가?
- 대화는 어떤 형식으로 저장되고 다시 복구될까?
- `read`, `bash`, `edit`, `write`는 어떤 공통 절차로 실행될까?
- Interactive와 RPC는 어떻게 같은 session을 사용할까?

## 1. 쉽게 이해하기: 엔진과 작업 노트

`Agent`를 자동차 엔진이라고 하면 `AgentSession`은 운전석과 계기판, 내비게이션, 운행 기록을 합친 부분이다.

엔진은 동력을 만들지만 다음은 알지 못한다.

- 어느 프로젝트에서 일하는가?
- 이전 작업 기록을 어디에 저장하는가?
- 어떤 `AGENTS.md`를 따라야 하는가?
- 어떤 extension이 tool call을 허용하거나 막는가?
- context가 넘치기 전에 언제 요약해야 하는가?

이런 애플리케이션 수준의 책임이 `AgentSession`에 모인다.

## 2. CLI 설정이 Session으로 들어오는 과정

### 2.1 인자 파싱

[`packages/coding-agent/src/cli/args.ts`](../packages/coding-agent/src/cli/args.ts)는 문자열 배열을 구조화된 `Args`로 바꾼다.

대표적으로 다음 항목을 해석한다.

- model과 provider 선택
- thinking level
- 새 session, continue, resume, fork
- tool allowlist와 denylist
- extension 경로
- print/JSON/RPC 모드
- 초기 prompt와 첨부 파일

인자 파서는 실행하지 않고 해석과 진단만 담당하는 것이 중요하다.

### 2.2 실행 모드 선택

`main.ts`는 명시적인 mode 옵션뿐 아니라 stdin/stdout이 TTY인지도 확인한다.

```text
터미널 입출력 + 별도 옵션 없음 → interactive
pipe 입력 또는 --print          → print
--mode json                    → JSON event stream
--mode rpc                     → RPC
app-server 명령                → app-server
```

### 2.3 설정 우선순위 합성

Senpi에는 기본값, 전역 설정, 프로젝트 설정, CLI 옵션이 함께 존재한다. `SettingsManager`와 model 관련 resolver가 이 값들을 합쳐 현재 session에서 사용할 값을 결정한다.

일반적인 원칙은 더 구체적이고 명시적인 입력이 우선한다는 것이다. 단, model fallback이나 session 복구처럼 저장된 상태와 현재 설정을 함께 고려해야 하는 기능에는 별도 정책이 있다.

## 3. `createAgentSession()` 조립 과정

[`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)는 외부 프로그램도 사용할 수 있는 조립 진입점이다.

주요 단계는 다음과 같다.

1. 작업 디렉터리와 agent directory를 정한다.
2. `SettingsManager`와 `SessionManager`를 준비한다.
3. `ModelRuntime`을 통해 사용할 모델과 인증을 결정한다.
4. `ResourceLoader`가 prompt, context file, skill, extension을 찾는다.
5. 기본 coding tool을 만든다.
6. extension이 등록한 tool과 합친다.
7. 활성 tool allowlist/denylist를 적용한다.
8. 공통 `streamSimple`을 이용하도록 `Agent`를 만든다.
9. 모든 서비스를 묶어 `AgentSession`을 만든다.

이 함수는 dependency injection 지점이기도 하다. 테스트나 외부 SDK 사용자는 기본 manager 대신 준비한 구현을 넘길 수 있다.

## 4. `AgentSession`의 주요 책임

[`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)는 크기가 크므로 책임별로 나눠 읽어야 한다.

### Prompt lifecycle

- 현재 tool과 resource를 반영한 system prompt 구성
- 새 사용자 prompt 전처리
- extension의 `before_agent_start` 실행
- Agent 실행 시작

### Event bridge

Agent가 내보낸 message/tool/turn event를 session event로 변환한다. Extension과 UI는 이 경계를 통해 실행 상태를 관찰한다.

### Persistence

완료된 user/assistant/tool/custom entry를 `SessionManager`에 기록한다. Streaming 중인 불완전한 상태와 확정된 저장 상태를 구분해야 한다.

### Model과 Tool 상태

- 모델 변경
- thinking level 변경
- 활성 tool 변경
- 모델 변경 후 system prompt 재생성
- session에 저장할 상태와 임시 상태 구분

### Compaction

- context 사용량 확인
- compaction hook 실행
- summary 적용
- overflow 후 재시도
- queue와 상태 복구

### Extension binding

Extension API가 실제 session 기능을 호출할 수 있도록 core 구현을 연결한다. Extension은 `AgentSession`의 private 상태를 직접 만지지 않고 공개된 event와 API를 사용한다.

## 5. Session 저장 모델

세션은 단순한 `messages.json`이 아니다. 대화가 분기될 수 있는 append-only entry 흐름으로 생각하는 것이 좋다.

대표적인 entry는 다음과 같다.

- session header
- user message
- assistant message
- tool result를 포함한 agent message
- model/thinking 변경
- custom extension entry
- compaction summary
- branch summary

구체적인 저장 형식은 [`packages/coding-agent/docs/session-format.md`](../packages/coding-agent/docs/session-format.md)와 [`session-manager.ts`](../packages/coding-agent/src/core/session-manager.ts)를 함께 본다.

### 왜 append-only에 가까운가?

과거 상태를 직접 덮어쓰면 다음이 어려워진다.

- 어느 시점에서 어떤 모델을 사용했는지 확인
- 과거 지점에서 branch 생성
- extension 상태 복구
- compaction 전후의 경계 추적

Entry를 시간 순서대로 쌓으면 현재 leaf까지의 경로를 재생해 session state를 복구할 수 있다.

## 6. 새 Session, Continue, Resume, Fork

### 새 Session

새 ID와 header를 만들고 현재 cwd를 기준으로 시작한다.

### Continue

현재 프로젝트의 최근 session을 찾아 마지막 상태에서 계속한다.

### Resume

사용자가 선택하거나 지정한 기존 session 파일을 연다. 저장된 cwd가 사라졌다면 사용자 확인이나 오류 처리가 필요하다.

### Fork와 Branch

기존 대화의 특정 지점을 부모로 삼아 새로운 작업 경로를 만든다. 원래 대화를 삭제하지 않고 다른 결정을 시험할 수 있다.

쉽게 말하면 Git commit graph와 비슷하지만, 대상이 코드가 아니라 대화 entry라는 차이가 있다.

## 7. 기본 Coding Tool

Tool factory는 [`packages/coding-agent/src/core/tools`](../packages/coding-agent/src/core/tools)에 있다.

### `read`

- 경로를 cwd 기준으로 해석한다.
- 파일 또는 이미지 여부를 판단한다.
- 필요한 범위만 읽을 수 있다.
- 큰 결과는 model context를 보호하도록 제한한다.

### `grep`, `find`, `ls`

프로젝트를 탐색하는 read-only tool이다. 결과 크기와 출력 형식을 제한해 모델이 다루기 쉬운 텍스트를 만든다.

### `write`

새 내용을 파일에 기록한다. 결과에는 단순 성공 문자열뿐 아니라 UI와 extension이 활용할 수 있는 변경 detail이 포함될 수 있다.

### `edit`

기존 내용에서 정확한 부분을 찾아 교체한다. 일치하지 않거나 여러 곳이 애매하게 일치하면 안전하게 실패해야 한다.

### `bash`

명령을 child process로 실행하고 stdout/stderr, exit code, timeout과 abort를 관리한다. Persistent terminal builtin이 활성화된 경우 더 긴 실행은 PTY 경로로 이어질 수 있다.

### `apply_patch`

GPT/Responses 계열에서는 builtin extension이 `edit`와 `write` 대신 Codex식 freeform patch tool을 노출할 수 있다.

## 8. Tool 실행 파이프라인

모델이 tool call을 만들었다고 즉시 구현 함수가 호출되는 것은 아니다.

```text
모델 Tool Call
→ 등록된 Tool 찾기
→ 입력 schema 검증
→ prepareArguments 등 전처리
→ Extension tool_call hook
→ Permission 검사
→ Tool execute
→ 진행 update 전달
→ Extension tool_result hook
→ Agent용 ToolResultMessage 생성
→ Session 저장 및 UI 표시
```

이 파이프라인을 거치기 때문에 permission system, hooks, custom renderer가 기본 tool과 extension tool에 공통으로 적용될 수 있다.

## 9. 파일 변경의 동시성

여러 tool call이 병렬로 실행될 때 두 edit이 같은 파일을 동시에 바꾸면 문제가 생긴다. Coding tool 계층에는 file mutation queue가 있어 충돌 가능한 변경을 직렬화한다.

여기서 Agent Loop의 병렬성과 파일 변경 안전성을 구분해야 한다.

- 서로 다른 read는 병렬 실행 가능
- tool call 전체는 병렬로 시작할 수 있음
- 같은 파일의 mutation은 queue에서 순서를 보장

## 10. 실행 모드와 Session의 관계

### Interactive

TUI, dialog, editor, shortcut을 모두 지원한다.

### Print/JSON

한 번의 작업을 비대화형으로 실행한다. 사용자에게 확인을 요청할 수 없는 기능은 명시된 fallback 정책을 사용해야 한다.

### RPC/App Server

다른 프로세스가 session command를 보내고 event를 수신한다. UI 요청도 protocol을 통해 외부 host로 전달하거나 지원하지 않는 것으로 처리한다.

핵심 AgentSession은 공유하지만 `ExtensionUIContext`의 구현이 mode마다 다르다.

## 11. 소스 읽기 경로

1. [`packages/coding-agent/src/cli/args.ts`](../packages/coding-agent/src/cli/args.ts)
2. [`packages/coding-agent/src/main.ts`](../packages/coding-agent/src/main.ts)의 mode 선택과 session 생성 부분
3. [`packages/coding-agent/src/core/sdk.ts`](../packages/coding-agent/src/core/sdk.ts)
4. [`packages/coding-agent/src/core/agent-session.ts`](../packages/coding-agent/src/core/agent-session.ts)의 생성자, `prompt()`, Agent event handler
5. [`packages/coding-agent/src/core/session-manager.ts`](../packages/coding-agent/src/core/session-manager.ts)
6. [`packages/coding-agent/src/core/tools/index.ts`](../packages/coding-agent/src/core/tools/index.ts)
7. `read.ts`, `bash.ts`, `edit.ts`, `write.ts` 중 하나씩

`agent-session.ts`는 처음부터 끝까지 읽기보다 “prompt”, “model”, “compact”, “event” 중 한 책임을 정해서 읽는다.

## 12. 확인 문제

1. `AgentSession`이 없고 `Agent`만 있다면 어떤 기능이 빠질까?
2. Session을 단순한 message 배열이 아니라 entry graph로 관리하는 이유는 무엇인가?
3. Tool schema 검증과 permission 검사는 각각 무엇을 막는가?
4. 병렬 tool 실행과 file mutation queue가 동시에 필요한 이유는 무엇인가?
5. Interactive와 RPC에서 UI 기능이 다르지만 같은 AgentSession을 쓸 수 있는 이유는 무엇인가?

## 13. 추적 실습

`read` tool 하나를 골라 다음 네 관점을 따로 추적한다.

1. Tool이 만들어지는 위치
2. Agent에 등록되는 위치
3. 모델 호출에 schema가 포함되는 위치
4. 실행 결과가 session과 UI에 전달되는 위치

그다음 session 파일 하나를 열어 user message, assistant tool call, tool result, 최종 assistant message가 어떤 순서로 나타나는지 확인한다. 실제 credential이나 민감한 경로가 포함된 session은 공유하지 않는다.

[이전 장: LLM 통신과 Agent Loop](02-llm-and-agent-loop.md) · [다음 장: Extension과 Senpi 주요 기능](04-extensions-and-features.md)
