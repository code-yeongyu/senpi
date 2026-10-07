# Cache Keep-Alive Extension Changes

## 2026-09-30 - Keep-alive pings arm after the run settles and send the turn's tools (senpi#2389)

### What changed

- `index.ts`: `agent_end` records the completed turn and marks it for arming; a new `agent_settled` handler arms the keep-alive once the session reports idle. The ping's tool list now comes from `ctx.getPromptCachePrefixRequest()`, which builds the agent's tools in request order through `buildProviderContext` with the fields the turn sends; when that build is skipped, the ping falls back to the previous active-tool assembly.

### Why

- `agent_end` handlers run while the run is still active, so `arm()` saw `isIdle() === false`, stood down with `agent-busy`, and nothing re-armed it: the keep-alive never pinged in a real session. The ping also listed tools in registry order without the fields the turn sends, so an armed ping would write a different cache prefix than the turn it keeps warm.

### Why an extension could not handle it

- This is the builtin keep-alive extension itself; the fix uses only existing extension APIs (`agent_settled`, `getPromptCachePrefixRequest`).

### Expected merge conflict zones

- `cache-keepalive/index.ts`: the `agent_end` handler and the tool assembly inside `ping()`.

## 2026-09-24 - Prewarm the OpenAI GPT-5.6+ prompt cache at session start (senpi#2096)

### What changed

- `session-prewarm.ts` (new): on every `session_start` for a native OpenAI Responses model with explicit prompt caching (and `cacheRetention` not `none`), one detached `warmPromptCache` request writes the first user turn's prefix: the model, context (system prompt after the `before_agent_start` preview pass, the agent's tools in request order, empty conversation), and options (reasoning, thinking selection/budgets, session id, effective service tier, `onPayload`, `before_provider_headers`, auth, `extraBody`) come from `ctx.getPromptCachePrefixRequest()`, which the host resolves after session start has settled, the way the turn resolves them. It never awaits in the turn path, is aborted on the next `session_start` and on `session_shutdown`, times out after 30 s, and records a `prompt-cache-prewarm` custom entry (`warmed` with priced usage, or `failed` with the error).
- `prewarm-entry.ts` (new): the entry type and `getPromptCachePrewarmUsage`, which core session stats read.
- `index.ts`: creates the prewarm, starts it from the `session_start` handler and cancels it on `session_shutdown`; `createCacheKeepAliveExtension` accepts an `isPromptCachePrewarmModel` override for tests. The opt-in Anthropic keep-alive loop is unchanged.

### Why

The first turn of every GPT-5.6+ session paid a cold prefix; the platform's `prompt_cache_options.prewarm` writes it ahead of the user's first message. The platform reuses a prefix only up to a block boundary, so the prewarm has to send the turn's exact developer message and tools: the earlier `ctx.getSystemPrompt()` snapshot taken inside this `session_start` handler was about 6k tokens shorter than the first turn's prompt (live QA: prewarm wrote 12,242, the first turn read 0 and wrote 18,444).

### Why an extension could not handle it

This is the extension; the change stays inside this builtin apart from the session-stats read documented in `core/changes.md`.

### Expected merge conflict zones

- `session_start` and `session_shutdown` handlers and the factory signature in `index.ts`.

## 2026-09-21 - Do not warm parked retained sessions (#1902)

### What changed

- `index.ts` cancels its timer on `session_parked`, rejects rearming while parked even when a detached turn finishes, and rearms on `session_resumed`.

### Why

- Parked sessions deliberately allow the cache to expire rather than paying for periodic warm requests.

### Why an extension could not handle it

- The timer and generation fence are private to this builtin.

### Expected merge conflict zones

- `arm()` guard and session lifecycle subscriptions. Request/cost caps and TUI cadence remain unchanged.

## 2026-09-07 - Keep-alive no longer stands down for an armed goal timer (code-yeongyu/oh-my-openagent#7720)

### What changed

- `index.ts` drops the `goal_continuation_timer_state` subscription, the `goalTimerArmed` flag, the `goal-timer-armed` stop in `arm()`, the same condition in `ping()`, and the now-unused `isGoalTimerState` guard and `GOAL_CONTINUATION_TIMER_STATE_EVENT` import. Every other guard is untouched: keep-alive still requires the opt-in setting, a direct Anthropic Messages model, an idle session with no pending input, and it still honors the per-session request and cost caps and the generation fencing.

### Why

- The stand-down assumed the armed goal timer would itself issue a provider request that refreshes the same prompt cache. That is no longer true: the goal monitor now parks on a long stall backstop and issues no request while wake sources are live, so treating the armed timer as a warm source silently disabled the only loop the user opted into to keep the cache warm during exactly that wait.

### Why an extension could not handle it

- The coupling was hard-wired into this built-in loop's own lifecycle, between its timer and the goal extension's event bus; nothing outside it could remove the stop without disabling the loop.

### Expected merge conflict zones

- LOW: the removed subscription block near the top of the factory, and the two guard conditions in `arm()` and `ping()`.

## 2026-08-09 - Opt-in native Anthropic warm pings

### What changed and why

- `index.ts` adds a default-off idle loop controlled by `promptCache.keepAlive`. It arms only for direct Anthropic
  Messages models while the session is idle, has no pending input, and has no armed Goal continuation timer.
- Each timer is measured from the later of the last completed real request or successful warm ping. The loop permits
  one timer and one provider request at a time, uses generation fencing across cancellation/reload, and stops silently
  on provider errors without adding model messages or retrying.
- Pre-arm projection uses the prior turn's prompt-token proxy and the larger cache read/write rate. Completed pings use
  the provider's actual normalized input/cache usage; attempted requests count toward the request cap even on failure.
- Successful pings emit `cache_warm_ping`, append durable `cache-keepalive` entries, and render through the shared
  notice kit as `⚡ Warm ping #N · ~45K tokens refreshed · $0.005`.
- The Goal continuation coordinator publishes an additive `goal_continuation_timer_state` event for both monitor and
  user-grace timers. Keep-alive treats any armed Goal timer as dormant because the eventual Goal request refreshes the
  same prompt cache.

### Why this cannot be expressed externally

- The loop needs live idle/pending state, canonical provider-request transformations, active tool schemas, model auth,
  current session identity, and Goal timer ownership in one lifecycle. A standalone extension cannot safely infer all
  of those from persisted transcript entries.

### Expected merge conflict zones

- MEDIUM: `settings-manager.ts`, extension context actions, and `agent-session.ts` getter wiring.
- MEDIUM: `goal/monitor-continuation.ts` additive timer-state emissions around schedule/cancel/fire transitions.
- LOW: `builtin/index.ts` registration order immediately after Goal.
