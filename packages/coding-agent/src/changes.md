## Experimental `--grok-neo` mode: env-gated grok chrome for the interactive loop (2026-07-26)

### What changed

- New opt-in flag `--grok-neo` (`src/cli/args.ts`, gate `src/cli/grok-neo-gate.ts`): `SENPI_ENABLE_GROK_NEO` accepts `1`/`true`/`yes`, default OFF. When the gate is off the flag is absent from `--help` and parses as an unknown extension flag, exactly as if the feature did not exist. When on, it runs the ordinary interactive mode with the grok chrome (`chrome: "grok"` dispatch in `main.ts`) — same senpi process, no separate binary or daemon.
- New built-in themes `grok-night` and `grok-day` (`src/modes/interactive/theme/grok-night.json` / `grok-day.json`, registered in `getBuiltinThemes()` in `src/modes/interactive/theme/theme.ts`). Precedence: an existing settings theme always wins; `grok-night` is only an in-memory fallback when no theme was ever chosen (`applyGrokNeoThemeFallback` in `main.ts`) and is never written to `settings.json`. `--theme` registers theme resources; it does not select one.
- Chrome components under `src/modes/interactive/grok/`: rounded input card, compact footer (model + cwd only), welcome card, single-line tool rows with a `┃`/`◆` guide column, braille working indicator, and a palette/chrome-token layer that resolves colour through the active theme.
- User docs: `docs/grok-neo.md` (mode, gate, themes, in-process architecture, experimental status, independent-reimplementation and non-affiliation statement) plus a `docs/docs.json` navigation entry.

### Why

- Replaces the removed out-of-process Go TUI with an in-process presentation layer: one process and one deployable directory for the Bun binary (native addons ship as sidecars), with the classic TUI unchanged as the default.

### Expected merge conflict zones on next upstream sync

- LOW: additive seams only — the gate module, one conditional branch each in `args.ts` parse/help, the theme-fallback and `chrome` dispatch lines in `main.ts`, and the `grok-night`/`grok-day` registration in `theme.ts`.

## Extension user-message injections are retained when the prompt path rejects (2026-07-26)

- `core/agent-session.ts`: `sendUserMessage()` now tracks the prompt disposition. When `prompt()` rejects before the message reaches a queue or a turn (e.g. a required compaction that cannot complete, auth/model validation, or provider admission), the message is queued for later delivery (`deliverAs: "steer"` goes to the steering queue, otherwise the followUp queue) instead of being silently dropped. The rejection still propagates, so fire-and-forget extension bindings keep emitting their `send_user_message` error event.
- Root cause of the omo `team_wait` starvation forensics: member self-poller injections via `pi.sendUserMessage(..., { deliverAs: "followUp" })` vanished without a trace when the fresh-prompt path threw, leaving no record in the session JSONL while RPC-path `steer`/`follow_up` commands (which bypass `prompt()`) landed normally.
- Interactive `prompt()` behavior is unchanged: a rejected interactive prompt still drops the input and surfaces the error to the user (pinned by `test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`).
- Coverage: `test/suite/agent-session-extension-injection.test.ts` pins retention for followUp and steer injections, exact-once delivery after recovery through the post-run drain, and no double-queueing on the streaming accept path.

## Reload-safe MCP preservation and extension-removal lifecycle event (2026-07-26)

- `session_extensions_removed` is emitted on the old extension runner when a `/reload` or a session replacement (`/new`, `/resume`, `/fork`, import) rebuilds the extension set. Its payload is `{ type: "session_extensions_removed", reason: SessionShutdownEvent["reason"], removed: Array<{ path, resolvedPath }> }`, allowing an extension that did not survive the rebuild to release resources after the new settings and active builtin set are known.
- Unchanged MCP servers now survive a classic `/reload`: the shared service reattaches and reconciles by config hash, preserving live connections while replacing changed servers and disposing removed ones. Provider-scoped MCP services still dispose on reload because their factory creates a replacement instance.
- If the MCP builtin itself is disabled during a reload or replacement, its removal event disposes the preserved classic service so stdio children cannot leak. For an otherwise wedged server, use `/mcp reconnect <name>` to force a fresh connection.

## Same-model-first transient retries and capped server waits (2026-07-26)

### What changed

