# 4장. Extension과 Senpi 주요 기능

## 먼저 한 문장으로

Senpi는 핵심 실행 흐름을 유지한 채 Tool, Command, Prompt, Permission, Compaction 정책을 교체할 수 있도록 Extension을 주요 설계 경계로 사용한다.

## 이 장에서 답할 질문

- Extension은 언제, 어떤 순서로 로드될까?
- Extension은 Agent 실행에 어떻게 개입할까?
- Builtin extension과 사용자가 설치한 extension은 무엇이 다를까?
- 동적 system prompt는 어떻게 구성될까?
- Senpi의 수많은 builtin을 어떤 기준으로 분류하면 좋을까?

## 1. 쉽게 이해하기: 건물의 표준 연결 포트

코어를 건물 골조라고 생각해 보자. 새 기능을 추가할 때마다 벽을 뜯으면 건물이 불안정해진다. 대신 전기, 수도, 네트워크 연결 포트를 정해 두면 장비를 꽂아 기능을 추가할 수 있다.

Extension event와 `ExtensionAPI`가 이 연결 포트다.

- 새 Tool을 등록한다.
- `/command`를 등록한다.
- Tool 실행 전에 허가를 확인한다.
- 모델에게 보낼 context를 보강한다.
- footer와 widget을 표시한다.
- session에 custom state를 저장한다.

Extension으로 표현할 수 없는 저수준 변경만 core에 남기는 것이 Senpi의 extension-first 원칙이다.

## 2. Extension의 기본 모양

Extension은 `ExtensionAPI`를 받는 factory다.

```ts
export default function example(pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "인사하기",
    handler: async (_args, ctx) => {
      ctx.ui.notify("안녕하세요", "info");
    },
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName === "dangerous-tool") {
      return { block: true, reason: "이 도구는 허용되지 않았습니다." };
    }
  });
}
```

Factory는 등록만 하고, 장시간 process나 timer는 `session_start` 이후에 시작하는 것이 원칙이다. 종료할 자원은 `session_shutdown`에서 정리한다.

## 3. Extension 로딩 순서

[`packages/coding-agent/src/core/resource-loader.ts`](../packages/coding-agent/src/core/resource-loader.ts)가 여러 출처의 resource를 모은다.

개념적인 순서는 다음과 같다.

1. 소스에 포함된 builtin factory
2. 번들된 codemode 같은 extension
3. SDK가 직접 전달한 inline extension
4. 전역·프로젝트·설정·CLI 경로의 extension

Builtin의 배열 순서는 동작에 영향을 줄 수 있다. 앞선 extension이 Tool이나 provider payload를 바꾸고, 뒤 extension이 그 결과를 관찰할 수 있기 때문이다.

실제 builtin 목록은 [`packages/coding-agent/src/core/extensions/builtin/index.ts`](../packages/coding-agent/src/core/extensions/builtin/index.ts)가 기준이다. 최상위 README의 요약 목록보다 이 배열을 먼저 신뢰한다.

## 4. `ExtensionRunner`

[`runner.ts`](../packages/coding-agent/src/core/extensions/runner.ts)는 등록된 handler와 기능을 보관하고 session event를 전달한다.

주요 책임은 다음과 같다.

- event별 handler 등록
- handler 실행 순서 유지
- handler 반환값 수집과 병합
- Tool, Command, Provider registry 유지
- extension source 추적
- 종료 handler 실행
- core 구현과 Extension API 연결

Extension factory가 처음 로드될 때는 아직 실제 session 객체가 완전히 연결되지 않았을 수 있다. `bindCore()`가 나중에 model 변경, tool 실행, session metadata 변경 같은 privileged 동작을 실제 구현에 연결한다.

## 5. `ExtensionAPI`와 `ExtensionContext`

두 객체의 역할을 구분한다.

### `ExtensionAPI`

Factory에서 기능을 **등록**하는 표면이다.

- `registerTool`
- `registerCommand`
- `registerShortcut`
- `registerFlag`
- `registerProvider`
- `on(event, handler)`
- message renderer 등록

### `ExtensionContext`

