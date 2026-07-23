# Core Extensions Changes

## 2026-07-23 - Compaction feedback operation handles

### What changed

- `ExtensionContext` compaction feedback actions now return and accept an optional operation `AbortSignal`, allowing
  progress and terminal feedback from superseded generations to be ignored without breaking existing extensions.
  Each handler invocation receives an isolated context that remembers its own `beginCompaction()` signal and supplies
  it to legacy `updateCompaction()`, `endCompaction()`, and `applyCompaction()` calls that omit the signal, so another
  handler in the same event emission cannot rebind an old completion or durable apply to a newer operation.
- `stale-revision` is a structured compaction rejection cause for a source that changed before durable append.
- The builtin compaction extension threads that signal through local and remote summary generation and application.

### Why

Asynchronous summary feedback can arrive after a newer compaction begins; operation identity prevents stale progress
or completion from mutating the current session lifecycle.

## 2026-07-22 - Config-reload rejection loop breaker

### What changed

- `builtin/config-reload/index.ts`: rejected watch registrations are now fingerprinted (`id`, `displayName`, `targets`, `hasValidate`) and remembered per registration id. A synchronous re-registration with an identical payload after a rejection is ignored without re-emitting `CONFIG_WATCH_REJECTED`, breaking the reject → re-register synchronous recursion that crashed startup with `RangeError: Maximum call stack size exceeded`. Acceptance and unregistration clear the recorded fingerprint, so a repaired registration with a changed payload is processed normally. Suppressions are logged once at debug level as `registration_rejection_suppressed`.
- `test/suite/config-reload-extension.test.ts`: regression coverage for the single-rejection loop break and for post-rejection repair with a changed target.

### Why

External plugins that re-register synchronously from a `CONFIG_WATCH_REJECTED` listener (sticky-rejection recovery) recursed unboundedly against restricted-target rejections; the existing identity guard only covered accepted registrations re-emitted on ready, and rejected registrations were never recorded.

## 2026-07-21 - Look-at and image settings context APIs

### What changed

- `ExtensionContext` now exposes `getLookAtSettings()` and `getImageSettings()`, with matching context actions wired through the runner, agent session, and interactive shortcut contexts.

### Why

Builtin look-at extensions need resolved look-at and image settings without accessing the core `SettingsManager` directly.


## 2026-07-21 - Config-reload builtin registration

### What changed

- Registered the default-on `config-reload` builtin after settings-dependent builtins and before final `mcp` registration. It hash-gates configuration filesystem changes, validates parseable built-in surfaces before requesting the existing session reload flow, and publishes the `config-watch:*` in-process protocol for external registrations.

### Why

The reload-request context seam below lets the builtin reuse the host reload path without making reload a model tool. Keeping MCP last preserves its provider-payload observation ordering.


## 2026-07-21 - Extension reload request seam

### What changed

- `ExtensionContext` now exposes optional `requestReload()` and `isCompacting()` accessors. The runner promotes a host-provided command reload action into event and tool contexts, coalescing concurrent requests; hosts without that action expose no reload method.
- `AgentSession` binds `isCompacting()` to its unified auto/manual/branch-summary controller state. Interactive shortcut contexts expose the same pair.

### Why

Config-reload extensions need to request the existing host reload flow only when available and defer while compaction is active. A resolved interactive request is not proof of reload because the host deliberately warn-drops reloads while streaming or compacting.


## 2026-07-20 - recovery model config is public to provider extensions

### What changed

- `types.ts`: `ProviderModelConfig` now exposes optional `recoverTextToolCalls`, matching the composed provider model field. Extensions can register recovery-enabled, disabled, or inherited models without excess-property type errors.

### Expected merge conflict zones

- LOW: `types.ts` `ProviderModelConfig` model metadata fields.


## 2026-07-20 - Model fallback command builtin

- Added the `model-fallback` builtin and `/fallback` command for viewing, creating, removing, enabling, and setting the revert policy for global retry fallback chains.
- Quick-set form validates selectors before persisting; headless runs support quick-set and report that the menu requires interactive UI.
- Registered `--no-model-fallback` and `SENPI_NO_FALLBACK=1` as the per-run fallback escape-hatch inputs.
- `ExtensionContext.sessionSettings` delegates command writes to the active session's `SettingsManager`, so quick-set changes are immediately visible to the retry controller. Its read-only fallback status accessor powers the menu's live-state view.
- `--no-model-fallback` and `SENPI_NO_FALLBACK=1` apply a non-persistent `retry.modelFallback=false` override at session bootstrap.


## 2026-07-20 - session_compact `accepted: false` and structured cancel result

### What changed

- `types.ts`: `SessionBeforeCompactResult` gained optional `rejectionCause?: CompactionRejectionCause`
  and `reason?: string` fields so extensions can attach a structured cause and a
  human-readable detail when returning `{ cancel: true }`. `SessionCompactEvent.compactionEntry`
  is now optional and only populated on `accepted: true` events, and the JSDoc
  spells out that rejection events fire too.
- `agent-session.ts`: `_rejectCompaction` populates `compaction_end.errorMessage`
  with a message derived from `rejectionCause` (or the extension-provided
  `reason` when present) and also emits a `session_compact` event with
  `accepted: false`. Manual `/compact` used to swallow `would-overflow` and
  extension cancels silently; this closes plan §1.
- `builtin/nested-agents-md/index.ts`, `builtin/rules/index.ts`: `session_compact`
  handlers now guard on `event.accepted` before mutating session state, since
  the event fires on rejection too and there is no compaction entry to react to.

### Why

- `_rejectCompaction` emitted `compaction_end` with no `errorMessage` and the
  interactive-mode handler had no branch for `aborted:false && !result && !errorMessage`,
  so `/compact` rejected by `_wouldCompactionOverflow` was invisible. The
  builtin compaction extension's `session_compact` `!accepted` branch was also
  dead because core never emitted the rejection.

### Why extension system couldn't handle this alone

- The event union and the emit sites live in the core extension surface.
  Extensions cannot add typed fields to `SessionCompactEvent` or make the core
  emit rejections from outside.

### Expected merge conflict zones

