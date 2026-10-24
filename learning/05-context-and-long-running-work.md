# 5장. 컨텍스트 관리와 장시간 실행

## 먼저 한 문장으로

Senpi는 제한된 모델 context 안에서 중요한 작업 상태를 보존하고, 오래 실행되는 명령과 평가를 background resource로 분리한 뒤 완료 시 Agent를 다시 깨우는 구조를 갖는다.

## 이 장에서 답할 질문

- 대화가 길어지면 왜 단순히 오래된 메시지를 삭제하지 않을까?
- Compaction은 언제 준비되고 언제 적용될까?
- Todo, 작업 의도와 읽었던 파일은 요약 뒤 어떻게 보존될까?
- Background process가 끝났다는 사실을 Agent는 어떻게 알까?
- Persistent terminal과 Codemode는 무엇이 다를까?

## 1. 쉽게 이해하기: 작은 책상과 별도의 작업실

모델의 context window는 책상 크기와 비슷하다. 처음에는 모든 자료를 펼칠 수 있지만, 대화와 파일 출력이 쌓이면 더 놓을 공간이 없다.

해결책은 두 가지다.

1. 오래된 자료를 요약해 작은 노트로 바꾼다. 이것이 compaction이다.
2. 오래 걸리는 작업은 책상 앞에서 계속 기다리지 않고 별도의 작업실에 맡긴다. 이것이 persistent terminal과 detached eval이다.

요약할 때는 단순히 종이 양만 줄이면 안 된다. 현재 목표, 아직 끝나지 않은 Todo, 중요한 파일과 결정은 남겨야 한다.

## 2. Context Window

Provider 요청에는 다음이 함께 들어간다.

- system prompt
- user/assistant 대화
- Tool call과 Tool result
- Tool schema
- 이미지와 provider metadata

모델마다 context 한도가 있고, 출력에 사용할 token 공간도 남겨야 한다. 입력이 한도에 너무 가까우면 provider가 context overflow 오류를 반환하거나 답변에 필요한 여유가 줄어든다.

특히 `read`와 `bash` 결과는 짧은 시간에 context를 크게 늘릴 수 있다.

## 3. Compaction의 기본 아이디어

Compaction은 과거 대화 일부를 summary로 바꾸고 최근 메시지를 유지하는 작업이다.

```text
오래된 대화 A + B + C + 최근 대화 D + E
                     ↓
요약 S(A,B,C) + 최근 대화 D + E
```

좋은 summary는 문장 수만 줄이는 것이 아니라 다음 작업에 필요한 상태를 전달해야 한다.

- 사용자의 원래 목적
- 이미 확인한 사실
- 변경한 파일
- 실패한 접근과 이유
- 아직 남은 작업
- 지켜야 할 제약

## 4. Senpi Compaction Pipeline

Core의 기본 compaction 구현은 [`packages/coding-agent/src/core/compaction`](../packages/coding-agent/src/core/compaction)에 있고, 정책이 풍부한 동작은 [`builtin/compaction`](../packages/coding-agent/src/core/extensions/builtin/compaction)에 있다.

### 4.1 사전 판단

현재 token 사용량과 모델 context window를 비교해 아직 여유가 있는지, 미리 준비해야 하는지, 즉시 줄여야 하는지 판단한다.

### 4.2 Speculative Compaction

한도에 가까워지기 전에 다음 turn과 병렬로 summary를 준비할 수 있다. 실제로 필요해졌을 때 기다리는 시간을 줄이는 목적이다.

준비 중 원본 session이 바뀌면 오래된 summary를 그대로 적용하면 안 된다. Compaction job이 시작될 때의 revision과 적용 시점의 revision을 비교해야 한다.

### 4.3 Deterministic Reduction

항상 LLM summary부터 요청하지 않는다. 먼저 규칙만으로 줄일 수 있는 부분을 처리한다.

- 오래된 큰 Tool result 축소
- 연속된 Tool output 정리
- 오래된 답변의 세부 내용 축소
- 끊어진 Tool Call/Result pair 수리

이 단계는 빠르고 결과가 예측 가능하다.

### 4.4 Blocking Compaction

Provider 호출 전에 이미 한계에 도달했거나 context overflow가 발생했다면 현재 실행을 막고 compaction을 완료한다. 성공하면 줄어든 context로 provider 요청을 제한된 횟수만큼 재시도한다.

### 4.5 Idle Compaction

