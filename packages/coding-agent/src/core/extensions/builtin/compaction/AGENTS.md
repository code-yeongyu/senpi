# builtin/compaction

Builtin extension #20. Owns senpi's compaction *policy* (mechanics live in `core/compaction/`): speculative compaction running in parallel with the next turn, blocking compaction at the hard context limit, proactive compaction near the soft limit, degradation monitoring, circuit breaker, absolute session cap, todo bridging, checkpoint state, restoration tracker, and tool-result truncation. Policy-rich; touch with policy tests in lock-step. See `changes.md` for the restoration tracker rationale.

## FILES

```
compaction/
├── index.ts                  # Extension entry — wires every sub-policy into the event bus
├── state.ts                  # In-memory compaction state + persistence shape
├── policy.ts                 # Adaptive threshold + decision matrix
├── speculative.ts            # Parallel speculative compaction during next turn
├── overflow-retry.ts         # Bounded overflow-retry policy: input presize, geometric shrink, attempt cap + wall-clock budget
├── idle.ts                   # Proactive idle compaction predicate + instructions (agent_end trigger)
├── idle-retry.ts             # Bounded retry policy for transient idle warm-up failures
├── context-reduction.ts      # Deterministic no-LLM reductions (collapse tool-result runs, shrink old answers, clear old tool results)
├── openai-remote.ts          # OpenAI Responses remote-compaction route (`senpi.compaction.openai-remote.v1` schema)
├── repair-tool-pairs.ts      # Replaces orphaned tool-call/result pairs left by pruning with placeholders
├── summarization-turn-order.ts # Merges adjacent assistants + guarantees a leading user turn in summarization requests (Gemini alternation rule)
├── circuit-breaker.ts        # N consecutive failures → halt automatic compaction
├── degradation-monitor.ts    # Detects post-compact assistant degradation (all-tool, no-text turns)
├── log.ts                    # Always-on compaction logging + debug stderr mirror
├── per-turn-cap.ts           # Absolute session compaction cap (per-turn soft cap removed 2026-08-05)
├── task-intent.ts            # Extracts/persists/reinjects task-intent anchors across compaction
├── tool-truncation.ts        # Emergency/compaction-budget truncation for oversized bash/read results
├── speculation-lead.ts       # Speculative lead and grace-band policy primitives
├── tool-admission.ts         # Deterministic diskless tool-result admission projections
├── token-budget-reminder.ts  # Per-generation context budget reminder state
├── yield.ts                  # Structural yield capture and ineffective-compaction accounting
├── checkpoint-state.ts       # Snapshots agent state (model, thinking, todos) at compact boundaries
├── todo-bridge.ts            # Carries todos through compaction so the summary preserves them
├── restoration-tracker.ts    # Post-compact: re-injects skill + file context (fork-introduced)
├── prompts.ts                # Compaction summarization prompt + system message
├── lane-policy.ts            # SDK-native lane detection; `external-owner` structured ownership
├── deterministic-fallback.ts # Classification + construction when summarization fails outright
├── summarization-retry.ts, transient-failure.ts, retained-message-safety.ts  # Retry/safety predicates
├── openai-remote-{convert,model,schema,timeout,responses-v2}.ts  # Remote-route support modules
└── changes.md                # Fork tracker (restoration tracker, extension hook wiring)
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Adjust when proactive compaction fires | `policy.ts` (thresholds) and `idle.ts` (idle trigger guards) |
| Tune circuit breaker count | `circuit-breaker.ts` |
| Add a new degradation signal | `degradation-monitor.ts` |
| Change tool-result truncation format | `tool-truncation.ts` |
| Change when emergency tool-result truncation fires | `speculative.ts` |
| Add a new piece of state that should survive compaction | `checkpoint-state.ts` + `restoration-tracker.ts` |
| Modify the summarization prompt | `prompts.ts` |

## PIPELINE (one turn)

1. **Pre-turn**: `policy.ts` checks thresholds; if proactive, fire `speculative.ts` in parallel.
2. **Context assembly** (`context` event): `tool-admission.ts` first caps every oversized tool result with a deterministic diskless head/tail projection, regardless of the current context threshold.
3. **Context reduction and emergency pruning** (`context` event): near the limit, `context-reduction.ts` applies deterministic no-LLM reductions, then `speculative.ts` applies the `tool-truncation.ts` emergency valve and old-message pruning if the context still exceeds the hard threshold; `repair-tool-pairs.ts` finally patches orphaned tool-call/result pairs.
4. **Provider call**: on a provider context-overflow error, `core/agent-session.ts` detects it via `isContextOverflow` (`packages/ai/src/utils/overflow.ts`), cancels the turn, runs blocking compaction, and auto-retries once. On OpenAI Responses models, compaction routes through `openai-remote.ts` instead of local summarization.
5. **Post-turn**: `circuit-breaker.ts` + `per-turn-cap.ts` gate any further auto-compaction; `degradation-monitor.ts` watches for post-compact quality drop. When the turn ends and the context is over the soft threshold (`idle.ts`), summary generation warms at `agent_end`; a transient warm-up failure is retried while the session stays idle (`idle-retry.ts`, bounded attempts + delay, fenced on the observed job); when generation completes while the session is still idle, the warm result is applied immediately (`armIdleApply` in `index.ts`, fenced on the idle flag, lane, breaker, cap, and a fresh threshold check), so the [compaction] block renders during the idle gap and the next message stacks below it. A stale or refused apply keeps the warm hold and the next `before_agent_start` consumes it through normal admission, exactly as before. The warm-up is skipped when the run will auto-continue (`willRetry`), was aborted, in one-shot (`print`/`json`) mode, or `idleCompactionEnabled` is false.
6. **Compact event**: `checkpoint-state.ts` snapshots, `todo-bridge.ts` injects todos, `restoration-tracker.ts` queues re-injections for the first post-compact turn.

## CONVENTIONS

- **Each sub-policy is a pure module** with explicit state passed through. Don't add singletons.
- **The 13 per-feature compaction fixtures** under `packages/coding-agent/test/fixtures/compaction/` map 1:1 onto these sub-policies — when you change a policy, update its fixture (and add a new one if you split a behavior).
- **Restoration tracker is opt-in via `CompactionSettings`** — don't make it unconditional; tests rely on the on/off path.
- **`session_compact` is the canonical event**; everything else (degradation, restoration) hangs off it.

## ANTI-PATTERNS

- Wiring compaction logic into `core/agent-session.ts` — that's the seam this extension was built to remove. See upstream `core/compaction/` for the bare policy constants.
- Changing the `prompts.ts` summarization template without regenerating the relevant goldens.
- Bypassing `tool-truncation.ts` for "small" tool results — the policy uses a global token budget; even small additions matter.
- Mutating `restoration-tracker.ts` queue from a non-compaction hook.
- Treating provider-owned SDK-native compaction as ordinary extension cancellation — `lane-policy.ts` must preserve `external-owner` ownership.
- Letting an aborted compaction surface: aborts stand down silently (no circuit-breaker failure, no raw abort error, no `{cancel: true}` rejected-compact event).
- Leaving idle warm-up continuations unfenced against retired extension generations — stale context access becomes an uncaught crash.

## NOTES

- The fork's compaction differs significantly from upstream pi (speculative + restoration + degradation are all senpi additions). Upstream has a much simpler `core/compaction/` policy.
- The 13 per-feature fixtures (under `packages/coding-agent/test/fixtures/compaction/`) are documented in their own `README.md` — each isolates one subsystem to avoid spooky-action regressions.
- `restoration-tracker.ts` is the marquee feature: post-compact, the agent re-reads its prior file/skill context so summarization doesn't lose tool grounding.