- HIGH: `types.ts` around `SessionBeforeCompactResult` and `SessionCompactEvent`.
- MEDIUM: `agent-session.ts` `_rejectCompaction` and `_executeCompaction` cancel branch.
- LOW: builtin `session_compact` handlers guarding on `event.accepted`.

## 2026-07-19 - Port phased op-based todo tool

### What changed

- Rewrote `builtin/todotools/` around one `todo` tool with `init`,
  `start`, `done`, `drop`, `rm`, `append`, and `view`
  operations.
- Added phased state, content-keyed task resolution, automatic promotion,
  atomic failure behavior, compaction compatibility, and a static phase-aware
  renderer while preserving the `todowrite` builtin id and
  `todo-sidebar` widget key.

### Why

- The old pair required sending a complete flat snapshot on every mutation.
  The op-based port makes incremental updates retry-safe and gives the model a
  smaller, phase-aware contract.

### Attribution

- Ported and adapted from oh-my-pi commit
  `9fd6e97113f5ed3a847e66d346970efdf8afcad9` (v17.0.5); see
  `builtin/todotools/changes.md` and the repository `NOTICE.md`.

### Expected merge conflict zones

- HIGH: `builtin/todotools/`, `builtin/compaction/todo-bridge.ts`, and
  todo-specific tests if upstream changes its todo or compaction contracts.

## 2026-07-17 - video-in builtin extension and "video" input modality

### What changed

- `types.ts`: `ProviderModelConfig.input` widened to `("text" | "image" | "video")[]`, tracking the pi-ai
  `Model.input` union (kimi-coding `k3` declares video input).
- New builtin `builtin/video-in/`: registers a `read_video` tool that attaches a local video file
  (mp4/mpeg/mov/webm/mkv/avi/flv/3gp, ≤100MB) as a base64 `video/*` ImageContent block. The tool is
  activated/deactivated on `session_start` and `model_select` based on `model.input.includes("video")`,
  so it is only exposed to video-capable models. Registered in `builtin/index.ts` after `webfetch`.

### Expected merge conflict zones

- LOW: `types.ts` `ProviderModelConfig.input`.
- LOW: `builtin/index.ts` import block and `builtinExtensions` array tail.

## 2026-07-19 - model_select handlers observe live systemPromptOptions

### What changed
- `src/core/extensions/runner.ts`: `emitModelSelect` spreads a fresh
  `systemPromptOptions` from `getSystemPromptOptionsFn()` into each handler's event, so
  toolset-swapping handlers (gpt-apply-patch) and prompt-rebuilding handlers
  (prompt-preset) stay consistent within one model switch.

## 2026-07-17 - Factory-time `pi.registerMcpServer()` API

### What changed
- `src/core/extensions/builtin/mcp/config-schema.ts`: added `"extension"` to
  `McpServerSource`; exported a public raw `McpServerDeclaration` type and a
  single-server `validateMcpServerDeclaration(name, raw)` validator.
- `src/core/extensions/types.ts`: added `ExtensionAPI.registerMcpServer(name,
  config)`, `RegisteredMcpServerDeclaration`, and `Extension.mcpServers` +
  `registrationCwd` storage; added optional
  `ExtensionContext.getRegisteredMcpServers()`.
- `src/core/extensions/loader.ts`: `createExtension` stores `registrationCwd`;
  `createExtensionAPI` implements `registerMcpServer` with synchronous
  ServerSchema + endpoint validation that throws only for the declaring
  extension.
- `src/core/extensions/runner.ts`: added
  `ExtensionRunner.getRegisteredMcpServers()` with first-wins aggregation and a
  conflict warning naming both extension paths; exposed it on
  `ExtensionContext`.
- `src/core/extensions/index.ts` + `src/index.ts`: re-export `McpServerDeclaration`.
- `docs/extensions.md`: documented the factory-time-only contract, validation,
  precedence, cwd defaulting, reload, and child-session behavior.

### Why
- Extensions need a first-class way to declare MCP servers that are available on
  turn 1. Factory-time registration is the only seam that runs before
  `session_start`, so servers can be connected and their tools registered before
  the first model request.

### Why extension system couldn't handle this alone
- This is a public extension API addition: the declaration type, validator,
  per-extension storage, runner aggregation, and context accessor all live in
  the extension system.

### Expected merge conflict zones
- HIGH: `types.ts` around `ExtensionAPI` and `Extension` definitions.
- MEDIUM: `loader.ts` `createExtension` / `createExtensionAPI`.
- MEDIUM: `runner.ts` around `createContext()` and the aggregation helpers.
- LOW: `src/index.ts` extension type re-exports.

## 2026-07-17 - Tool renderer hasResult context

### What changed

- Added optional `ToolRenderContext.hasResult`, true once a partial or final result exists for a tool call.
- Lets a call renderer that draws self-contained framing (e.g. codemode `eval`) yield to the result renderer instead
  of stacking a duplicate block, since `ToolExecutionRenderer.update()` renders call-then-result into one container.

### Why

- `renderCall` previously had no way to detect that a result had arrived: `isPartial` is true both for "no result yet"
  and "partial result", so a self-framing call renderer kept drawing its own box on top of the result box.

### Why extension system couldn't handle this alone

- `ToolRenderContext` is a public host-to-extension contract, and result presence for a tool row is owned by the
  interactive renderer (`modes/interactive/components/tool-execution-renderer.ts`).

### Expected merge conflict zones

- MEDIUM: `types.ts` around `ToolRenderContext` as upstream adds renderer context fields.
- LOW: `modes/interactive/components/tool-execution-renderer.ts` around `getRenderContext()`.

## 2026-07-16 - anthropic-web-search gated to endpoints that support server-side web search

### What changed

- `builtin/anthropic-web-search/index.ts`: the extension now gates on the model instead of the API type,
  mirroring `builtin/openai-web-search`. `supportsNativeAnthropicWebSearch(target)` is true for the first-party
  `api.anthropic.com` endpoint or an explicit `compat.supportsWebSearch` opt-in. For unsupported
  `anthropic-messages` endpoints the extension no longer
  injects `web_search_20250305`, no longer strips a function-tool `web_search` (pi-websearch keeps working as the
  fallback), strips any hook-injected native `web_search_*` variant plus an orphaned `tool_choice`, and skips the
  web-search system prompt section.