Turn이 끝나 사용자가 생각하거나 다음 입력을 준비하는 동안 summary를 미리 warm할 수 있다. 다음 prompt의 critical path에서 summary 생성을 제거하려는 최적화다.

## 5. 상태를 잃지 않는 장치

### Checkpoint

Compaction 경계에서 model, thinking level과 주요 session 상태를 snapshot으로 남긴다.

### Todo Bridge

열린 Todo를 summarization 입력에 포함해 “무엇을 끝냈고 무엇이 남았는가”가 summary에 보존되도록 한다.

### Task Intent

세부 대화가 줄어들어도 사용자의 원래 목적과 핵심 제약이 사라지지 않도록 별도 anchor를 유지한다.

### Restoration Tracker

Summary만으로는 실제 파일 내용이나 skill 지침이 충분하지 않을 수 있다. Compaction 전 중요하게 사용하던 file/skill context를 첫 post-compaction turn에서 다시 읽도록 추적한다.

### Tool Pair Repair

Provider는 tool call 바로 뒤에 대응하는 result가 있기를 요구할 수 있다. 메시지를 자르는 과정에서 한쪽만 남으면 placeholder나 정리 규칙으로 pair를 복구한다.

## 6. Compaction 실패 방어

Compaction도 모델 호출이므로 실패할 수 있다.

- summary가 비어 있음
- 결과가 원본보다 충분히 작지 않음
- provider timeout
- 연속 context overflow
- speculative 결과가 현재 session보다 오래됨
- compaction 후 assistant 품질 저하

Senpi는 retry budget, circuit breaker, stale revision 검사, degradation monitor와 절대 실행 횟수 제한을 사용한다. 자동 복구가 계속 반복되어 실제 작업을 방해하지 않게 하는 것이 목적이다.

## 7. 장시간 작업의 문제

모델이 `npm test`처럼 오래 걸리는 명령을 요청했다고 해 보자. Tool call 하나가 20분 동안 반환되지 않으면 다음 문제가 생긴다.

- 사용자가 다른 요청을 전달하기 어렵다.
- provider prompt cache가 만료될 수 있다.
- 실행 중인지 멈췄는지 알기 어렵다.
- 앱이 재시작되면 process와 연결을 잃을 수 있다.

그래서 Senpi는 foreground wait와 실제 작업 수명을 분리한다.

## 8. Persistent Terminal

[`packages/pty`](../packages/pty)는 pseudo-terminal session을 관리한다. Terminal builtin은 이를 Agent가 사용할 Tool로 연결한다.

### 일반 Bash와 PTY

일반 child process pipe는 한 번 실행하고 출력을 모아 반환하는 데 적합하다. PTY는 shell과 계속 상호작용하거나 process를 background에서 유지하는 데 적합하다.

### 주요 개념

- Terminal session ID
- screen/output buffer
- foreground wait
- background detach
- 입력 전송
- output peek
- monitor
- 종료 상태

### Foreground에서 Background로

짧게 끝날 것으로 예상되는 명령은 잠시 foreground에서 기다린다. 일정 시간 안에 끝나지 않거나 명령 형태가 긴 wait를 암시하면 session을 유지한 채 control을 Agent에게 돌려준다.

Agent는 다른 작업을 하다가 `bash_output` 등으로 상태를 확인할 수 있다.

## 9. Monitor와 Wake Source

Background process를 매 turn마다 polling하라고 모델에게 시키면 token과 tool call을 낭비한다. Monitor는 특정 상태 변화를 구독한다.

예:

- process 종료
- 특정 output pattern 등장
- Anthropic service 상태 회복
- detached eval 완료

Wake source는 “현재 session을 나중에 다시 깨울 책임이 있는 작업”을 나타낸다. 활성 wake source가 있으면 Goal builtin은 성급하게 동일한 continuation을 반복하지 않고 완료 알림을 기다릴 수 있다.

```text
Agent turn 종료
→ background 작업은 계속 실행
→ monitor가 완료 감지
→ hidden notification/continuation 등록
→ Agent가 결과를 가지고 다시 진행
```

## 10. Steering, Follow-up과 Continuation

세 개념은 비슷해 보여도 출처와 목적이 다르다.

| 개념 | 누가 만드는가 | 목적 |
|---|---|---|
| Steering | 주로 사용자 | 현재 진행 방향 변경 |
| Follow-up | 사용자 또는 시스템 | 현재 turn 뒤에 새 작업 수행 |
| Continuation | Goal/monitor 등의 정책 | 끝나지 않은 기존 작업 재개 |

