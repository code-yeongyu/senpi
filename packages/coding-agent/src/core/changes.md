## 2026-09-25 - An extension-triggered turn emits `before_agent_start` with `trigger: "extension"` (senpi#2137)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: the `sendCustomMessage(..., { triggerTurn: true })` path passes `{ trigger: "extension" }` to `emitBeforeAgentStart`; the user-prompt path and the preview keep the runner's default `"prompt"`. The event field itself is recorded in `extensions/changes.md`.

### Why

The todotools first-turn plan opener could not tell a user request from an extension's hidden bootstrap turn and armed on omo's onboarding greeting, skipping the user's real first request.

### Why an extension could not handle it

Only the host knows which path started the turn.

### Expected merge conflict zones

- The `emitBeforeAgentStart` call inside the `triggerTurn` branch of `sendCustomMessage`.

## 2026-09-25 - `setActiveToolsByName` emits `tool_activated` (senpi#2128)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `setActiveToolsByName` emits `tool_activated` with the tools that were not active before the call, when any handler listens. It emits fire-and-forget, because `ExtensionRunner.emit` reports handler failures itself. Every activation path goes through this method: `pi.setActiveTools`, tool_search promotion, and lazy activation of a by-name call.

### Why

The `computer-use` builtin arms the user's stop chord when its tool becomes active (see `extensions/changes.md`).

### Why an extension could not handle it

The active tool set belongs to `AgentSession`, and only the host can report a change to it.

### Expected merge conflict zones

- LOW: the `previousToolNames` line and the tail of `setActiveToolsByName`.

## 2026-09-25 - `todo.turnEndBackstop` setting (senpi#2121)

### What changed

- `packages/coding-agent/src/core/settings-shapes.ts`: `TodoSettings.turnEndBackstop`, default `true`.
- `packages/coding-agent/src/core/settings-manager.ts`: `getTodoTurnEndBackstop()`, which returns the merged value and falls back to `true` for a missing or non-boolean value.
- `packages/coding-agent/docs/settings.md`: a `todo.turnEndBackstop` row in the Todo section.

### Why

The goal builtin's turn-end backstop (`builtin/goal/todo-owed-backstop.ts`) needs a user switch to silence the hidden nudge for sessions that want unattended turns to end without it.

### Why an extension could not handle it

Settings shapes and their resolved defaults live in the settings manager; the goal builtin reads the resolved value through `SettingsManager` the way todotools reads `todo.firstTurnPlan`.

### Expected merge conflict zones

- LOW: the `TodoSettings` interface in `settings-shapes.ts`; the getter block next to `getTodoFirstTurnPlan()` in `settings-manager.ts`; the Todo table in `docs/settings.md`.

## 2026-09-25 - `todo.firstTurnPlan` setting (senpi#2121)

### What changed

- `packages/coding-agent/src/core/settings-shapes.ts`: `TodoFirstTurnPlan` (`"force" | "remind" | "off"`) and `TodoSettings.firstTurnPlan`, default `"force"`.
- `packages/coding-agent/src/core/settings-manager.ts`: `Settings.todo` and `getTodoFirstTurnPlan()`, which returns the merged value and falls back to `"force"` for a missing or unknown value.
- `packages/coding-agent/docs/settings.md`: a Todo section documents the setting.

### Why

The todotools first-turn plan opener (`builtin/todotools/first-turn.ts`) needs a user switch between forcing the opening `todo` call, only reminding, and disabling both.

### Why an extension could not handle it

Settings shapes and their resolved defaults live in the settings manager; the builtin reads the resolved value through `SettingsManager` like the other settings-driven builtins.

### Expected merge conflict zones

- LOW: the `Settings` interface and the getter block next to `getAskUserSettings()` in `settings-manager.ts`; the `settings-shapes.ts` import list.

## 2026-09-24 - Fold the environment context into the user message it precedes (senpi#2118)

### What changed

- `packages/coding-agent/src/core/messages.ts`: `convertToLlm` records the converted form of every `environment-context` custom message and, after `dropFailedAssistantTurns`, passes the list through `foldEnvironmentContextIntoNextUserMessage`. An environment context immediately followed by a user-role message becomes that message's leading content block(s) (same text); one that no user message follows stays a standalone user message.
- `packages/coding-agent/src/core/environment-context.ts` (fork-only): new `foldEnvironmentContextIntoNextUserMessage(messages, environmentMessages)`.