- `test/suite/anthropic-web-search-extension.test.ts`: added kimi-coding-shaped regression coverage for
  non-injection, native-variant stripping, compat opt-in, and prompt-section gating.

### Why

- Anthropic-compatible endpoints such as kimi-coding accept the injected native tool and execute the server-side
  search, but reject the replayed `server_tool_use` / `web_search_tool_result` blocks on the next request
  (kimi-coding 400s with `tool_call_id is not found`), wedging the session mid-turn.

### Why extension system couldn't handle this alone

- It can (this is the extension-side half); `pi-ai` additionally strips unsupported `web_search_*` tools after all
  hooks run (see `packages/ai/src/changes.md` 2026-07-16) so payloads from other extensions are covered too.

### Expected merge conflict zones

- MEDIUM: `builtin/anthropic-web-search/index.ts` if upstream reshapes native web tool payload handling.
- LOW: `test/suite/anthropic-web-search-extension.test.ts` fixtures.
## 2026-07-10 - Tool renderer image protocol context

### What changed

- Added optional `ToolRenderContext.imageProtocol`, exposing `"kitty"`, `"iterm2"`, or `null` to tool call and result renderers.
- The interactive host owns native image rendering and Kitty conversion fallbacks, allowing custom renderers to suppress duplicate image indicators when a terminal image protocol is active.
- Documented the field in the exhaustive tool renderer context list in `docs/extensions.md`.

### Why

- Custom renderers need the active terminal image capability to coordinate their text output with host-owned image rendering without leaving image-only results blank or rendering duplicate fallbacks.

### Why extension system couldn't handle this alone

- `ToolRenderContext` is a public host-to-extension contract, and the active image protocol plus native/fallback image lifecycle are owned by the interactive renderer.

### Expected merge conflict zones

- MEDIUM: `types.ts` around `ToolRenderContext` as upstream adds renderer context fields.
- LOW: `modes/interactive/components/tool-execution.ts` around host-owned image composition.

## 2026-07-07 - Persistent-terminal builtin extension

### What changed

- Added builtin extension id `terminal` in `builtin/index.ts`, registered AFTER `bash-timeout` and
  `anthropic-bash`. It swaps the core `bash` for a PTY-backed `bash` (adds `run_in_background`, `cols`,
  `rows`, mode-aware `timeout`) and registers four snake_case companion tools — `bash_output`
  (`wait_for`/`filter`/`view:screen`), `bash_input` (stdin + named keys), `bash_resize`, `kill_bash` —
  backed by the new `@earendil-works/pi-pty` package (native ConPTY/portable-pty + `@xterm/headless`
  screen, with a child_process pipe fallback).
- The extension is MUTUALLY EXCLUSIVE with `anthropic-bash`: on `session_start` AND `model_select` it
  re-evaluates `isAnthropicBashEnabled() && model.api === "anthropic-messages"` and deactivates the
  companions (one-line notice) so none dangle when native Anthropic bash strips/replaces `bash`; when
  the condition clears it re-activates the PTY `bash` + companions. It injects a prompt section on
  `before_agent_start` (skipped while stepped aside) and tears the manager down on `session_shutdown`.
- `builtin/permission-system/parsers.ts`: registered a `bash_input` parser that classifies it in the
  `bash` permission class (via its `input` field), because writing stdin to a live shell is arbitrary
  command execution and must not be bypassable under `read-only`/`ask` presets.

### Why

- senpi lacked Claude-Code-shaped persistent/background terminal sessions (stdin steering, resize, live
  screen snapshot, `wait_for` subscription, clean tree-kill). Shipping it as a builtin extension keeps
  the PTY runtime, tool surface, and provider-exclusion logic out of the high-conflict core session
  runtime, reusing the gpt-apply-patch tool-swap and bash-timeout injection precedents.

### Why extension system couldn't handle this alone

- The mutual-exclusion swap must restore the ORIGINAL core `bash` definition (extension tools override
  base tools by name in `_refreshToolRegistry`), and `bash_input` permission gating must live in the
  builtin permission parser registry — both are builtin/registration surfaces, not user-extension
  surface. Shell-kind resolution for non-bash shells lives in core `utils/shell.ts` (see
  `utils/changes.md`).

### Expected merge conflict zones

- MEDIUM: `builtin/index.ts` registration array near `bash-timeout` / `anthropic-bash` (other trains
  insert builtins here). Resolution: keep `terminal` after both.
- LOW: `builtin/permission-system/parsers.ts` `registry.register` block (see its own `changes.md`).
- LOW: `builtin/terminal/**` self-contained sources.

## 2026-07-06 - Bundled codemode extension

### What changed

- `@code-yeongyu/senpi-codemode` is loaded as a default-on builtin-adjacent extension from its package manifest.
- `disabledBuiltinExtensions: ["codemode"]` disables the bundled extension, while `--no-extensions` only disables user extension discovery.
- Interactive permission prompts raised by tools called inside codemode bridge cells suspend the cell until the prompt resolves; denial returns an error reply to the kernel instead of hanging.

### Why

- Codemode must be available by default while still using the normal extension loader, active-tool filtering, hook pipeline, and permission system.

### Expected merge conflict zones

- MEDIUM: `resource-loader.ts` around builtin-adjacent extension ordering and package shadowing.

## 2026-07-06 - Extension executeTool API

### What changed

- Added `pi.executeTool(toolName, params, options?)` plus exported option, result, update-callback, and typed error aliases.
- `executeTool` resolves only from the active session tool set, runs the same argument preflight as the agent loop, emits `tool_call` and `tool_result` hooks, and executes the wrapped registered tool with extension context intact.
- Bridge subcalls intentionally do not emit `tool_execution_start`, `tool_execution_update`, or `tool_execution_end` UI events. Callers should stream their parent tool UI through the supplied `onUpdate` callback.

### Why

- Codemode kernels need to call built-in and extension-registered tools without bypassing permissions, hook mutation/blocking, result rewriting, or extension-scoped execution context.

### Expected merge conflict zones