Compaction, abort와 model fallback 도중에도 이 queue가 유실되지 않아야 한다. 그래서 queue drain과 restore가 transaction처럼 다뤄진다.

## 11. Codemode

[`packages/senpi-codemode`](../packages/senpi-codemode)는 source-only extension으로 persistent eval kernel을 제공한다.

### 일반 Tool과의 차이

일반 Tool call은 하나의 정해진 작업을 수행한다. Codemode의 eval cell은 작은 프로그램 안에서 계산과 여러 bridge 동작을 조합할 수 있다.

### Persistent Kernel

각 eval마다 완전히 새 process를 만드는 대신 kernel 상태를 유지할 수 있다. 앞 cell에서 만든 값이나 helper를 다음 cell에서 활용할 수 있다.

### Detached Cell

오래 걸리는 eval은 caller를 계속 막지 않고 detach할 수 있다.

- 실행 중 상태 유지
- cell ID로 조회
- 결과 peek
- 명시적 stop
- 완료 시 wake-source 상태 갱신

Terminal은 shell/process 중심이고 Codemode는 code cell과 kernel 중심이라는 차이가 있다.

## 12. Prompt Cache와 긴 Wait

Provider에 따라 prompt prefix cache의 수명이 다르다. 너무 긴 foreground wait 뒤에 같은 대화로 모델을 다시 호출하면 cache가 사라져 비용과 latency가 증가할 수 있다.

Senpi는 provider별 cache retention 정보를 이용해 foreground window와 keep-alive 정책을 조정한다. 그렇다고 cache 때문에 process를 중단하는 것은 아니다. 사용자의 wait와 background process 수명을 분리한다.

## 13. 소스 읽기 경로

### Compaction

1. [`packages/coding-agent/docs/compaction.md`](../packages/coding-agent/docs/compaction.md)
2. [`core/compaction/compaction.ts`](../packages/coding-agent/src/core/compaction/compaction.ts)
3. [`builtin/compaction/AGENTS.md`](../packages/coding-agent/src/core/extensions/builtin/compaction/AGENTS.md)
4. `policy.ts`, `speculative.ts`, `context-reduction.ts`
5. `checkpoint-state.ts`, `todo-bridge.ts`, `restoration-tracker.ts`

### Terminal과 Codemode

1. [`packages/pty/README.md`](../packages/pty/README.md)
2. [`builtin/terminal`](../packages/coding-agent/src/core/extensions/builtin/terminal)
3. [`packages/coding-agent/docs/terminal-tools.md`](../packages/coding-agent/docs/terminal-tools.md)
4. [`packages/senpi-codemode/README.md`](../packages/senpi-codemode/README.md)
5. Codemode의 `src/tool`과 detached cell manager

## 14. 확인 문제

1. 오래된 메시지를 단순 삭제하는 것보다 compaction이 나은 이유는 무엇인가?
2. Speculative 결과를 적용하기 전에 revision을 확인해야 하는 이유는 무엇인가?
3. Deterministic reduction과 LLM summary는 각각 어떤 장점이 있는가?
4. Todo bridge와 restoration tracker는 서로 무엇을 보존하는가?
5. Polling 대신 monitor를 사용하는 이유는 무엇인가?
6. Persistent terminal과 detached eval cell의 중심 abstraction은 어떻게 다른가?

## 15. 추적 실습

다음 두 시나리오를 각각 상태 전이 그림으로 그린다.

### 시나리오 A: Context Overflow

```text
provider 요청
→ overflow 감지
→ 현재 turn 정리
→ blocking compaction
→ summary 적용
→ provider 재시도
```

각 단계에서 메시지 queue와 session revision이 어떻게 보호되는지 코드에서 찾는다.

### 시나리오 B: 오래 걸리는 테스트

```text
bash 시작
→ foreground window 초과
→ PTY session detach
→ monitor 활성화
→ Agent는 다른 작업 수행
→ 테스트 종료
→ wake notification
→ Agent continuation
```

각 화살표를 담당하는 패키지와 builtin을 적는다.

[이전 장: Extension과 Senpi 주요 기능](04-extensions-and-features.md) · [다음 장: TUI, 실행 모드와 품질 관리](06-ui-modes-and-quality.md)
