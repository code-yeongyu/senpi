<!-- changes-log: packages/agent/src/changes.md -->
## 2026-11-20 - parked follow-ups join the next run's first turn; `all` lists every queued message (oh-my-openagent#14428)

### What changed

- `packages/agent/src/agent.ts`: a run that ends in a provider error with follow-ups still queued marks them parked, whoever owns that run's post-run decision (a retry, a compaction or `agent_before_settle`, which suppress the core's own drain). The next run started from new input (a prompt, a started delivery, a goal continuation's message) sets `takeFollowUpsAtStart`, so those follow-ups enter it at its first turn boundary instead of only after its first response; a retry or other `continue()` leaves the mark for that run, so follow-up work still waits behind a retry. A run that starts from the follow-up queue itself clears the mark. `peekQueuedMessages({ all: true })` returns every queued steering and follow-up message (new `PendingMessageQueue.all()`); in `one-at-a-time` mode it returned only each queue's next drain.
- `packages/agent/src/agent-loop.ts`: the loop's first queue poll also drains follow-ups when `takeFollowUpsAtStart` is set and no steering is queued.
- `packages/agent/src/internal-events.ts`: `InternalLoopConfig` carries the internal `takeFollowUpsAtStart` flag; the public `AgentLoopConfig` is unchanged.

### Why

- oh-my-openagent#14428: follow-ups another session queued while a run was failing were parked, and every later run whose request failed too (a started delivery, a goal continuation) settled without writing them, so they stayed pending for hours. The transcript entry is the delivery: the next run writes them before its request, whatever that request returns.
- `takeQueuedDeliveries()`, `clearQueue()` and the ticket lookups used `peekQueuedMessages({ all: true })` as "every queued message". With user input queued ahead of a delivery, an interrupt dropped the delivery from the admission ledger while it stayed queued, so the sender's redelivery was written twice.

### Why an extension could not handle it

- Queue polling inside a run and the queue snapshot are agent-loop internals; no extension hook runs at a run's first turn boundary or owns the native queues.

### Expected merge conflict zones

- LOW: `runWithLifecycle()`, `createLoopConfig()` and `peekQueuedMessages()` in `agent.ts`; the first steering poll in `runLoop()` in `agent-loop.ts`.

<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-11-20 - queued input waits out a rate-limited provider instead of parking (oh-my-openagent#14428)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: when the retry owner gives up on a retryable failure (rate limit, overload, transient server error) and input is still queued, `_drainQueueAfterProviderBackoff()` waits (the provider's stated delay, else the retry profile's backoff for a counter that grows with each such wait, capped by `retry.maxAgentDelayMs` and reset by a run that ends without an error) and then runs the queue through the scheduled continuation. The wait uses the retry abort controller, so Esc or `abort()` cancels it like a retry backoff and the run settles.

### Why

- oh-my-openagent#14428: after a night of rate-limited requests the queued cross-session follow-ups stayed parked until an unrelated prompt arrived, while the provider was answering again.

### Why an extension could not handle it

- The retry owner's exhaustion and the agent_end continuation decision are session-core state; an extension sees the settle only after the queue has already been parked.

### Expected merge conflict zones

- LOW: the agent_end continuation block in `_handleAgentEvent()` (next to `retryExhaustionAllowsQueuedContinuation`) and the new method next to `abortRetry()`.

## 2026-11-20 - a compaction no longer detaches the session from its agent's events (oh-my-openagent#14428)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `compact()` and the extension `ctx.compact()` keep the session subscribed to its agent while the summary is prepared. `_reconnectToAgent()` is removed and `_disconnectFromAgent()` is called by `dispose()` only. Upstream removed the same detach in e56893f4cd (pi-mono #7253); the fork still carried it.

### Why

- oh-my-openagent#14428: the abort that precedes a compaction does not always leave the agent quiet. It returns at once when the run is already ending (an open `agent_end` boundary) or is a run the session does not own, and that run's own continuation, retry or queue drain then ran with no subscriber. Every message such a run emitted was lost. Queued cross-session deliveries it took were never written and stayed `pending` in the admission ledger for the life of the process, so their sender never delivered them again, and the unheard `agent_end` left the session marked busy.

### Why an extension could not handle it

- The agent subscription and both compaction entry points are session core; an extension cannot observe events the session itself does not receive.

### Expected merge conflict zones

- LOW: the `try`/`finally` of `compact()` and of the extension `compact` action in `agent-session.ts`. Upstream has no detach there either; take upstream's shape.

<!-- changes-log: packages/agent/CHANGELOG.md -->
### Fixed
- Follow-ups parked by a run that ended in a provider error are written at the next run's first turn, even when that run's request fails too, and `peekQueuedMessages({ all: true })` lists every queued message in `one-at-a-time` mode ([oh-my-openagent#14428](https://github.com/code-yeongyu/oh-my-openagent/issues/14428))

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- Cross-session follow-ups queued behind rate-limited or overloaded requests are delivered once the provider answers again, with no new prompt, and an interrupt that drops a delivery queued behind user input no longer leaves a copy that is written again on redelivery ([oh-my-openagent#14428](https://github.com/code-yeongyu/oh-my-openagent/issues/14428))
- A run that overlaps a manual or extension-requested compaction is recorded like any other: the cross-session deliveries and queued input it takes are written to the session instead of being lost, which had left those deliveries pending forever and the session marked busy ([oh-my-openagent#14428](https://github.com/code-yeongyu/oh-my-openagent/issues/14428))