- Supersedes the 2026-07-20 entry's sentence "retryable transient failures now switch to a configured fallback ...": transient retryable failures (timeouts, overload, 429, 5xx, transport drops) now retry the same model on the existing exponential backoff until `retry.maxRetries` is spent; only then does the configured `retry.fallbackChains` chain engage, and each fallback candidate starts with a fresh retry budget.
- `core/agent-session.ts`: `retry.provider.maxRetryDelayMs` (default 60000) now bounds the server-requested wait honored on the same model. Beyond the cap the fallback chain engages and the primary is suppressed for the requested duration; the turn fails with an informative error only when no chain candidate is available. Waits at or below the cap are honored as before.
- `core/retry-fallback/cooldown.ts`: timeout and connection/transport errors now carry a 60-second selector cooldown instead of the five-minute unmatched default, so revert-to-primary is no longer blocked for five minutes after one network blip. Existing tiers keep precedence: quota/billing 30 minutes, rate-limit 30 seconds, capacity 45 seconds plus jitter, 5xx 20 seconds, and a provider retry-after hint always wins.
- Unchanged: classifier-refusal fallback (immediate, pinned), hard-error fallback (quota/auth/model-not-found, immediate), and `retry.abortServerSideFallback` (default true) routing provider-side model substitution onto the configured chain.
- Cost/latency: with `retry.maxRetries >= 1` a fully failing chain now costs up to `1 + (chainLength + 1) * maxRetries` provider calls plus per-rung backoff before the turn fails; with `maxRetries: 0` every failure switches immediately, costing `1 + chainLength` calls.
## OMO local plugin remote-diff updater beta on bare `senpi update` (2026-07-26)

- A bare `senpi update` now triggers the beta OMO local-update hook (`src/beta/omo-local-update.ts`, reachable only through the two BETA-marked touch points in `package-manager-cli.ts`) before any self-update work. The hook compares the state of the two packages (`omo-senpi` + `senpi-task`) on `origin/dev` of the OMO source checkout against the locally installed modules, and updates the local install ONLY when they differ.
- The user's checkout receives ZERO git mutations: the hook performs one read-only `git fetch origin dev`, builds in a feature-owned persistent worktree under the agent directory, and atomically swaps the installed plugin directory by rename. No checkout/branch/commit/merge/reset/clean/stash/push ever touches the user's tree.
- `SENPI_OMO_LOCAL_UPDATE=0` is a kill-switch that disables the hook entirely. All failures are non-fatal: the hook never throws and never sets `process.exitCode`; any error downgrades to a warning plus a manual-update hint so the `senpi` self-update proceeds untouched.
- Removal is exactly three steps: delete `src/beta/omo-local-update.ts`; delete all `test/omo-local-update*` files; delete the two BETA-marked touch points (the import and the hook call) in `package-manager-cli.ts`.

## App-server daemon launch diagnostics and hermetic lifecycle coverage (2026-07-24)

- The daemon launcher now classifies websocket listener occupancy before spawn: a compatible app-server answers `initialize` and attaches, while any other TCP listener fails immediately with an `EADDRINUSE` diagnostic instead of consuming the child readiness budget. Child-process startup stderr still accompanies actual post-spawn failures, and each launch replaces stale diagnostics.
- The real-CLI daemon lifecycle test isolates home/XDG state, verifies the pre-spawn occupied-port diagnostic and that it does not create a child stderr log, retries the bounded QA port pool, and awaits lock/process events rather than polling sleeps.

## Manual compaction keeps agent lifecycle subscription through abort (2026-07-24)

- `core/agent-session.ts`: manual or extension-initiated compaction claims its synchronous admission/barrier first,
  then aborts and waits for the active agent run while still subscribed. The abort's `agent_end` now clears the
  active-run and retry state before compaction disconnects for summary generation; all disconnected exits reconnect.
- Regression: `test/suite/compaction-race.test.ts` covers compaction during a live provider stream and asserts the
  aborted `agent_end` precedes compaction startup without deadlocking future prompts.

# changes

## Removed the legacy `--neo` Go TUI surface (2026-07-26)

### What changed

- Removed the Go TUI launcher, daemon dispatch, CLI flags, settings, documentation, build gate, and the retired Go package. The classic interactive and `--mode rpc` paths remain unchanged.
- Migrated generic RPC authentication and connection-handler framing coverage into `test/suite/rpc-auth-and-connection-handler.test.ts` before deleting the legacy-specific suites.

### Why

- The legacy out-of-process TUI and its daemon are no longer part of the supported CLI surface.

### Expected merge conflict zones on next upstream sync

- LOW: removal-only changes across fork-owned legacy surfaces.

## Inspector handoff and VM-import crash isolation (2026-07-24)

### What changed

- The launcher closes an inherited startup Inspector endpoint immediately before spawning `cli-main`, allowing the
  child process to bind the same configured endpoint instead of failing with `address already in use`.
- With `SENPI_RECOVER_INSPECTOR_VM_IMPORT=1` set at process start, interactive mode recovers only the exact unhandled
  Inspector-eval rejection produced when `import()` runs without a VM dynamic-import callback. Recovery is fail-closed
  by default; application-owned VM failures and unrelated uncaught exceptions remain fatal.

### Why