### Why

- The #2093 environment-context message reached every provider as a user message right before the prompt. Bedrock and Gemini were folded in their converters (#2114), but OpenAI Chat Completions still sent two consecutive user messages, which alternation-enforcing chat templates (vLLM's Mistral tool template, Gemma 3) reject. Folding at conversion keeps persistence, rollover, and resume unchanged, keeps the system prompt byte-stable, and fixes the user message bytes once they are sent, so prefix caches are unaffected.

### Why an extension could not handle it

- `convertToLlm` is the host's AgentMessage-to-LLM projection and runs after every `context` hook; an extension cannot reshape its output for every transport, compaction, and side-query caller.

### Expected merge conflict zones

- LOW: the `environment-context.ts` import, the `environmentMessages` set, the `custom` case, and the final `return` of `convertToLlm` in `messages.ts`.

## 2026-09-24 - Build the prompt-cache prefix only from preview-safe handlers and cancel it when a turn starts (senpi#2115)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: the session owns one `PromptCachePrefixBuilds` (`_promptCachePrefixBuilds`). The `getPromptCachePrefixRequest` context action delegates to `_promptCachePrefixBuilds.build(...)` with the new `ready: this._sessionStartSettled` source and the caller's `{ signal }` option, and both real `before_agent_start` emits (`prompt()` and the `triggerTurn` custom-message path) call `_promptCachePrefixBuilds.cancelAll()` immediately before `emitBeforeAgentStart`.
- `packages/coding-agent/src/core/prompt-cache-prefix-request.ts` (fork-only): `buildPromptCachePrefixRequest(sources, signal)` now returns a `PromptCachePrefixResult`. It waits for `sources.ready`, returns `skipped` without running any handler when `runner.getPreviewUnsafeBeforeAgentStartPaths()` is non-empty, passes `{ preview: true, signal }` to the preview pass, and resolves `skipped` with the abort reason (`PROMPT_STARTED_REASON` when a turn cancelled it) as soon as the signal aborts, without waiting for a stalled handler. `PromptCachePrefixBuilds` tracks each in-flight build's `AbortController` (linked to the caller's signal through `AbortSignal.any`) so `cancelAll()` stops every build.

### Why

The #2096 preview pass ran every `before_agent_start` handler with `event.preview: true`, but extensions written before that flag existed do not check it. An external memory extension that drains and marks notices delivered in `before_agent_start` lost them to the preview: the returned message was discarded and no turn followed. A preview also ran concurrently with the first real turn's `before_agent_start` when the user typed before it finished, so the same handlers raced on shared state.

### Why an extension could not handle it

The preview pass, its handler selection, and the moment a real turn dispatches `before_agent_start` are all host-owned; an extension cannot stop the host from invoking another extension's handler, nor observe the real turn's dispatch before it happens.

### Expected merge conflict zones

- LOW: the `prompt-cache-prefix-request.ts` import and the `_sessionStartSettled` field block, the `getPromptCachePrefixRequest` context action, and the two `this._refreshToolDeclarationsForModel()` + `emitBeforeAgentStart` pairs in `prompt()` and the `triggerTurn` branch of custom-message delivery in `agent-session.ts`.

## 2026-09-24 - Count session-start prompt-cache prewarm usage and build its request from the first turn's prefix (senpi#2096)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `getSessionStats` adds the usage of `prompt-cache-prewarm` custom entries in phase `warmed` (read through `getPromptCachePrewarmUsage` from `extensions/builtin/cache-keepalive/prewarm-entry.ts`) to the token and cost totals. The new `getPromptCachePrefixRequest` context action waits for `_sessionStartSettled` (settled by `bindExtensions` and by the reload `session_start` path once session_start handlers, default-tool enforcement, and `extendResourcesFromExtensions` have run, via `_beginSessionStartSettlement`) and then calls `buildPromptCachePrefixRequest` with the agent, extension runner, model runtime, effective service tier, and base prompt/options.
- `packages/coding-agent/src/core/prompt-cache-prefix-request.ts` (new, fork-only): `buildPromptCachePrefixRequest` composes the system prompt with `emitBeforeAgentStart("", undefined, base, options, { preview: true })` (a second pass when the base prompt changed during the first), builds the tools through agent-core `buildProviderContext` from `agent.state.tools`/`declaredTools` (the same declared list and `activeToolNames` subset the loop sends on allowed-tools models), mirrors `Agent.createLoopConfig()` for reasoning (configuration-update baseline, then thinking level), thinking selection/budgets, session id, and `onPayload`, applies `before_provider_headers`, and resolves auth/headers/`extraBody`/upstream model id through `ModelRuntime.prepareSimpleRequest`.
- `packages/coding-agent/src/core/model-runtime.ts`: new public `prepareSimpleRequest(model, options)` returns the `prepareRequest` result with `withPayloadRequestMetadata`, the same preparation `streamSimple` applies on the single-credential path, without sending a request.
- `packages/coding-agent/src/core/usage-totals.ts`: `getUsageCostBreakdown` counts the same entries in the `Tools/summaries` bucket, so the breakdown and the totals agree.

