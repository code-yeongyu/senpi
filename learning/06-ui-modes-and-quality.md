# 6장. TUI, 실행 모드와 품질 관리

## 먼저 한 문장으로

Senpi는 하나의 `AgentSession`을 여러 입출력 모드에서 사용하고, TUI의 차등 렌더링과 계층화된 테스트·QA로 긴 실행에서도 일관된 동작을 유지한다.

## 이 장에서 답할 질문

- TUI component는 어떻게 화면이 될까?
- 매 token마다 화면 전체를 다시 그리지 않는 방법은 무엇일까?
- Interactive, JSON, RPC, App Server는 무엇을 공유하고 무엇이 다를까?
- Unit test가 통과해도 실제 CLI QA가 필요한 이유는 무엇일까?
- Fork 고유 변경은 어떻게 기록하고 upstream과 함께 유지할까?

## 1. 쉽게 이해하기: 같은 공연, 다른 중계 화면

AgentSession이 공연이라면 실행 모드는 공연을 전달하는 방식이다.

- Interactive는 무대와 관객이 같은 공간에 있는 공연이다.
- Print는 끝난 결과만 전달하는 녹화본이다.
- JSON은 모든 장면을 구조화된 기록으로 내보낸다.
- RPC는 외부 감독이 명령을 보내고 event를 받는다.
- App Server는 여러 client가 연결될 수 있는 공연장 서버다.

공연 내용은 같지만 입력, 출력과 사용자 확인 방식이 다르다.

## 2. TUI Component 모델