- The launcher and child previously inherited one fixed Inspector port, so developers attached to the wrapper rather
  than the TUI process. Running asynchronous `import()` in Node's Inspector VM then terminated the attached process.
  Node exposes no non-spoofable Inspector provenance on the global exception, so continuing requires an explicit
  developer opt-in rather than weakening the default fatal boundary.

### Why extension system couldn't handle this

- Inspector ownership is decided before extensions load, and process-wide uncaught-exception handling belongs to the
  host's terminal-restoration boundary.

### Expected merge conflict zones

- LOW: `cli.ts` immediately before the `cli-main` spawn.
- LOW: `modes/interactive/interactive-mode.ts` uncaught-exception handler.

## Reload measurement and redundant-work removal (2026-07-26)

- `/reload` records a `reload` timing namespace with one marker per phase
  (`shutdown`, `settings`, `models`, `resources`, `runtime`, `chatRebuild`,
  `lifecycle`). With `PI_TIMING=1` the breakdown is appended to the reload
  status line; with it unset nothing is recorded.
- Settings are read once per reload instead of twice.
  `ResourceLoaderReloadOptions.settingsAlreadyReloadedFor` takes the
  `SettingsManager` the caller just reloaded, and the loader skips its own
  reload only when that is the very manager it owns AND project trust is not
  being resolved, so trust-scoped values can never go stale.
- `ModelRuntime.reloadConfig()` delegates to `refresh()` instead of repeating
  the config load and provider rebuild that `refresh()` performs immediately
  afterwards.
- Both model-scope resolutions read the snapshot the reload refresh just
  produced rather than each triggering another availability scan (3 scans -> 1).
  The snapshot is trusted only via `hasFreshAvailabilitySnapshot()`; a failed
  refresh falls back to the runtime so scan errors still surface.
- `scripts/bench-reload.mjs` measures `DefaultResourceLoader.reload()` from
  source through a subprocess probe (real jiti path), reporting cold-first and
  warm p50/p95 across fresh processes.
## Multi-session RPC mode, session-owned MCP/config-reload state, and back-compat guarantee (2026-07-23)

### What changed

- `src/modes/rpc/`: new `--multi-session` startup flag. `senpi --mode rpc --multi-session`
  constructs NO default session (no default `AgentSessionRuntime`, no default extension/watcher load).
  Mode is fixed at process start; there is no runtime transition. New modules: `session-registry.ts`,
  `session-command-router.ts`, `session-binding.ts`, `multi-session-host.ts` (each ≤250 pure LOC).
- Multi-session wire protocol per the D1 normative table (see `docs/rpc.md` → Multi-session mode, and
  the `rpc-mode.ts` header doc block for the verbatim table): `get_protocol_info` (answered in BOTH
  modes; side-effect-free; THE capability probe), `open_session` / `close_session` / `list_sessions`,
  mandatory `sessionId` routing on session-scoped commands, `sessionId` tagging on all session-owned
  output, stable error codes (`unknown_session`, `session_closing`, `session_path_in_use`,
  `missing_session_id`, `multi_session_disabled`, `invalid_path`, `open_failed: <detail>`), identities
  (D6: response-level `sessionId` = opaque routing handle, ephemeral per process epoch;
  `state.sessionId` = durable JSONL identity), and the D9 ordering guarantee (strict FIFO per session,
  one total stdout order, fair round-robin between sessions' queued complete records, NO cross-session
  batch coalescing, starvation freedom NOT promised).
- `src/core/extensions/builtin/mcp/` and `src/core/extensions/builtin/config-reload/`: in multi-session
  mode each session OWNS its MCP service instance (extension factory closes over it; helpers take the
  instance, never call the `getMcpService()` global getter), its elicitation/instructions/prompts state,
  and its `reloadHandoff` keyed by the session handle. Classic single-session mode keeps the globals
  (no behavior change).
- Session-owned config-reload state: the fs-watcher reload chain
  (`config-reload/index.ts` → `agent-session.ts:3807` `resetApiProviders()`) is scoped per session via
  the pi-ai provider scope, so reloading session A cannot reset session B's providers.

### Why

- A single shared `senpi --mode rpc --multi-session` process serves all of a provider instance's
  threads concurrently. Cross-session turns run concurrently; per-session turn serialization comes
  from `AgentSession`. Session-scoped state (provider registry, MCP, config-reload) must be owned by
  the session so one conversation can never corrupt another.

### Back-compat guarantee

- Classic single-session mode (`senpi --mode rpc`, no flag) is byte-identical to today. The ONLY
  additive classic-mode behavior is that `get_protocol_info` is answered (side-effect-free). Existing
  RPC tests, the classic-compat characterization pin suite, and the neo-daemon suites stay green
  unchanged.

### Explicit non-goal