- HIGH: `types.ts` around `ExtensionAPI` and action handler types.
- MEDIUM: `loader.ts` and `runner.ts` around `bindCore` action wiring.
- MEDIUM: `agent-session.ts` around tool hook installation and active tool dispatch.

## 2026-07-07 - MCP W1 builtin implementation

### What changed

- The `mcp` builtin skeleton is now the full W1 implementation: TypeBox-validated config discovery/merge (global,
  project, imported Claude configs), stdio + StreamableHTTP transports, a per-server connection state machine, a
  process-owned service lifecycle (`lazy` / `eager` / `keep-alive`), end-to-end tool registration with spec-correct
  call semantics, the `/mcp` command suite, tool exposure policy (`auto` / `direct` / `search` / `proxy`), server
  instructions injection, and secret-redacting per-server logging. Per-module details: `builtin/mcp/changes.md`.

### Why

- W1 turns the registered no-op skeleton into working MCP support while keeping every moving part inside the builtin
  extension boundary.

### Why extension system couldn't handle this alone

- It did: W1 uses only the public `pi.*` API (`registerTool`, `registerCommand`, `session_start`,
  `before_agent_start`, `session_shutdown`). No `types.ts` or `runner.ts` change was needed.

### Expected merge conflict zones

- LOW: `builtin/index.ts` registration order near the final builtin entries.
- NONE: `types.ts` (untouched by MCP W1); `builtin/mcp/` does not exist upstream.

## 2026-07-06 - MCP builtin extension skeleton

### What changed

- Added builtin extension id `mcp` at the end of the builtin registration list, with a no-op lifecycle skeleton and
  official MCP SDK wrap point.

### Why

- MCP support needs to ship as a builtin extension so future server lifecycle, tool exposure, and provider-payload
  handling stay out of the high-conflict core session runtime.

### Why extension system couldn't handle this alone

- This is the builtin extension registration itself. The skeleton uses existing extension lifecycle hooks and does not
  add new public extension API surface.

### Expected merge conflict zones

- LOW: `builtin/index.ts` registration order near the final builtin entries.
- LOW: `builtin/mcp/` as later MCP implementation phases fill in the skeleton.

## 2026-07-04 - Tool hook status `update` phase and `ctx.updateToolHookStatus()`

### What changed

- `types.ts`: tool hook lifecycle events gained an `update` phase, and tool-hook-capable event contexts gained an
  optional `updateToolHookStatus(statusMessage)` method so `tool_call` / `tool_result` handlers can publish live
  status text while a hook runs.
- `runner.ts`: dispatches the update-phase status events to the host.
- `builtin/hooks/`: the dispatcher forwards configured command-hook `statusMessage` values (previously parsed and
  trust-hashed but never rendered) through the new update phase, so the TUI hook row shows the live hook identity
  instead of a static per-extension guess.
- `docs/extensions.md` documents the new API; rendering side is in `modes/interactive/changes.md`.

### Why

- Users could not tell which hook was running or what it was doing during `Running PreToolUse/PostToolUse hook` rows.

### Why extension system couldn't handle this alone

- This is a public extension API addition: the event union, context method, and runner emit helper all live in the
  extension system itself.

### Expected merge conflict zones

- MEDIUM: `types.ts` around the tool hook lifecycle event union and context method declarations.
- LOW: `runner.ts` emit helpers; `builtin/hooks/dispatcher.ts` status forwarding.

## 2026-07-02 - Extension entry renderer sync

### What changed

- `types.ts`, `runner.ts`, `loader.ts`, and `index.ts`: accepted upstream extension entry-renderer support for persisted
  display-only session entries.
- `agent-session.ts` and interactive rendering now use those renderers so custom entries can render in persisted order
  without being sent back to the model context.

### Why

- Extensions need a typed way to render custom session entries that are display-only, survive persistence, and do not
  mutate the model transcript.

### Why extension system couldn't handle this alone

- This is an extension-system API addition: the runner, loader, exported types, session dispatch, and interactive renderer
  all need matching core support before an extension can provide an entry renderer.

### Expected merge conflict zones

- MEDIUM: `types.ts` around extension API and entry renderer type definitions.
- MEDIUM: `runner.ts` and `loader.ts` around renderer registration/loading.
- LOW: `index.ts` exports if upstream changes extension type re-exports.

## 2026-06-29 - Builtin hooks extension runtime resource plumbing

### What changed

- Added builtin extension id `hooks` before `permission-system` so builtin command hooks can inspect tool calls before permission prompts.
- Added `ResourcesDiscoverResult.hookPaths`, `ResourceExtensionPaths.hookPaths`, `DefaultResourceLoader.getLoadedHookSources()`, and `ExtensionContext.getLoadedHookSources()` for hook config source injection.
- `ExtensionRunner.emitResourcesDiscover()` now collects hook paths, and `AgentSession.extendResourcesFromExtensions()` passes them to the resource loader as runtime hook sources.
- `builtin/hooks/index.ts` now loads settings/default files, pre-session hook paths, and runtime hook paths lazily; malformed hook sources become diagnostics instead of startup failures.
- Registered `/hooks` for command-output diagnostics and basic loaded-hook status.

### Semantics

- Initial `SessionStart` only sees pre-session sources: settings/default hook files and `DefaultResourceLoaderOptions.additionalHookPaths`.
- Runtime `hookPaths` returned from `resources_discover` are late sources. They are visible to later hook events in the current runtime and to reload/next-session `SessionStart`, where `SessionStart` hooks from runtime sources emit the existing caveat diagnostic.
- Malformed user/runtime hook JSON is nonfatal. Managed or builtin hook safety invariant failures remain hard failures at the dispatch layer rather than being trusted silently.

### Expected merge conflict zones

- MEDIUM: `types.ts` public API additions around `ExtensionContext`, `ResourcesDiscoverResult`, and `ExtensionContextActions`.
- MEDIUM: `runner.ts` resource discovery aggregation and context construction.
- MEDIUM: `resource-loader.ts` extension resource plumbing.
- LOW: `agent-session.ts` `extendResourcesFromExtensions()` resource handoff.
- LOW: `builtin/index.ts` registration order near `permission-system`.

## 2026-06-15 - Remove legacy Kimi-specific web-search builtin; fold Kimi search into pi-websearch

### What changed

