# Senpi 소스 코드 용어집

이 용어집은 사전식 정의보다 “Senpi 코드에서 이 단어가 무엇을 뜻하는가”에 초점을 둔다.

## Agent

- **쉽게 말하면:** 모델과 Tool을 반복해서 실행하는 엔진.
- **코드에서:** message state, model, thinking level, Tool과 streaming 상태를 가진다.
- **주의:** 세션 파일, 프로젝트 규칙과 TUI 전체를 책임지는 객체는 아니다.

## Agent Loop

- **쉽게 말하면:** 모델이 최종 답을 낼 때까지 모델 호출과 Tool 실행을 반복하는 절차.
- **코드에서:** `packages/agent/src/agent-loop.ts`의 `agentLoop()`, `runLoop()`가 중심이다.

## AgentSession

- **쉽게 말하면:** 범용 Agent를 실제 코딩 작업으로 운영하는 감독자.
- **코드에서:** 세션 저장, Extension, 동적 prompt, compaction, model과 Tool 변경을 조정한다.

## API Adapter

- **쉽게 말하면:** Senpi 공통 메시지를 특정 LLM API 형식으로 번역하는 통역사.
- **예:** Anthropic Messages, OpenAI Responses, OpenAI Completions.

## App Server

- **쉽게 말하면:** 외부 애플리케이션이 Senpi session을 장기적으로 실행하고 제어할 수 있는 server mode.

## Assistant Message

- **쉽게 말하면:** 모델이 만든 한 번의 응답.
- **코드에서:** Text, thinking, Tool Call 등 여러 content block을 가질 수 있다.

## Abort

- **쉽게 말하면:** 현재 실행을 더 진행하지 말라는 취소 신호.
- **코드에서:** `AbortSignal`을 provider와 Tool에 전달한다. 하위 OS process 종료와는 별도 문제가 될 수 있다.

## Builtin Extension

- **쉽게 말하면:** 외부 설치 없이 Senpi에 포함되어 기본 등록되는 Extension.
- **예:** permission-system, compaction, terminal, goal, MCP.

## Compaction

- **쉽게 말하면:** 긴 대화의 과거 부분을 요약해 context 공간을 확보하는 작업.
- **주의:** 단순 메시지 삭제가 아니라 작업 상태를 보존해야 한다.

## Context

- **쉽게 말하면:** 현재 모델 호출에서 모델이 볼 수 있는 정보 전체.
- **포함:** System prompt, 대화, Tool Call/Result, 이미지와 Tool schema.

## Context Window

- **쉽게 말하면:** 모델이 한 요청에서 처리할 수 있는 token의 최대 범위.

## Codemode

- **쉽게 말하면:** Persistent kernel에서 code cell을 실행하는 Senpi Extension.
- **코드에서:** `packages/senpi-codemode`에 있으며 긴 cell은 detach할 수 있다.

## Differential Rendering

- **쉽게 말하면:** 이전 화면과 달라진 부분만 terminal에 다시 그리는 방식.
- **목적:** 깜빡임과 CPU·출력 비용 감소.

## Entry

- **쉽게 말하면:** Session log에 append되는 기록 한 단위.
- **예:** Message, 모델 변경, custom state, compaction summary.

## Extension

- **쉽게 말하면:** Core를 직접 수정하지 않고 Tool, Command, Event handler, UI와 Provider를 추가하는 모듈.

## ExtensionAPI

- **쉽게 말하면:** Extension factory가 기능을 등록할 때 쓰는 API.

## ExtensionContext

- **쉽게 말하면:** Event handler가 현재 session 상태와 UI에 접근할 때 받는 문맥 객체.

## ExtensionRunner

- **쉽게 말하면:** 등록된 Extension 기능과 event handler를 보관하고 실행하는 관리자.

## Faux Provider

- **쉽게 말하면:** 실제 API와 credential 없이 정해진 모델 event를 재현하는 테스트 provider.

## Follow-up Message

- **쉽게 말하면:** 현재 Agent 작업이 끝난 다음 실행할 추가 메시지.

## Goal

- **쉽게 말하면:** 여러 turn이나 재시작을 지나도 유지되는 완료 목표.
- **주의:** 현재 작업 단계 목록인 Todo보다 상위 개념이다.

## MCP

- **풀어 쓰면:** Model Context Protocol.
- **쉽게 말하면:** 외부 server가 제공하는 Tool, Resource와 Prompt를 Agent에 연결하는 표준.