- Per-session AuthStorage / multi-tenant key isolation is NOT added inside the shared process. The
  process is single-tenant; tenancy isolation remains the neo daemon's job (per-connection worker
  model). The neo daemon's behavior and its header distrust rationale are unchanged.

### Why extension system couldn't handle this

- Session lifecycle, the multi-session host/router/registry, MCP service ownership, and config-reload
  handoff are protocol and core-runtime infrastructure below the extension boundary.

### Expected merge conflict zones on next upstream sync

- HIGH: `src/modes/rpc/` (new multi-session modules + `rpc-mode.ts`/`connection-handler.ts` seams).
- MEDIUM: `src/core/extensions/builtin/mcp/service.ts` global getter removal on the multi-session path.
- LOW: `src/core/extensions/builtin/config-reload/index.ts` reloadHandoff keying.

## App-server web-search projection and cumulative turn diffs (2026-07-21)

### What changed

- `modes/app-server/threads/`: projects only OpenAI `web_search_call` metadata into the structured Codex `webSearch`
  shape, preserves readable generic provider-native items for other subtypes, and emits subscriber-only
  `turn/diff/updated` notifications rebuilt from per-tool patches in file-change source order.
- `core/tools/` and `core/extensions/builtin/gpt-apply-patch/`: preserve source-backed unified patches for real edit,
  write, multi-file, partial-success, repeated same-path, dependent sequential, and move-only results.
- Non-empty app-server `fileChange` changes use the generated v2 tagged kind shape; moves retain the source path,
  expose the destination in `move_path`, and carry an applicable delete/add-or-update representation.
- `test/suite/` and `test/qa/app-server/`: cover final web-search payload fidelity, concurrent completion ordering, real
  mutation result shapes, per-turn reset, notification envelopes, subscriber routing, and a zero-token source-CLI run.

### Why

- Codex app-server clients render native web-search activity and live file-change previews from these item and
  notification contracts; synthesized fields and missing diffs break that client experience.

### Why extension system couldn't handle this

- Provider-native item projection, turn-scoped diff state, and subscriber notification routing are app-server protocol
  infrastructure below the extension boundary; source patches must be captured by each mutation tool before apply.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/threads/projection*.ts` implementation and its app-server QA fixtures.
- MEDIUM: write/apply_patch result details where source baselines are captured.

## Fuzzy file search one-shot and sessions (2026-07-21)

### What changed

- `modes/app-server/search/`: added bounded deterministic file traversal, subsequence scoring, same-token one-shot
  cancellation, and replaceable query sessions with latest-query update and completion notifications.
- `modes/app-server/runtime.ts` and `server/notifications.ts`: registered the stable one-shot method plus the three
  experimental session methods, routed the two stable session notifications globally, and cancelled outstanding work on
  runtime teardown.
- `test/suite/` and `test/qa/app-server/`: pinned traversal/scoring limits, cancellation and session races, request
  gates, ungated notification fanout, manifest status, and a zero-token source-CLI fixture-tree scenario.

### Why

- Codex clients use fuzzy file search for path completion and rely on cancellation tokens and long-lived sessions to
  avoid stale results while a query changes rapidly.

### Why extension system couldn't handle this

- File-search requests and global app-server notifications are transport-level JSON-RPC behavior below the extension
  boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/search/` implementation and app-server registration/router allowlists.

## Wave 2 app-server parity verifier corrections (2026-07-20)

### What changed

- `modes/app-server/protocol/`: corrected fuzzy-search result keys to Codex's snake-case wire names and completed the
  handwritten thread-item/history facade so runtime modules no longer import generated protocol files directly.
- `modes/app-server/threads/`: made source-kind parsing strict, applied Codex's interactive-session default when search
  source filters are omitted or empty, rejected malformed search `u32`/boolean fields, separated user-activity recency
  from general updates, persisted unarchive timestamp bumps, rejected non-`u32` history limits, preserved every
  projected history-item variant plus completed-turn lifecycle data, read cold history without loading the thread,
  deferred compact work and `item/started` until after the RPC acknowledgement, and recorded rejected compactions as
  failed without fabricating a completed item.
- `modes/app-server/server/models.ts`: validates `remoteControl/client/list` parameters before returning the honest
  no-remote-control internal error.
- `test/qa/app-server/`: extended the Todo 8–12 drivers for the rejected edge cases and made the compaction fixture
  exercise explicit manual compaction without being preempted by automatic compaction.

### Why

- Independent parity verification found boundary-validation, persistence, timestamp, import-layer, and failure-path
  mismatches that the first wave's happy-path tests did not distinguish from Codex HEAD behavior.

### Why extension system couldn't handle this

