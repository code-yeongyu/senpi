# changes

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