## Model

- **쉽게 말하면:** 사용자가 선택할 수 있는 구체적인 LLM 하나와 capability metadata.
- **포함:** Provider, API 종류, context window, reasoning, modality.

## ModelRuntime

- **쉽게 말하면:** 모델 목록, 인증과 실제 사용 가능 상태를 관리하는 coding-agent 계층.

## Mode

- **쉽게 말하면:** 같은 AgentSession을 사용자나 외부 프로그램과 연결하는 입출력 방식.
- **예:** Interactive, Print, JSON, RPC, App Server.

## Permission

- **쉽게 말하면:** 특정 Tool 동작을 allow, ask 또는 deny할지 정하는 논리적 정책.
- **주의:** OS sandbox나 container boundary는 아니다.

## Prompt Preset

- **쉽게 말하면:** 모델 family의 행동 특성에 맞춰 system prompt를 조정하는 builtin 기능.

## Provider

- **쉽게 말하면:** 모델 endpoint와 인증을 제공하는 서비스 또는 실행 환경.
- **주의:** Provider와 API wire format은 항상 일대일 관계가 아니다.

## PTY

- **풀어 쓰면:** Pseudo Terminal.
- **쉽게 말하면:** 실제 terminal처럼 shell process와 계속 상호작용할 수 있게 하는 가상 terminal.

## ResourceLoader

- **쉽게 말하면:** Extension, Skill, Prompt, Theme, 프로젝트 context file 등 session resource를 발견하고 로드하는 객체.

## RPC

- **풀어 쓰면:** Remote Procedure Call.
- **쉽게 말하면:** 외부 process가 JSONL command를 보내 Senpi session을 제어하고 event를 받는 mode.

## Session

- **쉽게 말하면:** 하나의 지속 가능한 대화·작업 기록.
- **포함:** 메시지뿐 아니라 모델 상태, compaction, Extension custom entry와 branch 관계.

## SessionManager

- **쉽게 말하면:** Session entry를 저장하고 읽으며 branch와 현재 leaf를 관리하는 객체.

## Steering Message

- **쉽게 말하면:** Agent가 실행 중일 때 현재 방향을 바꾸기 위해 끼워 넣는 사용자 메시지.

## Stream / Streaming

- **쉽게 말하면:** 완성된 답변을 기다리지 않고 생성되는 text, thinking과 Tool Call 조각을 순서대로 받는 방식.

## System Prompt

- **쉽게 말하면:** 모델의 역할, Tool, 규칙과 현재 작업 환경을 설명하는 상위 지침.
- **Senpi에서:** 활성 Tool, model preset, 프로젝트 규칙에 따라 동적으로 조립된다.

## Thinking Level

- **쉽게 말하면:** 모델이 답변 전에 사용할 reasoning 강도를 표현하는 공통 설정.
- **주의:** 실제 provider payload와 지원 단계는 모델마다 다르다.

## Todo

- **쉽게 말하면:** 현재 목표를 달성하기 위한 진행 단계 목록.

## Tool

- **쉽게 말하면:** 모델이 구조화된 입력으로 요청할 수 있는 외부 동작.
- **예:** read, bash, edit, web search, MCP Tool.

## Tool Call

- **쉽게 말하면:** 모델이 특정 Tool을 특정 argument로 실행해 달라고 보낸 요청.

## Tool Result

- **쉽게 말하면:** Tool 실행 뒤 모델에게 돌려주는 성공·실패 결과.

## Tool Pair

- **쉽게 말하면:** 하나의 Tool Call과 그에 대응하는 Tool Result의 쌍.
- **주의:** 일부 provider는 pair가 깨진 transcript를 거부한다.

## TUI

- **풀어 쓰면:** Terminal User Interface.
- **쉽게 말하면:** 일반 GUI 대신 terminal 문자와 ANSI sequence로 구성하는 사용자 인터페이스.

## Wake Source

- **쉽게 말하면:** Background 작업이 끝났을 때 session을 다시 진행시킬 책임이 있는 활성 작업.
- **예:** Terminal monitor, detached eval cell.

## Wire Format

- **쉽게 말하면:** 실제 provider나 remote transport로 전송되는 JSON 또는 binary 형식.
- **주의:** Senpi 내부 공통 타입과는 다를 수 있다.

---

[처음으로](README.md) · [1장: 전체 구조와 실행 흐름](01-architecture-and-flow.md)