- Removed the legacy Kimi-specific web-search builtin and its registration in `builtin/index.ts`. Its search/fetch tools no longer exist.
- Kimi search is now a `pi-websearch` provider (`kimi`, vendored at 0.2.0). On a `kimi-coding` model the native auto-route prepends a `kimi` entry (api.kimi.com/coding/v1/search) using the model API key, so `web_search` works zero-config and falls back to the configured chain. URL fetching is handled by the `webfetch` builtin.
- `test/suite/regressions/3592-...test.ts`: dropped `kimi_search_web` / `kimi_fetch_url` from the tool-list expectations.

### Why

- One web-search surface instead of two. Kimi's coding search fits pi-websearch's provider + native-route architecture, so the standalone builtin was redundant.

### Expected merge conflict zones

- LOW: `builtin/index.ts` registration array; `builtin/websearch/` vendored sources (re-vendor from `../pi-extensions/pi-websearch`).

## 2026-05-15 - OpenAI native web search endpoint compatibility

### What changed

- `builtin/openai-web-search/index.ts`: The extension now passes the full selected model into OpenAI native web search handling and only injects `web_search_preview` for Azure Responses, official `api.openai.com` OpenAI Responses, or custom Responses models with `compat.supportsWebSearchPreview: true`.
- Custom OpenAI Responses endpoints now strip OpenAI native `web_search_preview` / `web_search_preview_*`, matching `tool_choice`, and `web_search_call.action.sources` includes by default while preserving ordinary function tools such as a configurable `web_search`.
- `model-registry.ts`: Added `compat.supportsWebSearchPreview` to the models.json schema so users can opt custom OpenAI-compatible providers into native web search support.
- `test/suite/openai-web-search-extension.test.ts`: Added regression coverage for default custom-endpoint stripping and explicit opt-in preservation.

### Why

- The failing GPT-5.5 session used an `openai-responses` model pointed at a custom proxy endpoint. The old extension keyed only on `api`, injected OpenAI-native `web_search_preview`, and the downstream endpoint rejected the tool schema. Matching the `../ai` and `../opencode` pattern means provider-native tools are only sent when the endpoint explicitly supports that provider's native tool dialect.

### Why extension system couldn't handle this alone

- The extension can prevent its own automatic injection, but the selected model's endpoint capability is the real decision point. The companion `pi-ai` provider guard still handles later hook mutations after this extension runs.

### Expected merge conflict zones

- LOW: `builtin/openai-web-search/index.ts` around `addOpenAiWebSearchToPayload()` and `before_agent_start`.
- LOW: `model-registry.ts` provider compat schema if upstream adds more Responses compatibility fields.

## 2026-05-15 - OpenAI native web_search_preview strip for non-OpenAI-Responses payloads

### What changed

- `builtin/openai-web-search/index.ts`: When `ctx.model.api` is not an OpenAI Responses variant, the extension now also scans `payload.tools` for OpenAI native `web_search_preview` / `web_search_preview_*` entries and strips them before the request leaves senpi. The OpenAI Responses path (inject + Anthropic-tool sanitize) is unchanged.
- `test/suite/openai-web-search-extension.test.ts`: Added regression coverage for stripping `web_search_preview`, the versioned `web_search_preview_2025_03_11` variant, the `openai-completions` case, the disabled-via-env case, and a no-op assertion guaranteeing Anthropic-native `web_search_*` / `web_fetch_*` entries are left intact on anthropic-messages payloads.

### Why

- Anthropic rejects requests whose `tools[]` contains `type: "web_search_preview"` with `tools.N: Input tag 'web_search_preview' found using 'type' does not match any of the expected tags`. The leak shows up for users whose `openai` provider is wired to a proxy that translates `openai-responses` → `anthropic-messages` (e.g., ccapi / quotio when routing claude-* models) and forwards `web_search_preview` verbatim. Defense-in-depth stripping ensures senpi never lets the OpenAI-only tool reach Anthropic-format backends regardless of how it ended up in the payload.

### Why extension system couldn't handle this alone

- The fix is entirely inside the existing `openai-web-search` builtin extension via `before_provider_request`. No core or pi-ai change required.

### Expected merge conflict zones

- LOW: `builtin/openai-web-search/index.ts` early-return branch in `addOpenAiWebSearchToPayload` if upstream restructures the non-OpenAI-Responses fall-through path.

## 2026-05-15 - OpenAI Chat Completions Tool Pair Guard

### What changed

- `builtin/tool-pair-guard/index.ts`: Extended the provider request guard to run an OpenAI Chat Completions payload sanitizer after the Anthropic and OpenAI Responses sanitizers.
- `builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts`: Added Chat Completions request message repair that drops orphan or duplicate `role: "tool"` messages and inserts synthetic `role: "tool"` results for interrupted assistant `tool_calls`.
- `test/tool-pair-guard/sanitize-openai-chat-completions-payload.test.ts`: Added regression coverage for valid-pair no-op behavior, orphan output removal, duplicate output removal, and missing output synthesis before transcript advance or payload end.

### Why

- OpenAI-compatible Chat Completions providers reject `role: "tool"` messages whose `tool_call_id` has no preceding assistant `tool_calls` entry. Persisted or compacted sessions with stale tool outputs can otherwise keep replaying the same invalid payload and fail with HTTP 400.

### Why extension system couldn't handle this alone

- The fix does use the extension system: `tool-pair-guard` is a builtin extension that repairs provider payloads through `before_provider_request`. No core provider or agent loop change was required.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` if upstream changes provider-request hook wiring.
- LOW: `builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts` if upstream adds an equivalent Chat Completions pairing normalizer.

## 2026-05-15 - OpenAI Responses Tool Pair Guard

### What changed

- `builtin/tool-pair-guard/index.ts`: Extended the existing provider request guard to run both Anthropic and OpenAI Responses payload sanitizers.
- `builtin/tool-pair-guard/sanitize-openai-responses-payload.ts`: Added OpenAI Responses request input repair that drops orphan `function_call_output` / `custom_tool_call_output` items and inserts synthetic outputs for interrupted calls that have no result.
- `test/tool-pair-guard/sanitize-openai-responses-payload.test.ts`: Added regression coverage for orphan output removal, missing output synthesis, valid-pair no-op behavior, and `previous_response_id` delta preservation.

### Why

- OpenAI Responses rejects requests with `No tool call found for function call output with call_id ...` when a stale tool output survives without its matching call. Once such history is persisted, follow-up prompts can repeatedly send the same invalid output and leave the session stuck.

### Why extension system couldn't handle this alone

- The fix does use the extension system: `tool-pair-guard` is a builtin extension that repairs provider payloads through `before_provider_request`. No core provider or agent loop change was required.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` if upstream changes provider-request hook wiring.
- LOW: `builtin/tool-pair-guard/sanitize-openai-responses-payload.ts` if upstream adds an equivalent OpenAI Responses pairing normalizer.