- These contracts are JSON-RPC parsing, thread persistence/projection, and app-server lifecycle behavior below the
  extension boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` and app-server QA surfaces. Preserve Codex wire names and re-run the focused
  verifier drivers if upstream session timestamp or compaction behavior changes.

## Codex HEAD app-server catalogs, facade, and terminal envelopes (2026-07-20)

### What changed

- `modes/app-server/protocol/`: aligned method catalogs with the pinned Codex HEAD source, added complete experimental
  notification metadata, and added handwritten facade types for the catalog, config, account, collaboration-mode,
  fuzzy-search, thread-parity, terminal-error, and notification-envelope surfaces selected by the parity plan.
- `modes/app-server/server/connection.ts`, `server/notifications.ts`, `rpc/envelope.ts`, `rpc/ndjson.ts`: gate
  experimental notifications from the shared catalog and populate one `emittedAtMs` timestamp per notification before
  fanout, preserving it through final transport serialization while leaving server requests untouched.
- `modes/app-server/server/server-core.ts`: added post-response deferred actions so later thread handlers can guarantee
  response-before-notification ordering.
- `modes/app-server/threads/turns.ts`, `turn-adapter.ts`, `threads/projection.ts`: replaced the fork-only terminal
  `turn/failed` wire event with Codex HEAD's ordered `error` plus failed `turn/completed` pair, sharing one `TurnError`.
- `modes/app-server/server/models.ts`: moved model catalog runtime typing onto the handwritten facade while retaining the
  existing remote-control behavior for its dedicated follow-up task.

### Why

- Codex's generated TypeScript exporter omits experimental request roots and cannot by itself describe the live HEAD
  catalog. Senpi needs a stable, Node-compatible facade derived from both the pinned source inventory and generated
  evidence.
- Current Codex clients expect populated notification timestamps, capability-aware experimental delivery, and terminal
  failures expressed through the canonical error/completion pair.

### Why extension system couldn't handle this

- Method catalogs, transport envelopes, response-frame ordering, and terminal event projection are app-server protocol
  infrastructure that runs outside the coding-agent extension surface.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` tree. Re-derive catalogs and facade shapes from the new Codex source before
  resolving conflicts; never hand-edit `protocol/generated/**`.

## Parallel side questions via `/btw` (2026-07-21)

### What changed

- New builtin extension `core/extensions/builtin/btw/` adds `/btw <question>`: a read-only side LLM query against a synchronously captured snapshot of the current conversation, running in parallel with any in-flight main turn without writing to session history. Details in `core/extensions/builtin/btw/changes.md`.
- TUI: the answer streams into a dismissable widget above the editor; Escape dismisses the side panel without touching main-turn Escape behavior. Non-TUI modes deliver the answer via `ctx.ui.notify`.
- `core/extensions/builtin/index.ts` registers the extension between `goal` and `mcp`.

### Why

- Asking a question about the ongoing session previously required waiting for the main turn and polluting its context. `/btw` answers immediately, in parallel, and leaves the main session untouched.

## Claude text tool-call recovery (2026-07-20)

### What changed

- `core/model-runtime.ts`: both streaming entry points conditionally wrap prepared provider streams through the side-effect-free AI recovery API, using the original selected model and non-empty tools while keeping provider retries/auth/request preparation underneath a single wrapper.
- `core/model-config.ts` and `core/provider-composer.ts`: custom definitions, built-in overrides, and extension models accept the top-level tri-state `recoverTextToolCalls` boolean without using `compat`.
- Session and agent-loop integration tests prove complete and truncated raw Anthropic/OpenAI SSE recovery, safe non-execution, persisted native history, provider-native next-turn replay, original historical XML preservation, and retry-attempt isolation.
- The isolated senpi-qa mock loop now exposes complete/truncated leak modes for both supported APIs, hashes real auth before/after, and captures cleanup/evidence receipts.

### Why

- Provider-specific middleware cannot enforce the cross-provider persistence, retry, abort, ordering, and execution boundaries required after a model leaks XML as assistant text.

- `core/agent-session.ts` and `core/retry-fallback/controller.ts`: non-retryable provider errors now advance immediately through an eligible fallback chain without replaying the failed model or waiting for backoff. Hard-failing selectors receive the normal session-local cooldown; overflows, aborted responses, refusals, and error responses containing tool calls continue to settle through their existing paths.

- `core/agent-session.ts`: typed classifier refusals now bypass same-model retries and immediately advance through a pinned fallback chain without cooldowns. Switched refusal messages are removed from active context while retained in session history; exhausted chains leave only the final refusal visible.

- `ExtensionContext.sessionSettings` now gives the model-fallback builtin the live session-owned retry settings and retry status; `/fallback` writes are immediately visible to the retry controller, while `--no-model-fallback` and `SENPI_NO_FALLBACK=1` apply a non-persistent session override.