각 event handler가 현재 session 상태를 **읽거나 제한적으로 조작**할 때 사용한다.

- 현재 cwd와 model
- session manager
- 현재 system prompt
- UI dialog, status, widget
- compaction 설정
- 현재 활성 tool
- extension event bus

Context가 event마다 전달되는 이유는 오래된 전역 상태를 보지 않고 그 시점의 session 상태를 사용하게 하기 위해서다.

## 6. 중요한 Lifecycle Event

모든 event를 외우기보다 실행 단계에 따라 묶는다.

### Resource와 Session 준비

- `resources_discover`
- `session_start`
- `session_before_reload`
- `session_shutdown`

### Agent 실행

- `before_agent_start`
- `context`
- `before_provider_request`
- `agent_end`

### 메시지와 Tool

- message 관련 event
- `tool_call`
- tool execution 관련 event
- `tool_result`

### 상태 변경

- `model_select`
- `system_prompt_change`
- compaction 관련 event

일부 handler는 단순 알림이 아니라 값을 반환해 실행을 변경한다. 예를 들어 tool call을 block하거나 context를 바꾸고 compaction을 취소할 수 있다.

## 7. 동적 System Prompt

Senpi는 고정된 문자열 대신 [`dynamic-prompt/build.ts`](../packages/coding-agent/src/core/dynamic-prompt/build.ts)의 builder를 사용한다.

기본 조립 순서는 다음과 같다.

1. identity
2. intent gate
3. parallel tool 지침
4. exploration 규율
5. verification 규율
6. 현재 활성 tool 설명
7. 정책과 금지 사항
8. 응답 style
9. 모델별 tuning
10. 프로젝트 context file과 skill
11. workstation, 날짜와 cwd

### 왜 동적인가?

활성 Tool, 프로젝트 규칙, 모델 family가 session마다 다르기 때문이다. 존재하지 않는 Tool을 system prompt에서 사용하라고 가르치거나, Claude에 맞춘 규칙을 GPT에 그대로 주면 품질이 떨어질 수 있다.

### Prompt preset

`prompt-preset` builtin은 모델 ID와 metadata를 보고 적절한 tuning 또는 full core prompt를 선택한다. 공통 builder를 재사용하면서 모델별 행동 차이를 보정한다.

## 8. Builtin을 기능별로 분류하기

등록 개수가 많으므로 배열 순서보다 목적별로 보는 편이 쉽다.

### 안전과 실행 통제

- `permission-system`
- `bash-timeout`
- `loop-guard`
- `tool-pair-guard`
- `ttsr`

### 모델과 Provider 적응

- `prompt-preset`
- `gpt-apply-patch`
- `anthropic-bash`
- `anthropic-web-search`
- `openai-web-search`
- `service-tier`
- `model-fallback`
- `recommended-models`
- `claude-sdk-oauth`

### 작업 지속성

- `todowrite`
- `goal`
- `terminal`
- `compaction`
- `cache-keepalive`

### Context와 외부 지식

- `rules`
- `nested-agents-md`
- `websearch`
- `webfetch`
- `MCP`
- `history-search`
- `look-at`
- `video-in`

### 사용자 경험과 운영

- `help`
- `config-reload`
- `hooks`
- `redraws`
- `btw`

## 9. 대표 Builtin의 동작

### Permission System

Tool call을 permission name과 pattern으로 바꾸고 allow/ask/deny 규칙을 적용한다. Interactive mode에서는 사용자에게 물을 수 있지만, headless mode에서는 설정된 fallback을 사용해야 한다.

Permission은 OS sandbox가 아니다. 허용된 Tool은 여전히 Senpi process가 가진 시스템 권한으로 실행된다.

### Todo와 Goal

Todo는 현재 작업을 구조화해 보여 주는 목록이다. Goal은 여러 turn과 session 재개를 넘어 “아직 끝나지 않은 목표”를 유지하고 agent를 다시 진행시키는 상위 상태다.

```text
Goal: 사용자에게 제공할 최종 결과
└─ Todo: 목표를 달성하기 위한 현재 작업 단계
```

### Rules와 Nested AGENTS.md