### Why

The `cache-keepalive` builtin now issues one OpenAI GPT-5.6+ prompt-cache prewarm per session start. The request is billed at the cache-write rate but produces no assistant message, so without the stats change the session totals under-report what was billed.

The first version of the prewarm sent `ctx.getSystemPrompt()` from inside its own `session_start` handler. Live QA (gpt-6-luna, real API) showed the prewarm writing 12,242 tokens while the first turn read 0 and wrote 18,444: that prompt was taken before later extensions finished `session_start`, before resource discovery added skills to the base prompt, and without the per-turn `before_agent_start` additions. OpenAI reuses a prefix only up to a block boundary, so a shorter developer message is never read. The prefix now comes from the same state the first turn reads, after session start has settled.

### Why an extension could not handle it

Session stats and the cost breakdown are computed in core from session entries; there is no hook to contribute usage from a custom entry. The turn's composed system prompt, tool list, loop reasoning, and provider auth/`extraBody` resolution live in `AgentSession`, `Agent`, and `ModelRuntime`, and the end of session-start resource discovery has no event an extension can await.

### Expected merge conflict zones

- LOW: the builtin import block, the `_sessionStartEvent` field block, `bindExtensions` (settlement handle and its `finally`), the reload `session_start` block, the context-action object after `getSystemPromptOptions`, and the entry loop at the top of `getSessionStats` in `agent-session.ts`.
- LOW: the new `prepareSimpleRequest` method before `completeSimple` in `model-runtime.ts`.
- LOW: the import block and the `branch_summary`/`compaction` branch of `getUsageCostBreakdown` in `usage-totals.ts`.

## 2026-09-24 - Keep tool declarations and the prompt tool section stable on allowed_tools models (senpi#2095)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: the session records every tool that has been active (`_declaredToolNames`, first-activation order). On a model whose compat sets `supportsAllowedTools`, `setActiveToolsByName` publishes that declared set as `agent.state.declaredTools` (only when it differs from the active list) and builds the base system prompt, including `selectedTools` for prompt presets, from it, so a tool removing itself (ask-user) or being toggled (gpt-apply-patch, tool-search promotion, MCP active set, eval-only filtering) no longer changes the tools or the prompt tool section; the active subset reaches the provider as `allowed_tools`. Models without the flag keep the active list as tools and prompt section. `_refreshToolDeclarationsForModel` re-derives the declaration before `before_agent_start` (both prompt paths) and in the next-turn snapshot, rebuilding the prompt only when a model switch moves its tool list; the snapshot carries `declaredTools`. The resources-discover prompt rebuild uses the same tool list.

### Why

Every mid-session tool-set change rewrote both the provider `tools` list and the prompt's "Available Tools" section, so the next GPT-5.6+ request missed the whole cached prefix.

### Why an extension could not handle it

The active tool list, the base system prompt and the next-turn context snapshot are owned by `AgentSession`; extensions only call `setActiveTools`.

### Expected merge conflict zones

- MEDIUM: the tail of `setActiveToolsByName` and the new private helpers after it; the start of `_rebuildSystemPrompt`.
- LOW: the next-turn snapshot return in the `prepareNextTurnWithContext` wrapper, the two `emitBeforeAgentStart` call sites, `extendResourcesFromExtensions`, the private field block, and the `@earendil-works/pi-ai` import.