## 2026-05-15 - Normalize remaining senpi internal names

### What changed

- `builtin/system-messages.ts`: Renamed the exported conversation constants, event type names, and helper function names to the `SENPI_*` / `Senpi*` spelling, and changed the emitted conversation event name to `senpi:conversation`.
- `builtin/todotools/system-messages.ts`: Applied the same event-name and constant-name cleanup to the vendored todotools helper.
- `builtin/todotools/state.ts`: Changed the todo state custom entry type to `senpi.todo-state`.
- `test/suite/senpi-conversation.test.ts`: Renamed the regression test file and assertions to match the senpi runtime naming.

### Why

- The fork identity is `senpi`, and the remaining internal directive/event/state/env names should carry the same identity instead of preserving an earlier spelling.

### Why extension system couldn't handle this alone

- These names are builtin extension wire constants and session custom-entry identifiers. They must be emitted correctly by the bundled implementation before user or external extensions can observe them.

### Expected merge conflict zones

- LOW: `builtin/system-messages.ts`, `builtin/todotools/system-messages.ts`, and `builtin/todotools/state.ts` if upstream or vendored builtins rename these helper surfaces.
## 2026-05-14 - Native Web Tool UI Cleanup Hooks

### What changed

- `builtin/anthropic-web-search/index.ts`: Added session/model UI cleanup for Anthropic native `web_search` so older startup widgets are cleared.
- `builtin/openai-web-search/index.ts`: Added session/model UI cleanup for OpenAI Responses native `web_search_preview` so older startup widgets are cleared.
- `test/suite/anthropic-web-search-extension.test.ts` and `test/suite/openai-web-search-extension.test.ts`: Added regression coverage that native web tool extensions do not leave startup/footer widgets behind.

### Why

- Native provider web search is injected below the function-tool layer, but always-on footer widgets for that availability are too noisy. The UI should stay quiet until an actual tool execution or provider response needs rendering.

### Why extension system couldn't handle this alone

- These are already builtin extensions responsible for native provider payload mutation; the useful UI state belongs beside that injection logic.

### Expected merge conflict zones

- LOW: `builtin/anthropic-web-search/index.ts` and `builtin/openai-web-search/index.ts` if native web tool payload handling changes upstream.

## 2026-05-13 - Rename injected system prefix to senpi

### What changed

- `builtin/system-messages.ts`: Changed the injected builtin system-message prefix to `[system:senpi]`.
- `builtin/todotools/system-messages.ts`: Applied the same prefix change to the vendored todotools helper.
- `test/suite/senpi-conversation.test.ts`: Added regression coverage that both helpers emit the `senpi` marker.

### Why

- The runtime identity is `senpi`, so internally injected reminder/follow-up messages should use the matching `[system:senpi]` marker.

### Why extension system couldn't handle this alone

- The marker is emitted by bundled helper modules used by builtin extensions before handing messages to the agent runtime.

### Expected merge conflict zones

- LOW: `builtin/system-messages.ts` and `builtin/todotools/system-messages.ts` if the helper modules are renamed or consolidated.

## 2026-05-12 - Externalize todotools vendored builtin source

### What changed

- Added `pi-todotools` to the vendored builtin sync manifest and `sync-builtin-extensions.mjs` mapping.
- Refreshed `builtin/todotools/` from the standalone `../pi-extensions/pi-todotools` source while preserving the `todowrite` builtin id and tool names.
- Added local `todotools/settings.ts` and `todotools/system-messages.ts` helpers so the extracted extension uses only public package APIs externally.
- Updated sync coverage to pin the `pi-todotools` package version.

### Why

- Todo tools are now maintained as a public sibling extension like other vendored builtins, while senpi continues shipping the feature in the binary.

### Why extension system couldn't handle this alone

- senpi's builtin list is assembled by core resource loading; shipping a sibling extension as a builtin still requires vendored source and the builtin sync manifest.

### Expected merge conflict zones

- `builtin/todotools/` if upstream adds its own todo tooling.
- `builtin/external-versions.json` and `scripts/sync-builtin-extensions.mjs` if more vendored packages are added.

## 2026-05-11 - GPT apply_patch Realtime Progress Rendering

### What changed

- `builtin/gpt-apply-patch/types.ts`: Added progress metadata for partial apply_patch updates.
- `builtin/gpt-apply-patch/apply.ts`: Added an optional progress callback emitted after each patch operation.
- `builtin/gpt-apply-patch/preview.ts` and `tool.ts`: Render pending updates as `Applying patch (done/total)` while preserving rich diff previews.
- `test/suite/gpt-apply-patch-extension.test.ts` and `gpt-apply-patch-rich-render.test.ts`: Added regression coverage for realtime progress updates and pending widget titles.

### Why

- Multi-file apply_patch calls previously showed a single pending diff preview and did not update the TUI as individual operations completed.

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is already the builtin extension; progress has to be emitted from its apply loop and rendered by its tool result renderer.

### Files modified

- `builtin/gpt-apply-patch/types.ts`
- `builtin/gpt-apply-patch/apply.ts`
- `builtin/gpt-apply-patch/preview.ts`
- `builtin/gpt-apply-patch/tool.ts`
- `builtin/gpt-apply-patch/index.ts`
- `../../test/suite/gpt-apply-patch-extension.test.ts`
- `../../test/suite/gpt-apply-patch-rich-render.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/apply.ts` apply loop callback wiring.
- LOW: `builtin/gpt-apply-patch/tool.ts` pending update render title.

