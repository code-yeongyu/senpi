# test/suite

Preferred harness-based coverage for `AgentSession` / `AgentSessionRuntime`, builtin extensions, app-server, goals, loops, and compaction lifecycle. 367 direct TypeScript files + `regressions/` and small `fixtures/`. Score 12 — high-fan-in session/extension integration boundary.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Shared session/agent fixture | `harness.ts` (`createHarness`, `Harness`, `HarnessOptions`, `getUserTexts`, `getAssistantTexts`, `getMessageText`) |
| App-server transports/threads | `app-server-mode-harness.ts`, `app-server-mode-socket.ts`, `app-server-thread-handlers-harness.ts`, `app-server-thread-search-support.ts`, `app-server-fuzzy-test-support.ts` |
| RPC worker lifecycle / backpressure | `rpc-connection-harness.ts`, `rpc-worker-host-support.ts`, `rpc-worker-pressure-support.ts`, `rpc-worker-reservation-support.ts` |
| Goal subsystem | `goal-*.test.ts`, `goal-monitor-test-harness.ts` (`TestEventBus`, `waitForGoalStatus`) |
| Loop scheduler/tools | `loop-*.test.ts`, `loop-guard-test-harness.ts` |
| Hooks lifecycle/safety/trust | `hooks-*.test.ts`, `hooks-command-harness.ts` |
| History/help UI fixtures | `history-search-fixtures.ts` (`testTheme`, `writeSessionFile`) |
| Prompt presets / model rules | `prompt-presets-*.test.ts`, `recommended-models-harness.ts` |
| TTSR activation asserts | `ttsr-activation-assertions.ts` (`expectTtsrActivation`) |
| Terminal monitor notifications | `terminal-monitor-notify-harness.ts` |
| Issue regressions | `regressions/` — see its own AGENTS.md |

Local `README.md` carries the same harness/faux-provider rules; keep both in sync.

## CONVENTIONS

- Broad lifecycle and characterization tests go here flat; issue regressions go to `regressions/`. Small text/process fixtures live in `fixtures/`.
- Support modules are `*-harness.ts` / `*-support.ts` / `*-fixtures.ts` siblings (never `.test.ts`) and export their helpers directly rather than hiding behind one fixture API.
- Harnesses inject clocks, timers, IDs, model registries, extension APIs, and faux providers. Time-dependent tests use `vi.useFakeTimers` / `advanceTimersByTimeAsync` or deferred promises — never elapsed real time.
- App-server tests assert wire-level JSON-RPC envelopes over real WebSocket/UDS/stdio transports plus fake connections; protocol/parity tests pin generated manifests, hashes, and stable/experimental method lists.
- State machines are asserted via typed terminal reasons, phases, delivery IDs, persisted state, event ordering, and exact call counts — `exactly once` / `at most one` are the load-bearing invariants for recovery ticks, coalesced due work, wakeups, and fallback transitions.
- Config-reload timing tests use dynamic `import()` after env setup because timing config is read at module evaluation. This is the documented exception to the repo's top-level-import rule.

## ANTI-PATTERNS

- Worker credit/backpressure assertions must observe the real host/worker/socket boundary; replacing the entire transport with a stub cannot catch stalled-peer credit loss.
- Never introduce sleeps, polling, or real-clock assertions here; the suite's whole value is deterministic scheduling.
- Do not reuse a captured `pi` / command context after `newSession`, `fork`, `switchSession`, or `reload` — `goal-ticker-stale-context.test.ts` and `stale-extension-context-*` exist because that broke in production.
- Goal schemas and guidance stay budget-free; legacy budget metadata is migrated away, never resurrected.
- `app-server-thread-compact.test.ts` pins that completion emits the shared context-compaction item and **never** the deprecated notification.
- Do not verify protocol behavior by filename or shape guessing; compare against the generated manifests.

## HOTSPOTS

`agent-session-compaction.test.ts`, `config-reload-extension.test.ts`, `goal-extension.test.ts`, `goal-store.test.ts`, `goal-monitor-continuation.test.ts`, `loop-scheduler.test.ts`, `gpt-apply-patch-extension.test.ts`, `loop-extension.test.ts`, `agent-session-queue.test.ts`, and `retry-fallback-engine.test.ts` concentrate lifecycle orchestration. AST import inspection finds 255 imports of `createHarness` across packages.

## COMMANDS

```bash
bun run --cwd packages/coding-agent test test/suite/<file>.test.ts
bun run --cwd packages/coding-agent test test/suite   # includes regressions
CI=1 bun run --cwd packages/coding-agent test test/suite/app-server-mode-ws.test.ts
```
