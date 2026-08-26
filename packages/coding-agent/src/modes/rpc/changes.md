# changes

## Suppress initial command-surface invalidation events (2026-08-17)

### What changed

- RPC records the initial ordered command digest without publishing `commands_changed`.
- Later distinct command snapshots still publish once, while identical reload snapshots remain deduplicated.
- Focused coverage distinguishes baseline initialization from an actual post-bind command-surface change.

### Why

- Discovery sessions already fetch their initial command surface with `get_commands`. Treating that baseline as an
  invalidation made clients refresh provider discovery, whose new sessions emitted another baseline invalidation and
  created an unbounded refresh loop.

### Why extension system couldn't handle this

- Baseline establishment and JSONL event emission are owned by the built-in RPC transport.

### Expected merge conflict zones

- LOW: `rpc-command-surface.ts` initial-digest guard and its focused regression.

## Publish typed command surfaces and invocation events without disturbing MCP inventory (2026-08-16) ([PR #909](https://github.com/code-yeongyu/senpi/pull/909))

### What changed

- RPC exports self-describing `RpcSlashCommand` rows with canonical `syntax`, pushes ordered `commands_changed`
  snapshots after initial bind and runtime reloads, and publishes typed `command_invocation` metadata only after the
  session actually resolves an extension command or an accepted prompt template survives extension input interception.
- RPC continues to export `RpcSkillInvocationEvent` with ordered `{name,path,syntax}` entries.
- The classic and routed connection handler explicitly type-checks `skill_invocation` and `command_invocation` before
  forwarding them through the existing event buffer.
- Prompt, steer, and follow-up text fields reject inputs above one million characters before session dispatch.
- Classic and multi-session hosts reject valid non-object JSON with parse-style responses instead of dereferencing it
  as a command, and both enforce a 16 MiB JSONL record ceiling that discards one oversized record through LF before
  resuming framing.
- Regression coverage proves candidate ordering, update deduplication, post-interception command classification,
  bounded text and record handling, malformed-command rejection, JSONL resynchronization, and skill event delivery
  while `get_loaded_surfaces` keeps the same revealed MCP inventory before and after invocation.

### Why

- OmO Desktop can render and refresh the same mixed command/skill picker without terminal parsing or command-surface
  polling, and can observe accepted command or skill invocations as typed metadata.
- Skill expansion must remain orthogonal to MCP inventory reveal; a new event cannot reset or reorder loaded
  surfaces.

### Why extension system couldn't handle this

- The public JSONL event contract and loaded-surface inventory response are owned by the built-in RPC transport.

### Expected merge conflict zones

- LOW: additive event types in `rpc-types.ts`, `rpc-command-surface.ts`, and `rpc-command-invocation.ts`.
- MEDIUM: `connection-handler.ts`, `rpc-mode.ts`, `multi-session-host.ts`, `rpc-input-validation.ts`, and `jsonl.ts`
  own command-surface invalidation, input/framing bounds, and typed event forwarding.
- LOW: focused RPC contract tests plus `rpc-loaded-surfaces.test.ts` inventory assertions.

## Settings source selection event (2026-08-16)

### What changed

- Classic and multi-session RPC now receive the additive `settings_source_selected` session event with `{ path, format, reason, scope }` at startup/rebind and after settings reload selection.
- The public RPC type surface documents the event; existing session forwarding and routing remain unchanged.

### Why

- Headless clients need to know whether JSONC won precedence and which path subsequent settings writes target.

### Why the extension system could not handle this

- The source is selected before extension binding, while RPC framing/routing is host-owned.

### Expected merge conflict zones

- LOW: additive event typing in `rpc-types.ts`; event forwarding uses the existing unfiltered session subscription.

## Model/tier events, fast-mode commands, and turn-scope validation (2026-08-16)

### What changed

- Additive events `model_changed` (model + post-switch thinking level + source) and `service_tier_changed` (tier + fastMode) reach clients through the existing session subscription; no event is reshaped.
- `RpcSessionState` gained `serviceTier?` and `fastMode`, so `get_state` no longer hides which tier a request would carry.
- `get_state` and `open_session` now project state through one exported `buildRpcSessionState(session)`. They were two hand-rolled literals, and only the `get_state` one was type-annotated, so `open_session` silently answered without the new fields.
- New commands `set_fast_mode` / `get_fast_mode` delegate to `applyFastMode` from the service-tier extension module — the same entry point the `/fast` command uses, so persistence and `-fast` key normalization exist once.
- `scope: "turn"` `set_thinking_level` now validates the level against `getAvailableThinkingLevels()` BEFORE applying it. Previously it applied first and reported the mismatch afterwards, so a rejected request left the session on the clamped level.
- `RpcClient` gained `setFastMode`/`getFastMode`, and `setThinkingLevel` accepts `{ scope: "turn" }` and now throws on a failed response instead of swallowing it.

### Why

