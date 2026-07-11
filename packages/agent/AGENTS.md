# packages/agent

`@earendil-works/pi-agent-core` provides the stateful agent loop and a publicly exported optional harness for compaction, sessions, skills, prompts, and execution environments.

## STRUCTURE

```text
src/agent.ts                 Agent state, prompt queue, subscriptions, abort
src/agent-loop.ts            Provider/tool loop and scheduling
src/types.ts                 App messages, events, state, conversion boundary
src/proxy.ts                 Remote stream proxy
src/index.ts                 Browser-safe public exports
src/node.ts                  Node harness public exports
src/harness/                 Compaction, sessions, skills, prompts, env adapters
src/changes.md               Fork-specific behavior record
```

## WHERE TO LOOK

| Task | File |
|---|---|
| Tool scheduling or terminal states | `src/agent-loop.ts` |
| Agent lifecycle or abort | `src/agent.ts` |
| Public message/event contract | `src/types.ts` |
| Harness orchestration | `src/harness/agent-harness.ts` |
| Node process and filesystem behavior | `src/harness/env/nodejs.ts` |
| Session persistence | `src/harness/session/` |
| Compaction | `src/harness/compaction/` |

## INVARIANTS

- Keep `AgentMessage` as app state and convert to the AI package `Message` only through `convertToLlm`.
- Core files `agent.ts`, `agent-loop.ts`, and `types.ts` remain browser-safe; Node filesystem/process behavior belongs behind `src/node.ts` and `src/harness/env/`.
- Tool preparation/finalization may complete concurrently, but returned `toolResults` remain in assistant source order.
- The active run owns idle-timeout and abort cleanup. Abort produces terminal behavior once; do not emit or settle a run twice.
- Subscribers receive events; messages remain state. Preserve discriminated streaming event shapes.
- Keep harness interfaces injectable so tests can use memory storage and fake execution environments.

## ANTI-PATTERNS

- Sequentializing independent tool calls.
- Importing Node-only modules into browser-safe entry points.
- Storing provider-shaped messages directly as app state.
- Adding harness behavior without exporting and documenting the matching public surface.

## VALIDATION

- Run `npm test` from this package for agent-loop coverage.
- Run `npm run test:harness` for harness/session/env changes.
- Runtime changes also require root `npm run check` and the root QA evidence gate.
- Keep `README.md`, `docs/agent-harness.md`, and `src/changes.md` aligned with public or fork-specific changes.