프로젝트 루트 규칙뿐 아니라 Agent가 더 깊은 디렉터리의 파일을 읽을 때 그 경로에 적용되는 가까운 규칙을 context에 삽입한다. 더 구체적인 디렉터리 규칙이 우선한다.

### Model Fallback

재시도 가능한 provider 장애가 발생하면 설정된 fallback chain의 다음 모델로 session을 전환할 수 있다. 단순히 API를 다시 호출하는 것이 아니라 thinking level과 system prompt, 사용자 표시 상태도 함께 갱신해야 한다.

### MCP

외부 MCP server의 Tool, resource와 prompt를 session에 연결한다. 모든 Tool을 처음부터 모델에게 노출하지 않고 검색을 통해 필요한 Tool만 활성화하는 context 절약 기능도 포함한다.

## 10. Builtin과 외부 Extension

둘 다 같은 event와 registration API를 사용하려고 하지만 차이가 있다.

| 구분 | Builtin | 외부 Extension |
|---|---|---|
| 배포 | Senpi 소스와 함께 | 사용자·프로젝트·package에서 로드 |
| 기본 상태 | 대체로 기본 활성 | 명시적 설치 또는 경로 필요 |
| 설정 | `disabledBuiltinExtensions`로 끌 수 있음 | 설정과 파일 제거로 관리 |
| 결합도 | 일부 Senpi 내부 기능과 밀접 | 공개 Extension API에 의존 |

좋은 설계는 builtin도 가능한 한 외부 extension과 같은 경계를 사용하게 만든다.

## 11. 소스 읽기 경로

1. [`packages/coding-agent/src/core/extensions/AGENTS.md`](../packages/coding-agent/src/core/extensions/AGENTS.md)
2. [`types.ts`](../packages/coding-agent/src/core/extensions/types.ts)의 `ExtensionAPI`, `ExtensionContext`, event 타입
3. [`runner.ts`](../packages/coding-agent/src/core/extensions/runner.ts)
4. [`loader.ts`](../packages/coding-agent/src/core/extensions/loader.ts)
5. [`resource-loader.ts`](../packages/coding-agent/src/core/resource-loader.ts)의 extension loading 부분
6. [`builtin/index.ts`](../packages/coding-agent/src/core/extensions/builtin/index.ts)
7. 작은 builtin 하나를 선택해 `index.ts`부터 읽기
8. [`dynamic-prompt/build.ts`](../packages/coding-agent/src/core/dynamic-prompt/build.ts)

첫 builtin으로는 파일 수가 적고 목적이 분명한 `help`, `bash-timeout`, `history-search` 중 하나가 좋다. Compaction이나 MCP부터 시작하지 않는다.

## 12. 확인 문제

1. Extension factory에서 장시간 timer를 바로 시작하면 왜 문제가 될 수 있는가?
2. `ExtensionAPI`와 event의 `ExtensionContext`는 무엇이 다른가?
3. Builtin 배열 순서가 동작에 영향을 줄 수 있는 이유는 무엇인가?
4. Permission system이 sandbox를 대신하지 못하는 이유는 무엇인가?
5. 동적 system prompt가 현재 활성 Tool 목록을 알아야 하는 이유는 무엇인가?
6. Goal과 Todo는 어떻게 다른가?

## 13. 작은 Extension 읽기 실습

Builtin 하나를 골라 다음 표를 채운다.

| 질문 | 찾은 내용 |
|---|---|
| Factory는 어디에서 export되는가? | |
| 어떤 event를 구독하는가? | |
| Tool이나 Command를 등록하는가? | |
| 상태는 어디에 저장하는가? | |
| UI를 사용하는가? | |
| session shutdown에서 정리할 자원이 있는가? | |
| 어떤 테스트가 동작을 고정하는가? | |

그다음 이 기능을 core 코드에 직접 넣었을 때 어떤 결합이 생길지 생각해 본다.

[이전 장: Coding Agent, 세션과 Tool](03-coding-agent-session-tools.md) · [다음 장: 컨텍스트 관리와 장시간 실행](05-context-and-long-running-work.md)