- Clients had no way to observe model or tier changes: model tracking was inferred from `entry_appended`, and fast mode was invisible to the protocol even though it changes what is sent upstream.
- A command that answers `success: false` after mutating state is unusable for state reconciliation — the client's retry/rollback logic cannot know what actually happened.

### Why extension system couldn't handle this

- The command union, `RpcSessionState`, and the event projection are transport contracts owned by the RPC mode; extensions cannot add commands or state fields to them.

### Expected merge conflict zones

- LOW: additive union arms in `rpc-types.ts` and additive `case` arms in `connection-handler.ts`.
- LOW: the `set_thinking_level` case body is rewritten in place (validate-then-apply).
- LOW: `session-command-router.ts` `open_session` now calls the shared state builder instead of inlining the literal. Session test doubles must answer `isFastModeActive()`.

## Pin classic RPC delta batching and immediate barriers (2026-08-14)

### What changed

- Characterization coverage now proves 1000 classic delta-only `message_update` records remain complete while sharing one same-tick raw write.
- Event, extension-UI request, event, and response ordering is pinned across consecutive immediate-write barriers.
- Classic connection-handler backpressure remains deliberately attached to every agent-loop event.

### Why

- Classic RPC projects cumulative assistant updates into delta-only public wire records. Those deltas cannot be compacted safely, so per-event backpressure is its flow control and must not be removed as part of the multi-session writer redesign.
- `RpcClient` consumers depend on the documented delta sequence and on immediate UI/response records never overtaking pending events.

### Why extension system couldn't handle this

- Classic JSONL projection, batching, and agent-loop backpressure are built-in RPC transport contracts below extension hooks.

### Expected merge conflict zones

- LOW: characterization-only additions in `rpc-event-coalescing.test.ts`.
- NONE: classic runtime code remains unchanged.

## Single-flight multi-session RPC drain and control lane (2026-08-14)

### What changed

- The multi-session writer now hands exactly one complete record to stdout, awaits backpressure, and then selects the next ready session in round-robin order.
- Untagged host responses use a dedicated non-coalescing control lane, and shutdown waits for all retained and in-flight records before flushing raw stdout.
- Deterministic buffered-record/byte counters include the in-flight record, control enqueues resolve after their own backpressure boundary, and permanent stdout failures reject the active drain and pending control completions.

### Why

- Direct host response writes could bypass session ordering, while synchronous queue draining still fed an unbounded downstream promise chain during stdout stalls.
- Keeping the backlog in typed lanes lets per-session compaction remain effective and prevents one busy session from monopolizing the raw writer.

### Why extension system couldn't handle this

- Process-wide stdout ownership, host control responses, session fairness, and shutdown flushing are built-in RPC transport responsibilities.

### Expected merge conflict zones

- HIGH: `session-event-writer.ts` drain lifecycle and constructor contract.
- MEDIUM: `multi-session-host.ts` output and shutdown wiring.
- LOW: deterministic multi-session drain tests.

## Compact cumulative multi-session RPC events per session (2026-08-14)

### What changed

- Multi-session RPC queues now retain structured records until drain time and compact cumulative assistant snapshots within each session and ordering segment.
- Superseded full snapshots keep their delta while replacing cumulative `message` and `partial` fields with present `null` values; adjacent compatible deltas merge, and the newest update remains the sole full snapshot.
- Tool progress is latest-wins per tool-call id, with retained updates appended in occurrence order. Protocol, lifecycle, error, delta-only, and unknown records remain barriers and are never coalesced.

### Why

- Long cumulative assistant snapshots produced quadratic queued bytes when a desktop RPC reader stalled, causing visible freezes followed by large output bursts.
- Delta content and transition boundaries must remain lossless, while repeated cumulative snapshots and accumulated tool progress are redundant before they reach stdout.

### Why extension system couldn't handle this

- Session tagging, JSONL framing, and pending stdout scheduling are owned by the built-in multi-session RPC transport below extension hooks.

### Expected merge conflict zones

- MEDIUM: `session-event-writer.ts` queue representation, compaction keys, and drain serialization.
- LOW: focused multi-session event-writer tests.

## Extension request RPC command (2026-08-12)

### What changed

- Added the session-scoped `extension_request` command and structured success/error response.
- `RpcClient.requestExtension()` exposes the command through the public client.
- Existing multi-session routing tags the response with the owning `sessionId`.

### Why

- Capability-gated `extension_event` records cover extension-to-client state, but interactive
  extension controls also need a direct client-to-extension request path that does not become a
  model prompt.

### Why extension system couldn't handle this

- Request ids, multi-session routing, JSONL response serialization, and public client correlation
  are owned by the built-in RPC transport.

### Expected merge conflict zones

- MEDIUM: `rpc-types.ts`, `connection-handler.ts`, and `rpc-client.ts`.

## Multi-session open failure details (2026-08-07)

### What changed