## 2026-05-11 - GPT apply_patch OpenCode-style Diff Rendering

### What changed

- `builtin/gpt-apply-patch/preview-format.ts`: Reworked expanded patch previews to render OpenCode-like diff rows with colored signs, muted line numbers, added/removed row backgrounds, syntax highlighting when a TUI theme is available, and inverse inline word highlights for paired edits.
- `builtin/gpt-apply-patch/types.ts`: Added `toolErrorBg` to the local theme background type used by apply_patch row rendering.
- `test/suite/gpt-apply-patch-rich-render.test.ts`: Added regression coverage for row background colors and inline added/removed highlights.
- `builtin/external-versions.json`: Bumped the vendored `pi-apply-patch` snapshot metadata to `0.1.1`.

### Why

- The previous rich preview only colored whole `+` / `-` lines and did not match OpenCode's edit/apply_patch diff visual hierarchy closely enough.

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is already the builtin extension; the change is inside its own TUI render path.

### Files modified

- `builtin/gpt-apply-patch/preview-format.ts`
- `builtin/gpt-apply-patch/types.ts`
- `builtin/gpt-apply-patch/index.ts`
- `builtin/external-versions.json`
- `../../test/suite/gpt-apply-patch-rich-render.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/preview-format.ts` render helpers.
- LOW: `builtin/gpt-apply-patch/types.ts` local theme background union.

## 2026-05-11 - GPT apply_patch External Path Support

### What changed

- `builtin/gpt-apply-patch/workspace.ts`: Removed workspace-boundary and realpath validation from path resolution.
- `builtin/gpt-apply-patch/apply.ts` and `preview.ts`: Resolve patch paths with Node `path.resolve(cwd, filePath)` and allow absolute, parent-escaping, and symlink-escaping targets.
- `test/suite/gpt-apply-patch-backport.test.ts`: Added regression coverage for absolute paths outside the current workspace and symlink paths resolving outside it.

### Why

- Codex-style patch payloads can legitimately target files outside the session cwd, for example adjacent worktrees or debug journals. The previous guard rejected those paths with `File references must stay within the current workspace.`

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is a builtin extension and the path policy lives inside its vendored implementation.

### Files modified

- `builtin/gpt-apply-patch/workspace.ts`
- `builtin/gpt-apply-patch/apply.ts`
- `builtin/gpt-apply-patch/preview.ts`
- `../../test/suite/gpt-apply-patch-backport.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/workspace.ts` path resolution helpers.
- LOW: `builtin/gpt-apply-patch/apply.ts` and `preview.ts` imports/call sites for the path resolver.

## 2026-05-08 - Generated Default Extension Factory Resolver

### What changed

- `loader.ts`: `loadExtensions()` now accepts an optional factory resolver and creates the jiti importer lazily only when an extension path is not resolved to a known factory.
- `builtin/index.ts`: Exposes a keyed map for the four global default extension factories used by generated shims.

### Why

- The default global extension shim files are deterministic. Letting core resolve those shims to known factories avoids the jiti import path without changing extension order, source paths, or behavior for custom extension files.

### Why extension system couldn't handle this alone

- Extension loading is core infrastructure; extensions cannot intercept the module importer before their factories have been loaded.

### Files modified

- `loader.ts`
- `builtin/index.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `loader.ts` around `loadExtension()` and `loadExtensions()` signatures/importer construction.
- LOW: `builtin/index.ts` around global default extension registration.

## 2026-05-08 - Shared Jiti Extension Importer

### What changed

- `loader.ts`: Reuses one `jiti` importer across each `loadExtensions()` batch while keeping `moduleCache: false` for reload freshness.
- `loader.ts`: Aliases upstream `@mariozechner/pi-*` peer imports to the already-loaded senpi workspace packages.

### Why

- Startup was spending several seconds creating a fresh `jiti` instance for every configured extension, causing repeated TypeScript/dependency resolution work before the first TUI frame.
- Installed pi extensions still import upstream `@mariozechner/pi-coding-agent`, `pi-ai`, and `pi-tui` peer names. Without aliases, jiti can fall through to each extension's own `node_modules` and load a duplicate pi runtime.

### Why extension system couldn't handle this alone

- Extension loading is core infrastructure; extensions cannot change how the core loader imports extension modules.

### Files modified

- `loader.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `loader.ts` around `loadExtensionModule()`, `loadExtension()`, and `loadExtensions()` importer construction.

## 2026-04-30 - Model Switch System Prompt Change Event

### What changed

- `types.ts`: Added `ModelSelectEventResult` and `SystemPromptChangeEvent`, plus `pi.on("system_prompt_change", ...)` typing.
- `runner.ts`: Added `emitModelSelect()` so `model_select` handlers can request an active system prompt replacement.
- `builtin/prompt-preset/index.ts`: Returns the resolved prompt preset during `model_select`, including fallback reset when no preset applies.

### Why

- Prompt presets previously updated the system prompt only at `before_agent_start`, so a mid-session model switch did not immediately update the active prompt or expose a typed event for observers.

### Why extension system couldn't handle this alone

- Extensions could listen to `model_select`, but the runner ignored handler return values and there was no typed `pi.on` event for the resulting system prompt change.

### Files modified

- `types.ts`
- `runner.ts`
- `builtin/prompt-preset/index.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` around model/agent event unions and `ExtensionAPI.on` overloads.
- HIGH: `runner.ts` around event emission helpers.

### Migration notes

- Preserve the invariant that `system_prompt_change` fires only after the active prompt string actually changes.

## 2026-04-28 - Compaction Settings Context API

### What changed

- `types.ts`: Added `ExtensionContext.getCompactionSettings()` and matching `ExtensionContextActions.getCompactionSettings`.
- `runner.ts`: Wired the new context action through `bindCore()` and `createContext()`.
- `agent-session.ts`: Bound the context action to `settingsManager.getCompactionSettings()`.
- `interactive-mode.ts`: Added the same method to inline shortcut `ExtensionContext` construction.

### Why

- The builtin compaction extension previously used `DEFAULT_COMPACTION_SETTINGS`, which bypassed user/project settings such as `compaction.enabled: false`.
- Plugsuit-style threshold realignment needs resolved settings for speculative toggles, cooldowns, keep-recent caps, and restoration budgets.

