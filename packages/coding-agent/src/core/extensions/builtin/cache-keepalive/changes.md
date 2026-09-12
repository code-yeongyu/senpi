# Cache Keep-Alive Extension Changes

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