- `core/agent-session.ts` now centralizes active-model switching, preserving manual selection behavior while supporting non-persistent, non-notifying ephemeral fallback switches.
- `core/session-manager.ts` records optional fallback model-change metadata and restores the primary model rather than a fallback-period assistant model after restart.

- `core/retry-fallback/validate.ts`: validate fallback-chain configuration with deterministic warnings.

- `core/retry-fallback/log.ts`: add a bounded, sanitized 0600 NDJSON fallback debug logger.

## Retry fallback settings (2026-07-20)

### What changed

- `core/settings-manager.ts` now persists global per-model retry fallback chains, fallback enablement, and the
  fallback revert policy. Reads provide safe defaults when those optional settings are unset or malformed.
- Project `retry` settings retain the established one-level merge behavior: a project `fallbackChains` map replaces
  the global map rather than merging individual chain keys.

### Why

- Model fallback behavior needs a durable, user-configurable chain without adding another settings file or allowing
  fallback controls to write project settings.


- `core/retry-fallback/chains.ts`: adds pure, canonical selector parsing and fallback-chain resolution.

- `core/retry-fallback/cooldown.ts`: adds per-session, lazy-expiry selector cooldowns with provider retry-after and error-derived durations.

## Accepted compaction resumes the waiting prompt (2026-07-20)

### What changed

- `agent-session.ts`: the pre-prompt fail-closed check now recognizes an assistant response retained behind the latest accepted compaction boundary as historical usage. A prompt waiting on compaction therefore dispatches with compacted history, while cancelled or would-overflow compaction remains blocked before any provider request.
- `agent-session-compaction.test.ts`: added a provider-dispatch regression for irreducibly oversized pre-prompt compaction results.

### Why extension system couldn't handle this

- `AgentSession` owns the compaction boundary, stale usage classification, prompt settlement barrier, and the provider-dispatch decision. Extensions can propose or reject summaries but cannot serialize this state transition.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-session.ts` around `prompt()`, `_checkCompaction()`, and compaction-boundary stale-message checks.

## Model-runtime upstream model id and model-config service tier (2026-07-19)

### What changed

- `core/model-runtime.ts`: `prepareRequest()` now swaps the wire model id to the models.json/extension
  `upstreamModelId`. Previously only the compaction and websearch extensions honored it, so main-loop requests sent
  the configured alias id (e.g. `gpt-5.6-terra-fast`) verbatim and upstreams rejected the unknown model.
- `core/agent-session.ts`: `_currentServiceTier` now falls back to the model's configured `serviceTier` from the
  compatibility request config (models.json / extension model definition) when no scoped/favorite tier is set
  (`_resolveServiceTier`). The builtin service-tier extension then injects `service_tier` into OpenAI Responses
  payloads through `before_provider_request`, so client-configured priority tiers reach the wire.

### Why

- models.json `-fast` pseudo-models declare `upstreamModelId` + `serviceTier: priority` so priority-tier requests are
  client-controlled instead of proxy-side per-model overrides; the main request path must honor them.
  (`extraBody.service_tier` is not a viable channel: it is an OpenAI Responses reserved body key.)

### Why extension system couldn't handle this

- `prepareRequest()` is the core chokepoint every stream/complete call funnels through; extensions cannot rewrite the
  wire model id for the main loop, and the builtin service-tier extension only sees the session tier, which never
  reflected model-level configuration.

### Expected merge conflict zones on next upstream sync

- LOW: `model-runtime.ts` `prepareRequest()` body; `agent-session.ts` service-tier assignment sites.

## Accepted compaction resumes the waiting prompt (2026-07-20)

### What changed

- `agent-session.ts`: the pre-prompt fail-closed check now recognizes an assistant response retained behind the latest accepted compaction boundary as historical usage. A prompt waiting on compaction therefore dispatches with compacted history, while cancelled or would-overflow compaction remains blocked before any provider request.
- `agent-session-compaction.test.ts`: added a provider-dispatch regression for irreducibly oversized pre-prompt compaction results.

### Why extension system couldn't handle this

- `AgentSession` owns the compaction boundary, stale usage classification, prompt settlement barrier, and the provider-dispatch decision. Extensions can propose or reject summaries but cannot serialize this state transition.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-session.ts` around `prompt()`, `_checkCompaction()`, and compaction-boundary stale-message checks.

## Paced streaming tool argument previews (2026-07-20)

### What changed

- `modes/interactive/tool-args-reveal.ts` paces append-only partial JSON independently per tool call, reusing the smooth
  streaming FPS and catch-up policy while batching parser work and preserving UTF-16 surrogate boundaries.
- `modes/interactive/interactive-mode.ts` flushes exact arguments before completion or execution and tears down reveal
  state anywhere pending tool components are cleared.