### Why extension system couldn't handle this alone

- Extensions receive `ExtensionContext`, not the core `SettingsManager`; without a typed context method, builtin extensions cannot read the already-merged global/project/user compaction settings.

### Files modified

- `types.ts`
- `runner.ts`
- `agent-session.ts`
- `interactive-mode.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

- If upstream adds settings access to `ExtensionContext`, keep this method or map the builtin compaction extension to the upstream equivalent. The required invariant is that compaction policy uses resolved settings, never hardcoded defaults.

## 2026-04-27 - Seam 3: Compaction Apply Context API

### What changed

- `types.ts`: Added `ApplyCompactionOptions`, `ApplyCompactionResult`, `ExtensionContext.getMessageRevision()`, and `ExtensionContext.applyCompaction()`.
- `runner.ts`: Wired the new context actions through `bindCore()` and `createContext()` so extensions can read the current message revision and apply a precomputed compaction result.
- `interactive-mode.ts`: Added the same methods to the inline shortcut `ExtensionContext` literal.

### Why

- Speculative/v2 compaction needs a stable compare-and-apply seam: extensions can prepare a compaction summary against revision N and only apply it if no context-affecting message mutation has happened since.
- `getMessageRevision()` is intentionally monotonic and in-memory only; it is a staleness guard, not persisted session data.
- `applyCompaction()` returns explicit `ok`, `stale`, or `rejected` outcomes so extensions can avoid racing the live session.

### Why extension system couldn't handle this alone

Extensions can observe hooks and return summaries during a core-driven compaction, but they cannot append a compaction entry, rebuild agent context, emit core compaction events, or atomically guard against stale session context without a typed core API.

### Files modified

- `types.ts`
- `runner.ts`
- `interactive-mode.ts`
- `agent-session.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

If upstream adds new `ExtensionContext` methods or changes `AgentSession` message mutation logic, preserve the monotonic revision counter and the `applyCompaction()` compare-and-apply semantics. The revision guard must remain in-memory and advance on every context-affecting mutation. Do not let upstream's `ExtensionContext` additions shadow the new methods.

## 2026-05-15 - Compaction Feedback Context API

### What changed

- `types.ts`: Added optional `ExtensionContext.beginCompaction()` and `ExtensionContext.endCompaction()` methods.
- `runner.ts`: Wired the new optional context actions through `bindCore()` and `createContext()`.
- `agent-session.ts`: Supplies the context actions with the same abort controller and canonical compaction events used by core compaction routes.

### Why

- Builtin speculative compaction can generate or await a summary before it calls `applyCompaction()`.
- That wait must still surface as a normal compaction to TUI/RPC consumers so loaders, cancellation, and input queueing work while the summary is in flight.

### Why extension system couldn't handle this alone

UI notifications alone cannot update `AgentSession.isCompacting`, participate in `abortCompaction()`, or emit the canonical compaction event pair.

### Files modified

- `types.ts`
- `runner.ts`
- `agent-session.ts`
- `builtin/compaction/index.ts`
- `modes/interactive/interactive-mode.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `agent-session.ts` around compaction abort-controller ownership and `applyCompaction()` event emission.

### Migration notes

Keep `beginCompaction()`/`endCompaction()` optional for third-party context mocks, but preserve runner support so builtin extensions receive the real core-backed implementation.

## 2026-04-27 - Seam 1: Compaction Event Metadata

### What changed

- `types.ts` line ~85: Added `CompactionReason` and `CompactionRejectionCause` exported literal-union aliases.
- `types.ts` lines ~541-554: Added `reason`, `willRetry`, and `requestId` metadata to `SessionBeforeCompactEvent`.
- `types.ts` lines ~549-554: Added `reason`, `requestId`, `accepted`, and optional `rejectionCause` metadata to `SessionCompactEvent`.
- `agent-session.ts` lines ~1651, ~1713, ~1910, and ~1986: Populated the 4 existing compaction event construction sites with the new required metadata fields. T15 will refactor these construction sites into the unified `_executeCompaction()` pipeline. T13 only populates the new required fields with minimal correct values to keep tsgo passing.

### Why

- Extensions cannot safely apply route-specific policies such as cooldown scope or circuit-breaker counters without knowing the compaction source.
- The user explicitly required consistency across the 6 compaction routes; this metadata is the prerequisite.
- `reason` always preserves the route source, while `rejectionCause` explains why a compaction was rejected when `accepted` is false.

### Why extension system couldn't handle this alone

Event payloads are core-defined types. Extensions can consume compaction events, but they cannot add typed fields to those events from outside the core extension API.

### Files modified

- `types.ts`
- `agent-session.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` is high-churn upstream, especially around extension event definitions. Resolution: preserve additive compaction metadata and keep `reason` semantically separate from `rejectionCause`.

### Migration notes

If upstream modifies compaction event definitions in `types.ts`, preserve the additive metadata fields (`reason`, `willRetry`, `requestId`, `accepted`, `rejectionCause`) and keep them semantically separate from upstream's existing fields. Update the 4 event construction sites in `agent-session.ts` to populate the new fields with the correct route-specific values.

## 2026-04-13 - GPT apply_patch builtin support

### What changed and why

- Added builtin `gpt-apply-patch` extension support so OpenAI GPT sessions can swap `write`/`edit` for a Codex-style `apply_patch` tool and react to mid-session model changes.
- Extended extension/tool plumbing to carry OpenAI Responses freeform grammar metadata. This core change was necessary because the existing extension API only modeled JSON-schema function tools, which made exact Codex GPT `apply_patch` parity impossible from an extension alone.

### Files modified

- `types.ts`
- `builtin/index.ts`
- `builtin/gpt-apply-patch/index.ts` (vendored from `pi-apply-patch`)

### Why the extension system couldn't handle this alone

- `ToolDefinition` had no way to express freeform grammar tools, only JSON-schema parameters.
- Wrapper plumbing dropped any provider-specific tool metadata before requests reached `pi-ai`.

### Expected merge conflict zones

- `types.ts` around `ToolDefinition`
- `builtin/index.ts` builtin registration ordering