[`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts)의 component는 주어진 폭에서 화면의 줄 배열을 만든다.

핵심 계약은 단순하다.

- `render(width)`: 표시할 문자열 줄을 반환
- `handleInput(data)`: 키 입력 처리
- `invalidate()`: cache 무효화
- 선택적으로 focus와 dispose 지원

Text, Markdown, Editor, Box, Stack, SelectList와 Overlay 같은 부품을 조합해 interactive 화면을 만든다.

### 순수한 render가 중요한 이유

가능하면 동일한 상태와 폭에서 동일한 줄이 나와야 이전 frame과 비교할 수 있다. Render 중 외부 상태를 무작위로 변경하면 differential rendering과 테스트가 어려워진다.

## 3. InteractiveMode와 TUI의 구분

[`interactive-mode.ts`](../packages/coding-agent/src/modes/interactive/interactive-mode.ts)는 애플리케이션 UI controller이고 `packages/tui`는 범용 terminal renderer다.

### InteractiveMode

- AgentSession event 구독
- assistant message component 생성
- Tool call/result renderer 선택
- editor와 message queue 연결
- dialog, footer와 extension widget 관리
- model selector와 slash command 처리

### TUI

- component tree render
- terminal 크기와 cursor 관리
- 이전 frame과 새 frame 비교
- ANSI sequence 출력
- input dispatch
- overlay 배치

InteractiveMode가 “무엇을 보여 줄지” 결정하고 TUI가 “터미널에 어떻게 그릴지” 처리한다.

## 4. Differential Rendering

매 streaming delta마다 전체 transcript를 다시 출력하면 화면이 깜빡이고 긴 session에서 CPU 사용량이 커진다.

차등 렌더링은 다음 과정을 사용한다.

1. component tree로 새 화면 줄을 계산한다.
2. 이전에 그린 줄과 비교한다.
3. 변경된 범위를 찾는다.
4. terminal cursor를 필요한 위치로 이동한다.
5. 바뀐 줄만 출력한다.

### Viewport 제한

대화가 매우 길어도 화면에 보이는 영역은 terminal 높이 정도다. Senpi는 가능한 경우 전체 transcript가 아니라 현재 viewport와 주변 overscan만 정규화하고 비교한다.

### Insert-scroll fast path

Streaming으로 아래쪽에 새 줄이 추가될 때 기존 화면 전체를 다시 그리지 않고 terminal의 scroll 동작을 활용한다.

### Atomic frame

Terminal이 중간 상태를 보여 주지 않도록 synchronized output 계열 sequence를 사용해 한 frame의 변경을 묶을 수 있다. Cursor, IME와 animation이 섞일 때 중요하다.

## 5. Streaming UI

Provider event가 올 때마다 즉시 모든 문자를 그대로 표시하면 빠른 모델에서는 읽기 어려운 burst가 생길 수 있다. Interactive mode에는 reveal pacing과 buffer가 있어 출력 속도를 조절한다.

Tool도 상태가 변한다.

```text
argument streaming
→ 실행 대기
→ 실행 중 progress
→ 완료 또는 실패
→ 최종 result renderer
```

Tool definition과 extension은 call/result renderer를 제공할 수 있고, interactive mode가 현재 단계에 맞는 renderer를 선택한다.

## 6. Terminal의 까다로운 부분

### 문자 폭

문자열 길이와 terminal column 수는 다르다. 한글, CJK, emoji, 결합 문자를 grapheme과 표시 폭 기준으로 다뤄야 한다.

### ANSI sequence

색상과 cursor sequence는 화면 폭을 차지하지 않는다. 문자열을 자를 때 escape sequence를 중간에서 끊으면 terminal 상태가 깨질 수 있다.

### IME

한글 입력기의 후보 창이 올바른 위치에 나타나려면 실제 hardware cursor를 editor cursor와 맞춰야 한다.

### tmux와 이미지

Kitty graphics 같은 protocol은 tmux passthrough와 pane 위치를 고려해야 한다. Terminal capability를 탐지하고 지원되지 않으면 안전한 fallback을 사용한다.

## 7. 실행 모드

### Interactive Mode

사람이 직접 사용하는 기본 모드다. 모든 UI primitive와 실시간 입력을 지원한다.

### Print Mode

Prompt를 실행한 뒤 최종 텍스트를 stdout에 출력한다. Shell script와 일회성 자동화에 적합하다.

### JSON Event Stream

사람용 화면 대신 구조화된 event를 출력한다. 외부 도구가 streaming 과정과 Tool 상태를 기계적으로 처리할 수 있다.

### RPC Mode

stdin/stdout JSONL을 통해 command를 받고 event를 전송한다. Session 생성, prompt, abort, 상태 조회 등을 외부 host가 제어한다.

### App Server

장기 실행되는 server runtime이 session을 관리한다. 연결, 재연결, backpressure와 여러 session의 수명을 고려한다.

## 8. Protocol, Client, Server

### Protocol

[`packages/protocol`](../packages/protocol)은 request, response와 event의 transport-neutral schema와 CBOR framing을 정의한다.

### Client

[`packages/client`](../packages/client)는 byte transport 위에서 request ID, pending response와 event subscription을 관리한다.

### Server

[`packages/server`](../packages/server)는 protocol 요청을 session runtime 동작으로 연결한다. Unix socket 같은 transport와 독립적인 server core를 지향한다.

세 패키지를 분리하면 protocol 타입을 browser와 Node client가 공유하면서 실제 socket 구현은 필요한 환경에만 둘 수 있다.

## 9. 테스트 계층

### Unit Test

작은 함수와 정책을 빠르게 검증한다. 예를 들어 parser, token policy, renderer helper가 대상이다.

### Package Test

AI adapter, Agent Loop, TUI, Coding Agent의 package 단위 동작을 검증한다.

### Faux Provider Test

실제 credential과 token을 사용하지 않고 정해진 streaming event와 오류를 재현한다. Tool call, retry, compaction 같은 Agent 동작을 결정적으로 테스트할 수 있다.

### Regression Test

실제 발견된 버그의 입력과 기대 동작을 고정한다. 문제를 고친 뒤 같은 버그가 돌아오지 않게 한다.

### Fixture와 Golden

복잡한 compaction context나 TUI output을 입력 fixture와 기대 결과로 관리한다.

### Live API Test

Provider 실제 동작이 필요한 테스트다. 기본 test에서는 실행하지 않고 명시적인 환경 변수와 credential이 있을 때만 실행한다.

## 10. 실제 CLI QA가 필요한 이유

Unit test가 모두 통과해도 다음 문제는 놓칠 수 있다.

- CLI process가 시작되지 않음
- TTY에서 raw mode가 복구되지 않음
- JSONL stdout에 불필요한 로그가 섞임
- PTY가 종료 후에도 남음
- 실제 event 순서가 외부 client와 맞지 않음
- Extension이 source 실행 환경에서만 load 실패

`.agents/skills/senpi-qa`의 harness는 실제 CLI를 격리된 환경에서 실행한다.

- CLI smoke
- RPC JSONL
- mock provider agent loop
- TUI/PTY smoke

Runtime 변경에는 이런 end-to-end 증거가 필요하지만, 이 학습 자료처럼 Markdown만 추가하는 변경은 링크와 문서 형식 검증으로 충분하다.

## 11. `AGENTS.md`와 `changes.md`

### `AGENTS.md`

특정 디렉터리를 수정할 때 따라야 할 구조, 규칙, 금지 사항과 검증 방법을 설명한다. 더 가까운 디렉터리의 지침이 더 구체적인 범위를 가진다.

### `changes.md`

Fork가 upstream 파일을 왜 수정했는지 기록한다.

- 무엇을 변경했는가?
- 왜 필요한가?
- Extension으로 해결할 수 없었던 이유는 무엇인가?
- 다음 upstream merge에서 어디가 충돌할 가능성이 있는가?

일반 사용자용 changelog와 달리 코드 유지보수자를 위한 fork ledger다.

## 12. 변경 작업의 판단 순서

Senpi에 기능을 추가하려면 다음 순서로 생각한다.

1. 기존 Extension API만으로 만들 수 있는가?
2. 필요한 작은 context/event seam만 core에 추가하면 되는가?
3. 정말 Agent Loop나 provider adapter의 저수준 변경인가?
4. 어떤 package test가 책임을 고정해야 하는가?
5. 실제 CLI QA가 필요한 runtime 변경인가?
6. Upstream 파일을 바꿨다면 어느 `changes.md`에 기록할 것인가?

이 순서를 지키면 fork 고유 기능이 core 전체로 퍼지는 것을 줄일 수 있다.

## 13. 소스 읽기 경로

### TUI

1. [`packages/tui/README.md`](../packages/tui/README.md)
2. [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts)의 Component와 render 요청
3. `components/text.ts`, `components/markdown.ts`, `components/editor.ts`
4. [`interactive-mode.ts`](../packages/coding-agent/src/modes/interactive/interactive-mode.ts)의 session event 처리
5. tool progress와 streaming reveal helper

### 원격 모드와 품질

1. [`packages/coding-agent/docs/rpc.md`](../packages/coding-agent/docs/rpc.md)
2. [`packages/coding-agent/src/modes/rpc`](../packages/coding-agent/src/modes/rpc)
3. [`packages/protocol/README.md`](../packages/protocol/README.md)
4. [`packages/client/README.md`](../packages/client/README.md)
5. [`packages/server/README.md`](../packages/server/README.md)
6. 루트 [`AGENTS.md`](../AGENTS.md)와 package별 `AGENTS.md`

## 14. 확인 문제

1. InteractiveMode와 TUI를 분리한 이유는 무엇인가?
2. 긴 transcript에서 viewport-bounded rendering이 중요한 이유는 무엇인가?
3. JSON mode와 RPC mode는 어떻게 다른가?
4. Faux provider가 live API test보다 유리한 경우는 언제인가?
5. TypeScript 검사와 실제 CLI QA가 서로 대체할 수 없는 이유는 무엇인가?
6. Fork 변경을 일반 changelog뿐 아니라 `changes.md`에 기록하는 이유는 무엇인가?

## 15. 최종 종합 실습

다음 기능을 실제로 구현하지 말고 설계 위치만 정해 본다.

> `/count-tools` 명령을 추가해 현재 session에서 실행된 Tool 수를 footer에 표시하고, session 재시작 후에도 누적 수를 복구한다.

아래 질문에 답한다.

1. Extension으로 만들 수 있는가?
2. 어떤 Agent/Session event를 구독해야 하는가?
3. 상태를 memory와 session 중 어디에 저장해야 하는가?
4. Interactive가 아닌 mode에서는 어떻게 동작해야 하는가?
5. 어떤 unit test와 CLI QA가 필요한가?
6. Core 파일을 수정하지 않고 구현할 수 있는가?

이 질문에 답할 수 있다면 Senpi의 주요 경계를 이해한 것이다.

[이전 장: 컨텍스트 관리와 장시간 실행](05-context-and-long-running-work.md) · [용어집](glossary.md) · [처음으로](README.md)
