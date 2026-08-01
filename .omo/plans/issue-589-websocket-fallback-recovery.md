# Issue 589: recover from transient WebSocket fallback

## Objective

Prevent one transient OpenAI Codex WebSocket failure from pinning a long-lived
session to the more expensive SSE path forever, while preserving the guard
that never retries an already-started response.

## Diagnosis

- Issue #589's expensive cache-miss burst happened after WebSocket transport
  failures moved the session to SSE.
- `websocketSseFallbackSessions` is currently a process-lifetime
  `Set<string>`. Once added, a session has no production recovery path.
- `closeOpenAICodexWebSocketSessions` closes sockets but leaves fallback and
  debug state behind.
- PR #597 fixed the SSE request-affinity tuple. This plan fixes the remaining
  client-controlled exposure: permanent degradation after a transient failure.
- Provider-side prefix caching is still best-effort. The mitigation is to
  return future fresh requests to WebSocket continuation after a bounded
  cooldown, not to retry a completed cache miss.

## Tier and topology

Tier: **HEAVY** because this changes external-provider transport recovery and
shared session state.

The lead session owns implementation. A separate dependency PR handles the
unrelated PostCSS advisory.

## Success criteria

### 1. Time-bounded recovery

Drive the real adapter through a pre-start WebSocket failure and safe SSE
fallback. A request inside 60 seconds remains on SSE. After advancing the
clock by 60,001 ms, the next fresh request must attempt WebSocket and complete
without an additional HTTP request.

RED: current permanent fallback sends the post-cooldown request through SSE.

### 2. Cleanup clears degradation state

Trigger fallback, call `closeOpenAICodexWebSocketSessions(sessionId)`, then
issue a fresh same-session request with a working WebSocket.

PASS: WebSocket is attempted immediately and stale fallback/debug state is
gone.

RED: current cleanup leaves the session pinned to SSE.

### 3. Safety boundaries remain

- Transport errors after the first streamed event still propagate and never
  cause an SSE retry.
- Immediate requests during cooldown still use SSE.
- Existing continuation, connection-limit, stale-response, and
  `cacheRetention:"none"` tests remain green.

### 4. Real-surface proof

A TypeScript QA driver controls `Date.now`, observes one local HTTP fallback,
advances 60,001 ms, then observes the next request complete over WebSocket
with no second fetch. It must close all sockets/server resources. The required
real CLI mock-loop self-test must also pass.

## Implementation

1. Add focused integration tests outside the oversized existing stream test.
2. Capture both intended RED failures.
3. Extract fallback/debug-state ownership into
   `src/api/openai-codex-responses/fallback-state.ts`.
4. Replace the permanent set with a timestamped 60-second circuit.
5. Clear scoped/all circuit and debug state during production cleanup.
6. Keep the adapter net-smaller than before.
7. Document the semantics in `packages/ai/src/changes.md`.

## Verification

- Focused fallback tests.
- Existing Codex stream and cache-affinity tests.
- Full AI package tests.
- Root `npm run check`.
- Real library QA artifact and cleanup receipt.
- `mock-loop.mjs --self-test`.
- Independent reviewer, GitHub CI, and Cubic unless quota-exhausted.

## Stop condition

Stop when the PR is merged with a merge commit and
`/Users/yeongyu/local-workspaces/senpi-wt/issue-589-fallback-recovery` is
absent.