### Why

- Provider bursts should not make large tool-call previews jump or force a full partial-JSON parse for every timer tick.

### Why extension system couldn't handle this

- Pending tool components and their streaming/execution transition state are private to the built-in interactive mode.

### Expected merge conflict zones on next upstream sync

- MEDIUM: interactive tool-call event handling and smooth-streaming settings callbacks.
- LOW: the fork-only reveal controller.

- MEDIUM: interactive tool-call event handling and smooth-streaming settings callbacks.
- LOW: the fork-only reveal controller.

## Smooth streaming reveal (2026-07-20)

### What changed

- `modes/interactive/streaming-reveal.ts`: adds a grapheme-safe, time-based controller that reveals streamed assistant
  text at a stable perceived rate from 30–120fps, catches up bounded backlogs, and flushes immediately at tool-call and
  lifecycle boundaries.
- `core/settings-manager.ts` and the interactive settings selector persist smooth-streaming enablement and FPS.
- `modes/interactive/interactive-mode.ts` routes assistant deltas through the controller and tears it down on final,
  abort, session-switch, and shutdown paths.

### Why

- Provider chunks often arrive in bursts; rendering each burst verbatim makes otherwise fast responses visually jumpy.

### Why extension system couldn't handle this

- The controller owns private in-flight assistant component updates, TUI render scheduling, and session lifecycle state.

### Expected merge conflict zones on next upstream sync

- MEDIUM: interactive assistant event handling and settings-selector plumbing.
- LOW: the fork-only reveal controller and settings accessors.

## Incremental assistant message re-render (2026-07-19)

### What changed

- `modes/interactive/components/assistant-message.ts`: assistant content is now planned as flat render descriptors
  and reconciled against the previous child list. Unchanged children stay mounted, growing text/thinking Markdown
  updates through `Markdown.setText()`, and structural changes rebuild only the divergent suffix.
- `../test/assistant-message-incremental-render.test.ts`: exact raw-render parity covers text, thinking,
  provider-native blocks, error tails, hidden thinking, expansion, and output padding; identity assertions pin the
  incremental reuse contract.

### Why

- Streaming updates previously cleared the entire content container, so every delta recreated all Markdown children
  and discarded their instance render caches even when only the final block grew.

### Why extension system couldn't handle this

- The built-in assistant component owns transcript child identity, disposal, render caching, and OSC marker behavior;
  extensions cannot reconcile its private render tree.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `modes/interactive/components/assistant-message.ts` around content construction and streaming cache reuse.

## Neo launch handoff and daemon dispatch (2026-07-06)

### What changed

- `main.ts`: `--neo` / `--neo-isolated` (+ hidden `--neo-bin`) dispatch to the neo Go TUI launcher (`cli/neo/`),
  spawning the per-platform binary with inherited stdio, forwarded signals, and propagated exit code/signal. Dispatch
  sits after the version/export fast-paths and first-time setup, before any `AgentSessionRuntime` construction or
  extension loading, so the launcher stays thin.
- `main.ts`: `--listen <path>` dispatches to the neo daemon supervisor (see `modes/rpc/changes.md` 2026-07-06). The
  `NeoRuntimeOptions` field list is gated by a generated extraction test over `main.ts` `parsed.*` reads, so new
  runtime-relevant flags fail the test until threaded through.

### Why

- The neo TUI is a separate Go binary; senpi remains the single user-facing entrypoint and must hand off cleanly.

### Why extension system couldn't handle this

- Mode dispatch happens in `main()` before extensions load.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` mode-dispatch ordering around startup fast-paths.

## App-server mode dispatch (2026-07-02)

### What changed

- `main.ts`: added dispatch for the fork's `senpi app-server` subcommand into `modes/app-server/` (transports,
  daemon supervision, thread lifecycle), hardened on 2026-07-03 with review fixes (entrypoint split, archive-state
  handling). Arg plumbing is in `cli/changes.md`; the mode directory itself does not exist upstream.

### Why

- Codex-compatible app-server clients need a first-class mode entrypoint next to interactive/print/rpc.

### Why extension system couldn't handle this

- Modes are dispatched from `main()` before extension loading; a wire-protocol server cannot be an extension.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` around mode selection and subcommand routing.

## Public model resolution SDK exports (2026-07-02)

### What changed

- `index.ts`: accepted upstream exports for CLI-equivalent model and scoped-model resolution helpers.
- Documentation and examples were updated to describe extension entry renderers and the public SDK surface.

### Why

- External integrations need the same model-resolution behavior the CLI uses without duplicating internal resolver logic.

### Why extension system couldn't handle this

- Public package exports and SDK documentation are package API surfaces. Extensions can consume the exported helpers after
  load, but they cannot publish or document the root module exports themselves.

