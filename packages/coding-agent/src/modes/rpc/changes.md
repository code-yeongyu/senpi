# changes

## Model-fallback event pass-through (2026-07-20)

### What changed

- `test/suite/rpc-fallback-events.test.ts` verifies that a faux-provider fallback run sends
  `retry_fallback_applied`, `retry_fallback_succeeded`, and `retry_fallback_exhausted` as LF-delimited RPC JSONL events.

### Why

- RPC forwards complete `AgentSessionEvent` payloads without an event whitelist; this test preserves that contract as
  model-fallback lifecycle events evolve.

### Expected merge conflict zones on next upstream sync

- LOW: test-only coverage of the existing connection-handler event subscription.

Fork tracker for `src/modes/rpc/` — this directory exists upstream, so every
fork change here is a merge-conflict surface on upstream syncs.

## System-prompt options threaded through NeoRuntimeOptions (2026-07-18)

### What changed

- `neo-runtime-options.ts`: `NeoRuntimeOptions` gained `systemPrompt` /
  `appendSystemPrompt`, both added to `NEO_RUNTIME_OPTION_SOURCE_FIELDS` so the
  extraction test covers them.
- `neo-runtime-options-argv.ts`: the daemon re-emits them as `--system-prompt`
  and repeated `--append-system-prompt` in the per-connection worker argv.
- Go mirror: `packages/neo/internal/bridge/runtimeopts.go` gained the matching
  payload fields and `--system-prompt` / `--append-system-prompt` parse entries.

### Why

- `main.ts` consumes `parsed.systemPrompt` / `parsed.appendSystemPrompt` in the
  runtime-construction path (`resourceLoaderOptions`); without handshake fields a
  neo client silently lost both flags when going through the shared daemon.

### Why extension system couldn't handle this

- The handshake payload and daemon worker argv are fork protocol surfaces, not
  extension hooks.

### Expected merge conflict zones on next upstream sync

- LOW: all touched modules are fork-only.

## Auth RPC commands and capability-gated custom-UI notice (2026-07-06)

### What changed

- `rpc-mode.ts` / `rpc-types.ts`: added additive RPC commands for the neo
  login/logout UI — `get_auth_providers`, `login_start`, `login_cancel`,
  `login_api_key`, `logout`. Login completion is delivered via events only
  (`auth_login_url`, `auth_login_end`): `login_start` responds
  `success: true` immediately because the 30s request timeout cannot span an
  interactive OAuth round-trip.
- Third-party `ctx.ui.custom` gained an additive, capability-gated
  `extension_ui_request` notice: only clients that advertised the
  `custom_unsupported` capability receive it; default RPC clients see
  byte-identical behavior.

### Why

- The neo Go TUI drives login/logout over RPC and needs the provider list,
  OAuth URL delivery, and terminal results without holding a request open.

### Why extension system couldn't handle this

- RPC command dispatch and the wire protocol live in the built-in RPC mode;
  extensions cannot add RPC commands or events.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `rpc-mode.ts` command dispatch and event emission.
- LOW: `rpc-types.ts` around the added command/event unions.

## Neo daemon serving (2026-07-06)

### What changed

- `rpc-mode.ts`: command handling was extracted into `connection-handler.ts`
  (injected output sink, no stdout takeover or process signal coupling).
  Classic `--mode rpc` stdio behavior is unchanged.
- Fork-only daemon modules: `neo-daemon-mode.ts` (supervisor that binds the
  unix socket first — bind is the spawn-race mutex — and serves one child RPC
  worker process per connection), `neo-daemon-child-worker.ts`,
  `neo-daemon-protocol.ts` (hello/welcome/refuse token+version handshake
  carrying typed `NeoRuntimeOptions`), `neo-daemon-registry.ts` (atomic
  temp+rename self-registration under `~/.senpi/agent/neo-daemon/`, 0600,
  stale pid/socket cleanup), `neo-runtime-options.ts` /
  `neo-runtime-options-argv.ts`, and `custom-capability.ts`. Launch-side
  plumbing lives in `cli/neo/` (see `cli/changes.md`).

### Why

- The shared neo daemon needs N concurrent RPC runtimes; two process-global
  blockers (pi-ai's global provider registry resets, pi-agent-core's
  module-level UUIDv7 counter) make in-process multi-runtime unsafe, so each
  connection gets an isolated worker process (see `docs/neo.md`).

### Why extension system couldn't handle this

- Mode entrypoints, stdout ownership, and process lifecycle are core mode
  plumbing outside extension reach.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `rpc-mode.ts` around the extracted connection handler seam.
- LOW: `connection-handler.ts` and `neo-daemon-*.ts` (fork-only files).

## RPC event write coalescing and output hot paths (2026-06-13)

### What changed

- `event-output-buffer.ts` (fork-only): same-tick RPC events are coalesced
  into a single stdout write.
- `rpc-mode.ts` / `jsonl.ts`: event emission routes through the buffer and the
  JSONL hot path avoids redundant work per event.

### Why

- High-frequency streaming events caused one syscall per event; batching
  same-tick events measurably reduces output overhead (see
  `bench/rpc-event-emit.ts`).

### Why extension system couldn't handle this

- Wire output buffering is internal to the RPC mode's event loop.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `rpc-mode.ts` event emission sites.
- LOW: `jsonl.ts` write helpers; `event-output-buffer.ts` is fork-only.

## Supported thinking levels and turn-scoped thinking controls (2026-07-22)

### What changed

- `get_available_models` now decorates every model with the core-authoritative `supportedThinkingLevels` list.
- RPC `prompt` accepts `thinkingLevel` for immediate prompts and rejects queued level changes before queue mutation.
- `set_thinking_level` accepts `scope: "turn"` for a session-only setting and returns an error unless the effective level exactly matches the request.
- RPC contracts expose the `thinking_level_changed` event and the TypeScript client preserves model capability data when available.

### Why extension system couldn't handle this

- JSONL RPC command parsing, response assembly, and session event forwarding happen below the extension API.

### Expected merge conflict zones

- MEDIUM: `connection-handler.ts` command dispatch and `rpc-types.ts` response unions.
- LOW: `rpc-client.ts` model metadata and `docs/rpc.md` protocol reference.