## 2026-09-24 - Fast /resume listing: chunked summary reader and persistent summary index (senpi#2087)

### What changed

- `packages/coding-agent/src/core/session-summary.ts`: `readSessionSummary` reads through `readFileLines`, a 1 MiB reused-buffer async reader that splits on LF only and drops a trailing CR, instead of `readline`. Summaries are unchanged except that records containing raw U+2028/U+2029 (valid inside JSON strings) are no longer split and dropped; they now count exactly as `loadEntriesFromFile` loads them.
- `packages/coding-agent/src/core/session-summary-index-file.ts` (new): the on-disk format of `<sessions-dir>/.session-summaries.index` - a `{"version":1}` header, then one `{file,size,mtimeMs,summary}` JSON line per session; tolerant loading (missing or foreign header discards the file, unparsable lines are skipped, last line wins), whole-line appends that first close a torn tail, and atomic rewrite through a temp file plus `rename`.
- `packages/coding-agent/src/core/session-summary-index.ts` (new): `SessionSummaryIndex`, the per-directory second cache level. It loads lazily on the first in-memory miss it can serve (a per-process snapshot of entry stamps, trusted only while the index file's size and mtime are unchanged, skips the load for a changed or never-indexed file), appends summaries it lacks after a listing, and rewrites the file when it is unusable or its entry bytes exceed twice the live bytes. Live entries are capped at 256 MiB, keeping the most recently active sessions; entries for removed files are dropped on rewrite. Every index failure is swallowed and the listing streams instead.
- `packages/coding-agent/src/core/session-summary-cache.ts`: `readCachedSessionSummary(filePath, store?)` consults an optional `SessionSummaryStore` on an LRU miss before streaming, and records every served summary into it; `sessionSummaryStreamCount()` test seam; `clearSessionSummaryCache()` also forgets index snapshots.
- `packages/coding-agent/src/core/session-discovery.ts`: `buildSessionInfo` / `listSessionInfos` pass the store through; new `listSessionFilesInDir(dir, files, onLoaded)` lists one directory through its index and persists it; `listSessionsFromDir` uses it.
- `packages/coding-agent/src/core/session-manager.ts`: `listAll()` lists each project directory through `listSessionFilesInDir` in turn (so each directory's index is used and updated) with the same `(loaded, total)` grand-total progress.

### Why

- A cold process re-streamed every session file to list `/resume` rows: 5.6-27 s for a 1,089-session, ~2.5 GB directory, dominated by `readline`'s per-line async iteration. With a warm index the same cold listing reads one ~49 MB file.

### Why an extension could not handle it

- Session listing, the summary cache, and `SessionManager.list` / `listAll` are core session internals with no extension hook.

### Expected merge conflict zones

- LOW: the import line and the per-directory loop in `SessionManager.listAll` in `session-manager.ts`; the other files are fork-owned.

## 2026-09-24 - Profile /resume session switches under TIMING (senpi#2087)

### What changed

- `packages/coding-agent/src/core/timings.ts`: adds the `switch` namespace to `TimingLabel`.
- `packages/coding-agent/src/core/agent-session-runtime.ts`: `switchSession` resets the `switch` namespace and marks `beforeSwitch`, `open`, `apply`, and `rebind`; `teardownCurrent` marks `abort`, `shutdown`, and `dispose` when the reason is `resume`. Every mark is a no-op unless `TIMING=1` (brand or legacy prefix), exactly like the existing `reload` namespace.

### Why

- Resuming a 42.5 MB / 8,201-message session took 2-4 s from Enter to "Resumed session" with no way to see where the time went. The marks showed the switch has no single avoidable phase: the wall time is ~40 serial `session_start` handlers (~0.8 s self time) interleaved with the deferred transcript hydration (~0.65 s in 11 chunks), plus open/services/session construction/render at ~0.1 s each. `test/suite/switch-timings.test.ts` pins the runtime-owned mark sequence the same way `reload-timings.test.ts` pins the reload one.

### Why an extension could not handle it

- The phases are runtime internals (`SessionManager.open`, teardown, factory, rebind) that run before any extension of the new session is bound.

### Expected merge conflict zones

- LOW: the `TimingLabel` union in `timings.ts`; the import block, `switchSession`, and `teardownCurrent` in `agent-session-runtime.ts`.