### Expected merge conflict zones on next upstream sync

- LOW: `index.ts` export list if upstream changes public SDK exports.
- LOW: docs/examples around extension entry renderer examples and model-resolution helper documentation.

## Nested legacy config migration (2026-07-01)

### What changed

- `migrations.ts`: split legacy directory and extension-system migrations into focused modules.
- `legacy-senpi-dir-migration.ts`: migrates missing files from nested legacy `~/.senpi/.pi/agent` and `~/.senpi/.pi/mom` directories into the current senpi config layout without overwriting existing files.

### Why

- Some pre-rename local configs ended up under nested `~/.senpi/.pi/agent`, so a fresh `~/.senpi/agent` could strand custom `models.json` entries such as ccapi-routed Anthropic models.

### Expected merge conflict zones on next upstream sync

- LOW: startup migration orchestration in `migrations.ts`.

## shared provider-native rendering in text output (2026-05-14)

### What changed

- `modes/provider-native-rendering.ts`: added shared provider-native formatting for Anthropic, OpenAI, and Google native web-search metadata, with a generic JSON fallback for unknown provider-native blocks.
- `modes/print-mode.ts`: text print mode now emits provider-native summaries and bodies through the shared formatter instead of silently skipping provider-native content.

### Why

- Native web-search metadata should be readable outside the interactive TUI as well, and the compact rendering rules should stay consistent between interactive and print surfaces.

### Why extension system couldn't handle this

- Print mode emits assistant content directly after the session finishes; extension tool renderers do not own provider-native assistant content.

### Expected merge conflict zones on next upstream sync

- LOW: `modes/print-mode.ts` final assistant-content emission and `modes/provider-native-rendering.ts` if upstream adds its own provider-native formatter.

## CLI export tilde expansion (2026-05-13)

### What changed

- `main.ts`: `senpi --export ~/session.jsonl ~/out.html` expands leading `~` for both the input session path and optional output path before exporting.

### Why

- The interactive `/export` bug also affected the non-interactive export path because Node's path resolution treats `~` as a literal directory name.

### Why extension system couldn't handle this

- `--export` exits before interactive mode and extension command handlers run, so CLI path normalization must happen in `main.ts`.

### Expected merge conflict zones on next upstream sync

- LOW: `main.ts` around the early `parsed.export` branch.

## Senpi self-update release source (2026-05-02)

### What changed

- `config.ts`: Bun-binary self-update fallback now points to `code-yeongyu/senpi` releases.
- `package-manager-cli.ts`: `senpi update senpi` is accepted as the branded self-update target and help text uses senpi wording.
- `package.json`: Repository metadata now points to the senpi fork.

### Why

- Self-update messaging and release metadata should direct users to senpi, not upstream pi-mono.

### Why extension system couldn't handle this

- These are core package metadata and built-in package-command parsing paths that run before extensions participate.

### Expected merge conflict zones on next upstream sync

- LOW: self-update command parsing/help and package metadata.

## Per-model transient retry fallback engine (2026-07-20)

### What changed

- `core/retry-fallback/controller.ts`: added the session-local fallback-chain controller. It canonicalizes configured selectors, suppresses transiently failing models, skips unavailable candidates with scoped logging, applies ephemeral thinking levels, and emits fallback lifecycle events.
- `core/agent-session.ts`: retryable transient failures now switch to a configured fallback without persisting the selected model, emitting a zero-delay retry and retaining the existing failed-assistant removal behavior. A fallback success event is emitted after the next successful response.

### Why extension system couldn't handle this

The retry budget, abortable retry sleep, provider continuation, and active model state all belong to `AgentSession`; an extension cannot safely replace a model inside that lifecycle without persisting it or rebuilding context.
- Retry fallback revert-to-primary at turn boundaries: unpinned fallback state under the `cooldown-expiry` policy restores the original model once its selector cooldown lapses (checked at prompt entry and between the retry sleep and continuation), emits `retry_fallback_reverted`, preserves user thinking-level overrides, and is abandoned on manual `setModel`/`cycleModel` (which also abort a pending fallback retry sleep).
- Server-side fallback aborts (2026-07-25): `retry.abortServerSideFallback` (default true) forwards `abortServerSideFallback` into provider stream options via a new `Agent` field and `createLoopConfig`. `AgentSession` translates the provider's `server_fallback_aborted` diagnostic into a session event of the same name carrying `from`/`to`/`chainConfigured`, emitted synchronously from `message_end` so it precedes refusal retry handling, and the existing refusal path then routes the turn onto the configured chain. `RetryFallbackController.hasConfiguredChain()` distinguishes "no chain configured" from "chain spent", because the no-chain refusal path emits no `retry_fallback_exhausted`. Interactive mode renders the abort and names `/fallback` when no chain exists.