- Multi-session `open_session` failures retain the typed `open_failed` registry code while returning the underlying
  error message on the wire as `open_failed: <reason>` when one is available.
- All other stable RPC error codes remain exact strings without detail suffixes.

### Why

- The registry rollback path discarded the runtime/session construction error, leaving RPC clients with a bare
  `open_failed` response that did not identify invalid workspace directories or other actionable causes.

### Why extension system couldn't handle this

- Multi-session lifecycle errors and JSONL response serialization are owned by the built-in RPC transport and are not
  exposed through extension hooks.

### Expected merge conflict zones

- LOW: `session-registry.ts` error construction and `session-command-router.ts` registry-error serialization.

## high_reasoning_warning RPC event (2026-07-30)

- New `RpcHighReasoningWarningEvent` contract (`{ type: "high_reasoning_warning"; modelId; provider; thinkingLevel }`), auto-published to RPC stdout via the existing `session.subscribe -> outputEvent` seam. No new wiring; the event is a session event forwarded like `thinking_level_changed`.

## Credential-header auth status sources (2026-07-29)

### What changed

- `rpc-types.ts` mirrors the new `models_json_headers` and `extension_headers` auth-status sources emitted by the
  model runtime. `get_auth_providers` can now distinguish static header credentials from API-key values without
  exposing any credential material.

### Why

- The RPC status type must remain structurally identical to the core auth status returned by
  `getProviderAuthStatus()`; otherwise header-auth providers type-check in core but fail response assembly.

### Expected merge conflict zones

- LOW: additive string literals in `RpcAuthStatus.source`.

## Claude Agent SDK provider-account RPC events (2026-07-27)

### What changed

- Added additive `get_provider_accounts`, `account_pin`, and `account_remove` commands. Account payloads expose only slot name, source, blocked state, and pin state; credential material never crosses RPC.
- Added `auth_accounts_changed` and `account_failover` events. The failover engine remains UI-free and reports through its callback seam; the RPC connection subscribes to the provider-account event bus.
- The app-server mirrors the surface with `account/providerAccounts/read`, `/pin`, and `/remove`, plus `account/providerAccounts/updated` and `/failover` notifications. These Senpi additions intentionally remain separate from the pinned Codex method catalog.

### Why

- The desktop app needs account-pool state and automatic failover visibility without reading auth storage or receiving subscription tokens.

### Why extension system couldn't handle this

- JSONL RPC command dispatch and app-server protocol registration are mode-owned transport surfaces. The desktop consumer contract at `../omo-desktop-app/packages/contracts/src/rpc.ts` is updated separately.

### Expected merge conflict zones

- MEDIUM: `connection-handler.ts` command dispatch and event subscriptions.
- LOW: app-server account handlers and protocol facade additions.


## Removed legacy `--neo` daemon support while preserving RPC contracts (2026-07-26)

### What changed

- Removed the legacy daemon, protocol, registry, child-worker, and runtime-option modules.
- Retained the standard RPC connection handler and capability contract, with generic authentication and JSONL framing coverage migrated into the kept suite.

### Why

- The supported RPC surface is the standard `--mode rpc` host, not the retired Go TUI daemon.

### Expected merge conflict zones on next upstream sync

- LOW: removal-only changes beside retained RPC infrastructure.

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

## Capability-gated extension events reach classic and multi-session clients (2026-08-11)

RPC clients advertising `extension_events` now receive additive
`extension_event { name, data }` records. Unflagged clients remain byte-identical. Multi-session mode
parses `SENPI_RPC_CLIENT_CAPABILITIES`, threads capabilities through `SessionCommandRouter` and
`createRpcSessionBinding`, and preserves the owning routing `sessionId` on emitted records.

## Session-start extension events are subscribed before binding (2026-08-11)

Capability-gated extension RPC listeners now attach before `bindExtensions()` dispatches
`session_start`. This preserves initial atomic extension snapshots such as native task state while
keeping rebind cleanup generation-safe; subscribing after binding deterministically dropped those
events.
## Public RPC client exposes extension events (2026-08-11)

`RpcClientEvent`, `RpcEventListener`, the modes barrel, and the package root now include
`RpcExtensionEvent`, so capability-enabled SDK consumers can narrow and validate generic extension
records. The extension and RPC guides document `pi.rpc.emit`, capability environment variables, the
wire shape, multi-session tagging, and payload validation responsibilities.

## 2026-08-25 - Preserve upstream RPC public queue API

### What changed

- `packages/coding-agent/src/modes/rpc/rpc-client.ts` and `packages/coding-agent/src/modes/rpc/rpc-types.ts` expose upstream queue-clearing commands while retaining fork RPC protocol structure.

### Why

- RPC command and response unions are a consumer-facing wire contract.

### Why this lives in the fork

- The RPC protocol is defined at the coding-agent public boundary.

### Expected merge conflict zones

- RPC command unions, response unions, and client methods.
