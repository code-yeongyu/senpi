# Cache Keep-Alive Extension Changes

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
