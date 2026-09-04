# changes

## 2026-09-03 - Skip context-incompatible fallback rungs and make the model switch transactional

### What changed

- `packages/coding-agent/src/core/retry-fallback/controller.ts`: `RetryFallbackControllerDeps` gained the injected `isCandidateUsable` capacity preflight and the `classifySwitchFailure` seam. `nextCandidate` now skips a rung whose window cannot hold the live conversation (`context-unusable`) and keeps walking; `tryFallback` walks the remaining rungs when applying a model is refused on capacity grounds after `model_select` ran, and rethrows any failure the classifier does not recognize so one broken extension cannot spend the whole chain. A turn-scoped, selector-keyed rejection ledger backs the new `exhaustion` accessor (`chainKey`, `from`, `reason`, `rejectedCandidates`); `exhaustedChainKey` is unchanged.
- `packages/coding-agent/src/core/agent-session.ts`: `_switchActiveModel` is now two-phase. Model, thinking level, service tier, and the server-side-fallback flag are applied provisionally so `model_select` handlers build against the target, but compaction invalidation, `model_changed`, `thinking_level_changed`/`thinking_level_select`, the service-tier event, the high-reasoning warning, `appendModelChange`, and the persisted default all wait until the post-`model_select` `assertModelUsable` clears. A rejected target is rolled back silently and extension-owned prompt/tool state is resynced by re-running `model_select` for the previous model. The seven duplicated exhaustion emits collapse into `_emitRetryFallbackExhausted`, which emits the unchanged session event plus the new extension event.
- `packages/coding-agent/src/core/extensions/types.ts`: new `RetryFallbackExhaustedEvent` (`sessionId`, `chainKey`, `from`, `lastError`, `lastErrorSha256`, `exhaustionReason`, `rejectedCandidates`) in the `ExtensionEvent` union with a `pi.on("retry_fallback_exhausted", ...)` overload. The digest correlates the bounded diagnostic to the complete failed error. It flows through the generic runner `emit` and returns no result: it is notification-only.
- Review hardening keeps the two-phase transaction scoped to automatic fallback while manual, cycle, restore, and fallback-revert switches retain their established committed-first event order. Rejected automatic fallbacks directly restore prompt, base prompt, active tools, requested/withheld tool names, model, thinking, tier, and server-fallback state; best-effort extension resynchronization cannot overwrite that snapshot. Exhaustion notifications do not block retry settlement and bound extension diagnostics to 8,192 error characters and 16 candidates.
- Persistence now defines the automatic-switch commit boundary: pre-commit failures roll back, while post-commit observer failures leave runtime state aligned with the durable `model_change`. `SessionManager` persists an entry before exposing it through in-memory indexes, so a filesystem failure cannot leave a phantom resident entry.
- Post-commit switch and fallback-event observer failures are logged and isolated so controller bookkeeping still records the applied rung. The retry-handler ownership boundary converts any remaining internal failure into a terminal `not-handled` outcome and resolves the retry promise, preventing a failed persistence or extension path from wedging `prompt()`.
- Session event listeners are failure-isolated per listener so an observer cannot abort core `agent_end` retry handling. Initial session-file publication now writes a private temporary file and atomically renames it, while failed append writes truncate back to the observed pre-append size before the in-memory entry is exposed. Extension exhaustion payloads cap every selector/model/error string as well as candidate count.

### Why

- The chain walk had no capacity dimension at all, so a 1M-window primary could fall back onto a 200K rung that cannot hold the conversation, trading one dead lane for another.
- The switch wrote its `model_change` entry before the budget assert, so a rejected target left an unpaired `reason: "fallback"` entry that session restore replays as a fallback window that was never entered, while thinking level and extension-swapped toolsets stayed on the rejected model.
- `ModelUsabilityBudgetError` escaping `tryFallback` reached `_processAgentEvent`, whose rejection is swallowed by the agent event queue, so `_resolveRetry()` never ran and `prompt()` hung on `waitForRetry()`.
- `retry_fallback_exhausted` existed only as an `AgentSessionEvent`, so an extension that could route the work to another model had no typed way to learn the parent model's chain was spent.

### Why an extension could not handle it

- Candidate selection, the model-switch commit boundary, and retry dispatch are private `AgentSession`/controller lifecycle state; extensions observe `model_select` only after the core has already mutated and persisted the switch, and cannot atomically defer or undo it.

### Expected merge conflict zones

- HIGH: `packages/coding-agent/src/core/agent-session.ts` around `_switchActiveModel` and the `_handleRetryableError` exhaustion branches.
- MEDIUM: `packages/coding-agent/src/core/retry-fallback/controller.ts` around `nextCandidate`, `tryFallback`, and the deps interface.
- LOW: `packages/coding-agent/src/core/extensions/types.ts` around the event union and the `on` overloads.
## 2026-09-04 - Skills prompt aliases each root to a short rN prefix

### What changed

- `skills.ts` `formatSkillsForPrompt`: emits a `<skill_roots></skill_roots>` table (one line per distinct root, `r0`, `r1`, ...) and renders each `<location>` as `alias/<name>/SKILL.md` plus a one-line expansion rule. `test/suite/skills-root-alias.test.ts` covers the table, alias re-join resolvability, and the character saving; `test/skills.test.ts` re-pins the location shape.

### Why

- The long absolute root was billed once per skill (145 skills): 23,381 -> 22,244 o200k tokens (-1,137) on the real set with no content removed.

### Why an extension could not handle this differently

- `skills.ts` owns the single renderer for the skills section; there is no extension seam for its formatting.

### Expected merge conflict zones

- LOW: `skills.ts` renderer body and `skills.test.ts` location assertion.

## 2026-09-04 - Restore the selected model, not its upstream wire id, on resume

### What changed

- `packages/coding-agent/src/core/session-manager.ts`: `getSessionContextSettings()` now treats an
  explicit selection (a manual `model_change`, or the primary model restored from a fallback window)
  as authoritative over later assistant messages from the same provider. An assistant message only
  redefines the restored model when no explicit selection is in force or when it comes from a
  different provider, which preserves legacy assistant-only sessions and the existing fallback
  window handling.

### Why

- A catalog entry that maps to an `upstreamModelId` (the `-fast` priority variants, e.g.
  `quotio-openai/gpt-5.6-sol-fast` -> `gpt-5.6-sol`) persists the upstream id on every assistant
  message, because the request went out with that id. The old restore let that echo overwrite the
  recorded selection, so resuming the session came back on the base model with no priority tier:
  the fast indicator was gone and `service_tier` left the wire. Regression:
  `test/session-manager/upstream-model-id-restore.test.ts`.

### Why an extension could not handle it

- Model restoration happens inside `SessionManager.buildSessionContext()` before the session or any
  extension exists; `session_start` observes the already-resolved (wrong) model.

### Expected merge conflict zones

- LOW: the `model` bookkeeping inside `getSessionContextSettings()` in `session-manager.ts`.

## 2026-09-03 - Make eval-only tool routing unconditional and registry-aware

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: replaces the settings-gated bash/workflow policy with the fixed eval-only set `bash`, `powershell`, `workflow`, and `monitor`; keeps SDK overrides, routes monitor guidance through its required `description` and command fields, filters prompt/hint names to the session registry, and preserves reload resolution and hint withdrawal.
- `packages/coding-agent/src/core/settings-manager.ts`: removes the deleted `experimental.bashEvalOnly` and `experimental.workflowEvalOnly` settings and getters while retaining `experimental.sharedHost`.

### Why

- Eval is the execution boundary for shell, workflow, and monitor operations whenever the registry provides it, so a settings key could disable the intended default and stale `powershell` guidance could reach macOS sessions that cannot provide that tool.

### Why an extension could not handle it

- Active-tool withholding, registry-backed execution, removed-tool hints, and system-prompt assembly are coordinated inside `AgentSession` before extension code can atomically enforce the policy; settings schema and getters are core load-time behavior.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/agent-session.ts` around eval-only policy constants, hint publication, prompt suffix assembly, tool registry refresh, and reload.
- LOW: `packages/coding-agent/src/core/settings-manager.ts` around `ExperimentalSettings` and the experimental getter block.

## 2026-09-02 - Provider stream-start default raised to 300s for slow thinking models

### What changed

- `packages/coding-agent/src/core/settings-manager.ts`: `DEFAULT_STREAM_START_TIMEOUT_MS` goes from 90_000 to 300_000, so the default provider stream-start watchdog grants 300s for the first SSE event. The effective value is still `min(default, idle timeout)`, explicit `retry.provider.streamStartTimeoutMs` overrides win unchanged, and `0` still disables the watchdog.
- `packages/coding-agent/src/core/settings-manager.ts`: `getRetrySettings()` now defaults `maxRetries` to 5 instead of 3, matching `SENPI_DEFAULT_RETRY_PROFILE.turn.maxRetries`. Without this the one `retry.maxRetries` key meant 5 on the turn stage but 3 on every `getRetrySettings()` consumer (session-title retry, compaction summarization retry, the agent-session retry gate), and the documented default could only be true for one of them.
- `packages/coding-agent/docs/settings.md`: the defaults table and the JSON example track the new default.

### Why

- Opus/Fable-class models with xhigh thinking routinely take longer than 90s to emit the first stream event, so the old default aborted healthy requests (`Provider stream start timed out after 90000ms`) and support had to tell users to raise the timeout by hand. Every comparable harness already grants 300s here (opencode's header timeout, codex's stream idle timeout, oh-my-pi's first-event timeout), and senpi's own stream idle default is already 300s.

### Why an extension could not handle it

- The value is a shipped core constant that applies only when no explicit setting exists; extensions can set `retry.provider.streamStartTimeoutMs` per session but cannot change the unset default every session inherits.

### Expected merge conflict zones

- LOW: the two default lines in `settings-manager.ts` (`DEFAULT_STREAM_START_TIMEOUT_MS`, the `getRetrySettings()` fallback) plus the matching rows in `docs/settings.md`.

## 2026-09-02 - Inherit extension provider settings for models.json custom models

### What changed

- `packages/coding-agent/src/core/provider-composer.ts` now lets models.json custom models inherit an extension-registered provider's `api` and `baseUrl`, and preserves extension catalog models when adding new custom IDs.

### Why

- A custom models.json model under an extension provider previously failed before the extension could compose it because the models.json layer could not see the extension's provider-level settings; models.json custom definitions not declared by the extension catalog were also dropped.

### Why an extension could not handle it

- Provider composition order and models.json merging are core responsibilities in `packages/coding-agent/src/core/provider-composer.ts`, before extension model behavior can repair the intermediate layer.

### Expected merge conflict zones

- LOW: models.json and extension composition in `packages/coding-agent/src/core/provider-composer.ts`.

## 2026-09-02 - Name the retry stream-start setting

### What changed

- Provider retry continuation watchdog abort messages now name `retry.provider.streamStartTimeoutMs` and explain that `0` disables the guard.

### Why

- Users need an actionable setting name when a retry continuation watchdog reports a provider stream-start stall.

### Why an extension could not handle it

- The watchdog is owned by `AgentSession` and aborts the core agent directly, before extension hooks can rewrite the error.

### Expected merge conflict zones

- LOW: `agent-session.ts` retry watchdog abort message builder.

## 2026-08-31 - Session activity contract for host occupancy decisions

### What changed

- `session-activity.ts` (new): the single definition of session-owned activity - `SessionActivitySnapshot` (agent run, bash, compaction, session-work barrier), `WakeSourceTracker` for extension-published `wake_source_state` counts, and the `isSessionBusySnapshot()` predicate composing them.
- `agent-session.ts`: `AgentSession` exposes `activitySnapshot` and `isSessionBusy`, and subscribes to `wake_source_state` on every extension bind so background terminal jobs, terminal monitors, and loop-guard holds count as live work; the subscription is dropped on dispose and counts deliberately survive an extension reload.
- `extensions/runner.ts`: `onBusEvent(channel, handler)` exposes the session's extension event bus for those activity signals, alongside the existing `onRpcEvent`.

### Why

- The shared RPC host's idle eviction asked only `isStreaming`/`isBashRunning`, so a session whose work outlives the turn - an auto-detached background terminal job, a running compaction, or barrier-held continuation work - could be torn down at the idle threshold, killing the user's job. Teardown decisions now consult one composed predicate, so a future activity source is picked up by every call site at once instead of being missed per call site.

### Why an extension could not handle it

- The predicate is consumed by host lifecycle code beneath every extension surface, and it must aggregate in-session state (`_isAgentRunActive`, the compaction lifecycle, the session-work barrier) that no extension can observe.

### Expected merge conflict zones

- LOW: the new `session-activity.ts` module, the activity getters and `_bindExtensionCore` subscription in `agent-session.ts`, and the `onBusEvent` helper in `extensions/runner.ts`.

## 2026-08-31 - Release refusal fallback pins on compaction

### What changed

- `packages/coding-agent/src/core/retry-fallback/controller.ts` records pin provenance and exposes `notifyCompactionApplied` to release refusal-caused pin contributions.
- `packages/coding-agent/src/core/agent-session.ts` calls `_onCompactionContextChanged` at the `_executeCompaction` success seam and eagerly restores the original model; billing pins and `fallbackRevertPolicy "never"` are unaffected, and there is no new settings key.

### Why

- Refusal pins encode "same context refuses again"; compaction rewrites the context, so one fresh primary attempt per successful apply is correct. This is always-on by user decision, with no config key.

### Why an extension could not handle it

- The pin state and restore gate live inside core retry-fallback controller state and the agent-session compaction apply seam. Extensions observe compaction events but cannot mutate `ActiveFallbackState` or re-enter the internal restore gate.

### Expected merge conflict zones

- The prepend zone at the top of `packages/coding-agent/src/core/changes.md`.
- The `tryFallback` state-write hunk in `retry-fallback/controller.ts`.
- The `_executeCompaction` success tail in `agent-session.ts` (near other compaction-lifecycle work).

## 2026-08-31 - Bound the session manager's in-memory mirror

### What changed

- `session-resident-store.ts` now evicts oldest externalized strings above a conservative 64 MiB per-session budget.
- `session-manager.ts` trims superseded pre-compaction entries from its live mirror and reloads the JSONL when a pruned branch is selected.

### Why

- The JSONL is the source of truth; retaining every serialized tool result and historical entry in RAM caused active sessions to grow without bound.

### Why an extension could not handle it

- Session persistence, compaction, branching, and the resident mirror are core `SessionManager` responsibilities below the extension API.

### Expected merge conflict zones

- LOW: resident string storage and `appendCompaction()` mirror maintenance.
## 2026-08-31 - Shared session host is OFF by default (opt-in)

- Interactive sessions no longer join the shared RPC host implicitly. `main.ts` now gates
  `createInteractiveHostRuntime` on `shouldJoinSharedHost()` (`core/shared-host-policy.ts`): a bare
  interactive session stays purely local and never opens `<agentDir>/rpc/rpc.sock`.
- Opt in persistently with the `experimental.sharedHost` setting, or per-process with the
  brand-prefixed `ENABLE_SHARED_HOST` env flag (`SENPI_ENABLE_SHARED_HOST=1` / `OMO_ENABLE_SHARED_HOST=1`) (`SettingsManager.getExperimentalSharedHost()`). Non-interactive
  modes (print, json, rpc, app-server) are unaffected; the app-server / `--multi-session` host owns
  its own transport.
- The former opt-out `DISABLE_SHARED_HOST` is obsolete: it is now the default, and setting it prints a
  one-time notice pointing at the opt-in flag.

## 2026-08-30 - Durable entry notifications are rpc-scoped

## 2026-08-30 - Wire ideal compaction execution through AgentSession

### What changed

- `packages/coding-agent/src/core/agent-session.ts` routes compaction through the ideal compaction execution pipeline while preserving the existing session lifecycle and transcript accounting contracts.

### Why

- The feature's compaction policy and execution layers need the session-owned model, settings, and transcript state at the integration boundary.

### Why an extension could not handle it

- Compaction dispatch is owned by `AgentSession`, before extension-level behavior can replace the session lifecycle integration.

### Expected merge conflict zones

- LOW: compaction dispatch in `agent-session.ts`.

## 2026-08-30 - Do not cancel client work from a binding-time tool change

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `setActiveToolsByName()` calls `abortCompaction()` and `_incrementMessageRevision()` only when the tool change happens outside extension binding, detected through the existing `_extensionBindingPromptReadiness` scope that `bindExtensions()` already maintains.

### Why

- A session replacement responds as soon as the swap is committed and rebinds extensions afterwards, by design: awaiting the bind would deadlock a client whose `session_start` handler blocks on an `extension_ui_request`. During that bind, `session_start` handlers deactivate tools for the active model (`video-in`, `look-at`), the tool set changes, and the abort plus revision bump cancelled a compaction the client had already started against the committed session - "Compaction cancelled" on roughly 4 of 6 runs, verified by capturing the abort stack inside the host process. Tool activation performed while binding is part of the binding, not a mid-session context change, so it must not invalidate that work. Mid-session tool changes still abort and bump exactly as before.

### Why an extension could not handle it

- The abort is core session lifecycle beneath the extension API, and the extensions involved are the ones whose binding triggers it.

### Expected merge conflict zones

- LOW: the `activeToolNamesChanged` branch in `setActiveToolsByName()`.


## 2026-08-30 - Drop the classic host-UI no-op stub

- `agent-session.ts`: `_emitEntryAppended` only fires while the session is bound in `rpc`
  mode. The notifications exist to hydrate the shared-host RPC proxy mirror; emitting them
  on classic/print streams injected extra labels into the released event-order contract
  (`agent-session-retry-events`, `retry-fallback-engine` pin the full ordered label list and
  the byte-for-byte no-chain retry contract).
- `agent-session-prompt.test.ts` binds `mode: "rpc"` before asserting durable prompt entries,
  so the new-behavior test exercises the lane the contract actually covers instead of the
  default print lane.


## 2026-08-30 - Experimental workflow eval-only policy

### What changed

- `packages/coding-agent/src/core/settings-manager.ts`: adds the `experimental.workflowEvalOnly` setting and its getter.
- `packages/coding-agent/src/core/agent-session.ts`: resolves the policy from settings in the constructor and on reload, hides the `workflow` tool while the registered `eval` tool is present, executes it through the registry without activation, publishes an eval-cell hint, adds system-prompt guidance, and retains the withheld tool so disarming restores direct access.

### Why

- Codemode can keep invoking the workflow (dag) tool from eval cells while preventing it from being advertised as a direct model tool. The policy is inert when codemode's `eval` tool is unavailable, so workflow access is never lost.

### Why an extension could not handle it

- Active tool visibility, lazy activation, the wrapped registry, and the agent-loop removed-tool hint map are coordinated inside `AgentSession`; an extension cannot atomically enforce these boundaries.

### Expected merge conflict zones

- `agent-session.ts`: active-tool selection, tool registry refresh, reload, and system-prompt assembly.
## 2026-08-29 - Bound Cursor serialized tool-result admissions

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: Cursor tool-result request views now use a conservative escaped/enveloped serialization bound and never amplify output with markers.

### Why

- Cursor duplicates history across JSON and protobuf envelopes, and JSON escaping makes raw-byte heuristics unsafe.

### Why an extension could not handle it

- AgentSession owns provider admission and the request-only transform boundary.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts`

## 2026-08-29 - Final shared-host bash callback coverage

### What changed

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/bash-executor.ts`

### Why

- Preserve callback rejection through shared-host cleanup.

### Why an extension could not handle it

- Core callback dispatch owns this boundary.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/bash-executor.ts`

## 2026-08-29 - Complete shared-host shell callback propagation

### What changed

- `packages/coding-agent/src/core/agent-session.ts` now observes asynchronous bash output callbacks and preserves the original callback failure through cleanup.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts` aborts shared-host commands when those callbacks reject and rethrows the original value at the client boundary.

### Why

- The shared-host execution path could otherwise resolve successfully after an asynchronous callback rejection and leave its large-output spill file behind.

### Why an extension could not handle it

- The callback is dispatched by the core session and RPC host boundary before extension code can finalize execution cleanup.

### Expected merge conflict zones

- LOW: bash callback dispatch in `agent-session.ts` and shared-host execution routing.

## 2026-08-29 - Bound bash callback settlement and cleanup

### What changed

- `packages/coding-agent/src/core/bash-executor.ts` bounds callback settlement on normal completion, reports callback abandonment as an execution error, and clears or unreferences its race timer.

### Why

- A never-settling output callback could hang a command indefinitely or leave a late callback failure and large-output spill unobserved.

### Why an extension could not handle it

- Bash callback settlement and spill-file cleanup are owned by the core executor lifecycle before extension code can observe the completed command.

### Expected merge conflict zones

- `packages/coding-agent/src/core/bash-executor.ts`: callback settlement timeout and final spill cleanup.

## 2026-08-29 - GLM-5.3 model resolver defaults

### What changed

- `packages/coding-agent/src/core/model-resolver.ts`: retain the GLM-5.3 Z.AI global and China default model and prompt-preset resolution introduced by this PR.

### Why

- The new Z.AI model family must remain the default for both coding-plan provider variants after synchronizing with upstream changes.

### Why an extension could not handle it

- Provider defaults and model-pattern resolution are core resolver behavior that runs before extension hooks.

### Expected merge conflict zones

- `packages/coding-agent/src/core/model-resolver.ts`: provider default mappings and model pattern resolution.

## 2026-08-29 - Make externally owned compaction delegation sticky

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: remember the provider and model id after an automatic compaction is rejected by an external owner, suppressing repeated automatic attempts until that key changes, compaction is accepted, or runtime ownership is reconfigured by reload/registry refresh. Manual compaction remains admitted.
- Added `test/suite/regressions/1174-sticky-delegated-compaction.test.ts` covering repeated turns, manual compaction, and model changes.

### Why

- A provider-owned compaction lane previously caused the core to emit a new automatic compaction attempt on every turn, repeatedly producing rejection events and repainting the same error.

### Why an extension could not handle it

- Automatic compaction admission and lifecycle state are private `AgentSession` control flow that runs before extension hooks are emitted.

### Expected merge conflict zones

- `agent-session.ts`: compaction state, automatic admission methods, rejection handling, model selection invalidation, and tree navigation.

## 2026-08-29 - Experimental bash eval-only policy

### What changed

- `packages/coding-agent/src/core/settings-manager.ts`: adds the `experimental.bashEvalOnly` setting and its getter.
- `packages/coding-agent/src/core/agent-session.ts`: resolves the policy from settings in the constructor and on reload, hides the `bash` and `powershell` tools while the registered `eval` tool is present, executes them through the registry without activation, publishes per-tool eval-cell hints, adds system-prompt guidance, and retains withheld tools so disarming restores direct access.

### Why

- Codemode can keep invoking `bash` and `powershell` from eval cells while preventing those tools from being advertised as direct model tools. The policy is inert when codemode's `eval` tool is unavailable, so shell access is never lost.

### Why an extension could not handle it

- Active tool visibility, lazy activation, the wrapped registry, and the agent-loop removed-tool hint map are coordinated inside `AgentSession`; an extension cannot atomically enforce these boundaries.

### Expected merge conflict zones

- `agent-session.ts`: active-tool selection, tool registry refresh, reload, and system-prompt assembly.

## Compaction settings resolution moved out of the settings manager (2026-08-29)

### What changed

- `settings-manager.ts` delegates compaction knob resolution to `compaction-settings-resolver.ts`
  instead of resolving every field inline. The manager keeps its public accessor shape; the resolver
  owns the defaults for the ideal-pipeline knobs (grace band, tool admission, reminder, reserve
  scaling, speculative lead).

### Why

- `settings-manager.ts` was already well past the module size ceiling. This branch adds compaction
  knobs, and the project rule forbids growing an already-oversized file, so the added resolution
  became its own module.

### Why an extension could not handle it

- These defaults are read by core admission before any extension runs, so they cannot be supplied
  from extension space.

### Expected merge conflict zones

- Upstream changes to `getCompactionSettings` now touch `compaction-settings-resolver.ts` as well as
  `settings-manager.ts`.

## Reject model downswitches that exceed the target budget (2026-08-30)

### What changed

- `packages/coding-agent/src/core/agent-session.ts` adds current live-context usage to the assembled
  model budget before direct or favorite-cycle downswitches. Rejected switches leave the active
  model, persisted session history, and global defaults unchanged.
- The rejection reports every measured budget component and directs callers to compact, revalidate,
  and retry. A successful manual compaction reduces the live projection, so the same explicit switch
  can then be retried normally.

### Why

- A session accumulated under a million-token model could previously commit a 372K model before
  discovering that its live transcript plus prompt, tools, and reserves did not fit. The next turn
  then entered emergency overflow recovery from a model state that was invalid when selected.

### Why an extension could not handle it

- Direct and favorite-cycle model selection mutate private session state and persistence before a
  post-selection extension hook runs. Admission must happen at that shared pre-commit boundary.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/agent-session.ts` around `_setModel`,
  `_cycleFavoriteModel`, and the model-budget assertion.

## Reject models with unusable assembled context budgets (2026-08-30)

### What changed

- `packages/coding-agent/src/core/agent-session.ts` projects the selected model against the current
  assembled system prompt, active tool schemas, output reserve, effective compaction reserve,
  speculation lead, and model-family safety margin before mutating explicit model selection.
- `packages/coding-agent/src/core/sdk.ts` runs the same projection after `AgentSession` construction,
  when the initial runtime prompt and active tools have been assembled, and rejects setup with the
  projection's precise budget diagnostic when the model is unusable.

### Why

- A small context window can put the fixed speculation lead at or beyond its compaction threshold.
  Accepting that model creates a session with no useful conversation budget and causes permanent
  compaction; setup and explicit selection now fail before provider traffic or model mutation.

### Why an extension could not handle it

- Session construction and explicit model mutation are core boundaries. Extensions cannot reject
  initial creation after the final prompt/tool assembly or atomically guard every model-selection
  caller before persistence.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/agent-session.ts` around `_setModel` and the public budget
  assertion used by runtime setup.
- LOW: `packages/coding-agent/src/core/sdk.ts` immediately after `AgentSession` construction.

## Compaction settings resolution moved out of the settings manager (2026-08-29)

### What changed

- `settings-manager.ts` delegates compaction knob resolution to `compaction-settings-resolver.ts`
  instead of resolving every field inline. The manager keeps its public accessor shape; the resolver
  owns the defaults for the ideal-pipeline knobs (grace band, tool admission, reminder, reserve
  scaling, speculative lead).

### Why

- `settings-manager.ts` was already well past the module size ceiling. This branch adds compaction
  knobs, and the project rule forbids growing an already-oversized file, so the added resolution
  became its own module.

### Why an extension could not handle it

- These defaults are read by core admission before any extension runs, so they cannot be supplied
  from extension space.

### Expected merge conflict zones

- Upstream changes to `getCompactionSettings` now touch `compaction-settings-resolver.ts` as well as
  `settings-manager.ts`.

## 2026-08-29 - Withheld tools are filtered at the advertisement seam

### What changed

- `agent-session.ts`: names in `temporarilyDisabledToolNames` are dropped from `definitionRegistry`
  (which becomes `_toolDefinitions`, and therefore the prompt snippets and guidelines) and from the
  DEFAULT `nextActiveToolNames` selection. `_baseToolDefinitions` stays unfiltered, so
  `_toolRegistry` remains whole, and an explicit `activeToolNames` request still activates the tool.

### Why

- Filtering `_baseToolDefinitions` also emptied `_toolRegistry`, which `getRegisteredTool` serves.
  That method is documented to resolve "from the full registry ... independent of the active set"
  precisely because the Cursor exec bridge drives its own native read/bash/grep/ls frames regardless
  of what the request advertised, so every Cursor grep frame would have answered
  `Tool "grep" is not available in this session`. Withholding now happens only where the
  model-facing surface is derived, leaving programmatic name-based resolution working.
- The active-name filter applies to the default selection only. A caller that passes
  `activeToolNames` has named the tool deliberately; overriding that would have broken
  `filesystem-policy`'s contract that policies reach all six built-in file tools, and the
  `defaultTools` explicit-precedence guard.

### Why an extension could not handle it

- `_toolDefinitions`, `_toolRegistry`, and the active tool names are private session state built in
  one pass inside `AgentSession`; no extension hook runs between their construction and first use,
  so the split between the advertised surface and the resolvable registry can only be made here.

### Expected merge conflict zones

- `agent-session.ts`: the `definitionRegistry` construction and the `nextActiveToolNames` filter
  both gained a `temporarilyDisabledToolNames` guard alongside the existing `isAllowedTool` call.
  Upstream edits to either filter will conflict; keep the upstream predicate change and re-apply
  the withheld-name guard next to it.

- Model runtime credential admission counts the combined canonical environment and policy slot lane, admitting rotation for more than one live slot without acquiring leases during preflight.

## 2026-08-28 - Credential pool parity follow-ups

- Half-open leases now admit their holder exactly once for stored and environment probes.
- Named `models.json` credential slots participate in rotation, policy cooldown bases drive initial backoff,
  full streams preserve session affinity, and account health follows the auth storage directory.
- Bare-family fallback opt-outs normalize provider namespaces, and the shipped `"*"` lane is accepted by validation.

## 2026-08-28 - Wildcard fallback lane for chainless models

### What changed

- `packages/coding-agent/src/core/retry-fallback/chains.ts`: added the `WILDCARD_CHAIN_KEY` (`"*"`),
  taught `canonicalizeFallbackChains` to expand and tombstone it (both existing loops skip it because
  it is not a model selector), gave `resolveChainKey` an opt-in `allowWildcard` fallthrough, and added
  `hasExplicitFallbackOptOut` so a `[]` tombstone on the current model's exact/base/bare-family key
  suppresses the lane.
- `packages/coding-agent/src/core/retry-fallback/settings.ts`: `DEFAULT_FALLBACK_CHAINS` ships a `"*"`
  lane mirroring the Fable default rungs.
- `packages/coding-agent/src/core/retry-fallback/controller.ts`: `nextCandidate` resolves in the order
  own chain -> active episode's `chainKey` -> wildcard (gated on the opt-out check).

### Why

- Desktop thread 487d7c29 (2026-08-28) burned nine consecutive turns on upstream 500s from
  `apitopia/kimi-k3-unlocked` with zero fallback attempts and wedged terminal `error`; a manual model
  switch recovered it instantly. `DEFAULT_FALLBACK_CHAINS` only keyed `claude-fable-5`, so the
  manually selected model resolved no chain and `canTryFallback()` was permanently false.
- Ordering is load-bearing: an unconditional wildcard fallthrough hijacked sessions already walking a
  configured chain (their last rung usually has no key either), which the engine suite caught as a
  7 -> 5 call-count regression.
- The opt-out gate exists because canonicalization deletes tombstoned keys, which would otherwise let
  the shipped wildcard silently resurrect fallback for a user who explicitly disabled it.

### Why an extension could not handle it

- Chain resolution and candidate selection are private `RetryFallbackController` state; extensions see
  fallback events only after the core has already decided not to rotate.

### Expected merge conflict zones

- LOW: the `resolveChainKey` tail and the `canonicalizeFallbackChains` return block in `chains.ts`.
- LOW: the `chainKey` resolution expression in `controller.ts`.

## 2026-08-28 - Credential pool runtime wiring

- Normal simple agent streams now use credential rotation, session ids provide affinity, pinned accounts win selection, expired cooldowns use one half-open probe, successful probes persist health, and custom agent directories scope sidecar state.

## 2026-08-28 - Credential pool final-account removal

- Removing the last stored account now deletes the provider credential instead of leaving stale auth.json data.

## 2026-08-28 - SessionManager reloadFromDisk for external/shared-host mutations

### What changed

- `packages/coding-agent/src/core/session-manager.ts`: added `reloadFromDisk()` to reload `fileEntries`, update internal maps/caches, and rebuild index from `this.sessionFile` if it exists.
- Enables in-process mirrors (such as interactive host proxy) to synchronize with external changes like host-committed compactions.
## 2026-08-27 - Default retry policy phase-2 close-out (docs)

### What changed

- `packages/coding-agent/src/core/retry-fallback/profile-override.ts`: the `retry.providers.<providerId>` override surface accepts per-provider scheduling-knob overrides validated against `RetryStageOverride` (fields: `enabled`, `maxRetries`, `baseDelayMs`, `growthFactor`, `perAttemptCapMs`, `jitter`, `serverHintMaxDelayMs`). An entire provider entry is rejected atomically when any knob is invalid.
- Recommended settings snippet for users who configure no fallback chain and want a larger same-model budget:
  ```jsonc
  {
    // Raise the turn retry budget for a single-provider setup.
    // maxRetries must be a non-negative safe integer.
    "retry": {
      "providers": {
        "<providerId>": {
          "turn": {
            "maxRetries": 5
          }
        }
      }
    }
  }
  ```
- The default same-model turn retry budget stays at 3 retries. This is an intentional non-change: the budget was reviewed during phase-2 close and kept at its existing value for all providers that don't declare their own profile.
- No new kimi-code observability or telemetry surface was adopted.
- Regression coverage: `packages/coding-agent/test/suite/regressions/retry-default-no-kimi-leak.test.ts` guards senpi-default against kimi semantics leaking in (no-hint 429 first-failure fallback, 1258000ms hint tier routing, billing 429 pinned fallback, abort during backoff single `auto_retry_end`).
- Tracked in `packages/ai/src/changes.md` and `packages/coding-agent/src/core/changes.md`.

### Why

- Users running a single provider without a fallback chain benefit from a higher retry budget, but the default stays conservative (3) to avoid masking persistent failures when fallback providers are available. The snippet documents the exact override path so users don't have to read the validation source.

### Why an extension could not handle it

- `retry.providers` overrides are resolved inside `resolveRetryProfile` in `packages/coding-agent/src/core/settings-manager.ts`, before any extension hook. The validation and merge happen at settings load time.

### Expected merge conflict zones

- NONE: doc-only section append; no code files touched.

## Provider-neutral credential accounts (2026-08-27)

### What changed

- `packages/coding-agent/src/core/credential-accounts.ts` (new): provider-neutral account surface over the pool slot algebra - `getCredentialAccounts`/`summarizeCredentialAccounts` list stored slots (env slots only when nothing is stored, mirroring resolution precedence), `pinCredentialAccount` pins/unpins, `removeCredentialAccount` removes a stored slot and drops its sidecar health (env-backed accounts refuse removal). Blocked state reads BOTH sources: a slot's own persisted `blockedUntil`/`blockReason` and the pool sidecar. Mutations emit `emitProviderAccountsChanged` so subscribed clients re-read. Summaries carry names and health only, never key material.
- `packages/coding-agent/src/main.ts`: `auth check --json` now includes a non-secret `accounts` array (name/source/blocked/pinned) for the checked provider; enrichment failures never turn a readable auth state into an error.

### Why

- Account management was confined to the claude-sdk-oauth lane (`assertManagedProvider` hard-rejected every other provider). Generic multi-credential pools need one surface that works for every provider, and scripts consuming `auth check --json` need account visibility without parsing auth.json.

### Why an extension could not handle it

- The RPC and app-server consumers dispatch these operations inside core connection handling; an extension cannot replace their imports, and account listing needs the auth storage and pool sidecar wiring that live in core.

### Expected merge conflict zones

- LOW: `main.ts` auth-check output composition (one enrichment block); `credential-accounts.ts` is fork-new.

## 2026-08-27 - Credential pool: health sidecar, policy schema, env slots, in-lane rotation

### What changed

- `packages/coding-agent/src/core/credential-pool/state-store.ts` (new): file-locked health sidecar at `<agent-dir>/credential-pool-state.json` (mode 0600, `FILE_STORAGE_LOCK_OPTIONS`) holding ONLY health - absolute cooldown deadlines, permanent auth/billing blocks, half-open probe leases, `lastSuccessAt`, and HMAC-derived env-slot revisions. `CredentialSlotRepository.mutateSlotState` is an atomic read-modify-write with a `stateVersion` increment; `acquireHalfOpenLease` transitions an elapsed cooldown to half-open for exactly one probing caller. An unreadable or schema-invalid document resets to fresh state rather than failing auth resolution.
- `packages/coding-agent/src/core/credential-pool/classify.ts` (new): concrete provider-error taxonomy over `normalizeProviderError` and the existing 429 retry-hint parser. 401/invalid-key and account-scoped 403 block permanently and fail over; bare 403 fails the request; 429 fails over with a per-slot exponential cooldown floored (never overridden) by the server hint and capped at 48h; billing/quota-exhausted disables the account; 5xx/529/overload/network retry the SAME slot without blocking it; overflow, invalid model, 400, 404, malformed stream, and abort fail the request.
- `packages/coding-agent/src/core/credential-pool/failover.ts` (new): `runCredentialFailover` re-reads slots before each distinct-credential attempt (so a newly added slot participates), runs at most one failover attempt per slot per request, settles a failed stream before starting the next, persists the block BEFORE selecting a replacement, and requires an `isCommittedOutput` predicate whose contract is default-DENY. Committed output bars rotation and the rethrow carries the existing `senpi:no-turn-retry:` marker.
- `packages/coding-agent/src/core/credential-pool/env-slots.ts` (new): numbered env credential slots for any provider (`<VAR>`, `<VAR>_2` .. `<VAR>_16`), gap-tolerant, over the canonical `getApiKeyEnvVars` mapping.
- `packages/coding-agent/src/core/credential-pool/rotation-stream.ts` (new): lists a provider's rotation slots with sidecar health overlaid (stored lane when a credential exists, env lane otherwise), selects by sha256 HRW over the request affinity key, and persists blocks per lane. An env slot's persisted health applies only while its HMAC revision still matches the current value.
- `packages/coding-agent/src/core/model-runtime.ts`: `ModelRuntime.stream` engages that rotation only when the provider actually holds more than one slot and nothing pins the request to a single credential (runtime key, explicit per-request `apiKey`, or `credentials.rotation: false`); `prepareRequest` accepts a per-attempt slot override, and `ModelRuntimeAuthOverrides.slotName` plumbs slot-scoped resolution.
- `packages/coding-agent/src/core/model-config-schema.ts`: per-provider `credentials` policy block (`additionalProperties: false`) with `rotation`/`affinity` toggles, cooldown bounds, and named slot references to env vars or command values; `CREDENTIAL_POLICY_DEFAULTS` re-exports the engine constants so schema and runtime cannot drift.

### Why

- Multi-credential rotation needs durable per-slot health that survives restart with absolute deadlines, a taxonomy that distinguishes credential-scoped from provider-scoped faults (blocking a healthy credential for a provider outage only destroys prompt-cache locality), and a request-level runner that exhausts a lane's slots before the model fallback chain above it is consulted. Health cannot live in `auth.json`: that file is credential material under its own lock, and mixing volatile block state into it would rewrite user credentials on every rate limit.

### Why an extension could not handle it

- `ModelRuntime.stream` is the one place where a request's provider auth is resolved and the provider stream is constructed; per-attempt credential selection has to happen inside it. The sidecar likewise needs `getAgentDir()` and the shared file-storage lock policy, neither of which is reachable through the extension API.

### Expected merge conflict zones

- MEDIUM: `model-runtime.ts` `prepareRequest`/`stream` (upstream-owned request construction; the rotation branch is additive and the single-credential path is unchanged).
- LOW: `model-config-schema.ts` provider block (one optional property); the `credential-pool/` directory is fork-new with no upstream counterpart.

## 2026-08-26 - Capture bash spill-file errors before the first write

### What changed

- `packages/coding-agent/src/core/bash-executor.ts`: attaches an `error` listener as soon as the
  full-output `WriteStream` is created, records the first failure, and rejects the bash execution
  through the terminal `close` boundary even when a late filesystem close failure follows `finish`.
- The close helper waits for `close`, preserves the first storage failure, and removes its error and
  close listeners after settlement so a stream cannot resolve successfully before final storage state
  is known or retain listeners after cleanup.
- Successful command finalization now runs outside the command-execution catch, so an already-set
  abort signal cannot reinterpret a spill close failure as a successful cancelled result.
- Decoder flushing and output preparation now close the spill stream before propagating a callback
  or formatting failure; if cleanup also fails, both errors are preserved in an `AggregateError`.

### Why

- A full `/tmp` or exhausted user quota can make the spill stream emit `ENOSPC` or `EDQUOT` while
  command output is still arriving, or during the final filesystem close after `finish`. The close
  path must therefore wait for `close`, rather than treating `finish` as durable completion; the first
  storage failure is reported instead of returning a successful result with an incomplete path.

### Why an extension could not handle it

- The stream is created and written inside the core bash executor before extension result hooks
  receive control.

### Expected merge conflict zones

- LOW: the temp-file stream creation and close lifecycle in `bash-executor.ts`.

## 2026-08-26 - Continue provider fallback after failed required compaction

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: Cursor token-bearing quota `resource_exhausted`
  and eligible hard-error failures now advance the provider fallback chain when required pre-retry
  compaction is rejected (`retryContinuationBlocked` no longer covers those two classes). Ordinary
  transient retries remain compaction-blocked, and zero-token Cursor `resource_exhausted` keeps its
  compact-before-rotate contract.
- `packages/coding-agent/src/core/agent-session.ts`: the hard-error fallback not-switched path now
  emits `retry_fallback_exhausted` when the configured chain has no usable candidate, mirroring the
  refusal path.

### Why

- Cursor usage-pool exhaustion surfaces as `resource_exhausted` that also demands required
  compaction; the compaction generator runs on the same dead lane and always fails, so the old
  blocking wedged the turn ("Compaction rejected: compaction generator failed" then "Retry failed
  after 1 attempts") and the fallback chain never advanced to the next provider.
- The silent not-switched path gave the TUI no signal about why no fallback hop happened.

### Why an extension could not handle it

- `retryContinuationBlocked`, required-compaction admission, and fallback dispatch ordering are
  private `AgentSession` agent_end lifecycle state; extensions observe compaction and fallback
  events only after the core has already made the dispatch decision.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/agent-session.ts` agent_end retry/compaction dispatch
  block and the `_handleRetryableError` hard-error branch.

## 2026-08-26 - Uncaught-crash writer on the debug-log lane

### What changed

- `packages/coding-agent/src/core/hidden-stdout-log.ts`: factored the existing append (timestamp
  header + `redactSensitiveOutput` + `0o600` debug log) into a private `appendDebugLogEntry` and
  added the sibling `appendUncaughtCrashLog(origin, error)`, which writes the distinct
  `uncaught crash (<origin>)` header plus the error identity and stack. `appendHiddenTuiStdout`
  keeps its exact `hidden stdout while TUI active` header and empty-chunk skip.

### Why

- The interactive crash handler needed a redacted, permission-locked lane into the brand debug log,
  and the hidden-stdout writer already owned that lane. A distinct header keeps crash records
  greppable and prevents them from being read as suppressed TUI stdout.

### Why an extension could not handle it

- Fork-only file (absent from the pinned upstream tree); it is the core writer for the brand debug
  log and runs inside the fatal crash path, where no extension code executes.

### Expected merge conflict zones

- NONE: the file does not exist upstream.

## 2026-08-26 - Reject no-progress manual compaction before active abort

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `AgentSession.compact()` now runs the existing
  `prepareCompaction()` check before claiming manual admission or aborting an active agent run.
- A no-progress request still emits balanced manual `compaction_start` / failed `compaction_end`
  events and the existing `session_compact_failed` hook, but it leaves the active continuation alive.

### Why

- A manual compaction request can arrive after automatic tool-result compaction has committed but
  while that same turn's next provider call is streaming. The old order aborted the provider
  continuation first and only then discovered that the pre-abort branch had nothing left to
  summarize, terminally ending otherwise healthy goal work.

### Why an extension could not handle it

- Manual compaction admission, active-agent abort ownership, and the pre-abort branch snapshot are
  private `AgentSession` lifecycle state. An extension observes compaction hooks only after the core
  has already admitted the operation.

### Expected merge conflict zones

- HIGH: `packages/coding-agent/src/core/agent-session.ts` around the public `compact()` entry point.

## 2026-08-23 - Provider-declared retry policy profiles (session wiring)

### What changed

- `packages/coding-agent/src/core/provider-composer.ts`: forwards `retryPolicy` through provider composition (`extension?.retryPolicy ?? base?.retryPolicy`) so composed providers never silently drop provider-declared retry profiles. `ProviderConfigInput` gained the `retryPolicy` field for config-layer injection.
- `packages/coding-agent/src/core/retry-fallback/settings.ts`: `RetrySettings` gained `providers?: Record<string, RetryPolicyOverride>` for per-provider scheduling-knob overrides.
- `packages/coding-agent/src/core/retry-fallback/profile-override.ts` (new): `validateRetryProviderOverrides` returns warnings (never throws, never mutates) for the `retry.providers.<id>` map, rejecting an entire provider entry atomically when any knob is invalid, and warning once on unknown provider ids.
- `packages/coding-agent/src/core/settings-manager.ts`: `resolveRetryProfile(provider)` resolves the effective profile with documented precedence: shipped senpi-default -> provider-declared profile -> user global (no-profile providers only) -> `retry.providers.<id>` -> `retry.enabled` hard gate.
- `packages/coding-agent/src/core/agent-session.ts`: `_handleRetryableError` resolves the profile once per failure. `fallback.rateLimited` decides 429 routing ("tiered" keeps today's hint tiers, "after-turn-budget" routes 429s through the ordinary same-model budget). Profile ceiling null bypasses the over-ceiling error path. The kimi routing marks `is429TierRouted` to prevent double-counting with the generic non-429 path. Every same-model budget check (`_willRetryAfterAgentEnd`, `_degradeRateLimitedWithoutFallback`, and all `_handleRetryableError` branches incl. the `auto_retry_start.maxAttempts` field) reads the resolved profile's `turn.maxRetries` — identical to `settings.maxRetries` for providers without a declared profile, and the declared budget (kimi-code's 9) otherwise.
- `packages/coding-agent/src/core/sdk.ts`: `streamFn` resolves the profile's `providerRequest` stage for `maxRetries`/`maxRetryDelayMs`; a profile with `providerRequest.enabled === false` sends `maxRetries: 0`.

### Why

- The kimi-coding provider needs kimi-code's own retry policy (10 attempts, uncapped server hints, no immediate 429 fallback) while every other provider keeps senpi's existing behavior byte-identical. The profile resolution happens at the session's failure-handling loop so classification, delay, and fallback routing stay consistent.

### Why an extension could not handle it

- The retry decision happens inside the session's own failure-handling loop before any extension hook, and must also cover the transport stage in `sdk.ts`. An extension observing the error after the fact cannot influence the same-model budget, tier routing, or the over-ceiling gate.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/settings-manager.ts` getters region (new `resolveRetryProfile` sibling method).
- MEDIUM: `packages/coding-agent/src/core/agent-session.ts` `_handleRetryableError` profile routing and over-ceiling gate.
- MEDIUM: `packages/coding-agent/src/core/sdk.ts` `streamFn` provider-request stage resolution.
- LOW: `packages/coding-agent/src/core/provider-composer.ts` field forwarding (append-only).
- LOW: `packages/coding-agent/src/core/retry-fallback/settings.ts` + `profile-override.ts` (new module, no upstream owner).

## Core runtime re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/core/agent-session.ts` keeps the fork session runtime (prepared tool
  calls, server-fallback-aborted diagnostics, thinking selection, settlement/idle lifecycle).
- `packages/coding-agent/src/core/auth-storage.ts` keeps OAuth auth events, interactions, prompts,
  and login callbacks on the credential store surface.
- `packages/coding-agent/src/core/footer-data-provider.ts` keeps the polling fallback armed when
  `fs.watch` creation fails (descriptor limits, unsupported filesystems).
- `packages/coding-agent/src/core/keybindings.ts` keeps `app.history.search` (ctrl+r) and
  `app.models.toggleFavorite` (ctrl+f) with their record guards.
- `packages/coding-agent/src/core/model-config.ts` keeps the extracted `model-config-schema.ts`
  validation module and `samplingParams` passthrough.
- `packages/coding-agent/src/core/model-resolver.ts` keeps scoped-model resolution, service tiers,
  initial-model provenance, and the `AvailableModelsSource` snapshot interface.
- `packages/coding-agent/src/core/model-runtime.ts` keeps wire identity, payload request metadata,
  and remote-catalog provider routing.
- `packages/coding-agent/src/core/package-manager.ts` and `packages/coding-agent/src/core/pi-manifest.ts`
  keep the `hooks` resource type and branded `envValue("OFFLINE")` reads.
- `packages/coding-agent/src/core/provider-composer.ts` keeps the extracted api-key/header auth
  composition modules and tool-call middleware wrapping.
- `packages/coding-agent/src/core/resource-loader.ts` keeps bundled shim banners, builtin extension
  factories, and the cwd-scoped extension cache.
- `packages/coding-agent/src/core/sdk.ts` keeps auth storage, the cursor exec bridge, transport
  image budgets, model registry wiring, and initial-model provenance.
- `packages/coding-agent/src/core/session-manager.ts` keeps the session-discovery/resident-store
  split and the inlined UUIDv7 (upstream depends on the `uuid` package).
- `packages/coding-agent/src/core/settings-manager.ts` keeps retry/hint policy settings, lockfile
  policy, nearest-parent config, and atomic settings writes.
- `packages/coding-agent/src/core/slash-commands.ts` keeps `/favorite-models` and the `/exit` alias.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/settings-manager.ts`,
  and `packages/coding-agent/src/core/session-manager.ts` are the highest-churn files in every sync;
  expect import-block and constructor-wiring conflicts there first.

## 2026-08-23 - Slot-preserving credential writes for multi-account pools

### What changed

- `packages/ai/src/auth/pool/slots.ts` (new, exported as `@earendil-works/pi-ai/auth/pool/slots`): pure slot algebra over a provider credential - `listSlots`, `findSlot`, `upsertSlot`, `removeSlot`, `pinSlot`, `assertValidSlotName`. A stored credential with no `accounts` array is read as a one-slot pool named `default` derived from its flat fields, without writing anything back. `upsertSlot` replaces or appends one slot and leaves every sibling, the pin, and the flat top-level credential untouched. `removeSlot` drops the provider entry once its last slot is gone and clears a pin naming the removed slot.
- `packages/coding-agent/src/core/auth-storage.ts`: added `listSlots`, `setSlot`, and `removeSlot` delegating to that module; `set()` now appends to a pool (generated `login-N` slot, siblings preserved) instead of replacing the provider entry, so the RPC `login_api_key` path no longer destroys sibling slots; flat providers keep today's whole-write shape (imported via the new vitest source alias for `@earendil-works/pi-ai/auth/*` in `vitest.base.ts`). Each write runs inside the existing `storage.withLock` read-modify-write and rebuilds the provider entry from the locked content, so unrelated providers and sibling slots survive.

### Why

- `set()` replaces a whole provider entry and `remove()` deletes it, so any provider holding more than one credential lost every sibling the moment one slot was written. Multi-account support needs a write path that preserves siblings before any pooled data can exist. The flat top-level credential is deliberately retained on a pooled entry so a senpi build that predates pools still authenticates from it.

### Why an extension could not handle it

- `AuthStorage` is the app-owned `CredentialStore` implementation and the only holder of the `auth.json` lock; slot-preserving semantics must live inside that locked read-modify-write, which no extension can enter.

### Expected merge conflict zones

- LOW: the new methods sit immediately after `remove()` in `packages/coding-agent/src/core/auth-storage.ts`; `credential-slots.ts` is a new file with no upstream counterpart.

## 2026-08-25 - Fall back on Cursor usage-pool exhaustion

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: admits token-bearing Cursor `resource_exhausted` failures as a dedicated fallback class, retires failed assistants before fallback, and annotates terminal no-fallback errors with the likely usage-pool cause.

### Why

- Cursor quota exhaustion was misclassified as overflow and entered compaction loops; mid-turn tool calls also require explicit retry admission outside the generic hard-error gate.

### Why an extension could not handle it

- Retry admission, assistant retirement, and provider fallback are private AgentSession lifecycle boundaries.

### Expected merge conflict zones

- HIGH: Cursor retry admission and fallback dispatch in `packages/coding-agent/src/core/agent-session.ts`.

## 2026-08-25 - Harden watchdog abort accounting and retry jitter

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: carries watchdog provenance and applies injected jitter while preserving provider hints and 429 floors.
- `packages/coding-agent/src/core/extensions/types.ts`: includes provider abort ownership in `agent_end`.

### Why

- Watchdog aborts must remain retryable and consume the configured budget; delay jitter must not alter provider hints or the 429 exponential floor.

### Why an extension could not handle it

- Session retry admission and lifecycle event typing are core boundaries with no extension seam.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/agent-session.ts` retry scheduling and `packages/coding-agent/src/core/extensions/types.ts` event contract.
## 2026-08-24 - expose abort provenance to interactive rendering

### What changed

- `agent-abort-provenance.ts` exposes the current explicit abort owner across the active and settlement boundaries.
- `agent-session.ts` exposes that owner through the read-only `currentAbortSource` getter for the interactive renderer.

### Why

- An assistant `stopReason: "aborted"` does not prove that the user cancelled. Provider retry watchdogs can produce the same terminal shape without explicit ownership, while user and system aborts are recorded by `AgentAbortProvenance`.
- The renderer needs the existing provenance at message finalization so it can persist an accurate user, system, or provider label that remains correct when the transcript is replayed.

### Why an extension could not handle it

- Abort ownership is private AgentSession lifecycle state and the assistant message is finalized before the extension-visible `agent_end` event.

### Expected merge conflict zones

- LOW: `agent-abort-provenance.ts` source getter and the `AgentSession` read-only state getters.

## 2026-08-22 - Retarget OpenAI automatic defaults to GPT-5.6 Sol

### What changed

- `packages/coding-agent/src/core/model-resolver.ts`: retargeted the `openai` and `openai-codex` provider defaults from `gpt-5.5` to `gpt-5.6-sol` while retaining GPT-5.5 in catalogs and explicit settings resolution.

### Why

- Automatic startup recommendation should follow the current recommended GPT-5.6 Sol model; saved GPT-5.5 selections remain explicitly selectable.

### Why an extension could not handle it

- `defaultModelPerProvider` is consumed by core initial-model resolution before extension recommendations are applied.

### Expected merge conflict zones

- LOW: the OpenAI provider entries in `packages/coding-agent/src/core/model-resolver.ts`.

## 2026-08-22 - emit agent_idle after settlement-deferred turns resolve

### What changed

- `packages/coding-agent/src/core/agent-settled-delivery.ts`: added `DeferredTurnClaim` / `DeferredTurnDisposition` (`started` / `delegated` / `finished-without-start`) and `deferTriggerTurn`, so a settlement-deferred turn request declares whether it actually started a run. Claims resolve at the `_promptAgent` admission boundary.
- `packages/coding-agent/src/core/agent-session.ts`: after the deferred-action loop in `_emitAgentSettled`, an out-of-band check waits for all deferred turn dispositions, skips emission when any turn `started`, waits for delegated session work to drain, verifies the settlement epoch is still current, and emits `{ type: "agent_idle" }` only when no agent run or session work is active. Both settlement-deferred turn APIs register a claim: `sendMessage(..., { triggerTurn: true })` via `deferTriggerTurn`, and `sendUserMessage` (which always triggers a turn) via a claim resolved from its prompt disposition; its content normalization is wrapped so a throwing iterator/getter resolves the claim instead of hanging the idle wait. `agent_settled` ordering is unchanged for existing subscribers.

### Why

- The TUI cleared its working-status dock on the public `agent_settled`, but settlement-deferred continuations (TTSR, loop-guard, goal recovery) start a turn *after* that event, so the dock was removed and immediately remounted - the same vertical bounce the jitter fix exists to eliminate. `_isAgentRunActive` alone cannot decide this at the deferred-action loop because a deferred `sendCustomMessage`/`sendUserMessage` can be suspended at compaction/provider admission before reaching `_promptAgent`, and a throwing content normalization could leave the claim unresolved forever. `agent_idle` is the single race-free boundary for final cleanup.

### Why an extension could not handle it

- Settlement-deferred turn admission, the settlement epoch, and the deferred-turn claim lifecycle are private `AgentSession` / `AgentSettledDelivery` state.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `_emitAgentSettled`, `_promptAgent`, `sendCustomMessage`, `sendUserMessage`, and the `AgentEvent` union.
- `packages/coding-agent/src/core/agent-settled-delivery.ts`.

## 2026-08-21 - Auth-storage lock retry sleeps instead of spinning

### What changed

- `packages/coding-agent/src/core/auth-storage.ts`: `FileAuthStorageBackend.acquireLockSyncWithRetry` replaces the `while (Date.now() - start < delayMs) {}` busy-wait with `Atomics.wait` on a `SharedArrayBuffer`. The wait stays synchronous (callers and the 20ms/10-attempt policy unchanged) but the thread actually sleeps.

### Why

- This is the same defect PR #1056 removed from `settings-manager.ts`, but `auth-storage.ts` was left out of both #1056 and #1057. The sync `withLock` paths (`reload()`, `set()`, `remove()`) reach it, so under multi-session OAuth-refresh contention (auth.json rewritten by other sessions, forcing `reload()` through a contended lock) a synchronous auth write could spin up to 10×20ms of pure CPU on the main thread.

### Why an extension could not handle it

- `FileAuthStorageBackend` is the core credential persistence path with no extension seam.

### Expected merge conflict zones

- `auth-storage.ts` around `acquireLockSyncWithRetry` (line ~95).


## 2026-08-21 - Settings reads are lock-free; writes publish atomically via temp+rename

### What changed

- `packages/coding-agent/src/core/settings-manager.ts`: `FileSettingsStorage.withLock` no longer acquires the settings lock for read-only callbacks. The initial read happens without the lock; only a callback that returns content acquires the lock, re-reads under it, re-runs the callback when a concurrent winner changed the file, and publishes by writing a same-directory `*.tmp` file then `renameSync`-ing it over the settings path. `recordSelfWrite` fires before the rename so the config-reload watcher's self-write suppression still sees the hash first. A failed publish removes the temp file and rethrows.

### Why

- Follow-up to the settings-lock CPU-spin fix (#1056). Locked reads were the remaining lock-pressure source: every `SettingsManager` load acquired the lock even when nothing was written, so cache misses and multi-session startups still convoyed on `settings.json.lock`. Atomic rename publish makes torn reads impossible, which is the precondition for dropping the read lock entirely.

### Why an extension could not handle it

- `FileSettingsStorage` is the core settings persistence path with no extension seam.

### Expected merge conflict zones

- `settings-manager.ts` around `withLock` (line ~555) and the `fs` import list (line ~5).


## 2026-08-21 - Settings-lock retry sleeps instead of spinning; retry-fallback canonicalization memoized

### What changed

- `settings-manager.ts`: `acquireLockSyncWithRetry` replaces the `while (Date.now() - start < delayMs)` busy-wait with `Atomics.wait` on a `SharedArrayBuffer`. The wait stays synchronous (callers and the 20ms/10-attempt policy unchanged) but the thread actually sleeps, so contended retries no longer burn a CPU core per waiter.
- `retry-fallback/controller.ts`: `RetryFallbackController` memoizes `canonicalizeFallbackChains` by the serialized chains content. `canTryFallback`/`nextCandidate`/`hasConfiguredChain` reuse the canonical result for an unchanged config; a chains edit invalidates immediately; `clear()` drops the memo.

### Why

- Provider-error handling calls `canTryFallback` 4-6 times per error, each re-canonicalizing chains whose oauth-lane eligibility probes create fresh `SettingsManager` instances and locked disk reads. With ~12 sessions sharing one settings.json the lock convoy made every waiter busy-spin on the main thread, starving the TUI render loop and freezing the screen at ~100% CPU under 429/5xx storms. V8 profile of a frozen omo process showed 65% in `acquireLockSyncWithRetry` and 18% in `parseSettingsJson`.

### Why an extension could not handle it

- The settings file lock and the retry-fallback controller are core storage and session-admission paths with no extension seam.

### Expected merge conflict zones

- `settings-manager.ts` around `acquireLockSyncWithRetry` (line ~527). `retry-fallback/controller.ts` around `nextCandidate`/`hasConfiguredChain` and the new `canonicalChains` private method.


## 2026-08-20 - Resume picker caches exact streaming summaries

### What changed

- `packages/coding-agent/src/core/session-manager.ts`: session listing now delegates picker-row discovery instead of parsing every JSONL record itself.
- `packages/coding-agent/src/core/session-summary.ts`: streams each cold JSONL file once and preserves the exact prior row contract: first user text, latest name, maximum activity timestamp, parsed message count, parent/cwd, and full search text.
- `packages/coding-agent/src/core/session-summary-cache.ts`: reuses summaries while canonical path, size, and mtime match.
- `packages/coding-agent/src/core/session-summary-lru.ts`: caps retained summaries at 4,096 entries and 64 MiB of UTF-8 transcript text, evicting least-recently-used rows and refusing oversized entries without changing their returned result.
- `packages/coding-agent/src/core/session-discovery.ts`: builds and sorts picker rows from the exact cached summaries with the existing bounded-concurrency loader.

### Why

- `/resume` previously reparsed every message in every unchanged session each time the selector opened. The cost scaled with aggregate session bytes and made repeated selector use visibly slower as histories grew.
- Cold discovery still performs one exact streaming fold so picker metadata and full-text search do not regress. Reopening `/resume` validates one stat per file and reuses unchanged summaries; byte and entry budgets bound process-lifetime retention.

### Why an extension could not handle it

- Session directory enumeration and `SessionInfo` construction happen inside the core `SessionManager.list()` / `listAll()` path before extensions receive a session or selector hook.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/session-manager.ts` imports and the `list()` / `listAll()` delegation around session discovery.
- LOW: the new `session-discovery.ts`, `session-summary*.ts`, and `session-record.ts` modules are fork-owned extraction points.

## 2026-08-20 - Session title uses session-model auth

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `_generateSessionTitle` now calls `_getSummarizationRequestAuth(model)` instead of `_getCompactionRequestAuth(model)`.

### Why

- Compaction auth can be remapped to another provider (see #974). Title generation still streams with the session model, so a remapped key produces `session_title_generation` `unauthenticated` on Cursor while the main turn works.

### Why an extension could not handle it

- Title generation is private session lifecycle. There is no extension hook for the title complete auth.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `_generateSessionTitle`.

## 2026-08-20 - Cursor 0-token RE stays on the same model and shrinks

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: 0-token Cursor `resource_exhausted` retries with `sameModelRemint` instead of 429/k3 fallback; overflow compact uses Cursor keep-recent-0 settings; too-small compact truncates to the last user turn.

### Why

- `resource.?exhausted` was classified as a 429 transient fallback, and overflow compact that saved <1% still retried the same Cursor payload.

### Why an extension could not handle it

- Retry fallback and pre-prompt compaction are core AgentSession admission paths.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `_handleRetryableError`, `_executeCompaction`, `_isHardErrorFallbackEligible`.

## 2026-08-20 - streamRetryTimeoutMs docstring aligned with the reconciled watchdog (issue #723 lane)

### What changed

- `core/retry-fallback/settings.ts`: the `streamRetryTimeoutMs` interface comment now states the actual
  post-2026-08-18 semantics — it caps the retry-CONTINUATION watchdog, reconciled to
  `max(cap, streamStartTimeoutMs)` — instead of the stale "first-request liveness cap after a provider
  timeout" wording. Comment-only; no behavior change.

### Why

- Issue #723 diagnosis (M3) read that comment and concluded the setting clamps the stream-start guard
  itself. It does not: since the 2026-08-18 reconciliation the retry request keeps its full granted
  guard and only the continuation watchdog takes this cap. A wrong comment on the exact knob a
  retry-storm investigation reaches first sends the next diagnosis down the same dead end.

### Why an extension could not handle it

- The setting is a core `ProviderRetrySettings` field consumed by `core/provider-timeout-retry.ts`; the
  doc contract lives with the interface.

### Expected merge conflict zones

- `core/retry-fallback/settings.ts` `ProviderRetrySettings` field list only (comment line).
## 2026-08-20 - Cursor exec emits tool_result after native write/edit

### What changed

- `packages/coding-agent/src/core/cursor-exec-bridge.ts`: `executeTool` now calls `emitToolResult` after `tool_execution_end`, passing cleaned args and the real result so plan-touch listeners see native exec writes.
- `packages/coding-agent/src/core/cursor-exec-bridge-session.ts`: wires the bridge's optional `emitToolResult` to `emitExecBridgeToolResult` on the session.
- `packages/coding-agent/src/core/agent-session.ts`: adds `emitExecBridgeToolResult`, which runs `_emitAfterToolCallHooks` so the same `tool_result` hook path as the local tool loop fires after Cursor exec.

### Why

- Cursor exec runs `write`/`edit` via `tool.execute` and previously only emitted `tool_execution_end`. Plan-touch trackers listen to `tool_result`, so momus stayed gated after a real `.omo/plans/*.md` write (#989).

### Why an extension could not handle it

- The exec-bridge factory is inside `packages/coding-agent` before any omo hook sees the stream; an extension cannot inject `tool_result` into a path that never emitted it.

### Expected merge conflict zones

- `packages/coding-agent/src/core/cursor-exec-bridge.ts` `executeTool` (ownership recheck after preflight plus `emitToolResult`).
- `packages/coding-agent/src/core/cursor-exec-bridge-session.ts` session wiring.
- `packages/coding-agent/src/core/agent-session.ts` `emitExecBridgeToolResult`.
## 2026-08-20 - Append-only goal continuations and exponentially floored 429 waits

### What changed

- `packages/coding-agent/src/core/messages.ts`: removed `keepLatestGoalContinuationMessage()`.
  `filterContextExcludedMessages()` is now an explicit identity pass and `convertToLlm()` maps the full
  input array, so every accepted `goal-continuation` custom message stays in provider-visible chronological
  history. `GOAL_CONTINUATION_MESSAGE_TYPE` and `isContextExcludedCustomMessage() === false` are unchanged;
  no dedupe by content, goal id, wake source, or streak was added. Session JSONL format and
  `queueHiddenGoalPrompt()` are untouched.
- `packages/coding-agent/src/core/retry-fallback/hint-policy.ts`: `nextInTurnDelayMs()` computes
  `exponentialFloorMs = baseDelayMs * 2 ** (attempt - 1)` and applies it to all three same-model branches
  (half-used deadline remainder, first hinted idle probe, and the done/hint-override path). The floored
  delay — not the raw hint — feeds `cumulativeHintedWaitMs`, so cap demotion accounts for time actually
  slept. `degradeWithoutFallback()` tier 2 raises its cap-clamped wait to the same floor. The probe state
  machine, tier boundaries, budgets, and the tier-3 terminal verdict are unchanged.
- `packages/coding-agent/src/core/agent-session.ts`: comments only near 429 detection and retry scheduling,
  recording that the exponential floor lives in the pure policy and must not be recomputed at the call site.
  No control-flow change.

### Why

- Anthropic-style prompt caching keys on an exact message-array prefix. Dropping a previously sent
  continuation made request N stop being a prefix of request N+1, so every token ahead of the deletion point
  missed cache and was re-read at full price. In team mode, where continuations arrive every turn, that
  produced sustained cache-miss traffic and 429 storms (#1005). Keeping continuations append-only is the
  smallest change that restores prefix immutability; context growth is a deliberate trade bounded by normal
  compaction.
- The 429 handler previously let a provider hint fully replace the exponential schedule. A provider that
  repeats a 5 ms `retry-after` on every rate-limit pinned the same-model retry cadence at 5 ms, so the
  session hammered a model that was already refusing it. Flooring each wait guarantees monotonic pressure
  relief while still honouring hints longer than the floor.

### Why an extension could not handle it

- `filterContextExcludedMessages()` / `convertToLlm()` run inside the core transport and compaction paths
  (`agent-session.ts`, `compaction/compaction.ts`); an extension's `transformContext` hook fires before this
  core-owned filter, so it cannot prevent a core deletion of already-sent turns.
- The 429 wait is computed by the pure retry policy inside the session's own retry loop. Extensions observe
  `auto_retry_start` after the delay has been decided and cannot rewrite `delayMs` or the probe state.

### Expected merge conflict zones

- MEDIUM: `messages.ts` top-of-file exclusion helpers and the `convertToLlm()` entry line — any concurrent
  change that reintroduces context filtering there will collide.
- MEDIUM: `retry-fallback/hint-policy.ts` `nextInTurnDelayMs()` branch bodies and the
  `degradeWithoutFallback()` tier-2 return.
- LOW: `agent-session.ts` 429 detection and retry-delay comments (comment-only lines).
- LOW: `test/suite/goal-continuation-context-exclusion.test.ts`,
  `test/suite/retry-fallback-hint-policy.test.ts`, and
  `test/suite/regressions/issue-447-goal-continuation.test.ts`, whose assertions moved from
  keep-latest-only to append-only.

## 2026-08-20 - Skip Cursor compaction while a native Run is live

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `compactBeforeNextAdmission` no-ops for `cursor` / `cursor-cli-oauth` so mid-turn tool-loop admission does not compact while a native Cursor Run is live.

### Why

- Cursor rebuilds full conversation state each hop. Mid-turn compact desyncs `conversationId` and the next hop returns 0-token `resource_exhausted` (session 01a01879, issue #984).

### Why an extension could not handle it

- Tool-loop admission and pre-turn compaction live in `AgentSession.prepareNextTurnWithContext`; an extension cannot skip that core call.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `compactBeforeNextAdmission`

## 2026-08-20 - Ignore implausible Cursor billed usage in compaction threshold

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `_resolveThresholdContextTokens` now delegates to `resolveThresholdContextTokens` so a billed usage figure more than 8× a ≥50k local estimate is ignored for the compaction threshold.

### Why

- Complements the billed-cacheRead guard in cursor-agent. When no checkpoint arrived, a 4M `cacheRead` still must not beat a 149k transcript estimate.

### Why an extension could not handle it

- Threshold resolution runs inside `AgentSession` before any session hook sees the assistant message.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `_resolveThresholdContextTokens`

## Shared notice styling for built-in cards (2026-08-20)

### What changed

- The prompt URL widget and the multi-line pi-rules banner now render through `buildNoticeBox`, retaining their existing titles, paths, diagnostics, and URL details while using the shared notice background and bold tone title.
- The compact pi-rules footer remains a one-line status surface and is unchanged.

### Why

- These built-in multi-line cards were visually divergent from every transcript notice renderer and did not carry the `customMessageBg` notice background.

### Why an extension could not handle it

- The built-in widget and rules banner own their component rendering before another extension can restyle the returned component.

### Expected merge conflict zones

- LOW: `extensions/builtin/prompt-url-widget.ts` widget construction and `extensions/builtin/rules/ui/rules-banner.ts` multi-line rendering.

## Cursor exec emits tool_result after native write/edit (2026-08-19)

`executeTool` now calls `emitToolResult` after `tool_execution_end`. Cursor exec runs `write`/`edit` without the local tool loop, so momus `hasPlanArtifact()` never saw `.omo/plans/*.md` touches.

Conflict zone: `cursor-exec-bridge.ts` `executeTool`, `cursor-exec-bridge-session.ts`, `agent-session.ts` `emitExecBridgeToolResult`.

## Provider-declared fallback-expansion eligibility gate (2026-08-19)

### What changed

- `packages/coding-agent/src/core/provider-composer.ts`: `ProviderConfigInput` gained optional
  `fallbackEligible?(): boolean`, the extension-owned deterministic usability gate for implicit
  bare-family fallback expansion.
- `packages/coding-agent/src/core/model-runtime.ts`: new `isFallbackEligible(providerId)` consults the
  registered hook; hookless providers and throwing hooks stay eligible so expansion never shrinks on
  uncertainty.
- `packages/coding-agent/src/core/model-registry.ts`: new `isFallbackEligible(model)` forwards the
  per-provider verdict to `core/retry-fallback/` chain canonicalization.

### Why

- Bare expansion ranked OAuth-credential providers first without asking whether the lane could execute;
  a credentialed cursor-cli-oauth lane with an unacknowledged `--force` gate ranked tier 0, entered the
  shipped `claude-opus-5:xhigh` default chain, and hard-errored on every fallback hop (see
  `core/extensions/changes.md` 2026-08-19).

### Why an extension could not handle it

- Chain canonicalization runs inside `core/retry-fallback/` against the model registry; no extension
  hook observes it. The eligibility signal itself stays extension-owned via the registration field.

### Expected merge conflict zones

- `provider-composer.ts` end of `ProviderConfigInput`; `model-runtime.ts` near `hasConfiguredAuth`;
  `model-registry.ts` near `isUsingOAuth`.

## 2026-08-19 upstream sync integration repair (footer-data-provider watcher fallback)

### What changed

- `packages/coding-agent/src/core/footer-data-provider.ts`: `setupGitWatcher` no longer returns early when a
  watcher fails to register. The `tables.list` polling fallback is armed whenever the file exists, and its path is
  recorded after the watcher attempt because a failed registration synchronously clears watcher state.

### Why

- Carried forward from `origin/main` during the upstream sync merge. Tracker files resolve to `ours` on merges,
  which would otherwise drop this entry and leave the path uncovered for the next upstream audit.

### Why an extension could not handle it

- Footer git-state polling is core session plumbing owned by the CLI runtime; an extension cannot re-arm the
  internal watcher fallback or reach the reftable polling path.

### Expected merge conflict zones

- `footer-data-provider.ts` `setupGitWatcher` reftable block.

## 2026-08-19 - Core session, settings, packaging, and catalog divergence after the upstream 59a71b23 pin

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: the fork session keeps its own compaction stack over
  upstream's newly centralized one — `CompactionLifecycleCoordinator`, typed `CompactionReason`
  (`manual`/`threshold`/`overflow`/`pre_prompt`/`branch`/`extension`) and `CompactionRejectionCause` with
  human-readable rejection text, warm-anchor admission (`isWarmSummaryAnchorValid`), request ids on
  `compaction_start`/`compaction_progress`/`compaction_end`, and real `CacheFriendlySummaryOptions`
  (`sourceContext`/`turnPrefixSourceContext`) where upstream still passes `undefined // cacheFriendly`. It also
  keeps the `-fast` service-tier state machine (`serviceTier`, `isFastModeActive()`, `service_tier_changed`
  events, per-model tier memory) and the `senpi:`-prefixed hook/diagnostic custom-message types.
- `packages/coding-agent/src/core/settings-manager.ts`: retains the fork settings schema and loaders upstream has
  no counterpart for — JSONC parsing that ignores comment-like text inside strings, brand-aware `envValue()` and
  `findNearestParentConfigDir()` resolution, lockfile policy, retry/fallback settings
  (`resolveRetryFallbackSettings`, hint policy, abort server-side fallback), speculative/idle compaction and
  restoration knobs, prompt-cache and look-at settings, per-model thinking/service-tier memory, smooth-streaming
  and tips settings, `hooks` sources, and builtin-extension enable/disable lists.
- `packages/coding-agent/src/core/package-manager.ts`: keeps `hooks` as a fifth resource type (`.json` pattern,
  user and project dirs, override lists, accumulator and resolved-path maps), the legacy `.pi` project base dir
  scan when it differs from the branded one, and branded offline detection via `envValue("OFFLINE")`. Upstream's
  `semver.gt` version comparison arrived through the merge and is retained unchanged.
- `packages/coding-agent/src/core/remote-catalog-provider.ts`: keeps `FORK_ONLY_BUILTIN_PROVIDERS`
  (`alibaba-token-plan`, `opengateway`) with `remoteCatalogServesProvider()` so the pi.dev overlay is skipped for
  providers upstream's catalog cannot serve, and `mergeInputModalities()` so an overlay entry never drops an input
  modality the built-in model already declares.
- `packages/coding-agent/src/core/skills.ts`: keeps the fork's skill-listing guidance (load a skill whenever its
  description even loosely matches, because loading an irrelevant skill is cheap and missing a relevant one is
  not) and the branded `~/.senpi/agent` default in `LoadSkillsOptions.agentDir`. Upstream's nested markdown skill
  discovery from this sync is retained as-is.

### Why

- These files carry fork-only product behavior — compaction affinity/lifecycle ownership, `-fast` priority tiers,
  fork-only providers and catalog overlays, hooks packaging, legacy `.pi` layout support, and senpi branding —
  that the advanced pin does not contain, so they legitimately remain divergent after the merge instead of being
  reset to upstream's tree.

### Why an extension could not handle it

- Compaction admission, settings resolution, resource discovery, and the model-catalog overlay all execute before
  or beneath the extension runner: extensions are loaded from the settings and resources these modules resolve,
  and the compaction hooks they can observe are emitted by this same session code.

### Expected merge conflict zones

- HIGH: `agent-session.ts` compaction execution/admission block and the summarization request wiring.
- MEDIUM: `settings-manager.ts` settings interfaces and load/merge paths; `package-manager.ts` per-resource
  literal lists (`FILE_PATTERNS`, dirs, overrides, accumulator) where each new resource type must gain `hooks`.
- LOW: `remote-catalog-provider.ts` around `mergeModels()`; `skills.ts` prompt guidance line and the `agentDir`
  doc comment.

## 2026-08-18 - Resume active goals stuck after suppressed continuation-flood loads

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `sendCustomMessage` with `triggerTurn` no longer waits on
  `_sessionWorkBarrier` while the session-start binding itself holds it (`_extensionBindingPromptReadiness`
  active). A trigger-turn message queued from the `session_start` emission — a goal continuation queued on
  resume — previously waited on the very work that was delivering it, so the resumed session rendered the TUI
  but never started a turn.
- `core/extensions/builtin/goal/index.ts` + `direct-input-lifecycle.ts`: a suppressed flooded load now arms a
  one-shot latch; the next accepted user message (the "Send a message to resume" the notice promises) queues
  the goal continuation immediately instead of only resetting the continuation streak.
- Coverage: `test/suite/goal-extension.test.ts` (queues a continuation when the user sends a message after a
  suppressed flooded load) and `test/suite/agent-session-queue.test.ts` (triggerTurn send does not wait on the
  binding-phase barrier; fails pre-fix via a deadlock race).

### Why

- A resumed session whose branch ends in >= `GOAL_CONTINUATION_CAP` trailing continuations suppresses
  auto-continuation by design, but the documented resume path was a dead end: the user message reset the
  streak without queueing a continuation, and even once queued the continuation deadlocked on the
  binding-held barrier. Reproduced against a clone of the stuck session; post-fix the continuation is
  delivered and the agent resumes.

### Why an extension could not handle it

- The barrier admission condition lives in `AgentSession.sendCustomMessage`, and the resume latch lives in the
  builtin goal extension's own load/disposition path; both are core session-lifecycle surfaces.

### Expected merge conflict zones

- `core/agent-session.ts` `sendCustomMessage` wait condition, and the goal extension `session_start`
  suppressed-load branch in `core/extensions/builtin/goal/index.ts`.


## 2026-08-25 - Harden provider retry watchdog ownership and backoff

### What changed

- `core/provider-timeout-retry.ts`: gives the retry-continuation watchdog a proportional 10% grace beyond the granted stream-start guard, preserving `0`/`undefined` opt-out behavior.
- `packages/coding-agent/src/core/agent-session.ts`: mark watchdog aborts as provider-owned and retain the real watchdog cause for retry classification and terminal reporting; retry delays use injected +/-10% jitter.
- `packages/coding-agent/src/core/agent-abort-provenance.ts`: carries provider abort ownership through `agent_end`.
- `packages/coding-agent/src/core/extensions/types.ts`: adds provider abort ownership to the public `agent_end` event type.
- `packages/coding-agent/src/core/agent-session.ts`: apply injected retry jitter while preserving provider hints and 429 exponential floors.
- `modes/interactive/interactive-mode.ts` and `modes/interactive/aborted-error-label.ts`: render labels without mutating persisted messages.
- `modes/interactive/interactive-mode.ts` and `modes/interactive/aborted-error-label.ts`: render abort labels from a copied message rather than mutating session state.

### Why

- The watchdog starts before the retried request starts its stream-start timer, so equal deadlines deterministically laundered a retryable stall into an unclassifiable abort and discarded remaining retry budget.
- Codex-style jitter prevents synchronized retry storms while provider Retry-After hints remain lower bounds.

### Why an extension could not handle it

- Retry watchdog ownership, Agent abort propagation, session retry accounting, and message finalization are core lifecycle boundaries with no extension seam.

### Policy note

- Non-429 provider retry hints remain authoritative. Jitter applies only when no provider hint is present; 429-tier scheduling remains deterministic so its exponential floor remains a true floor.

### Expected merge conflict zones

- HIGH: `core/provider-timeout-retry.ts`, `core/agent-session.ts`, and `packages/agent/src/{agent.ts,agent-loop.ts}`.
- LOW: `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/extensions/types.ts`, and interactive aborted-label rendering.

## 2026-08-18 - Retry continuation watchdog reconciled with the guards it grants

### What changed

- `core/provider-timeout-retry.ts`: `createProviderTimeoutRetryPlan` now reconciles the retry-continuation
  liveness cap against the stream-start guard the same retry is handed:
  `watchdogTimeoutMs = max(streamRetryTimeoutMs, streamStartTimeoutMs)`. An explicitly disabled cap
  (`undefined`) stays disabled, and a cap that already outlasts the granted guard is returned unchanged.
- Coverage: `test/provider-timeout-retry-continuation.test.ts` (new; first direct coverage of
  `runBoundedRetryContinuation`), extended `test/provider-timeout-retry.test.ts`, and updated
  `test/suite/regressions/provider-idle-recovery.test.ts`.

### Why

- This completes the 2026-08-13 fix below. That change stopped clamping the retry *request* guards to
  `retry.provider.streamRetryTimeoutMs`, but left the same 30s cap bounding the retry *continuation*, which
  reproduced the identical defect one layer up: `runBoundedRetryContinuation` aborted the attempt at 30s while
  the request still had 60s of its configured 90s stream-start budget left.
- No attempt could therefore finish, so the bounded `retry.maxRetries` budget (default 3) collapsed into the
  single user-visible `Provider stream start timed out after 90000ms (raise streamStartTimeoutMs — retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)` / `Aborted after 1 retry attempt`
  outcome. A slow-but-alive provider was again judged dead on a deadline it was never given.
- Raising the watchdog to the granted guard preserves the wedge protection it was added for: the provider
  guards still fail a dead upstream, and the watchdog still cancels a retry that outlives every guard it was
  granted.

### Why an extension could not handle it

- The retry continuation bound and its abort ownership are core session-lifecycle surfaces with no extension
  hook.

### Expected merge conflict zones

- `core/provider-timeout-retry.ts` plan construction, and the retry-bound constants in
  `test/suite/regressions/provider-idle-recovery.test.ts`.


## Queue typed input admitted during auto-compaction (2026-08-18)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: `prompt()` gained a
  `canQueueDuringAutoCompaction` eligibility flag for a queueable submission
  (`streamingBehavior` set) that arrives while auto-compaction owns the session
  and no run is streaming. The flag suppresses the settled-session-work wait and
  routes the message through `_queueSteer`/`_queueFollowUp` beside the existing
  queue branches, after extension input handling and template expansion.

### Why

- `isCompacting` is true for the auto, manual, and branch-summary controllers,
  but the admission guard rejects only on `_compactionAbortController`, so
  auto-compaction never rejected typed input. That input then matched no queue
  branch — `canQueueWhileStreaming` requires `!isCompacting` — and fell through
  neither queued nor started, so a message typed while the TUI showed
  "Compacting context..." was accepted and silently dropped.
- Gating on the auto controller alone keeps the manual `/compact` fail-closed
  admission path and the post-compaction recovery continuation unchanged; a
  broader `isCompacting` relaxation regressed both.

### Why an extension could not handle it

- Prompt admission and queue ownership run inside the session before any
  extension input hook observes the submission, so an extension cannot recover
  input the engine has already dropped.

### Expected merge-conflict zones

- `packages/coding-agent/src/core/agent-session.ts`: the `prompt()` queue
  eligibility constants and the queue branches preceding the settled-work wait.

## Cursor bridge dispatches bind to the run that owns the stream (2026-08-18)

### What changed

- `packages/coding-agent/src/core/cursor-exec-bridge-session.ts`: the session
  adapter accepts the signal of the run that owns the exec stream and resolves
  `getAbortSignal` from it, returning `undefined` once that run is no longer
  the agent's live run. Adapters created without a captured owner fail closed
  instead of adopting whichever run is currently live.
- `packages/coding-agent/src/core/cursor-exec-bridge.ts`: dispatch rechecks the
  captured signal after awaited preflight work and before `tool.execute()`, so
  a run that ends during approval cannot start a side effect afterward.
- `packages/coding-agent/src/core/sdk.ts`: supplies the bridge as a per-run
  factory so every Cursor stream gets handlers bound to its own run.

### Why

- The bridge is built once per session, but each exec stream belongs to exactly
  one run. Resolving ownership from the agent's live signal let a straggler
  frame from a stream whose run had already ended adopt the replacement run's
  signal, clear the ownership guard in `Agent.emitExternalEvent`, and execute a
  dead run's tool inside the new run while emitting its lifecycle events into
  the new run's transcript.
- This is the shape the crashed 2026-08-18 session hit: a provider rate-limit
  error restarted the run on a fallback lane while the previous stream still
  held buffered exec frames.

### Why an extension could not handle it

- Run ownership of provider-driven exec frames is an engine contract between
  the agent loop and the Cursor stream; no extension hook sits between the
  straggler frame and the bridge dispatch.

### Expected merge conflict zones

- `cursor-exec-bridge-session.ts` signature and `getAbortSignal` resolution,
  `sdk.ts` `cursorExecHandlers` wiring.
## 2026-08-18 - Cursor reasoning levels: session provenance and legacy id resolution

### What changed

- `packages/coding-agent/src/core/agent-session.ts`, `agent-session-services.ts`, `session-manager.ts`:
  record, persist, and restore provenance-bearing thinking selections (explicit user actions, CLI `:suffix`,
  favorites, legacy variant ids); defaulted levels stay selection-free and next-turn refresh returns the
  selection so mid-run switches propagate.
- `packages/coding-agent/src/core/model-resolver.ts`: resolve allowlisted legacy Cursor variant ids to their
  grouped identity plus selection ahead of generic partial matching, and project wildcard/enabled/favorite
  patterns across the alias union without cross-provider projection.
- `packages/coding-agent/src/core/sdk.ts`: carry the startup selection into agent state.

### Why

- The Cursor catalog now publishes grouped identities, so sessions, favorites, and enabled-model patterns that
  referenced the old expanded variant ids must keep resolving, with the level they encoded preserved.

### Why an extension could not handle it

- Session state, persistence entries, startup model resolution, and favorite/enabled pattern expansion are
  core surfaces with no extension hook.

### Expected merge conflict zones

- `model-resolver.ts` pattern matching and partial-match ordering, `agent-session.ts` thinking-level setters,
  `session-manager.ts` entry schema.

## Cursor bridge lifecycle events retain run ownership (2026-08-18)

### What changed

- `packages/coding-agent/src/core/cursor-exec-bridge.ts`: bridge executions
  require and capture the active run signal before emitting
  `tool_execution_start`, pass that same signal through every matching
  `tool_execution_end` path, and await lifecycle delivery.
- `packages/coding-agent/src/core/cursor-exec-bridge-session.ts`: the session
  adapter forwards that captured signal to agent-core and returns its promise
  to the bridge.

### Why

- An aborted bridge tool can settle after a replacement run has started. The
  signal lets agent-core discard the stale lifecycle event instead of
  delivering it to the replacement run.
- A bridge dispatch with no active run is refused before tool execution, and
  active-run listener failures stay attached to the dispatch instead of
  becoming detached unhandled rejections.

### Why an extension could not handle it

- The run signal is owned by the engine bridge before extension preflight and
  tool execution, so an extension cannot reliably reconstruct the originating
  run after the asynchronous tool settles.

### Expected merge-conflict zones

- `packages/coding-agent/src/core/cursor-exec-bridge.ts`: lifecycle emission
  around preflight and tool execution.
- `packages/coding-agent/src/core/cursor-exec-bridge-session.ts`: the
  agent-core event forwarding adapter.

## Single availability scan across provider re-register (2026-08-18)

### What changed

- `model-runtime.ts`: `registerProvider` / `registerNativeProvider` skip `refreshAfterRegistration` when the provider is already registered and the availability snapshot is fresh. An optional `{ refresh: false }` defers the scan so a caller can do one refresh after a batch.
- `agent-session-services.ts`: the create-time pending-registration drain uses `{ refresh: false }`, then keeps the existing single `refresh({ allowNetwork: false })`.
- `test/model-runtime-registration-refresh.test.ts`: re-registering a native provider already in a fresh snapshot does not run another catalog refresh.

### Why

- Session reload re-binds the same extension provider and started a second full availability scan. Create-time drain also fire-and-forgot a registration refresh that could `credentials.list()` after create returned. `reload-efficiency` expected one `list()` per reload and failed deterministically on current main, which blocked `release:local` `npm test`.

### Why an extension could not handle it

- Availability refresh and provider registration are core `ModelRuntime` contracts. Extensions cannot coalesce those scans.

### Expected merge-conflict zones

- MEDIUM: `registerProvider` / `registerNativeProvider` in `model-runtime.ts` and the drain loop in `agent-session-services.ts`.

## Cerebras default retarget after live catalog drift (2026-08-18)

### What changed

- `model-resolver.ts`: `defaultModelPerProvider.cerebras` is now `gpt-oss-120b` instead of `zai-glm-4.7`.
- `test/model-resolver.test.ts`: the pinned Cerebras default expectation matches the retarget.

### Why

- The live Cerebras catalog dropped `zai-glm-4.7` and now ships only `gemma-4-31b` and `gpt-oss-120b`. The old default failed `every bundled provider default resolves in its catalog` after `hydrate:model-data` / `release:local` regeneration, which blocked the release smoke.
- `gpt-oss-120b` is present in both the committed snapshot and the live regenerated catalog, so the default stays resolvable across regen.

### Why an extension could not handle it

- `defaultModelPerProvider` is a core-owned exhaustive `Record<KnownProvider, string>` used by initial model selection. There is no extension hook for bundled provider defaults.

### Expected merge-conflict zones

- LOW: the `cerebras` row in `defaultModelPerProvider` and the matching pin in `test/model-resolver.test.ts`.

## Cursor CLI OAuth provider display name (2026-08-17)

### What changed

- `provider-display-names.ts`: added `"cursor-cli-oauth": "Cursor CLI (OAuth)"` for the new builtin
  provider lane. The `/login` list and auth status surfaces pick the name up automatically from the
  provider registration; only the display-name map needed a row. The lane's builtin registry entry is
  recorded in `extensions/builtin/changes.md` (this directory's nearest record for that file).

### Why

- The lane runs senpi turns through the official `cursor-agent` CLI in print mode as the documented
  fallback for the native Cursor provider (`cursor`, the api2.cursor.sh protobuf transport): use the
  native provider by default, and this lane when the native path misbehaves or Cursor's own agent
  harness is explicitly wanted.

### Why an extension could not handle it

- The display-name map is a core-owned literal with no extension hook: a builtin provider cannot name
  itself on the `/login` surface without an entry here. All lane behavior lives under
  `extensions/builtin/cursor-cli-oauth/` (see that directory's `changes.md` and `AGENTS.md`).

### Expected merge-conflict zones

- LOW: `provider-display-names.ts` map rows (one-line additions in a sorted literal).

## Repository audit baseline for the core tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`). It assigns every audited production path whose exact nearest tracker is
  this file, so the audit gate can resolve each divergence even where the per-feature history below predates the gate.
- Session and services surface: `packages/coding-agent/src/core/agent-session.ts`,
  `packages/coding-agent/src/core/agent-session-runtime.ts`, `packages/coding-agent/src/core/agent-session-services.ts`,
  `packages/coding-agent/src/core/sdk.ts`.
- Persistence and identity: `packages/coding-agent/src/core/session-manager.ts`,
  `packages/coding-agent/src/core/messages.ts`, `packages/coding-agent/src/core/settings-manager.ts`.
- Model runtime surface: `packages/coding-agent/src/core/model-config.ts`, `packages/coding-agent/src/core/model-registry.ts`,
  `packages/coding-agent/src/core/model-resolver.ts`, `packages/coding-agent/src/core/model-runtime.ts`,
  `packages/coding-agent/src/core/provider-composer.ts`, `packages/coding-agent/src/core/remote-catalog-provider.ts`,
  `packages/coding-agent/src/core/runtime-credentials.ts`.
- Resources and packaging: `packages/coding-agent/src/core/resource-loader.ts`, `packages/coding-agent/src/core/package-manager.ts`,
  `packages/coding-agent/src/core/pi-manifest.ts`, `packages/coding-agent/src/core/project-trust.ts`.
- Auth and output safety: `packages/coding-agent/src/core/auth-storage.ts`, `packages/coding-agent/src/core/bash-executor.ts`,
  `packages/coding-agent/src/core/output-guard.ts`.
- Process-level surfaces: `packages/coding-agent/src/core/event-bus.ts`, `packages/coding-agent/src/core/experimental.ts`,
  `packages/coding-agent/src/core/http-dispatcher.ts`, `packages/coding-agent/src/core/telemetry.ts`,
  `packages/coding-agent/src/core/timings.ts`.
- Invocation surfaces: `packages/coding-agent/src/core/slash-commands.ts`, `packages/coding-agent/src/core/prompt-templates.ts`,
  `packages/coding-agent/src/core/skills.ts`, `packages/coding-agent/src/core/resolve-config-value.ts`,
  `packages/coding-agent/src/core/keybindings.ts`.
- Rendering and branding: `packages/coding-agent/src/core/export-html/index.ts`,
  `packages/coding-agent/src/core/export-html/template.css`, `packages/coding-agent/src/core/export-html/template.js`,
  `packages/coding-agent/src/core/provider-attribution.ts`.
- Deleted upstream surface retained as a tracked divergence: `packages/coding-agent/src/core/index.ts`.

### Why

- The audit compares HEAD against the pinned upstream commit and requires every upstream-owned production divergence
  to be covered by one entry with all four canonical sections in its exact nearest tracker. Paths that only ever appeared
  in undated or partial-form entries were reported uncovered by the pre-backfill audit; this inventory closes that gap
  without rewriting the accurate per-feature history below.

### Why an extension could not handle it

- Tracker coverage is repository and release policy, not runtime behavior; it is enforced by repository scripts before
  any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker file merges to `ours` on upstream sync; the inventory intentionally names pin-relative paths so it
  stays valid as entries below change.

## Session runtime launch profiles and removed-extension reporting (2026-08-17)

### What changed

- `agent-session-runtime.ts`: new immutable `AgentSessionLaunchProfile` (cwd, permission preset, creation model,
  initial thinking level) captured at first launch and threaded through every replacement route — new, resume, fork,
  and branch switch — via the runtime factory options, so a replaced session keeps the flags the runtime was launched
  with.
- `agent-session-runtime.ts`: `teardownCurrent()` snapshots the outgoing extension runner's identities; `apply()` now
  diffs them against the new runner's resolved paths and emits one `session_extensions_removed` event (with the
  replacement reason) on the old runner. `apply()` became async to await that emission. Runners without
  `getExtensionIdentities` (test hosts, partial implementations) skip reporting instead of breaking replacement.
- `agent-session-services.ts`: `AgentSessionServices` now exposes `authStorage` and `modelRegistry`;
  `createAgentSessionServices()` constructs the `AuthStorage` for `<agentDir>/auth.json`, passes it into
  `ModelRuntime.create()` as its credential store, and wraps the runtime in a `ModelRegistry`.
- `agent-session-services.ts`: pending provider registrations (config-form and native) are replayed through one
  ordered `drainPendingProviderRegistrations()` drain so last-registration-wins holds across mixed registration
  kinds, replacing the two separate reset-after loops.
- `agent-session-services.ts`: duplicate extension flags resolve first-registration-wins; `scopedModels` and the new
  `favoriteModels` option carry a per-model `serviceTier`; `autoTitleSessions` is plumbed to session creation.

### Why

- Session replacement silently dropped the launch-time flags a runtime was created with, and extensions had no signal
  that their host session was being swapped out from under them — the old runner observed `session_shutdown` but
  consumers of the removed extension could not distinguish removal from reload.
- Services were constructing auth and model state twice (runtime-internal and caller-side), and mixed legacy/native
  provider registrations could interleave so a native provider registered earlier lost to a later config form.

### Why an extension could not handle it

- Runtime replacement and service construction happen before and beneath the extension runner; an extension cannot
  observe the outgoing runner's identity set or re-order provider registration drains that install it.

### Expected merge conflict zones

- MEDIUM: `agent-session-runtime.ts` `teardownCurrent()`/`apply()` and the `launchProfile` threading on every
  `createRuntime()` call site.
- LOW: `agent-session-services.ts` service assembly and the registration drain loop.

## Event bus provider-scope binding and extension RPC channel (2026-08-17)

### What changed

- `event-bus.ts`: `createEventBus()` wraps every subscribed handler with `bindToProviderScope()` from
  `@earendil-works/pi-ai/node/provider-scope`, so ambient provider scope established on the emitting side propagates
  through event dispatch; a binding failure falls back to the raw handler.
- `event-bus.ts`: exports the `senpi:extension-rpc-event` channel constant (`EXTENSION_RPC_EVENT_CHANNEL`) and the
  `ExtensionRpcEvent` shape used to relay extension-originated events to RPC hosts.

### Why

- Handlers dispatched on the shared bus otherwise lost the emitting session's provider scope (credentials, request
  context), and RPC hosts needed one named channel contract instead of a string literal duplicated per caller.

### Why an extension could not handle it

- The bus is constructed by core before extensions load; scope binding must wrap the handler at subscription time,
  which only the bus itself can do.

### Expected merge conflict zones

- LOW: `event-bus.ts` `on()` wrapper; the channel constant is fork-owned.

## Brand-scoped environment flags and programmatic timings (2026-08-17)

### What changed

- `experimental.ts`: experimental-feature gating reads the branded `envValue("EXPERIMENTAL")` flag instead of
  `process.env.PI_EXPERIMENTAL`.
- `telemetry.ts`: install-telemetry gating reads `envValue("TELEMETRY")` instead of `process.env.PI_TELEMETRY`.
- `timings.ts`: timing enablement reads `envValue("TIMING")`; the `reload` namespace joins `main`/`extensions`;
  exported `TimingEntry` plus `getTimings()`/`formatTimings()` give hosts programmatic access to the same data
  `printTimings()` writes to stderr.

### Why

- Fork environment flags are `SENPI_*`-branded via `brand.ts`, so every `PI_*` read had to move through the one
  branded resolver; timings additionally needed a machine-readable form for hosts that capture startup profiles
  without parsing stderr.

### Why an extension could not handle it

- These modules are imported by the bootstrap path before extension loading and by code that must stay loader-free;
  they cannot depend on extension-provided configuration.

### Expected merge conflict zones

- LOW: one env read per file; `timings.ts` accessor block is additive.

## HTML export: provider-native blocks, current skill invocations, tilde paths (2026-08-17)

### What changed

- `export-html/index.ts`: explicit output paths expand `~` through `expandTildePath()` in both
  `exportSessionToHtml()` and `exportFromFile()`; default names are unchanged.
- `export-html/template.js`: `parseSkillBlock()` recognizes the current chained skill-invocation format
  (`The user explicitly invoked … <skill-instruction> … <user-request>`) in addition to the legacy `<skill>` block,
  validating that the invocation and instruction names agree; kept in sync with core `agent-session.ts` so standalone
  exports render skill turns the same way live sessions do.
- `export-html/template.js`: assistant `providerNative` blocks render as a collapsible `<details>` element with the
  provider name, subtype, and a 2000-character collapsed preview over the full JSON body.
- `export-html/template.css`: styles for the provider-native collapsible block.

### Why

- Sessions exported after the skill-invocation format changed rendered skill turns as plain user text, and
  provider-native replay content was dropped entirely from exports because the renderer had no arm for it.
- `~/exports/session.html` failed with a literal tilde directory.

### Why an extension could not handle it

- The exporter renders from a session file with no runtime present; it is a static template executed in the exported
  HTML, outside any extension lifecycle.

### Expected merge conflict zones

- LOW: `export-html/index.ts` output-path branches; MEDIUM: `template.js` renderer arms and `parseSkillBlock()`
  (upstream evolves skill formatting); LOW: additive `template.css` rules.

## Multi-session RPC guards for the shared HTTP dispatcher (2026-08-17)

### What changed

- `http-dispatcher.ts`: in `--multi-session` processes, `applyHttpProxySettings()` refuses to change an already-set
  `HTTP_PROXY`/`HTTPS_PROXY` value and `configureHttpDispatcher()` pins one process-global idle timeout; both mismatch
  paths throw with an explicit "fixed at process startup" error instead of silently replacing the earlier setting.

### Why

- Multi-session RPC hosts share one process-global Undici `EnvHttpProxyAgent` dispatcher; a second session applying
  its own proxy or timeout would reconfigure every other session's transport mid-flight.

### Why an extension could not handle it

- The dispatcher is installed as the global `fetch` replacement during CLI bootstrap, before extensions load, and is
  process-global by construction — no extension can scope it per session.

### Expected merge conflict zones

- LOW: guard blocks at the top of `applyHttpProxySettings()` and `configureHttpDispatcher()`.

## Core barrel removal (2026-08-17)

### What changed

- Deleted `packages/coding-agent/src/core/index.ts`, the barrel that re-exported `AgentSession`, the runtime/services
  factories, the bash executor, the event bus, `createSyntheticSourceInfo`, and the extension type surface.
- Consumers import from the concrete modules (`agent-session.ts`, `agent-session-runtime.ts`,
  `agent-session-services.ts`, `extensions/index.ts`) instead.

### Why

- The barrel was a frozen snapshot of the public surface: every fork addition had to be mirrored into it or it
  silently exported a stale alias, and it duplicated the extension API re-exports that `extensions/index.ts` already
  owns. Removing it leaves one authoritative import path per module.

### Why an extension could not handle it

- Not runtime behavior: an unused re-export layer cannot be provided or removed by an extension.

### Expected merge conflict zones

- MEDIUM: upstream additions to the barrel resurrect it on sync; keep the deletion and port new re-exports to their
  concrete consumer imports.

## Hooks as a packaged resource and legacy `.pi` discovery (2026-08-17)

### What changed

- `pi-manifest.ts`: `PiManifest` gains an optional `hooks: string[]` field and `RESOURCE_FIELDS` includes `hooks`, so
  packaged hook resources are listed and validated like extensions, skills, prompts, and themes.
- `package-manager.ts`: `hooks` becomes a fifth resource type (`.json` file pattern) with user and project hook
  directories, global and project settings lists, `ResolvedPaths.hooks`, and accumulator handling.
- `package-manager.ts`: when the legacy project base dir (`.pi`) differs from the canonical one, its auto-discovered
  extensions, skills, prompts, themes, and hooks are still collected under legacy path metadata.
- `package-manager.ts`: offline detection reads the branded `envValue("OFFLINE")` flag instead of `PI_OFFLINE`.

### Why

- Hook plugins ship in packages alongside the other resource kinds and need the same install/update/listing pipeline;
  projects created before the config-directory rename must keep resolving resources from their existing `.pi` tree.

### Why an extension could not handle it

- Package installation, resource enumeration, and manifest validation run in the package manager before any
  extension (including hook plugins) can load.

### Expected merge conflict zones

- MEDIUM: `package-manager.ts` resource maps (`FILE_PATTERNS`, dirs, overrides) — every resource literal list gains a
  `hooks` entry on sync; LOW: `pi-manifest.ts` field list.

## Slash commands, prompt-template metadata, and skill guidance (2026-08-17)

### What changed

- `slash-commands.ts`: builtin command list gains `favorite-models` (manage favorites for Ctrl+P cycling) and `exit`
  (alias of `/quit`).
- `prompt-templates.ts`: new `expandPromptTemplateWithMetadata()` returns `{ text, template }` so callers can emit
  invocation metadata for the template they actually expanded; `expandPromptTemplate()` remains as a thin wrapper.
- `skills.ts`: the prompt skill-listing guidance now tells the model to load a skill whenever its description even
  loosely matches the task (loading an irrelevant skill costs little; missing a relevant one degrades the work), and
  documents the default global skill directory (`~/.senpi/agent`).

### Why

- Favorites needed a discoverable command surface next to `scoped-models`; `/exit` matches shell muscle memory.
- Invocation telemetry and session events need to know which template was expanded, not just the expanded text.
- The old skill guidance ("when the task matches its description") under-triggered: agents skipped relevant skills
  on loose matches.

### Why an extension could not handle it

- `BUILTIN_SLASH_COMMANDS` and the skill listing are baked into the core prompt/command surface; template expansion
  metadata is produced inside the core expansion function every caller shares.

### Expected merge conflict zones

- LOW: additive list entries and the wrapper split in `prompt-templates.ts`.

## Provider attribution branding (2026-08-17)

### What changed

- `provider-attribution.ts`: default OpenRouter attribution sends `X-OpenRouter-Title: <APP_NAME>` instead of `pi`,
  and the Cloudflare `User-Agent` is `<APP_NAME>-coding-agent` instead of `pi-coding-agent`; types import from
  `@earendil-works/pi-ai/compat`.

### Why

- Hardcoded `pi` strings leaked the upstream product identity on every attributed request; deriving both from
  `APP_NAME` keeps attribution consistent with the fork's published name.

### Why an extension could not handle it

- Default attribution headers are applied by the runtime for models that have no configured headers, before any
  extension can decorate the request.

### Expected merge conflict zones

- LOW: two header literals in `getDefaultAttributionHeaders()`.

## Credential command retry and per-session environment (2026-08-17)

### What changed

- `resolve-config-value.ts`: command-backed config values retry up to three attempts with 250 ms / 1000 ms backoff
  (blocking wait) before reporting unresolved, instead of failing on the first attempt.
- `resolve-config-value.ts`: `resolveConfigValue()`/`resolveConfigValueUncached()` accept a per-session `env`; command
  execution spawns with that environment merged over `process.env`, and uncached command results are no longer reused
  across sessions that carry different environments.

### Why

- Auth-broker commands (`omp token …`) are cold-started and fail transiently (lock contention, slow spawn, a racing
  OAuth refresh), and callers escalate an unresolved API key to a hard provider ejection — one blip kicked the session
  off its model with no retry.
- A process-wide cached command result produced under another session's environment is the wrong credential source.

### Why an extension could not handle it

- Config-value resolution runs inside model/auth runtime credential probes, beneath the extension loader.

### Expected merge conflict zones

- LOW: `executeCommandUncached()` retry loop and the `env` plumbing in the two shell-exec helpers.

## SessionManager usage totals, entry identity, and materialized views (2026-08-17)

### What changed

- `session-manager.ts`: exported `UsageTotals` and O(1) `getUsageTotals()` — running input/output/cacheRead/cacheWrite/
  cost totals plus the latest cache-hit rate, folded incrementally on assistant-message append and rebuilt on index
  construction; totals cover ALL entries, not just the current branch, matching the footer hot path.
- `session-manager.ts`: runtime message identity — `getSessionContextEntryId()`, `getMessageEntryPosition()`, and
  `getEntryOrder()` map projected context messages back to their durable entry and append order via WeakMaps, so
  compaction boundaries compare by append order rather than provider timestamps.
- `session-manager.ts`: a mutation counter keys memoized materialized views — `getEntries()` returns the same shared
  array between mutations (callers must not mutate it), no-arg `getBranch()` is memoized on (leaf, mutation), and
  `getSessionName()` is O(1) from an incrementally maintained cache.
- `session-manager.ts`: large payloads externalize through the resident string store — entries are stored in
  externalized form and materialized on read (`getEntry`, `getBranch`, `getHeader`), with stats exposed via
  `getResidentStoreStats()`.
- `session-manager.ts`: `model_change` entries carry `reason: "fallback" | "fallback-revert"` plus the original
  provider/model; context restoration keeps the primary model and restores the pre-fallback thinking level, including
  the crashed-inside-the-window case, while a manual switch inside the window keeps the user's level.
- `session-manager.ts`: `buildContextEntries()` skips compaction entries older than the boundary summary (the latest
  summary supersedes them instead of double-counting); added `hasContextMessages()`, `hasThinkingLevelChanges()`, and
  `countCompactions()`; inlined the UUIDv7 generator (no `uuid` dependency); session-directory docs name `~/.senpi`.

### Why

- The footer and RPC usage paths re-summed every assistant usage on each render; compaction classified history by
  payload timestamps that a late-arriving entry could violate; and repeated materialization of unchanged sessions
  dominated read hot paths.
- Fallback windows previously leaked the fallback model's ephemeral thinking level into the restored primary model.

### Why an extension could not handle it

- Entry indexing, identity maps, and the mutation counter live inside the append-only store that constructs the
  context every consumer (including extensions) reads from.

### Expected merge conflict zones

- MEDIUM: `session-manager.ts` index construction and the accessor bodies; LOW: additive helper methods.

## Message identity, context provenance, and transport image budget (2026-08-17)

### What changed

- `messages.ts`: every converted message copies context provenance onto its LLM form via `copyContextProvenance()`.
- `messages.ts`: `GOAL_CONTINUATION_MESSAGE_TYPE` messages keep only their latest occurrence in the model context
  (`keepLatestGoalContinuationMessage()` applied in `convertToLlm()`), while `isContextExcludedCustomMessage()` stays
  per-type false so compaction and branch summarization still see the entries.
- `messages.ts`: `CompactionSummaryMessage` carries optional `details` and `createCompactionSummaryMessage()` accepts
  it; the local `compactionSummary` role module-augmentation was dropped in favor of the upstream declaration.
- `messages.ts`: transport image policy — `TRANSPORT_IMAGE_BUDGET_BYTES` (24 MiB), `elideOldImages()` walking
  newest-to-oldest with `alwaysKeepNewest`/`maxHistoricalImages` protection, elision/blocking placeholders with
  consecutive-dedupe, and `convertToLlmForTransport()` applying the `blockImages` setting at request-build time.

### Why

- Provider-native replay and cache-affinity features need stable message-to-context identity across conversion;
  stale goal-continuation markers accumulated one per goal turn and misled later turns; and long sessions with inline
  screenshots exceeded provider request-size walls (Anthropic's 32 MB) with no request-time bound.

### Why an extension could not handle it

- These are the conversion and request-build functions every provider request passes through, including the
  compaction fallback path that runs with no extension participation.

### Expected merge conflict zones

- MEDIUM: `convertToLlm()` switch arms; LOW: additive transport-image helpers at end of file.

## Shared file-storage lock policy (2026-08-17)

### What changed

- `lockfile-policy.ts` (fork-only): one `FILE_STORAGE_LOCK_OPTIONS` (`realpath: false`, `stale: 30 s`,
  `update: 10 s`) for every proper-lockfile acquisition in the file-backed auth and settings stores.
- `auth-storage.ts`: `lockSync()` acquires with the shared policy and stale detection reads its `stale` value;
  credential writes re-read the latest storage content inside `withLock` instead of mutating an in-memory snapshot;
  runtime credential overrides layer over stored credentials for reads and refresh; extension OAuth login builds its
  interaction with a signal; typed exports (`AuthCredential`, `ApiKeyCredential`/`OAuthCredential`, `AuthStatus`,
  `GetApiKeyOptions`) formalize the storage surface.

### Why

- proper-lockfile defaults (`stale: 10 s`, mtime refresh at `stale/2`) let a sync contender classify a live async lock
  as stale in the 10–15 s gap and steal it; divergent per-store windows meant one store could out-vote another's live
  holder. One policy makes no contender able to out-vote a live holder.

### Why an extension could not handle it

- The lock windows guard the auth and settings files themselves, which the extension loader reads through; an
  extension cannot change how the files beneath it are locked.

### Expected merge conflict zones

- LOW: `lockfile-policy.ts` is fork-owned; LOW-MEDIUM: `auth-storage.ts` lock call sites and the withLock bodies.

## Provider composition: ambient auth, extra body, upstream ids (2026-08-17)

### What changed

- `provider-composer.ts`: `ExtensionOAuthConfig` gains `check()` (auth health probe) and `resolveAmbient()` — request
  auth for providers whose credentials live outside `auth.json` (an environment token or a CLI the provider shells
  out to), so ambient users resolve instead of hitting "Provider is not configured"; never consulted once a
  credential is stored.
- `provider-composer.ts`: model definitions accept `upstreamModelId`, `serviceTier`, `promptPreset`,
  `recoverTextToolCalls`, `extraBody`, and `cacheRetention`; providers accept `extraBody` and `cacheRetention`; the
  `video` input modality joins `text`/`image`; model overrides support `thinkingLevelMapMode: "replace"` alongside
  the merge default.
- `provider-composer.ts`: `AuthStatus.source` is extended with the header-auth sources; api-key and header auth
  helpers moved to fork-owned `provider-api-key-auth.ts` / `provider-header-auth.ts`; composition pulls
  `transformContext` and `wrapStreamWithToolCallMiddleware` from `pi-ai` so composed providers engage the same
  middleware and context transforms as native ones.

### Why

- Subscription/CLI-based providers had no way to express request auth without pretending to store an OAuth
  credential, and per-model wire fields (upstream ids, service tiers, prompt presets) had no composition path from
  `models.json` or extension providers to the outgoing request.

### Why an extension could not handle it

- Composition is the seam that turns an extension's provider description into the `pi-ai` provider object the
  runtime streams through; the fields must exist on the composed model itself.

### Expected merge conflict zones

- MEDIUM: `ProviderConfigInput` shape and `applyModelOverride()`/`modelFromJson()` bodies — upstream adds model
  fields here regularly; LOW: the fork-owned auth helper modules.

## Model runtime wire identity, availability gating, and registry services (2026-08-17)

### What changed

- `model-runtime.ts`: `setWireIdentity(BRAND?.userAgent ?? APP_NAME)` runs at module load so outgoing requests carry
  the fork identity; model refresh gains a `modelRefreshTimeoutMs` (default 15 s); network model refresh requires the
  branded offline flag to be unset AND explicit `allowModelNetwork`.
- `model-runtime.ts`: availability snapshot gating — `hasAvailabilitySnapshot()`/`hasFreshAvailabilitySnapshot()`;
  builtin providers without `refreshModels` and outside the remote catalog's served set keep their local catalog; a
  `createSync()` factory serves legacy `ModelRegistry` callers; `recomposeProvider()` deletes providers disabled in
  `models.json` instead of composing them.
- `model-runtime.ts`: request preparation merges compatibility `extraBody` with caller `extraBody`, rewrites the
  request model id to the configured `upstreamModelId`, applies auth `baseUrl`, and enriches `onPayload` with the
  resolved model and headers; streams wrap with model-recovery.
- `model-registry.ts`: the registry holds its `AuthStorage` (constructor default plus `create()`/`inMemory()`
  factories), answers `getAvailable()`/`hasConfiguredAuth()`/`isUsingOAuth()` from storage plus runtime status when no
  availability snapshot exists, exposes `getUpstreamModelId()`/`getServiceTier()`, falls back to built-in provider
  display names, and returns `extraBody`/`upstreamModelId`/`serviceTier` from `getApiKeyAndHeaders()`.

### Why

- The registry previously derived auth state from the runtime alone, so ambient/stored credentials were invisible
  until a full availability refresh completed; wire identity and per-model wire fields had to be applied at the one
  point every request passes through.

### Why an extension could not handle it

- The runtime is the credential-blind model collection every consumer (including extension tooling) resolves
  through; identity and availability policy cannot be layered from a loaded extension.

### Expected merge conflict zones

- MEDIUM: `model-runtime.ts` `create()`/`createSync()` and `prepareRequest()`; LOW-MEDIUM: `model-registry.ts`
  accessor bodies.

## Resource loader: bundled builtins, generated shims, package dedupe (2026-08-17)

### What changed

- `resource-loader.ts`: vendored builtin extension packages resolve from the package root with explicit
  source-tree versus installed-binary path candidates, and bundled builtin factories join user/project extensions
  in one final load set.
- `resource-loader.ts`: global default extensions materialize as generated shims under `<agentDir>/extensions` with
  a banner; existing shims are recognized (including accepted legacy banners) and resolved back to their factory
  instead of reloading as unknown user extensions.
- `resource-loader.ts`: extension paths dedupe by nearest package identity (`package.json` name), so the same
  installed package reached through different paths loads once; CLI `-e`/`-s` resources keep CLI precedence even
  when they resolve through a package manifest.
- `resource-loader.ts`: hooks resolve as a resource kind (`hookPaths`, enabled-hook resources, CLI hook paths);
  `SYSTEM.md`/`APPEND_SYSTEM.md` file discovery was removed in favor of explicit prompt options (see
  `packages/coding-agent/changes.md`); cached extension loading (`loadExtensionsCached`) was replaced by direct
  `loadExtensions()` calls; enabled/disabled builtin extension settings are honored during final-set assembly.

### Why

- Bundled extensions, generated shims, and package-installed duplicates produced multiple loads of one logical
  extension (duplicate commands/tools and confusing reload events), and trust resolution had to preserve builtin
  factories while filtering user extensions.

### Why an extension could not handle it

- The loader is what discovers, dedupes, and constructs extensions; it runs before any of them exist.

### Expected merge conflict zones

- HIGH: `resource-loader.ts` resource resolution and the final extension-set assembly; the shim and package-identity
  helpers are fork-owned.

## models.json schema split and provider disablement (2026-08-17)

### What changed

- `model-config.ts`: validation and the `ModelsJson*` types moved to fork-owned `model-config-schema.ts`
  (`validateModelsConfig`), with `model-config.ts` re-exporting the types augmented with `samplingParams`; the legacy
  inline typebox schema remains as a commented reference for upstream diffs.
- `model-config.ts`: `ModelConfig` tracks a disabled-provider set, exposes `isProviderDisabled()` for runtime
  composition, accepts provider-level `cacheRetention`, and gained a synchronous `loadSync()` constructor used by
  `ModelRuntime.createSync()`.

### Why

- One schema module is shared by config loading, authoring, and validation surfaces, so a field added for
  `models.json` authoring cannot drift from what the runtime accepts; provider disablement needed a config-level
  switch that composition honors.

### Why an extension could not handle it

- `models.json` is parsed during runtime bootstrap before extensions load; extensions register providers through
  the composer, not the config loader.

### Expected merge conflict zones

- MEDIUM: `model-config.ts` constructor/load paths; NONE: `model-config-schema.ts` is fork-owned.

## Model pattern service tiers and favorites resolution (2026-08-17)

### What changed

- `model-resolver.ts`: model patterns gain a service-tier decorator — grammar `<model-pattern>[:<auto|flex|priority>]
  [:<thinking-level>]`, consumed right-to-left with the leftmost (slot-order) occurrence winning, and a full-pattern
  match still tried first because real model ids contain colons.
- `model-resolver.ts`: `resolveModelScopeFromModels()` reports per-pattern `PatternResolution` ownership records
  (`ownedIds` after first-pattern-wins dedupe, unresolved patterns reported rather than dropped) for favorites
  persistence; `ScopedModel`/`ParsedModelResult` carry `serviceTier`.
- `model-resolver.ts`: scope sources accept `ModelRuntime`, `ModelRegistry`, or any `AvailableModelsSource` so a
  caller holding a settled availability snapshot resolves without triggering another scan;
  `getModelNarrowingPatterns()` unifies CLI versus legacy enabled-pattern inputs.
- `model-resolver.ts`: default-model table adds/updates fork providers (`cursor: "auto"`, `opengateway`, `ollama`,
  `alibaba-token-plan`, `zai`/`zai-coding-cn` → `glm-5.2`).

### Why

- Service tiers are per-model wire settings that users select in the same string they type a model in, and favorites
  persistence needs to know exactly which canonical models a stored pattern owns in the current registry.

### Why an extension could not handle it

- Pattern parsing runs in CLI argument handling and scope resolution before sessions (and therefore extensions)
  exist.

### Expected merge conflict zones

- MEDIUM: `parseModelPattern()` recursion and the `ResolveModelScopeResult` assembly; LOW: the default-model table.

## Stderr takeover for hidden diagnostics (2026-08-17)

### What changed

- `output-guard.ts`: `takeOverStderr()`/`restoreStderr()` mirror the existing stdout takeover — `process.stderr.write`
  is wrapped, hidden diagnostics are forwarded to a callback, and a callback failure falls back to writing the
  (optionally formatted) original text through the saved writer and surfaces the error via the write callback;
  chunk/encoding handling normalizes `Uint8Array` writes to text.

### Why

- While a TUI owns the terminal, dependency code writing to stderr corrupts the rendered frame the same way stdout
  writes did; the stdout guard had no stderr counterpart, so hidden-diagnostic capture had to intercept each writer
  ad hoc.

### Why an extension could not handle it

- The takeover must be installed around the whole process's stderr before rendering begins; extensions load after
  the terminal is already owned.

### Expected merge conflict zones

- LOW: additive block after `restoreStdout()`; the stdout takeover above it is the pattern to follow on sync.
## Expand explicit dollar skill tokens and publish invocation metadata (2026-08-16) ([PR #909](https://github.com/code-yeongyu/senpi/pull/909))

### What changed

- Skill composition accepts a leading `$name` run alongside `/skill:name`.
- The desktop composer's explicit `$skill:name` token expands even when it appears inline, while bare inline
  dollar tokens such as `$HOME` remain literal.
- Successful expansion emits one ordered `skill_invocation` session event containing each resolved skill's name,
  source path, and `dollar` or `slash` syntax.
- Dollar and slash tokens share the existing duplicate, unknown, file-read, and five-skill cap behavior.
- Token removal preserves unrelated blank lines, indentation, and literal dollar text, and token discovery stops after
  a bounded 64-token prefix while leaving every unprocessed token literal.
- Resolved extension commands and accepted prompt templates emit one `command_invocation` session event after
  extension input interception, so transformed or rejected text cannot be reported as an invocation.

### Why

- OmO Desktop serializes a selected skill chip as `$skill:name`; treating it as prose made the new desktop picker
  look successful while the runtime silently ignored the invocation.
- TUI autocomplete needs a concise leading `$name` form without making arbitrary inline shell variables executable.
- RPC consumers need typed invocation metadata instead of reparsing the expanded user prompt.
- Prompt content outside explicit invocation token spans must remain byte-meaningful for pasted code and structured text.

### Why an extension could not handle it

- Prompt, steering, follow-up, RPC, and interactive entry paths must share one pre-provider expansion contract.
- The session event union and prompt expansion boundary are core-owned and run before extensions can safely
  normalize every entry surface.
- Prompt-template resolution metadata is private session state; extensions cannot reliably emit accepted invocation
  events after another extension transforms or handles the original input.

### Expected merge-conflict zones

- `agent-session.ts` skill parsing, prompt-template resolution, command dispatch, queueing, and `AgentSessionEvent`.
- `prompt-templates.ts` expansion metadata.
- Skill-composition and command-invocation regressions under `test/suite/regressions/`.

## Cursor exec bridge (2026-08-16)

### What changed

- `cursor-exec-bridge.ts` (new): maps Cursor exec-channel frames onto the session's real tools through the
  same wrapped `AgentTool.execute` path model-issued calls use. Legacy frames map read→`read`
  (offset/limit kwargs), ls→`ls`, grep→`grep`, write→`write`, shell→`bash` (workingDirectory composed as a
  quoted `cd` prefix; senpi's bash has no cwd kwarg); modern Pi frames map 1:1 (`pi_edit` →
  `edits[{oldText,newText}]`, `pi_grep` flags, `pi_find` → `find`, `pi_ls` → `ls` with `limit`); MCP calls
  dispatch by tool name. Args are validated with `validateToolArguments` before execution; every valid call
  emits `tool_execution_start`, runs the session's vetoable extension `tool_call` preflight (including mutable
  input and first-block semantics), and emits a matching `tool_execution_end`. Blocked calls return the reason
  as an in-band error without invoking the tool. `delete`, `diagnostics`, and `mcpApprovalPreflight` handlers
  are deliberately absent (typed refusals on the wire).
- `cursor-exec-bridge-session.ts` (new): owns the late-bound session/Agent wiring. Tools resolve through the
  session's full registry, preflight delegates to `AgentSession.preflightToolCall`, lifecycle events ride
  `agent.emitExternalEvent`, and the active Agent signal remains the abort source.
- `sdk.ts`: replaces the inline bridge options with one `createSessionCursorExecBridge(...)` call, reducing the
  already-large session factory while preserving its post-Agent session-ref assignment.
- `agent-session.ts`: `getRegisteredTool()` exposes the full registry (builtin + extension tools) because Cursor
  drives its native tools over the exec channel regardless of the request's advertised set. The existing
  `_emitBeforeToolCallHooks` implementation is renamed `preflightToolCall`; its event-queue wait guarantees
  lifecycle correlation is visible before Cursor preflight.

### Why

- Cursor's protocol executes tools server-drivenly mid-stream; without the bridge every Cursor turn that
  touches a tool would stall and time out. Without the shared preflight, server-driven calls bypassed extension
  vetoes such as permission policy and loop-guard hard escalation.

### Why an extension could not do this

- The bridge must be wired into the Agent's loop config before any extension loads, and it needs the wrapped
  tool registry (approvals, sandboxing, truncation) rather than raw tool definitions.

### Expected merge conflict zones

- LOW: `sdk.ts` Agent construction options (additive), `agent-session.ts` additive accessor.
- NONE expected in `cursor-exec-bridge.ts`: fork-only file.

## Cursor provider display name (2026-08-16)

### What changed

- `provider-display-names.ts`: added `cursor: "Cursor"` for the new builtin Cursor OAuth provider
  (`packages/ai/src/providers/cursor.ts`). The `/login` list and auth status surfaces pick the name up
  automatically from the provider registration; only the display-name map needed a row.

### Why

- Without the entry the provider id would render raw ("cursor") in provider name surfaces that consult
  `BUILT_IN_PROVIDER_DISPLAY_NAMES`.

### Why an extension could not do this

- The display-name map for builtin providers is a core lookup table, not an extension surface.

### Expected merge conflict zones

- LOW: the alphabetical map in `provider-display-names.ts` when upstream adds providers.

## JSONC settings parser, precedence, and write ownership (2026-08-16)

### What changed

- `settings-manager.ts` now strips line/block comments only outside quoted strings, removes trailing commas before object/array closers, and delegates final validation to `JSON.parse`; no dependency was added.
- File storage selects `settings.jsonc` before `settings.json`, retains that selected path for writes, and reselects only at create/reload/project-trust load boundaries.
- Selected-source metadata includes path, format, reason, and scope; `AgentSession` forwards reload decisions and replays startup decisions once to each host subscriber.

### Why

- A per-write filesystem probe could redirect a session to another flavor after load, while JSON-only parsing prevented maintainable commented settings. Selection boundaries make precedence and write ownership explicit.

### Why an extension could not do this

- Parsing and locking happen before extensions load, and the session emitter is the shared transport boundary used by RPC and TUI hosts.

### Expected merge conflict zones

- HIGH: `settings-manager.ts` path/storage/load/save sections.
- MEDIUM: `agent-session.ts` event and subscription lifecycle.

## Model and service-tier session events (2026-08-16)

### What changed

- `AgentSessionEvent` gained `model_changed` (model, post-switch thinking level, `ModelSelectSource`) and `service_tier_changed` (tier, fastMode). Both are emitted from the existing switch seams: `_switchActiveModel`, `_cycleFavoriteModel`, and `setSessionFastMode`.
- `service_tier_changed` fires only when the effective tier or the fast-mode indicator actually moved (they move independently).
- New read-only accessors: `cwd` (the value extensions already receive as `ctx.cwd`) and `effectiveServiceTier` (`serviceTier`, promoted to `"priority"` while session fast mode is on — what the wire actually carries).

### Why

- Host surfaces (RPC) had to infer the active model from session entries and could not see tier or fast-mode state at all. Emitting at the switch seams means every path — command, slash command, cycle, fallback, restore — reports the level actually in force afterwards, which per-model memory makes different from the requested level.
- `effectiveServiceTier` exists so a client can never be shown `fastMode: true` alongside a tier that disagrees with it.

### Why an extension could not handle it

- Model switching, thinking-level clamping, and tier resolution are session-core state transitions; an extension observing `model_select` cannot report the post-clamp level atomically with the switch.

## /fast per-model service-tier persistence seam (2026-08-16)

### What changed

- `setSessionFastMode(false)` now also clears a cached `"priority"` `_currentServiceTier` when the active model is a codex-responses model AND that priority is inherited from the catalog (`getCompatibilityRequestConfig(model).serviceTier === "priority"`). A priority the catalog does not explain is an explicit scoped/favorite `:priority` pin and is left alone. `_resolveServiceTier` is unchanged.

### Why

`/fast` now persists per model (see `extensions/builtin/changes.md`), and turning it off writes a remembered `"auto"` that must override an inherited catalog-priority tier immediately. The resolved tier is only recomputed on model switches, so a same-session `/fast off` (which deliberately does not swap models) would otherwise keep the badge on and keep sending `service_tier: "priority"` until a restart. The memory itself is applied in the service-tier extension (which holds the fresh settings read); caching it here instead would survive the off and leak the inherited tier back onto the wire.

## Preserve per-model reasoning effort while reasoning is off (2026-08-16)

### What changed

- `SettingsManager` now persists `modelLastOnThinkingLevels` beside `modelThinkingLevels`.
- Every non-off per-model thinking write refreshes the companion value; writing `off` changes only the effective
  level, so startup remains off while a later `/reasoning on` can restore the previous effort.
- The companion accessor validates runtime JSON and marks only the nested model key for concurrent-session merges.

### Why

- Persisting `off` into the only per-model field destroyed the effort the user expected to restore. A
  session-scoped fallback hid that loss only until restart, making the same off/on sequence produce different
  results before and after a restart.

### Why an extension could not handle it

- Ordinary thinking-level changes and startup restoration already flow through core settings. The remembered
  non-off value must therefore be a storage invariant rather than extension-process state.

### Expected merge conflict zones

- LOW: `settings-manager.ts` beside the existing per-model thinking accessors.

## Clamp fallback thinking levels canonically and restore the pre-fallback level (2026-08-16)

### What changed

- `retry-fallback/controller.ts` `selectThinking()` now delegates to `clampThinkingLevel` from
  `@earendil-works/pi-ai` instead of falling back to the last (highest) supported level.
- `session-manager.ts` `getSessionContextSettings()` captures the thinking level in effect when a fallback
  window opens and restores it on `fallback-revert`, or at the end of the path when the window never closed.
  A manual `model_change` still abandons the window, keeping the in-window level for the newly chosen model.

### Why

- The old fallback clamp escalated: a requested `off` against an always-on fallback model resolved to that
  model's maximum level, silently spending the largest reasoning budget on an unattended retry. The canonical
  clamp walks to the nearest supported level in either direction.
- Session restoration already protected the model half of a fallback window (`originalProvider`/`originalModelId`)
  but assigned `thinking_level_change` unconditionally, so a session interrupted inside a window came back with
  the primary model and the fallback model's ephemeral thinking level.

### Why an extension could not handle it

- Both sites are core reducers: the retry controller picks the level before any extension observes the switch, and
  session context restoration runs while rebuilding state from the session file.

### Expected merge conflict zones

- LOW: `retry-fallback/controller.ts` `selectThinking()`; `session-manager.ts` `getSessionContextSettings()`.

## Skip pi.dev catalog overlay for fork-only builtin providers (2026-08-16)

### What changed

- `remote-catalog-provider.ts` exports `FORK_ONLY_BUILTIN_PROVIDERS` (`alibaba-token-plan`, `opengateway`) and
  `remoteCatalogServesProvider(providerId, catalogBaseUrl?)`.
- `model-runtime.ts` `create` and `createSync` skip the `withRemoteCatalog` wrap for fork-only builtin providers
  when the default upstream catalog base URL is in use. A custom `catalogBaseUrl` keeps the wrap, so a fork-owned
  catalog could serve these providers later.

### Why

- pi.dev is upstream infrastructure and does not serve fork-only provider ids. It answers them with a non-404
  failure, which surfaced as a chronic `Could not refresh <id>; showing cached models` warning on every
  model-selector refresh: transient-failure persists never write `lastModified`, so the four-hour freshness
  throttle never engaged for always-failing providers.
- Fork-only catalogs are already baked at build time, so skipping the overlay loses nothing.

### Why an extension could not handle it

- The wrap is applied inside `ModelRuntime` construction over the core-owned builtin provider list, before any
  extension registers providers; extensions cannot unwrap a builtin.

### Expected merge conflict zones

- LOW: `model-runtime.ts` at the two `withRemoteCatalog` wrap sites; `remote-catalog-provider.ts` near the
  top-level constants.

## Let a superseding compaction claim pass admission quietly (2026-08-16)

### What changed

- New private `AgentSession._hasSupersedingCompactionClaim()`: true when a live (non-aborted)
  compaction or auto-compaction controller is currently claimed. Compaction claims are
  last-writer-wins (`_claimCompactionController` aborts the incumbent), so after an admission
  compaction loses that race, the winner owns the route and re-gates admission itself.
- The guard joins `_isCompactionOnCooldown()` / `_isCompactionDelegated()` at the admission-family
  `RequiredCompactionError` sites: `_enforceCompactionBeforeProvider`,
  `_enforceFinalProviderAdmission`, `_checkCompaction`'s inline overflow throw,
  `_revalidateScheduledContinuationAdmission`, and the pre-retry compaction gate
  ([#886](https://github.com/code-yeongyu/senpi/issues/886)).
- User-initiated aborts keep throwing: `abortCompaction()` aborts the claimed controllers without
  registering a replacement, so no live claimant exists and the guard stays false.

### Why

- On a resumed over-threshold session, a queued extension message (goal continuation, ttsr nudge)
  races the user's own prompt; both run pre-prompt admission and the loser's compaction is aborted
  mid-flight. Treating that abort like a failure threw
  `Context remains above the compaction threshold because compaction did not complete` at the
  losing caller (surfaced as `Runtime error (send_message)`), even though a newer compaction was
  actively running. This mirrors the breaker-cooldown (#531) and SDK-delegation (#874) precedent:
  when compaction cannot complete for a transient/ownership reason, admission proceeds and
  overflow recovery remains the safety net.

### Why an extension could not handle it

- Required-compaction admission and the compaction controller registry are private `AgentSession`
  state; extensions observe only the thrown error.

### Expected merge conflict zones

- `agent-session.ts` around `_isCompactionOnCooldown` and each guarded
  `throw new RequiredCompactionError()` site.

## Admit provider-owned compaction lanes (2026-08-14)

### What changed

- `CompactionRejectionCause` now includes `external-owner`, with an exhaustive fallback description for rejection
  events that do not carry an extension reason.
- `AgentSession` treats a failed `external-owner` compaction as delegated only while the lifecycle's recorded model
  provider matches the active provider. Delegated failures neither throw `RequiredCompactionError`, block final or
  retry admission, nor arm `_blockedPostCompactionAssistant`.
- Circuit-breaker cooldown semantics remain unchanged: its final-admission bypass still requires the post-attempt
  estimate to fall below the threshold, while delegated lanes may proceed despite Senpi's unreliable oversize
  estimate.

### Why

- SDK-native provider lanes compact inside the admitted query. Rejecting the core compaction route is an ownership
  handoff, not a failed prerequisite, so stopping before provider dispatch prevents the component that owns
  compaction from doing its work.
- Failed lifecycle state survives model selection. Matching the recorded provider prevents a delegated rejection
  from one provider from suppressing required-compaction errors after switching to another provider.

### Why an extension could not handle it

- Required-compaction admission, retry gating, lifecycle model identity, and blocked-assistant recovery are private
  `AgentSession` state. An extension can report ownership but cannot alter these core gates.

### Expected merge conflict zones

- HIGH: `agent-session.ts`, around required-compaction admission, final provider admission, post-compaction blocking,
  scheduled continuation revalidation, and retry admission.
- LOW: `extensions/types.ts`, in the shared compaction rejection-cause union.

## Catalog listing and atomic fallback-chain overrides (2026-08-13)

### What changed

- `--list-models` reads the registered model snapshot without filtering out
  models whose credentials are not configured.
- Project `retry.fallbackChains` replaces the global map atomically while
  sibling retry settings continue to merge recursively.
- Native provider replacement synchronizes its composed OAuth adapter into the
  credential store, preserving auth-derived request metadata such as Copilot
  enterprise base URLs.
- Core summarization resolves stored provider auth before invoking SDK-style or
  custom stream wrappers, so account-specific request metadata is not replaced
  by a legacy catalog key.

### Why

- Model listing is a discovery fast path used before login.
- Fallback chains are ordered policy maps; retaining unrelated global keys
  changes project-specific retry behavior.

### Why an extension could not handle it

- CLI fast-path model discovery and settings precedence run before extensions.
- OAuth adapter composition belongs to the core model runtime and credential
  store boundary.
- Summarization auth is assembled inside `AgentSession` before extensions or
  stream wrappers receive the request.

### Expected merge conflict zones

- LOW: `cli/list-models.ts`, around catalog selection.
- MEDIUM: `settings-manager.ts`, around global/project deep merge behavior.
- MEDIUM: `model-runtime.ts`, around native provider registration and OAuth
  adapter replacement.
- MEDIUM: `agent-session.ts`, around summarization request auth.

## Compaction terminal-state and retry recovery parity (2026-08-13)

### What changed

- Successful manual compaction now clears its controller before publishing
  `compaction_end`, so listeners observe a terminal state and may queue prompts.
- Prompt admission failures during manual compaction report
  `preflightResult(false)`.
- Recoverable length-stopped assistants are removed before the post-compaction
  continuation, matching error-stopped recovery.
- Summarization reuses an active request API key for ordinary key-auth providers
  while preserving stored OAuth resolution and its account-specific base URL.

### Why

- The merged lifecycle emitted completion while `isCompacting` was still true,
  omitted the preflight rejection callback, and retained truncated assistants
  that prevented the scheduled retry from reaching the provider.

### Why an extension could not handle it

- Prompt admission, lifecycle publication, and continuation message ownership
  are private `AgentSession` state transitions.

### Expected merge conflict zones

- HIGH: `agent-session.ts`, around `isCompacting`, `prompt()`, successful
  `_executeCompaction()` completion, and `_runAutoCompaction()` continuation.

## Node built-in auth-storage timer import (2026-08-13)

### What changed

- Normalized the auth-storage retry delay import to `node:timers/promises`.

### Why

- Vitest's module runner can resolve bare `timers/promises` relative to an
  aliased package root, breaking codemode suites that import the coding-agent
  source graph.

### Why an extension could not handle it

- Auth storage is loaded as core module code before extensions can intercept
  module resolution.

### Expected merge conflict zones

- LOW: `auth-storage.ts`, in the Node timer import used by bounded retries.

## Historical image transport limits (2026-08-12)

### What changed

- Added `images.maxHistoricalImages` to limit how many images from completed
  turns are replayed to providers.
- Images in the active turn remain intact. Older images are replaced only in
  the provider request payload with the existing recoverable elision marker;
  persisted session history is unchanged.

### Why

- Long coding sessions could resend tens of megabytes of already-processed
  screenshots on every request, increasing upload cost and vision prefill even
  when the active turn contained no image.
- The setting is opt-in and removing it restores the previous replay behavior.

### Why an extension could not handle it

- Elision runs inside the core-owned transport conversion before provider
  dispatch and below extension payload hooks.
- The `images.*` setting and the request conversion are both core `Settings`
  and SDK responsibilities.

### Expected merge conflict zones

- MEDIUM: `messages.ts`, in the historical-image counting and elision loop.
- LOW: `settings-manager.ts`, in the `images.*` schema and getter.
- MEDIUM: `sdk.ts`, where `convertToLlmForTransport()` forwards the limit into
  the upstream-owned block-image conversion path.

## Extension OAuth runtime credential overlay (2026-08-13)

### What changed

- Preserved `asExtensionOAuthRegistry`, which overlays extension-registered
  OAuth providers onto the core runtime credential registry.

### Why

- Builtin and third-party OAuth extensions need to participate in model
  credential resolution without replacing the core credential store.

### Why an extension could not handle it

- The overlay is the core boundary that turns extension registrations into the
  credential interface consumed by model runtime and auth preflight.

### Expected merge conflict zones

- LOW: `runtime-credentials.ts`, around the registry wrapper and provider
  lookup delegation.

## OpenGateway display name for /login (2026-08-12)

### What changed

- `BUILT_IN_PROVIDER_DISPLAY_NAMES` maps `opengateway` to `OpenGateway`, which makes the new
  built-in provider API-key eligible in the `/login` and `/logout` selectors on both the TUI and
  RPC provider lists.
- `defaultModelPerProvider` gains the required `opengateway` entry (`moonshotai/kimi-k3`) so the
  exhaustive `Record<KnownProvider, string>` map stays total.

### Why

- `isApiKeyLoginProvider()` treats a built-in model provider without a display name as ineligible
  for API-key login; the display-name entry is the single switch that exposes the provider.

### Expected merge conflict zones

- LOW: `provider-display-names.ts` display-name map.

## Ambient auth resolution honours the request signal (2026-08-13)

### What changed

- `ExtensionOAuthConfig.resolveAmbient()` (`provider-composer.ts`) accepts an optional `signal` alongside `ctx`.
- The ambient-only api-key auth in `provider-api-key-auth.ts` forwards the `AbortSignal` that `ApiKeyAuth.check`
  and `ApiKeyAuth.resolve` already receive, so an abandoned request stops waiting on ambient resolution.

### Why

- Ambient resolution can shell out to a provider CLI, which runs on the auth path of every request. Without the
  signal an aborted turn still waited for that work to settle.

### Expected merge conflict zones

- LOW: the `resolveAmbient` signature in `provider-composer.ts` and the ambient auth callsites in
  `provider-api-key-auth.ts`.

## Compose ambient api-key auth for OAuth providers (2026-08-12)

### What changed

- `ExtensionOAuthConfig` (`provider-composer.ts`) gained an additive optional `resolveAmbient()` hook for providers
  whose credentials live outside `auth.json` — an environment token, or a CLI the provider shells out to.
- `composeApiKeyAuth` (`provider-api-key-auth.ts`) previously returned `undefined` for a provider with no inherited
  auth, no configured key and no configured headers whenever `oauth` was present. It now returns ambient-only
  api-key auth built from `resolveAmbient()` when the OAuth config supplies one, and still returns `undefined`
  otherwise. The composed auth deliberately omits `login`, so the OAuth flow keeps ownership of login, and it
  declines whenever a credential is passed, so a stored credential always wins.

### Why this cannot be expressed externally

- `resolveProviderAuth()` in `pi-ai` reads ambient credentials exclusively through `provider.auth.apiKey.resolve()`.
  A provider that registers only `oauth` is therefore unresolvable with an empty `auth.json`, no matter what the
  extension does: the composer discards its ambient credentials before `Models.getAuth()` runs. Availability and
  resolution then disagree, because `Models.checkProviderAuth()` falls back to `oauth.check()` with no credential —
  the provider advertises models it cannot authenticate, and every request fails
  `Provider is not configured: <id>`.
- This restores the resolution path that `apiKey: "claude-sdk-oauth-managed"` provided before 2acbb6e0c, without
  restoring its false availability: the synthesized auth resolves only when the provider's own ambient probe says so,
  where the literal sentinel reported configured unconditionally.

### Expected merge conflict zones

- LOW: the additive `ExtensionOAuthConfig.resolveAmbient` field in `provider-composer.ts`.
- LOW: the early-return branch at the top of `composeApiKeyAuth` in `provider-api-key-auth.ts`.

## Retire extension generations after reload notifications (2026-08-12)

### What changed

- Session reload invalidates the previous `ExtensionRunner` after removed-extension notifications
  have been delivered, including when notification delivery throws.

### Why

- Reload replaced the active runner but left captured references to the previous generation callable.
  Invalidating after the final old-generation lifecycle event preserves notification behavior while
  closing later request registration, emission, and dispatch.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` reload lifecycle ordering.

## Standalone binary codemode sidecar resolution (2026-08-11)

### What changed

- `resource-loader.ts` now loads codemode through a statically imported
  extension factory in compiled Bun binaries, while retaining an explicit
  `node_modules/@code-yeongyu/senpi-codemode/package.json` sidecar lookup for
  source/runtime assets and non-compiled package resolution.
- Source and npm installations retain their existing workspace/package
  resolution paths and builtin ordering.
- Standalone relocation smoke now initializes classic RPC and requires one
  enabled `codemode` extension at `<builtin:codemode>` in
  `get_loaded_surfaces`.

### Why this cannot be expressed externally

- Bun's compiled `$bunfs` `createRequire()` cannot resolve an external package
  beside the executable, and Jiti-loaded sidecar source cannot resolve its
  package dependencies back into the compiled host. The trusted
  builtin-adjacent loader must embed the factory while the distribution keeps
  worker and prelude assets beside the executable.

### Expected merge conflict zones

- HIGH: `resource-loader.ts` around bundled builtin package resolution.
- LOW: standalone binary relocation smoke coverage.

## Preserve extension OAuth availability checks (2026-08-11)

### What changed

- Extension provider OAuth configs can expose the additive `check()` availability hook from `pi-ai`.
- `provider-composer.ts` carries that hook through `adaptOAuth()` so the canonical model runtime can classify stored
  sentinel credentials and ambient OAuth sources without provider-specific core branches.

### Why this cannot be expressed externally

- Extension registration is normalized into canonical provider auth inside the core composer; without this adapter
  field, the provider's hook is discarded before `Models.checkAuth()` runs.

### Expected merge conflict zones

- LOW: the additive `ExtensionOAuthConfig.check` field and `adaptOAuth()` spread in `provider-composer.ts`.

## Refresh server-fallback policy for active-turn model changes (2026-08-10)

### What changed

- `AgentSession` now recomputes `abortServerSideFallback` in its next-turn refresh snapshot from the live retry
  settings and the newly active model's configured fallback chain.
- Favorite-model cycling during tool execution previously changed the next request's model but left the agent loop's
  run-start server-fallback option unchanged. A Fable request entered from an unchained model could therefore accept
  and persist Anthropic's provider-native Fable-to-Opus fallback instead of routing the refusal through Senpi's
  configured chain.
- The explicit `retry.abortServerSideFallback: false` opt-out remains false after the same in-turn model cycle.
- Coverage reproduces the real request order with a faux tool: unchained model request, favorite cycle during tool
  execution, then a chained-model continuation.

### Why this cannot be expressed externally

- Extensions can trigger or observe model selection, but the live provider option is assembled by agent-core from the
  session's next-turn snapshot before the continuation request is sent.

### Expected merge conflict zones

- LOW: `_installAgentNextTurnRefresh()` next-turn snapshot fields in `agent-session.ts`.
- LOW: `server-fallback-abort-option.test.ts` continuation-policy coverage.

## Extension filesystem policy binding (2026-08-09)

### What changed

- `AgentSession._buildRuntime()` composes factory-registered filesystem policies once and injects the resulting optional
  checker into Senpi's six built-in file tools.
- Policy absence produces `undefined`, preserving the previous runtime path without per-call extension dispatch.

### Why this cannot be expressed externally

- Only the session runtime constructs the canonical built-in tool definitions and can install a checker below
  permission/approval hooks while keeping extension-overridden custom tools separate.

### Expected merge conflict zones

- LOW: `_buildRuntime()` around extension result loading and `createAllToolDefinitions()` options.

## Prompt-cache keep-alive and goal backstop settings (2026-08-09)

### What changed

- `settings-manager.ts` gained `promptCache.goalBackstopMaxSeconds` (default 3570) capping the
  cache-derived goal continuation backstop, and `promptCache.keepAlive`
  (`enabled` default false, `maxRequestsPerSession` 3, `maxCostUsdPerSession` 0.05,
  `marginSeconds` 60) governing the opt-in `cache-keepalive` builtin extension.

### Why not an extension

- Both live on `Settings`, which is core-owned; extensions read them through
  `ExtensionContext`, they cannot declare new persisted settings keys themselves.

### Merge-conflict zones

- `PromptCacheSettings` interface and the corresponding getters in `settings-manager.ts`.

## Dispatch extension commands before settled session work (2026-08-09)

### What changed

- Registered extension slash commands now dispatch at the head of `AgentSession.prompt()`, after any
  in-flight user-abort wait but before prompt-start ownership and the settled-session-work gate.
- A synchronous command lookup avoids adding an await or widening prompt-start admission for unknown
  leading-slash text. Handled commands preserve the existing `promptDisposition("handled")` and
  `preflightResult(true)` callbacks; post-handler cancellation reports `preflightResult(false)` and
  rethrows.

### Why

- Extension commands are UI actions, not prompts. Serializing them behind compaction or the
  session-work barrier delayed command output until an active continuation run ended, even though
  the same commands were intended to execute immediately.

### Accepted behavior deltas

- Idle extension commands now skip `_maybeRestoreFallbackPrimary()`. `/fast` and `/fallback` may
  observe a fallback model whose cooldown has expired; the primary is still restored by the next
  real prompt.
- In print mode, a slash command in a scripted `-m` message list executes immediately rather than
  after pending continuations.
- App-server handled-command turn lifecycle behavior is unchanged, but command handling can now
  complete earlier relative to its pre-existing started/user-message events.

### Why this cannot be expressed externally

- The settled-work admission gate and prompt-start bookkeeping live inside `AgentSession.prompt()`;
  an extension command handler cannot run until core dispatch reaches it.
- Expected merge-conflict zone: `agent-session.ts` at the head of `prompt()` around user-abort,
  extension-command dispatch, prompt-start ownership, and settled-work admission.

## Degrade fallback-unavailable 429s to in-turn retry (2026-08-06)

### What changed

- A 429-class failure whose hint tier routes to fallback (`no-hint-fast-fallback`, tier2, tier3) no
  longer fails the turn with `auto_retry_end { attempt: 0 }` when no fallback candidate is usable
  (no chain for the model, chain exhausted, candidates cooling, or unauthenticated).
- No-hint failures degrade to same-model in-turn retries on the ordinary `settings.retry`
  exponential schedule; tier2 hinted waits retry in-turn with the wait clamped to
  `hintedWaitCapMs`; tier3 (>= `probeBackMaxMs`) waits stay terminal but the final error now names
  the provider-requested wait in seconds.
- The pure policy is `degradeWithoutFallback` in `retry-fallback/hint-policy.ts`;
  `agent-session.ts` routes both former instant-death branches through
  `_degradeRateLimitedWithoutFallback`, which also reports the TRUE attempt count on budget
  exhaustion.

### Why

- Providers that send hint-less 429s (e.g. wafer `server_overloaded` bodies that literally say
  "Please retry shortly") killed the turn on the FIRST 429 for any model without a usable fallback
  chain, surfacing "Retry failed after 0 attempts". sst/opencode retries such failures in-turn
  with a visible countdown and openai/codex replays the turn within its stream budget; failing
  with zero attempts was strictly worse than both.

### Why this cannot be expressed externally

- Retry admission, the retry promise, `_retryAttempt` accounting, and the hint tier router live in
  `AgentSession._handleRetryableError`; an extension cannot re-enter the continuation path after
  the fallback controller declines a candidate.
- Expected merge-conflict zone: `agent-session.ts` `_handleRetryableError` 429 tier routing and the
  `retry-fallback/hint-policy.ts` tail.

## Absolute-cap compaction rejection message (2026-08-05)

- `describeCompactionRejection()` for `"per-turn-cap"` now reads "absolute compaction cap reached for
  this session." The cause identifier is unchanged for extension-API stability; only the per-turn soft
  cap was removed (see `extensions/builtin/compaction/changes.md`).
- Expected merge-conflict zone: `agent-session.ts` around `describeCompactionRejection`.

## Bound provider-timeout retry continuations (2026-08-05)

### What changed

- Provider stream/transport timeout retries keep the existing first-request
  option cap, including the rule that disabled ordinary stream guards stay
  disabled.
- A separate retry-continuation watchdog now uses the same positive
  `retry.provider.streamRetryTimeoutMs` budget to abort only the Agent run whose
  signal it captured. A later prompt or low-level takeover cannot be cancelled
  by the stale timer.
- Timeout option planning and watchdog ownership live in
  `provider-timeout-retry.ts`; the oversized `AgentSession` delegates instead of
  absorbing another retry responsibility.

### Why

- A transport error such as `Request timed out.` could start a retry while both
  ordinary stream guards were disabled. If that retry emitted no provider
  events, its detached continuation held the session work barrier and retry
  promise forever, leaving the interactive session visibly Working until the
  process restarted.
- Re-enabling user-disabled stream guards would mask the wedge by changing an
  intentional policy. The retry-owned watchdog supplies liveness without
  changing provider call options.

### Why this cannot be expressed externally

- Only `AgentSession` owns the retry promise, scheduled-continuation barrier,
  active Agent signal, and settled lifecycle. An extension cannot prove that a
  timer still owns the same retry run before aborting it.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` scheduled continuation and retry admission wiring.
- LOW: `provider-timeout-retry.ts` timeout option planning and owned-run abort.
- LOW: provider timeout recovery regression file organization.

## Default fallback chains survive user chain configuration (2026-08-04)

### What changed

- `retry-fallback/settings.ts` now layers user `retry.fallbackChains` over
  `DEFAULT_FALLBACK_CHAINS` per key instead of replacing the whole map. A user
  key of the same name still replaces that default outright (never a union), and
  an explicit empty array removes a default the user does not want.
- `retry-fallback/validate.ts` no longer warns that an empty chain "must contain
  at least one entry", because an empty array is now the documented opt-out.
- The malformed-map warning names the offending value
  (`"...but got null."` / `"...but got an array."`) instead of being anonymous.
- `SettingsManager.getFallbackChainsScope()` reports which scope supplied
  `retry.fallbackChains` (project wins, since it replaces the map wholesale), and
  every `validation_warning` log record now carries that scope as `source`, so a
  single log line names the file to open. `source` is `"default"` when no scope
  configured chains and the resolved map is the shipped defaults.

### Why

- Configuring an unrelated model silently deleted every shipped default chain.
  A user who added only `apitopia/kimi-k3-*` chains lost the default
  `anthropic/claude-fable-5` chain without any warning.
- That loss then propagated into policy: with no chain for the active model,
  `hasConfiguredChain()` returned false, the 2026-08-03 server-fallback policy
  correctly disabled `abortServerSideFallback`, and Anthropic's server-side
  substitution replaced the user's intended client fallback. The policy behaved
  as designed; its input was wrong.
- The anonymous "must be a plain object" warning fired repeatedly in real logs
  with no way to identify which value produced it.

### Why this cannot be expressed externally

- Defaults-vs-user resolution happens inside settings resolution, before any
  extension observes a session. An extension can add chains through
  `setFallbackChain`, but cannot restore a default the resolver already dropped.

### Expected merge conflict zones

- LOW: `retry-fallback/settings.ts` `resolveFallbackChains()`.
- LOW: `retry-fallback/validate.ts` empty-entry branch and the malformed-map string.
- LOW: fallback settings/validate test expectations.

## Durable compaction telemetry correlation (2026-08-03)

### What changed

- `agent-session.ts` retains superseded compaction attempt IDs until their stale terminal event arrives, rather than evicting the oldest ID after 64 supersessions.
- A `compaction_end` event without a request ID is now logged as an uncorrelated skipped/no-attempt decision and cannot consume an active same-reason attempt. Request-bearing terminals still require an exact attempt-ID match.
- `test/session-log-routes.test.ts` covers an early stale accepted terminal after more than 64 supersessions and no-ID retry exhaustion while another overflow attempt remains active.

### Why

- FIFO tombstone eviction allowed a late accepted terminal from an old attempt to reappear as a committed compaction after enough supersessions.
- Reason-only fallback correlation let retry exhaustion, which starts no compaction and carries no request ID, falsely mark an unrelated active overflow attempt as failed/compact.

### Why this cannot be expressed externally

- Attempt ownership and session-log emission meet inside `AgentSession._logSessionEvent()` before external telemetry consumers receive the content-free lifecycle record.

### Expected merge conflict zones

- LOW: `agent-session.ts` compaction start/end logging correlation and `test/session-log-routes.test.ts` lifecycle telemetry coverage.

## Required-compaction continuation recovery (2026-08-03)

### What changed

- `AgentSession` marks only provenance-confirmed required-compaction admission errors as retrying.
- Accepted post-turn threshold compaction resumes the exact interrupted continuation, including queued
  steering input, without fabricating a user `continue`.
- A locally proven required-compaction error can use the persisted byte estimate when every provider
  usage sample is missing or zero.
- Rejected recovery stays terminal, provider errors with the same text do not gain retry provenance,
  and one recovery sequence persists one threshold error.

### Why

- Required admission previously surfaced as a terminal provider failure before the recovery compaction
  finished, leaving active work idle even after a successful compaction.

### Why this cannot be expressed externally

- Only the session runtime owns the interrupted continuation, compaction lifecycle, provider-admission
  ordering, and queued-input precedence.

### Expected merge conflict zones

- `agent-session.ts` required-compaction provenance, `_runAutoCompaction()`, and upstream request-ID telemetry.

## Prefer configured client fallback chains over server substitutions (2026-08-03)

### What changed

- `agent-session.ts` now enables Anthropic's server-fallback abort only when the
  current model has a configured client fallback chain.
- The policy refreshes before each prompt and after every active-model switch,
  so `/fallback` edits, manual model changes, retry fallbacks, and primary
  restoration cannot carry stale precedence into the next provider request.
- An explicit `retry.abortServerSideFallback: false` still opts out even when a
  client chain exists.

### Why

- The previous session bootstrap enabled the abort unconditionally by default.
  When Anthropic substituted `claude-opus-4-8` for `claude-opus-5` and no client
  chain existed, Senpi discarded the valid substitute response and surfaced an
  error plus a warning telling the user to configure `/fallback`.
- Server fallback should be the default recovery when the user has not selected
  a client policy; an explicit client chain should remain authoritative when it
  exists.

### Why this cannot be expressed externally

- The decision must be forwarded in request-local provider options before the
  Anthropic stream parses a fallback receipt. Extensions can configure chains
  and observe events, but cannot change the agent loop's provider option after
  model selection and before each internal retry continuation.

### Expected merge conflict zones

- LOW: `agent-session.ts` around `_promptAgent()` and `_switchActiveModel()`.
- LOW: server-fallback option/routing tests.

## Resume queued messages after non-auto compaction; retain admission-rejected custom messages (2026-08-03)

### What changed

- `agent-session.ts` gained `_resumeQueuedMessagesAfterCompaction()`, mirroring
  `_runAutoCompaction`'s accepted-path recovery, and calls it on the success
  paths of `applyCompaction()`, the extension `compact` context action, and
  manual `compact()`.
- `sendCustomMessage()`'s non-streaming `triggerTurn` path now retains the
  message in the matching agent-level queue (`followUp`/`steer`) before
  rethrowing when provider admission (`_enforceCompactionBeforeProvider` /
  `_enforceFinalProviderAdmission`) rejects, mirroring `sendUserMessage`'s
  documented retention contract.

### Why

- A custom `triggerTurn` message sent while a non-auto compaction owned the
  session (extension feedback stage via `beginCompaction`, extension `compact`
  action, manual `/compact`) was parked in the agent-level queues without a
  turn and nothing resumed it afterwards; an admission rejection dropped the
  message entirely because the fire-and-forget extension `sendMessage` action
  swallows the rejection. Hidden goal continuations were the primary victim:
  their single-flight latch clears only on `agent_start`, so the goal silently
  idled at "Pursuing goal (...)" until manual user input.

### Why this cannot be expressed externally

- Both fixes depend on internal compaction lifecycle ownership, agent-level
  queue state, and the private continuation scheduler; no extension hook can
  observe or reschedule them.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `compact()` / `applyCompaction()` / the
  extension `compact` action finally blocks, `sendCustomMessage()`'s
  triggerTurn branch, and `_scheduleContinuationAfterCurrentEvent()`.

## Hint-aware 429 retry tier routing (2026-08-03)

### What changed

- `agent-session.ts` retry orchestration classifies 429-class errors into three tiers using the structured
  hint from `packages/ai`: no-hint 429 falls back immediately with zero same-model retries; tier 1 (hint ≤
  `hintedWaitCapMs`, default 300 000 ms) performs in-turn half/full probes via `nextInTurnDelayMs` with
  cumulative-cap demotion; tier 2 (`hintedWaitCapMs` < hint < `probeBackMaxMs`) falls back and schedules
  at most two `ProbeBackScheduler` probes at half/deadline, clearing cooldown on success so
  `maybeRestorePrimary` reverts next turn; tier 3 (hint ≥ `probeBackMaxMs`) falls back only with a
  remaining-hint cooldown.
- `retry-fallback/probe-scheduler.ts` (new) owns the tier 2 probe schedule. `retry-fallback/controller.ts`
  and `retry-fallback/cooldown.ts` carry the tier decision and cooldown state.
  `retry-fallback/settings.ts` adds `resolveHintPolicySettings` with `hintedWaitCapMs` and `probeBackMaxMs`
  (defaults 300 000 / 3 600 000 ms).
- New session events `retry_probe_scheduled` and `retry_probe_result` surface probe lifecycle to the client.
- `retry-fallback-long-delay.test.ts` has two intentionally updated assertions: tier routing replaces the
  legacy over-budget gate for 429-class errors, so the expected retry/fallback behavior changes accordingly.

### Why

- A blind exponential backoff on 429 wastes a turn when the provider says “retry now,” and retries
  immediately when the provider says “wait an hour.” Structured hints let the agent respect the provider's
  guidance instead of guessing.

### Why this cannot be expressed externally

- The tier decision must intercept the retry sleep and fallback switch inside agent-session's orchestration
  loop, between the provider error and the retry/fallback decision. The extension API exposes no hook at that
  point — extensions see only post-decision error strings.

### Expected merge conflict zones

- HIGH: `agent-session.ts` retry orchestration (approximately lines 5380–5705).
- MEDIUM: `retry-fallback/*` (controller, cooldown, settings, probe-scheduler).
- LOW: `settings-manager.ts` for the new `hintedWaitCapMs` / `probeBackMaxMs` settings.

## Backfill: eval bridge deadlock prevention (2026-08-01)

### What changed

- Eval bridge requests no longer deadlock the session when completion and bridge delivery race.

### Why

- A blocked bridge stalls the entire agent turn and leaves no safe continuation path.

### Why this cannot be expressed externally

- The fix depends on internal agent-session bridge ordering and completion ownership.

### Expected merge conflict zones

- Agent-session eval bridge handlers, pending request state, and completion/error cleanup.

## Deduplicate high-reasoning warnings per session model (2026-07-31)

### What changed

- `agent-session.ts` now remembers every sensitive provider/model identity that
  already displayed the high-reasoning warning during the current session.
- Moving between `xhigh`, `max`, lower reasoning levels, or another model no
  longer re-arms the warning for an identity the user already saw.
- A different sensitive provider/model identity still receives its own first
  warning.

### Why

- The previous single last-key value was cleared whenever the active state was
  not warnable and included the reasoning level in its key. Cycling reasoning
  levels or switching away and back therefore appended the same large warning
  box repeatedly.

### Expected merge conflict zones

- LOW: `agent-session.ts` warning-dedup state and
  `_emitHighReasoningWarningIfNeeded()`.

## Preserve the user's reasoning preference across model switches (2026-07-31)

### What changed

- `agent-session.ts`: manual model selection and favorite-model cycling now
  apply model-specific overrides and capability clamps as session-effective
  levels without replacing `defaultThinkingLevel`.
- Model switches without an explicit favorite tier restore the remembered
  `defaultThinkingLevel` before clamping it to the selected model.

### Why

- Switching from a max-capable model to a basic reasoning model persisted the
  clamped `high` tier, so switching back no longer restored the user's last
  selected `max` tier. Explicit favorite tiers could likewise replace the
  global preference even though they are model-specific overrides.

### Expected merge conflict zones

- LOW: `agent-session.ts` around `_switchActiveModel()`,
  `_cycleFavoriteModel()`, and `_getThinkingLevelForModelSwitch()`.

## Thinking-level tier detection delegates to packages/ai (2026-07-30)

### What changed

- `thinking-levels.ts` no longer re-implements the `xhigh` / `max` model-id lists. `supportsXhigh`,
  `supportsMax`, and `getSupportedThinkingLevels` now wrap the canonical `@earendil-works/pi-ai` helpers
  and only keep the coding-agent's `ThinkingLevel` vocabulary plus the non-empty `["off"]` fallback.
- The local `ModelWithThinkingLevelMap` cast is gone: `Model.thinkingLevelMap` is already part of the
  public `pi-ai` model type.

### Why

- Tier rules belong to `packages/ai`; delegating removes the coding-agent's duplicate model-id lists and
  precedence logic so future capability changes have one implementation. Generated catalog models retain
  their explicit maps, so behavior for real catalog models is intentionally unchanged.

### Why extension system couldn't handle this alone

- Tier detection feeds session thinking-level clamping and the model/RPC surfaces inside core; it is not
  reachable from an extension.

## Codex fast-variant service-tier metadata lookup (2026-07-29)

### What changed

- `model-registry.ts` now exposes a selected model's configured `serviceTier`
  synchronously, alongside the existing `getUpstreamModelId()` lookup.
- The builtin `/fast` command uses both values to accept only catalog siblings
  that send the same upstream model with `service_tier: "priority"`.

### Why

- A `-fast` suffix alone is not proof that a model supports priority
  processing. The command must validate the request metadata already resolved
  by the model registry before switching the session.

### Why extension system couldn't handle this alone

- Compatibility request metadata is composed inside `ModelRuntime`; extensions
  can inspect the registry but could not synchronously read its resolved
  per-model service tier.

### Expected merge conflict zones

- LOW: the request-metadata accessors in `model-registry.ts`.

## Settings withLock first-write TOCTOU fix (2026-07-29)

### What changed

- `settings-manager.ts` `FileSettingsStorage.withLock`: when the settings file does not exist yet, the merge callback used to run with no lock held and the write-time lock then overwrote whatever a concurrent process had created. The write path now re-checks existence after acquiring the lock and re-runs the merge callback against the winner's content before writing. The existing-file path additionally re-verifies existence after the lock before reading.
- Pure read paths are unchanged: a read on a missing file still creates no directory and no lock artifacts, so loading settings in an arbitrary cwd still cannot spray `.senpi/` directories.

### Why

- Two processes racing the first write of a fresh `settings.json` silently lost one side's fields (`existsSync` gated the lock, so the merge ran unlocked). Deterministic regression: `test/settings-storage-lock.test.ts` injects a concurrent first-write at lock acquisition and asserts the merge preserves it.

## Nearest-parent project settings discovery (2026-07-28)

### What changed

- `settings-manager.ts`: project settings now resolve from the nearest ancestor containing a real `.senpi` directory, rather than only from the exact cwd. If none exists, the legacy `<cwd>/.senpi/settings.json` path remains the write/read target.
- Global settings remain loaded before project settings, so project values continue to override the selected agent-directory settings layer.

### Why

- Invoking senpi below a project root silently skipped that root's `.senpi/settings.json`.

### Expected merge conflict zones on next upstream sync

- LOW: `getSettingsPath()` in `settings-manager.ts`.

## messages.ts keep-latest exclusion for goal-continuation (2026-07-29)

### What changed

- `messages.ts` now excludes consumed `goal-continuation` custom messages by position instead of by type: every
  `role === "custom" && customType === GOAL_CONTINUATION_MESSAGE_TYPE` entry is dropped except the last one.
  The same keep-latest rule is applied in both `filterContextExcludedMessages` and `convertToLlm`, so token estimation
  and provider payload assembly stay in sync.
- `isContextExcludedCustomMessage` remains `false` for this custom type; the live triggering message still needs to be
  visible to per-entry consumers such as compaction and branch summarization.

### Why

- Goal continuation messages accumulate across long sessions, and stale consumed entries must stay out of the next
  provider request without hiding the active trigger or letting the estimator disagree with the payload.

### Expected merge conflict zones on next upstream sync

- LOW in `messages.ts` around the shared keep-latest helper, `filterContextExcludedMessages`, and `convertToLlm`.
- NONE in the per-entry custom-message predicate semantics.

## AgentEndEvent.willRetry extension event field (2026-07-29)

### What changed

- `extensions/types.ts` now exposes an optional `willRetry?: boolean` on `AgentEndEvent`, mirroring the agent-session
  end event so builtin extensions can tell a terminal provider error from a retryable one.
- The field is additive only; existing extension consumers that ignore it continue to behave the same.

### Why

- The goal builtin needs to block on terminal provider errors only after retries are exhausted. Without the retry
  signal, a terminal error could be misclassified while a fallback retry was still in flight.

### Expected merge conflict zones on next upstream sync

- LOW in `extensions/types.ts` and the runner plumbing that forwards agent-session end events to builtin extensions.

## claude-agent-sdk provider with native multi-account OAuth (2026-07-27)

### What changed

- New builtin extension `core/extensions/builtin/claude-agent-sdk/`: routes LLM calls through the
  official Claude Agent SDK (spawns the real Claude Code engine) while senpi executes all tools
  (Claude Code tool use is denied; custom tools are exposed in-process as `mcp__custom-tools__*`).
- Auth: `/login claude-agent-sdk` runs the existing Anthropic PKCE flow and stores multi-account
  slots inside the provider credential (top-level fields are non-expiring sentinels; real refresh is
  per-slot under the store lock). Import of an existing `anthropic` OAuth credential and
  `CLAUDE_CODE_OAUTH_TOKEN(_N)` env accounts supported.
- HRW session affinity (rendezvous hashing) pins each session to one account to preserve prompt
  cache; mandatory failover on rate_limit/overloaded/auth errors only, stream-safe (no transparent
  retry after the first visible delta) with an AgentSession `senpi:no-turn-retry:` marker suppressing
  whole-turn replay of post-delta failures.
- Surfaces: `/claude-account` command, `--claude-account` flag, RPC `get_provider_accounts` /
  `account_pin` / `account_remove` plus `auth_accounts_changed` / `account_failover` events, and
  actionable auth guidance. `AuthStorage` learned to enumerate extension-registered OAuth providers
  (`registerOAuthProvider` bridge), synced from `ModelRuntime.registerProvider`.
- Dependency: `@anthropic-ai/claude-agent-sdk` pinned `0.3.220`; `@anthropic-ai/sdk` stays `0.91.1`
  via a root override (the `>=0.93.0` peer range breaks the browser build through node-builtin
  imports in new credential modules).

## Session-title generation retry + humanized provider errors (2026-07-27)

### What changed

- `session-title-generator.ts`: `generateSessionTitle()` accepts an optional `retry: RetryPolicy` and wraps the
  title call in `retryAssistantCall`, mirroring `completeSummarization()`. A transient provider error (e.g. an
  Anthropic 529 `overloaded_error` stream event) no longer fails title generation on the first attempt. Final
  failures throw `humanizeProviderError(...)` output — a short human-readable line such as
  `Overloaded (overloaded_error, request req_...)` — instead of the raw provider JSON body.
- `session-title-generator.ts`: new `sessionTitleRetryPolicy()` narrows the user's `settings.retry` for this
  cosmetic background call — `enabled` is preserved, `maxRetries` capped at 1 and `baseDelayMs` at 2000ms, and a
  smaller configured budget is never inflated. The full agent-turn budget would keep hitting an already-overloaded
  provider for ~14s while the user's real turn competes for the same capacity; a title that still fails is
  regenerated at the next turn end anyway.
- `agent-session.ts`: `_generateSessionTitle()` passes `sessionTitleRetryPolicy(settingsManager.getRetrySettings())`.
  The runtime-emitted extension-error sites now use the shared `RUNTIME_EXTENSION_PATH` sentinel constant.

### Why

- A single transient 529 during background title generation surfaced as `Extension "<runtime>" error: {raw json}`
  in the TUI and left the session untitled until the next turn end.

### Expected merge conflict zones

- LOW: `session-title-generator.ts` around `generateSessionTitle()`.
- LOW: `agent-session.ts` `_generateSessionTitle()` and the `emitError` call sites.

## Composable leading skill commands (2026-07-26)

### What changed

- `agent-session.ts`: `/skill:<name>` now accepts a leading whitespace-separated run of loaded skills, expanding each unique skill in written order before appending the remaining prompt text. Repeated skills expand only once, unknown skills stop the run and remain literal, and slash text outside that leading run is never interpreted as a skill command.
- Explicit expansion is capped at `MAX_SKILL_EXPANSIONS_PER_PROMPT` (5). Commands beyond the cap remain literal and emit an existing `skill_expansion` error-channel notification, preventing a composed prompt from growing context without bound.
- The shared expansion seam is called by `prompt()`, `steer()`, and `followUp()`, so queued and non-TUI/RPC prompt paths receive identical behavior.

### Why extension system couldn't handle this alone

Skill commands are resource-loader entries rather than extension commands, and their substitution happens in the private `AgentSession` prompt and queue boundary before the outbound user message is assembled.

### Expected merge conflict zones

- LOW: `agent-session.ts` `_expandSkillCommand()` if upstream revises skill-command parsing.

## Provider-bound inline image budget (2026-07-26)

### What changed

- `messages.ts`: added a transport-only 24 MiB inline image budget. Provider-bound conversion keeps the newest image
  block, counts it against the budget, and replaces images older than the hard recency cutoff with a re-read
  placeholder while preserving all text and leaving the persisted session untouched.
- `sdk.ts`: routes the main agent loop through the shared transport conversion while preserving the dynamic
  `images.blockImages` kill switch and its existing placeholder/deduplication behavior.
- `test/suite/harness.ts`: uses the same transport conversion and accepts a small injectable image budget for
  deterministic first-request integration coverage.

### Why extension system couldn't handle this alone

- Inline images must be bounded after session messages are converted but before every main-loop provider request,
  including resumed sessions and provider fallbacks. That conversion boundary is owned by the core Agent wiring.

### Expected merge conflict zones

- MEDIUM: `sdk.ts` around the Agent `convertToLlm` wiring.
- LOW: the transport helpers at the end of `messages.ts` and the Agent construction in `test/suite/harness.ts`.

## Thinking-level tier detection for Claude 5 families and GPT-5.6 (2026-07-25)

### What changed

- `src/core/thinking-levels.ts`: `supportsXhigh` now recognizes `gpt-5.6`, `opus-5`, `sonnet-5` and
  `fable-5`; `supportsMax` recognizes `opus-5`, `sonnet-5` and `fable-5`. These lists are the fallback
  for models with no `thinkingLevelMap` (custom `models.json` entries and third-party gateways), so
  those models previously could not reach the `xhigh` / `max` tiers in the level cycler even though
  their provider accepts them. Bundled catalog models are unaffected because an explicit map wins.
- This file is the coding-agent copy of the tier predicates; `packages/ai/src/models.ts` owns the
  `pi-ai` copy and was updated in lockstep.

### Why

- `off` also became selectable for Claude Fable 5 in this change set: `packages/ai` now encodes
  "cannot send `thinking.type: disabled`" as a compat fact rather than `thinkingLevelMap.off: null`,
  and the Messages provider pins the cheapest effort for an off turn. The selector needed no change
  for that - removing the `null` was enough.

## Session-owned compaction lifecycle (2026-07-23)

### What changed

- `agent-session.ts` now holds a monotonic compaction lifecycle coordinator that snapshots the active model and
  controller at operation start, rejects stale completion/feedback, and retains the terminal result until another
  operation begins. Feedback-only aborts publish one terminal event, and accepted completions publish their terminal
  event before `session_compact` handlers can begin a fresh operation.
- Owned automatic compaction attempts publish balanced start/end events when execution cannot begin. Ownership is
  rechecked after start: a synchronous listener that supersedes the controller with a new operation silences the stale
  terminal event (the new owner publishes its own lifecycle), while a listener that aborts the same controller still
  receives an `aborted` terminal event so UI state opened on `compaction_start` is always closed.
- Durable append now rejects a generation whose message revision or agent-message snapshot changed during preparation
  or summary generation (`stale-revision`), preserving intervening context without duplicate replay.
- Required compaction uses one provider-admission gate for normal prompts, extension-triggered turns, and every next
  turn. Provider-confirmed overflow remains fail-closed even when the local token estimate is below the configured
  threshold; `agent_end` synchronously transfers both silent-overflow and threshold-compaction continuation ownership
  to `AgentSession` before agent-core can drain native queues, and failed recovery restores the overflow context so
  later prompts cannot bypass the same requirement.
- Next-turn snapshots reapply the live active tools and effective per-run system prompt after asynchronous preparation,
  so a tool removed during the turn is neither advertised nor executable by the following provider request.
- Required ownership now suppresses only agent-core's post-`agent_end` queue drain, not the run abort signal. Deferred
  extension dispatch retains the real source signal, so compaction ownership does not masquerade as user cancellation.
- Retry and fallback admission resolve required compaction first; rejected recovery retains native queues without
  dispatching a provider retry. Active-tool changes advance the context revision and abort active core compaction so
  summaries prepared against a prior tool set cannot apply.
- Fallback apply/revert transitions emit typed model-selection events, rebuild model-scoped tools and prompts, abort
  compaction prepared for the prior model, and re-run required compaction against the selected model's context window
  before retrying.
- Message objects are associated with their persisted session-entry order. Compaction-boundary checks use that order
  (and treat pending `message_end` persistence as post-boundary) instead of relying only on payload timestamps.
- Session reload materialization restores those message-to-entry associations, so older payload timestamps cannot
  bypass post-compaction admission after reopening a session.
- When a late queue triggers compaction after a host `prepareNextTurnWithContext` callback, the callback is replayed
  once against the compacted context so its message filtering/injection contract reaches the provider request.
- Every compaction execution receives its route-owned controller explicitly. Auto compaction cannot promote unrelated
  extension feedback, and superseded feedback controller references are released even when their stale terminal
  callback never arrives.
- Post-retry and post-compaction usage exemptions suppress only stale threshold accounting. Provider-confirmed
  overflow always retains queue ownership and runs fail-closed recovery.
- Extension-originated provider turns now wait behind active session work and manual compaction. `clearQueue()` clears
  both native and post-compaction deferred ownership layers, preventing canceled steer/follow-up input from resurfacing.
- Provider admission is checked again after assembling `nextTurn` and `before_agent_start` custom messages. Rejected
  compaction restores one-shot additions transactionally; accepted compaction rebuilds and rechecks the final visible
  request before the provider is called.
- Request-local context provenance is attached non-enumerably to message identities and removed from persisted/session
  JSON. Remote replay uses it to prove the exact checkpoint boundary after filtering, injection, or reordering.
- Trigger-turn custom messages serialize behind manual/extension compaction before they are appended or sent.
  Scheduled continuation revalidates the canonical context against any model selected by `session_compact`, retaining
  queues when the smaller model requires rejected re-compaction.
- Manual and extension compaction claim a synchronous pending-admission barrier before their first await, closing the
  same-tick window where a trigger-turn custom message could overtake startup. Retry continuation failures that occur
  before provider dispatch now settle retry/idle state and retain queues instead of hanging the session.
- Fire-and-forget `session_start` messages defer past replacement-session work without being discarded as stale.

### Why extension system couldn't handle this alone

- Model selection, durable session append, provider-overflow recovery, controller ownership, and prompt admission are
  private `AgentSession` lifecycle boundaries.

### Expected merge conflict zones

- HIGH: `agent-session.ts` compaction execution, pre-prompt recovery, abort handling, and extension context bindings.

## Streaming steer/followUp submissions bypass the session-work barrier (2026-07-21)

### What changed

- `agent-session.ts` (`prompt()`): a submission with a `streamingBehavior` while a run is active and not
  compacting now queues immediately instead of awaiting `_waitForSettledSessionWork()`. Scheduled
  queued-message continuations (goal chains, queued follow-ups) hold the `SessionWorkBarrier` for the
  entire remaining run, so the old gate trapped typed input inside `prompt()` — invisible, unqueued, and
  undelivered — until the whole chain settled or the user pressed Esc.
- If the run ends while the bypassed input is being expanded, `prompt()` re-serializes with remaining
  session work and re-queues when a scheduled continuation started a new run in the meantime.

### Why extension system couldn't handle this alone

- The trap sits between core-owned `prompt()` serialization and the core continuation scheduler; both are
  private `AgentSession` lifecycle boundaries.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` `prompt()` entry serialization and the streaming queue dispatch branch.

## Memoized materialized session views (2026-07-21)

### What changed

- `session-manager.ts`: added a monotonic `mutationCount` bumped by every mutator (`_appendEntry`, `branch()`,
  `resetLeaf()`, `setSessionFile`, `newSession`, `createBranchedSession`). `getEntries()` is memoized on
  `mutationCount`, no-arg `getBranch()` on `(leafId, mutationCount)` (explicit `fromId` bypasses), and
  `getSessionName()` is O(1) via a cached value maintained on `appendSessionInfo`/`_buildIndex` (empty name still
  clears the title). `getEntries()` now returns a shared cached array callers must not mutate.

### Why extension system couldn't handle this alone

- The mutation surface and resident-store materialization are private to `SessionManager`; external wrappers cannot
  observe every invalidation point.

### Expected merge conflict zones

- LOW: private fields and the listed getters; upstream rarely touches `SessionManager` internals.

## Smooth streaming settings (2026-07-20)

### What changed

- `settings-manager.ts`: added persisted `smoothStreaming` and `smoothStreamingFps` settings. Smoothing defaults on,
  FPS defaults to 60, and reads clamp the configured value to 30–120.

### Why extension system couldn't handle this alone

- The built-in interactive renderer must read the setting before extensions load and while it owns an active stream.

### Expected merge conflict zones

- LOW: `Settings` fields and accessors near the existing thinking-visibility setting.

## "video" input modality plumbed through provider composition (2026-07-17)

### What changed

- `provider-composer.ts`: model `input` arrays (config input, models.json override, custom model definition)
  widened to `("text" | "image" | "video")[]`, tracking the pi-ai `Model.input` union. Enables the
  kimi-coding `k3` video input capability and models.json overrides declaring video.
- `remote-catalog-provider.ts`: `mergeModels` now unions `input` modalities (canonical text/image/video
  order) when a pi.dev overlay entry replaces a builtin model. The overlay refreshes costs/limits but a
  stale remote entry must not silently drop a fork-declared capability — the cached kimi-coding `k3`
  entry in `models-store.json` otherwise strips `"video"` and deactivates the `read_video` tool.

### Why extension system couldn't handle this alone

- The modality union is a core type shared with pi-ai; extensions consume it but cannot widen it.

### Expected merge conflict zones on next upstream sync

- LOW: `provider-composer.ts` model field lists.

## Model-switch atomicity: live prompt options and api-change gate (2026-07-19)

### What changed

- `src/core/agent-session.ts`: `_modelSelectionChangesContext` now also fires on `api`
  changes with identical provider, id, and context window, so wire-protocol-only model
  changes trigger full toolset/prompt synchronization.
- `src/core/extensions/runner.ts`: `emitModelSelect` re-reads live `systemPromptOptions`
  per handler so an earlier handler that swaps the active toolset (gpt-apply-patch) lets
  later handlers (prompt-preset) rebuild the system prompt from the post-swap tools in
  the same emission.

### Why extension system couldn't handle this alone

- The stale-snapshot defect lives in the core emission path; extensions only consume the
  combined `model_select` result.

## Composed providers engage text tool-call compatibility middleware (2026-07-17)

### What changed

- `provider-composer.ts`: composed provider `stream()` and `streamSimple()` now apply the text tool-call middleware when a model has `compat.toolCallFormat` and active tools. Custom `models.json` providers previously dispatched directly to their base or API provider, silently bypassing this compatibility behavior.

### Why extension system couldn't handle this alone

- Provider composition owns the final base-provider/API-provider stream dispatch before extensions receive model output, so extensions cannot insert the required context transformation and streaming parser on both paths.

### Expected merge conflict zones

- LOW: `provider-composer.ts` shared `streamWith()` dispatch and its `@earendil-works/pi-ai/compat` imports.

## AnthropicMessagesCompat.supportsWebSearch in models.json schema (2026-07-16)

### What changed

- `model-config.ts` (`AnthropicMessagesCompatSchema`): added optional boolean `supportsWebSearch`, mirroring
  `supportsWebSearchPreview` in `OpenAIResponsesCompatSchema`. This is the models.json opt-in for
  Anthropic-compatible endpoints that genuinely support server-side web search (see `packages/ai/src/changes.md`
  2026-07-16); without the schema entry the flag would fail models.json validation.

### Why extension system couldn't handle this alone

- models.json validation happens in core `model-config.ts` before any extension sees the model entry.

### Expected merge conflict zones

- LOW: `model-config.ts` compat schemas if upstream adds more compat flags.

## Skill-loading trigger reframed with cost asymmetry (2026-07-16)

### What changed

- `skills.ts` (`formatSkillsForPrompt`): the load trigger changed from "when the task matches its description" to "whenever its description even loosely matches the task - loading an irrelevant skill costs little; missing a relevant one degrades the work" (ported from omo Hephaestus). `skills.test.ts` pins "even loosely matches".

### Why extension system couldn't handle this

- `formatSkillsForPrompt` is core-owned and rendered into every system prompt. Strict-match framing under-loads skills on compression-biased models (GPT-5.6); stating the cost asymmetry is the decision-rule form the 5.6 guide prescribes for judgment calls.

### Expected merge conflict zones

- LOW: `skills.ts` intro lines if upstream rewords the skills preamble.

## Release accepted auto-compaction ownership before recovery (2026-07-13)

### What changed

- `agent-session.ts`: accepted auto-compaction now releases only its own abort-controller identity before awaiting the recovery continuation, while the session-work barrier remains active until recovery settles.
- Final cleanup is identity-guarded so an older compaction cannot clear a newer controller installed during recovery.

### Why extension system couldn't handle this

- Interactive input classification reads core-owned `AgentSession.isCompacting`, and fresh-prompt serialization depends on the private session-work barrier. Extensions cannot split those two lifecycle boundaries safely.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `_runAutoCompaction()` accepted-result handling and final controller cleanup.

## Post-compaction continuation deadlock fix (2026-07-12)

### What changed

- `agent-session.ts`: deferred post-compaction and queued-message continuations until the current serialized
  `agent_end` event promise resolves, while registering the detached continuation in `SessionWorkBarrier`.
- Overflow retry, threshold/pending-message delivery, and normal queued `agent_end` continuation use the same scheduler.

### Why

- Awaiting `agent.continue()` inside the active `agent_end` queue item deadlocked tool-bearing continuations because
  pre-tool hooks wait for the current agent-event queue to finish persisting.

### Why extension system couldn't handle this

- `AgentSession` owns the event queue, tool-hook barrier, settlement state, and continuation launch boundary.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `agent_end` queued continuation handling and `_runAutoCompaction()` recovery.
- LOW: `_continueAgentAfterCurrentRun()` and the session-work barrier integration.

## Preserve builtin extensions after project trust resolution (2026-07-12)

### What changed

- `resource-loader.ts`: project-trust reloads now carry forward only preloaded factory-origin extensions - builtins, bundled codemode package entries, and inline factories - ahead of file-based extensions.
- Shadowed or disabled file extensions from the pre-trust pass remain excluded from the trusted final set instead of being restored by the factory carry-over.
- Added regression coverage that verifies trusted reloads preserve plain-reload membership and builtin-first order, including `todowrite`, codemode's `eval` tool, and a shadowed `pi-todotools` package.

### Why extension system couldn't handle this

- Project trust uses a core-owned two-phase resource load. Only the resource loader can retain the factory instances and side effects from the untrusted bootstrap pass while rebuilding the final trusted extension order.

### Expected merge conflict zones

- LOW: `resource-loader.ts` around trusted final extension-set composition.
## Upstream model context overflow recovery (2026-07-08)

### What changed

- `model-registry.ts`: exposed configured `upstreamModelId` metadata synchronously so session-control code can compare selected aliases with provider-reported wire model ids without resolving credentials.
- `agent-session.ts`: overflow recovery now treats a context-window error from the configured upstream model id as the same current-model source, preserving the existing stale/unrelated model guard.

### Why extension system couldn't handle this

- Provider context-overflow recovery happens inside the core session compaction gate before extensions can safely decide whether to retry the active turn.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around `_checkCompaction()` overflow eligibility.
- LOW: `model-registry.ts` around model request metadata accessors.

## Bundled codemode extension loading (2026-07-06)

### What changed

- `resource-loader.ts`: added `codemode` as a builtin-adjacent bundled extension loaded from the `@code-yeongyu/senpi-codemode` package manifest.
- The bundled extension is enabled by default, respects `enabledBuiltinExtensions` and `disabledBuiltinExtensions`, is unaffected by `--no-extensions`, and is still removable from the active tool set through `--exclude-tools eval`.
- Resolution failures, including compiled Bun binary package-resolution gaps, are reported as extension diagnostics and startup continues without `eval`.

### Why extension system couldn't handle this

- The extension package is shipped with the CLI and must be active before user extension discovery and project-trust resolution. User-installed extension paths cannot model that trusted default-on load order.

### Expected merge conflict zones

- HIGH: `resource-loader.ts` around builtin extension loading, package shadowing, and active builtin id filtering.

## executeTool active-tool bridge (2026-07-06)

### What changed

- `agent-session.ts`: added the core implementation for `pi.executeTool()`, including active-tool resolution, shared agent-loop argument preflight, synthetic `codemode-*` tool call ids, hook block handling, and post-result rewrites.
- Extracted the existing `beforeToolCall` and `afterToolCall` hook bodies into shared helpers used by both normal agent-loop dispatch and `executeTool()`.

### Why extension system couldn't handle this

- Extensions can observe and register tools, but only the session owns the active wrapped tool instances, the agent-event queue, and the hook/permission pipeline needed to execute subcalls with the same semantics as model tool calls.

### Expected merge conflict zones

- HIGH: `agent-session.ts` around `_installAgentToolHooks()`, `getActiveToolNames()`, and extension `bindCore()` wiring.

## Neo auth RPC core surface (2026-07-06)

### What changed

- `auth-providers.ts` (fork-only): shared auth-provider list module — the single source of truth across the classic
  TUI `/login` flow and the RPC auth commands.
- `agent-session.ts`: emits `auth_login_url` / `auth_login_end` as `AgentSessionEvent`s so interactive OAuth
  round-trips can complete out-of-band of a single RPC request; reuses `AuthStorage.login` callbacks unchanged.

### Why

- The neo Go TUI logs in over RPC (see `modes/rpc/changes.md`); login completion cannot fit inside the 30s RPC
  request timeout, so the terminal result must arrive as session events.

### Why extension system couldn't handle this

- Auth storage, login callbacks, and session event emission are core session services.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` around session event union and emission sites.
- LOW: `auth-providers.ts` (fork-only file).

## Provider stream idle timeout enabled by default (2026-07-06)

### What changed

- `sdk.ts`: the agent's stream idle timeout now defaults to `httpIdleTimeoutMs` (300s default) instead of being off
  unless `retry.provider.timeoutMs` was set.
- `settings-manager.ts`: `httpIdleTimeoutMs` participates in the default resolution; `0` disables, and
  `retry.provider.timeoutMs` still overrides.

### Why

- Sessions went stale forever when the network dropped and reconnected mid-stream: the dead connection never errors.
  Node runs were eventually rescued by the undici dispatcher body timeout, but the Bun binary has no such protection
  and hung indefinitely. With the guard on by default, a silently dead connection fails with a retryable idle-timeout
  error and auto-retry recovers the turn (abort-side fix in `packages/agent/src/changes.md` 2026-07-06).

### Why extension system couldn't handle this

- Stream option defaults are resolved in core SDK/settings plumbing before extensions see a request.

### Expected merge conflict zones

- LOW: `sdk.ts` stream-option assembly; `settings-manager.ts` retry/timeout resolution.

## External stdout/stderr guards while a TUI owns the terminal (2026-07-04)

### What changed

- `hidden-stdout-log.ts` (fork-only): hidden external stdout writes are redacted and appended to the debug log.
- `output-guard.ts` / `sensitive-output.ts`: stderr writes are likewise hidden and redacted while a TUI owns the
  terminal, matching the interactive stderr guard.
- Wiring: interactive mode, startup dialogs, and the config selector (see `modes/interactive/changes.md` and
  `cli/changes.md`); the TUI-side hook is `ProcessTerminal.onExternalStdoutWrite` (`packages/tui/src/changes.md`
  2026-07-04).

### Why

- A stray `console.log` from a library or extension corrupted the trust dialog and permanently desynchronized
  differential rendering.

### Why extension system couldn't handle this

- Redaction and debug-log routing for hidden writes are core services shared by every TUI surface.

### Expected merge conflict zones

- LOW: `hidden-stdout-log.ts`, `output-guard.ts`, `sensitive-output.ts` (fork-heavy files).

## Persist truncated bash output contents (2026-07-03)

### What changed

- `bash-executor.ts`: when bash output is truncated for the model context, the truncated contents are still persisted
  so the session record keeps the full output.

### Why

- Truncation previously dropped the overflow entirely; transcripts and session replays lost output that the user's
  terminal had shown.

### Why extension system couldn't handle this

- Output truncation happens inside the built-in bash executor before tool results reach extension hooks.

### Expected merge conflict zones

- LOW: `bash-executor.ts` truncation/persistence path.

## Await available-model lookups (2026-07-03)

### What changed

- `model-resolver.ts`: available-model lookups are properly awaited instead of racing an unresolved promise.

### Why

- The fork's model-resolution flow could observe an empty model list mid-startup.

### Why extension system couldn't handle this

- Startup model resolution runs before extensions load.

### Expected merge conflict zones

- LOW: `model-resolver.ts` async lookup call sites.

## App-server app-mode plumbing (2026-07-02)

### What changed

- `project-trust.ts`: `AppMode` gained `"app-server"` so project-trust resolution covers the fork's app-server mode
  (mode itself lives in `modes/app-server/`, dispatch in `src/changes.md` 2026-07-02).

### Why

- App-server sessions must honor the same project-trust gating as interactive/rpc modes.

### Why extension system couldn't handle this

- Trust gating is evaluated in core before a mode starts.

### Expected merge conflict zones

- LOW: `project-trust.ts` `AppMode` union.

## Upstream session, auth, and model-resolution sync (2026-07-02)

### What changed

- `auth-storage.ts`: accepted upstream persistence-failure surfacing so `/login` does not report success when `auth.json`
  could not be saved.
- `agent-session.ts`: accepted upstream split-turn serialization and kept fork prompt/compaction settlement behavior.
- `session-manager.ts`: accepted upstream context-building helper splits while preserving fork compaction detail propagation
  through `createCompactionSummaryMessage(entry.details)`.
- `model-resolver.ts`: accepted upstream structured model-resolution diagnostics and public helper behavior while
  preserving the fork's optional warning callback.

### Why

- These upstream fixes improve observable login errors, prevent overlapping summary generations, and expose consistent
  model diagnostics without dropping fork-only compaction metadata or warning behavior.

### Why extension system couldn't handle this

- Auth persistence, session context reconstruction, prompt/compaction scheduling, and model scope resolution are core
  session services that run before extensions can replace them.

### Expected merge conflict zones

- HIGH: `agent-session.ts` around prompt execution, compaction settlement, and split-turn continuation.
- MEDIUM: `session-manager.ts` around `sessionEntryToContextMessages()` and compaction-entry reconstruction.
- MEDIUM: `model-resolver.ts` around `resolveModelScope()` and diagnostics helpers.
- LOW: `auth-storage.ts` around save failure propagation.

## Resident session payload retention (2026-06-08)

### What changed

- `src/core/session-manager.ts`: large in-memory session strings are retained through a resident store while public
  readers, LLM context construction, branching, forking, and JSONL persistence materialize the original content.
- `src/core/session-resident-store.ts`: centralizes resident string references and store statistics for session payloads.

### Why

- Long sessions can retain repeated large message payloads in every session tree/index view. Keeping large resident
  strings behind lightweight refs lowers steady-state session memory pressure without changing persisted sessions.

### Expected merge conflict zones

- MEDIUM: `SessionManager` append, reload, branch, and persistence paths.
- LOW: tests under `test/session-manager/` that assert exact in-memory entry identity.

## Compaction prompt settlement barrier (2026-05-28)

### What changed

- `src/core/agent-session.ts`: normal user prompts now wait for pending session event processing and in-flight
  compaction work before starting a fresh provider request.
- `src/core/agent-session.ts`: overflow retry and user-visible queued follow-up/steering recovery now await the
  post-compaction continuation instead of scheduling an unobserved delayed `continue()`.
- `src/core/agent-session.ts`: agent-level custom-only queues also use the awaited post-compaction continuation path.
- `src/core/session-work-barrier.ts`: centralizes nested session-work barriers used by compaction settlement.

### Why

- `Agent` can become idle before `AgentSession` finishes `agent_end` compaction work. A prompt submitted in that window
  could race ahead of the compaction boundary or overflow recovery, making queued messages appear out of order or miss the
  compacted context.

### Why extension system couldn't handle this

- Extensions can provide compaction results, but only `AgentSession` can serialize fresh prompts against session event
  processing, compaction mutation, and retry/queue continuation.

### Expected merge conflict zones

- MEDIUM: `AgentSession.prompt()` around the pre-prompt settlement and post-prompt wait.
- MEDIUM: `_executeCompaction()` and `_runAutoCompaction()` around compaction lifecycle and continuation handling.

## Compaction cancellation across abort and model changes (2026-05-23)

### What changed

- `src/core/agent-session.ts`: `abort()` and `dispose()` now cancel in-flight manual/auto compaction and branch
  summarization controllers along with retry/agent cleanup.
- `src/core/agent-session.ts`: `setModel()` and favorite model cycling invalidate compaction state and bump the
  message revision whenever the selected model identity or context window changes.
- `src/core/agent-session.ts`: `model_select` now emits for same provider/model-id selections that change the effective
  context window, so extensions can drop stale model-bound work.

### Why

- An aborted over-context turn could leave a compaction request alive. If the user then switched to a larger-context
  model, stale compaction could finish beside the next normal assistant response and surface duplicate Working/status
  state.

### Why extension system couldn't handle this

- Extensions can observe model and compaction events, but the session owns the abort controllers and the monotonic
  message revision that guards precomputed compaction snapshots.

### Expected merge conflict zones

- MEDIUM: `AgentSession.abort()`, `setModel()`, and `_cycleFavoriteModel()` lifecycle paths.
- LOW: `AgentSession.dispose()` cleanup path and `_emitModelSelect()` early-return logic.

## Tool hook lifecycle status events (2026-05-19)

### What changed

- `src/core/extensions/runner.ts`: `tool_call` and `tool_result` handlers now emit internal start/end lifecycle
  observations with `PreToolUse` / `PostToolUse` labels, bounded status messages, elapsed-time anchors, and completed,
  blocked, or failed end statuses.
- `src/core/agent-session.ts`: the session relays those internal observations to mode listeners as
  `tool_hook_status` events without exposing a new extension author API.

### Why

- The interactive TUI needs to show when extension hook work is happening, including permission-rule matching and
  post-tool result processing, instead of leaving users with only a generic Working indicator.

### Why extension system couldn't handle this

- Extensions can show their own UI, but only the runner knows when each individual hook handler starts, ends, blocks, or
  fails. The session must relay that host-owned lifecycle to the TUI.

### Expected merge conflict zones

- MEDIUM: `extensions/runner.ts` around `emitToolCall()` and `emitToolResult()`.
- LOW: `agent-session.ts` around `_applyExtensionBindings()` and `AgentSessionEvent`.

## User abort prompt settlement barrier (2026-05-17)

### What changed

- `src/core/agent-session.ts`: `abort()` now creates a shared user-abort settlement promise before waiting for the
  active agent run to become idle.
- `src/core/agent-session.ts`: `prompt()` waits for that user-abort promise before classifying submitted input as
  streaming steering/follow-up or a normal fresh prompt.

### Why

- Pressing Esc while a tool call was active started abort asynchronously. A message submitted before the old run settled
  still saw `isStreaming === true`, so it was queued into the aborting run and could remain stuck after abort completed.

### Why extension system couldn't handle this

- The stale queue classification happens inside `AgentSession.prompt()` before extension commands or input handlers can
  reliably distinguish "streaming" from "currently aborting and about to become idle".

### Expected merge conflict zones

- MEDIUM: `AgentSession.prompt()` around the streaming queue branch.
- MEDIUM: `AgentSession.abort()` around agent abort and idle waiting.

## Provider-supplied retry delay handling (2026-05-15)

### What changed

- `src/core/agent-session.ts`: auto-retry now uses provider-supplied retry-after hints from assistant error messages when present, while refusing waits above `retry.provider.maxRetryDelayMs`.

### Why

- Rate-limit and overload responses can include an explicit wait period. Ignoring that hint caused senpi to retry too early with the local exponential base delay, often hitting the same provider throttle again.

### Why extension system couldn't handle this

- Retry scheduling is core `AgentSession` lifecycle behavior. Extensions can observe retry events, but they cannot replace the internal abortable sleep or resolve the prompt-level retry promise.

### Expected merge conflict zones

- MEDIUM: `AgentSession._handleRetryableError()` and retry event emission.

## Avoid duplicate compaction summary message augmentation (2026-05-15)

### What changed

- `messages.ts`: removed the coding-agent-side `CustomAgentMessages.compactionSummary` declaration merge entry.

### Why

- `@earendil-works/pi-agent-core` now declares the shared harness compaction summary message type. Keeping a second
  coding-agent declaration for the same `compactionSummary` slot made `tsgo` reject the package build because the two
  declarations used distinct local interface symbols.

### Why extension system couldn't handle this

- This is TypeScript declaration metadata for core message unions, evaluated at package build time before extensions run.

### Expected merge conflict zones

- LOW: `messages.ts` around the `CustomAgentMessages` declaration merge block.

## Compaction detail propagation (2026-05-15)

### What changed

- `messages.ts`: `CompactionSummaryMessage` can now carry opaque `details` from the accepted compaction result.
- `session-manager.ts`: reconstructed compaction summary messages preserve those details when rebuilding context from
  session entries.

### Why

- The OpenAI remote compact API returns provider-native retained input, counts, and route metadata that should remain
  visible after compaction and across context reconstruction without hard-coding provider behavior into core.

### Why extension system couldn't handle this

- Extensions can create the compaction result, but core owns conversion from persisted `compaction` entries into
  `CompactionSummaryMessage` objects.

### Expected merge conflict zones

- LOW: `messages.ts` around `CompactionSummaryMessage` and `createCompactionSummaryMessage()`.
- LOW: `session-manager.ts` around compaction-entry reconstruction.

## Export tilde paths (2026-05-13)

### What changed

- `src/core/export-html/index.ts` and `src/core/agent-session.ts`: `/export` output paths now expand leading `~` before writing HTML or JSONL exports.

### Why

- A user-facing `/export ~/asdf.jsonl` could create `./~/asdf.jsonl` instead of writing to the home directory.

### Why extension system couldn't handle this

- Export path resolution lives in the core export/session methods before extension command handlers see the final file write.

### Expected merge conflict zones

- LOW: `export-html/index.ts` and `AgentSession.exportToJsonl()` path handling.

## Overflow alias recovery (2026-05-13)

### What changed

- `src/core/agent-session.ts`: context-window overflow errors now trigger overflow compaction with automatic retry when the saved assistant provider differs from the current provider alias but the current context is also at the compaction limit.

### Why

- Imported or resumed sessions can contain OpenAI provider aliases from a previous run. When such a near-limit session overflows, treating the error as threshold compaction leaves the user with an empty error turn and no automatic retry.

### Why extension system couldn't handle this

- Overflow retry policy is core agent-loop recovery behavior; extensions can request compaction but cannot reliably remove the error turn and restart the agent turn.

### Expected merge conflict zones

- MEDIUM: `AgentSession._checkCompaction()` around overflow-vs-threshold recovery.

## Extension duplicate resource conflict policy (2026-05-12)

### What changed

- `src/core/resource-loader.ts`: Extension paths are deduped by nearest `package.json` package name plus relative extension entry before loading, so the same package installed from both a git package checkout and `~/.senpi/agent/extensions/` loads once without dropping multi-extension packages.
- Builtin extensions now precede disk-loaded extensions in the runtime array, and builtin-vs-external tool/flag name collisions no longer surface as startup errors.
- Extension flag defaults and CLI flag validation now follow that final builtin-first order, so an external duplicate flag cannot override builtin metadata by registering earlier during disk discovery.

### Why

- Users with both installed and manually cloned `code-yeongyu/pi-*` extensions saw noisy duplicate tool/flag conflict errors at startup, even when the duplicates represented the same logical extension or a builtin vendored copy.

### Why extension system couldn't handle this

- Extension factories only run after resource discovery and conflict diagnostics. Deduping package paths and classifying builtin/external conflicts has to happen in the core resource loader before the TUI renders startup diagnostics.

### Expected merge conflict zones

- LOW: `resource-loader.ts` around extension path assembly, rebuilt flag defaults, and `detectExtensionConflicts()` if upstream changes resource precedence or conflict diagnostics.
- LOW: `agent-session-services.ts` around extension CLI flag validation if upstream changes extension flag parsing.

## models.json per-model prompt preset metadata (2026-05-12)

### What changed

- `src/core/model-registry.ts`: Custom `models.json` model entries and built-in `modelOverrides` can now carry a `promptPreset` string.
- The registry preserves this value as model metadata for extensions instead of interpreting preset names in core code.

### Why

- Provider-specific model IDs can be too new or too aliased for automatic prompt-preset detection. Putting `promptPreset` next to the model definition keeps the routing metadata with the model catalog entry that needs it.

### Why extension system couldn't handle this

- The prompt-preset extension can consume model metadata, but `models.json` schema validation and model merging live in the core registry. Core needs to preserve the metadata before extensions see the selected model.

### Expected merge conflict zones

- LOW: `ModelDefinitionSchema`, `ModelOverrideSchema`, and `applyModelOverride()` in `src/core/model-registry.ts` if upstream adds more per-model metadata fields.

## Packaged thinking-tier helpers stay local (2026-05-12)

### What changed
- Added `src/core/thinking-levels.ts` so coding-agent owns the senpi-specific `xhigh` / `max` tier detection and supported-level expansion.
- Updated `src/core/agent-session.ts` and `src/core/sdk.ts` to import these helpers locally instead of from `@earendil-works/pi-ai`.

### Why
- The published `@code-yeongyu/senpi` package currently installs the registry `@earendil-works/pi-ai@0.74.0`, whose public exports do not include the fork-only `supportsXhigh` / `supportsMax` helpers.
- Importing those names directly from `pi-ai` makes packaged senpi fail during module loading before any CLI command runs.

### Why extension system couldn't handle this
- Thinking-tier availability is consumed by core session/model logic (`AgentSession`, SDK helpers) during startup and model switching, before extensions can replace those imports.

### Expected merge conflict zones on next upstream sync
- LOW: `agent-session.ts` / `sdk.ts` import blocks and any future upstream move of thinking-level helpers.

## Configured upstream model id and service tier (2026-05-09)

### What changed

- `src/core/model-registry.ts`: Custom `models.json` model entries can now set `upstreamModelId` and per-model `serviceTier`.
- `src/core/sdk.ts`: Provider requests use the configured upstream model id while preserving the configured catalog id for model selection.

### Why

- Users need both a normal catalog entry and a priority catalog entry, such as `gpt-5.5` and `gpt-5.5-fast`, while sending the upstream request as `model: "gpt-5.5"` with `service_tier: "priority"` for only the priority entry.

### Why extension system couldn't handle this

- The model id is embedded by the provider payload builder before `before_provider_request` hooks run, and `service_tier` is a provider-managed field. The registry has to carry the configured wire id and tier into the stream call before payload construction.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `model-registry.ts` schema/request-auth metadata and `sdk.ts` stream option composition.

## Generated default extension fast path (2026-05-08)

### What changed

- `src/core/resource-loader.ts`: Unchanged generated global default extension shims are now recognized by path and exact generated content, then resolved to the known in-process extension factory before the generic jiti loader runs.
- `src/core/resource-loader.ts`: User-edited or replacement files with the same default names still load through the normal extension import path.

### Why

- Clean-profile startup was spending several seconds loading deterministic generated shim files through jiti even though core already knows the matching default extension factories.

### Why extension system couldn't handle this

- Generated default shims are discovered and loaded by core resource bootstrap before extension code can run. Extensions cannot replace the loader's import strategy for their own files.

### Expected merge conflict zones on next upstream sync

- LOW: `resource-loader.ts` around generated global default extension path/content checks and the `loadExtensions()` call.

## Dist-backed default extension shims (2026-05-08)

### What changed

- `src/core/resource-loader.ts`: Default generated global extension shims now point at `dist` files when senpi itself is running from `dist`, even in a linked workspace that also has `src`.

### Why

- Linked CLI startup was re-transpiling default global extension TypeScript files through jiti before the first frame.

### Why extension system couldn't handle this

- Generated default global extension shims are created by core resource loading before extension code runs.

### Expected merge conflict zones on next upstream sync

- LOW: `resource-loader.ts` around `getGlobalDefaultExtensionModulePath()` and default shim generation.

## Model config controls (2026-05-08)

### What changed

- `src/core/model-registry.ts`: `models.json` can disable providers with top-level `disabledProviders` or per-provider `disabled`, filter provider models with `whitelist` / `blacklist`, and replace built-in thinking-level mappings with `thinkingLevelMapMode: "replace"`.
- `src/core/settings-manager.ts` and `src/core/sdk.ts`: added `favoriteModels` settings support and kept `enabledModels` as global model-catalog narrowing.
- `src/core/agent-session.ts`: reload refreshes the model registry, global model narrowing, and favorite models; Ctrl+P cycling only uses the configured favorite models, and available thinking levels honor model-level mapping overrides.

### Why

- The user requested opencode-style provider disable/filtering, favorite-model-only Ctrl+P cycling, and configurable replacement of reasoning variants with reload support.

### Why extension system couldn't handle this

- Model discovery, startup model resolution, persisted settings, and Ctrl+P cycling are core session/model-registry responsibilities. Extensions can add providers or shortcuts, but cannot reliably replace the built-in model registry, default catalog narrowing, or internal cycling semantics before the TUI starts.

### Expected merge conflict zones on next upstream sync

- HIGH: `model-registry.ts` schema/loading and model filtering.
- MEDIUM: `sdk.ts` startup model narrowing resolution and `agent-session.ts` reload/cycle paths.

### Migration notes

- `enabledModels` remains readable as global model narrowing, but Ctrl+P favorites are persisted through `favoriteModels`.

## Favorite model filter hardening (2026-05-11)

### What changed

- `src/core/agent-session.ts`: favorite models now act as a filter over the current available model list and current global narrowing before being exposed or cycled, so stale cached model objects cannot be selected after a provider/model leaves the registry.
- `src/core/model-resolver.ts`: slash-qualified glob patterns now match canonical `provider/model` ids only, preventing patterns like `openai/*` from also matching raw model ids such as `openai/gpt-*` under another provider.

### Why

- Favorite cycling should only choose models that are still present in the current model catalog. This matches opencode's validity filter behavior and avoids switching to stale favorites after provider/model changes.

### Why extension system couldn't handle this

- Favorite model resolution and Ctrl+P cycling are core `AgentSession` behavior, and glob pattern matching is shared by core startup/reload model resolution before extensions can safely override it.

### Expected merge conflict zones on next upstream sync

- `src/core/agent-session.ts` around favorite model getters and `cycleModel()`.
- `src/core/model-resolver.ts` around glob pattern matching in `resolveModelScope()`.

## Favorite model toggle keybinding (2026-05-12)

### What changed

- `src/core/keybindings.ts`: added configurable `app.models.toggleFavorite`, defaulting to `Ctrl+F`, for model selector favorite toggles.

### Why

- Users need the `/model` and `/favorite-models` selectors to select models normally while still being able to toggle favorite status for the highlighted row.

### Why extension system couldn't handle this

- Selector key handling uses the built-in keybinding registry before extension UI code can attach row-local actions, so the built-in selector action needs a first-class keybinding id.

### Expected merge conflict zones on next upstream sync

- LOW: `keybindings.ts` around model selector keybinding definitions.

## Git package dependency repair on update (2026-05-02)

### What changed

- `src/core/package-manager.ts`: `updateGit()` now runs the package dependency install step even when the fetched git target already matches the local checkout.

### Why

- `senpi update` previously returned early for current git packages. If an extension checkout's `node_modules` was damaged or incomplete, the update command reported success but left runtime imports broken.

### Why extension system couldn't handle this

- Git package update and dependency installation are core package-manager responsibilities that run before extension loading.

### Expected merge conflict zones on next upstream sync

- LOW: `DefaultPackageManager.updateGit()` around the post-fetch current-HEAD branch.

## Model Switch System Prompt Change (2026-04-30)

### What changed

- `src/core/agent-session.ts`: Applies `model_select` system prompt results immediately, emits `system_prompt_change` only when the active prompt string changes, and returns the change from `setModel()` / `cycleModel()`.
- `src/core/extensions/types.ts`: Added typed `system_prompt_change` event and model-select prompt-change result.
- `src/core/extensions/runner.ts`: Added `emitModelSelect()` to collect prompt-change results from `model_select` handlers.
- `src/modes/interactive/interactive-mode.ts`: Includes the changed prompt name in model-switch status messages and shows standalone prompt-change status for extension-driven switches.
- `src/core/extensions/builtin/prompt-preset/index.ts`: Resolves prompt presets during `model_select` so mid-session model changes update the active prompt immediately.

### Why

- The prompt-preset builtin only changed the effective prompt at the next `before_agent_start`. The user requested mid-session model changes to switch the system prompt immediately, emit a `pi.on` event, and show the TUI notice only when the prompt actually changes.

### Why extension system couldn't handle this

- The existing extension event runner ignored `model_select` return values and had no core-owned typed event for active system prompt changes. TUI status also needs core session feedback from `setModel()` / `cycleModel()`.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around model switching and event emission.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around model events.
- MEDIUM: `interactive-mode.ts` model status rendering.

### Migration notes

- Keep `system_prompt_change` gated by actual string inequality. Same-preset model switches must not spam the event or TUI.

## Seam 3: Compaction Apply ExtensionContext API (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Added in-memory monotonic message revision counter. Added `getMessageRevision()` and `applyCompaction(precomputed, { reason, expectedRevision })` for compare-and-apply speculative compaction.
- `src/core/agent-session.ts`: Extended `_executeCompaction()` to accept a precomputed `CompactionResult`.
- `src/core/extensions/types.ts`: Added `ApplyCompactionOptions`, `ApplyCompactionResult`, `ExtensionContext.getMessageRevision()`, `ExtensionContext.applyCompaction()`.
- `src/core/extensions/runner.ts`: Wired new context actions through `bindCore()` and `createContext()`.
- `src/modes/interactive/interactive-mode.ts`: Added same methods to inline shortcut `ExtensionContext` literal.

### Why

- Speculative/v2 compaction needs a stable compare-and-apply seam: extensions can prepare a compaction summary against revision N and only apply it if no context-affecting message mutation has happened since.
- `getMessageRevision()` is intentionally monotonic and in-memory only; it is a staleness guard, not persisted session data.
- `applyCompaction()` returns explicit `ok`, `stale`, or `rejected` outcomes so extensions can avoid racing the live session.

### Why extension system couldn't handle this

Extensions can observe hooks and return summaries during a core-driven compaction, but they cannot append a compaction entry, rebuild agent context, emit core compaction events, or atomically guard against stale session context without a typed core API.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around message revision and `applyCompaction()` implementation.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions.
- MEDIUM: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

If upstream adds new `ExtensionContext` methods or changes `AgentSession` message mutation logic, preserve the monotonic revision counter and the `applyCompaction()` compare-and-apply semantics. The revision guard must remain in-memory and advance on every context-affecting mutation. Do not let upstream's `ExtensionContext` additions shadow the new methods.

## Seam 3b: Extension Compaction Feedback Scope (2026-05-15)

### What changed

- `src/core/agent-session.ts`: Added core-owned begin/end helpers for extension-driven compaction feedback and wired them into `ExtensionContext`.
- `src/core/agent-session.ts`: `applyCompaction()` now reuses an already-open compaction abort controller so an extension can show `compaction_start` before it has a precomputed summary without emitting duplicate start events.
- `src/core/extensions/types.ts` and `src/core/extensions/runner.ts`: Added optional `beginCompaction()` and `endCompaction()` context methods.

### Why

- The fork's speculative/blocking compaction extension can spend time generating or awaiting a summary before `applyCompaction()` is called.
- Without a core-owned feedback scope, the TUI has no compaction loader, Esc cancellation signal, or `isCompacting` input queueing during that wait.

### Why extension system couldn't handle this

Extensions can call UI methods, but they cannot set `AgentSession.isCompacting`, own the session abort controller, or emit canonical `compaction_start`/`compaction_end` events without a core context action.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` around `applyCompaction()`, compaction abort controllers, and extension context binding.
- HIGH: `extensions/types.ts` and `extensions/runner.ts` around `ExtensionContext`/`ExtensionContextActions`.

### Migration notes

If upstream adds a native progress or cancellation API for compaction, map the builtin compaction extension to that API while preserving the invariant that visible feedback starts before extension summary generation begins and ends exactly once.

## Seam 4: Unified Compaction Pipeline (2026-04-27)

### What changed

- `src/core/agent-session.ts`: Consolidated manual, threshold, overflow, pre-prompt, and extension-triggered compaction routes into a single private `_executeCompaction()` pipeline.
- The unified pipeline covers: preparation, extension hook execution (`session_before_compact`), summary generation, pre-append token simulation, session append, context rebuild, and completion event emission (`session_compact`).
- Route-specific metadata (reason, custom instructions, thinking/max-token behavior), error handling, retry handling, token estimation before append, and abort handling now flow through one seam.

### Why

- The user identified 9 route inconsistencies caused by duplicated compaction code paths across manual `/compact`, threshold-triggered, overflow-recovery, pre-prompt, and extension-triggered compaction.
- Without unification, each route handled metadata, error recovery, token estimation, and event emission differently, causing observable behavioral differences for extensions consuming compaction events.

### Why extension system couldn't handle this

The duplicated route control flow lives inside `AgentSession`. Extensions can customize compaction content via `session_before_compact` hooks, but they cannot unify internal caller behavior, append semantics, context rebuilds, or core event ordering from outside the session.

### Expected merge conflict zones on next upstream sync

- HIGH: `agent-session.ts` is the highest-churn upstream file. Rebase conflict resolution must preserve the `_executeCompaction()` pipeline and keep branch summarization outside this helper.

### Migration notes

If upstream modifies any compaction route (manual, threshold, overflow, pre-prompt), resolve conflicts by routing the modified logic through `_executeCompaction()` rather than restoring inline duplication. Preserve the 6-route coverage: manual, threshold, overflow-recovery, pre-prompt, extension-triggered, and branch summarization (which routes through the hook but remains a separate caller). Keep the pre-append token simulation step to prevent post-compaction overflow.

## builtin extension labels

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so builtin extensions keep stable synthetic ids like `<builtin:todowrite>` instead of being loaded as numbered inline factories.
- This was changed in core because the startup Extensions list is sourced from extension metadata produced by `DefaultResourceLoader`; the extension API cannot rename builtin factory identities after load.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## move selected defaults to global extensions

- Changed `src/core/extensions/builtin/index.ts` and `src/core/resource-loader.ts` so `diff`, `files`, `prompt-url-widget`, and `tps` are no longer registered as builtin factories.
- `DefaultResourceLoader` now seeds generated shim files for those four defaults into the real global `agentDir/extensions/` directory, so they load through normal global extension discovery instead of builtin registration.
- `DefaultResourceLoader` now rewrites previously generated shim files when their absolute builtin module paths become stale after the checkout/package directory moves or is renamed.
- This had to be done in core because builtin-vs-global extension ownership is determined during resource bootstrap, before any extension code runs.
- Expected merge-conflict zone on upstream sync: builtin extension registration and early resource bootstrap in `src/core/resource-loader.ts`.

## disable builtin extensions from settings

- Changed `src/core/settings-manager.ts` and `src/core/resource-loader.ts` so `settings.json` can disable selected builtin extensions with `disabledBuiltinExtensions`.
- `DefaultResourceLoader` now skips builtin factories whose ids are listed in settings.
- This had to be done in core because builtin extensions are instantiated during early resource bootstrap, before project extensions can intercept or unregister them.
- Expected merge-conflict zone on upstream sync: settings schema/getters in `src/core/settings-manager.ts` and builtin factory loading in `src/core/resource-loader.ts`.

## steering default mode to all

- Changed `src/core/settings-manager.ts` so `getSteeringMode()` now defaults to `"all"` instead of `"one-at-a-time"` when no explicit setting is present.
- Added `test/settings-manager.test.ts` coverage to lock the new default behavior.
- This was changed in core because the default steering mode is injected into `Agent` during session creation via `SettingsManager`, so an extension cannot change the built-in default before the session runtime is constructed.
- Expected merge-conflict zone on upstream sync: `src/core/settings-manager.ts` default getter behavior.

## builtin openai service tier setting

- Changed `src/core/settings-manager.ts`, `src/core/extensions/builtin/index.ts`, and added `src/core/extensions/builtin/service-tier.ts` so `settings.json` can set `openai.serviceTier` and automatically inject `service_tier` into OpenAI Responses payloads.
- Added test coverage in `test/suite/service-tier-extension.test.ts`, `test/suite/service-tier-settings.test.ts`, and updated builtin extension registration coverage in `test/resource-loader.test.ts`.
- This was changed in core because builtin extension registration and settings schema/getter wiring happen before extension code can discover a new builtin id or read typed settings from the existing settings manager.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts` and settings schema/getter additions in `src/core/settings-manager.ts`.

## synced builtin extensions and webfetch

- Changed `src/core/extensions/builtin/index.ts`, `src/core/resource-loader.ts`, and `src/core/settings-manager.ts` so builtin extensions can be allowlisted with `enabledBuiltinExtensions` while preserving `disabledBuiltinExtensions` as an override.
- Added `src/core/extensions/builtin/webfetch/` as a builtin extension synced from `../pi-extensions/pi-webfetch`, and moved `bash-timeout` and `openai-api-parallel-tool-calls` to synced `../pi-extensions` layouts.
- Added `scripts/sync-builtin-extensions.mjs`, wired into the package build, so local builds refresh the vendored builtin snapshots from `SENPI_BUILTIN_EXTENSIONS_SOURCE` or `../pi-extensions` when that source checkout exists. `external-versions.json` records the source package names and versions included in the snapshot.
- This had to be done in core because builtin extension registration and builtin settings filtering happen before any user extension can affect resource discovery.
- Expected merge-conflict zone on upstream sync: builtin extension registration in `src/core/extensions/builtin/index.ts`, builtin factory filtering in `src/core/resource-loader.ts`, and settings schema/getters in `src/core/settings-manager.ts`.

## Anthropic "max" thinking level and provider/model extraBody config

- Widened the `"max"` thinking level through the coding agent surface: CLI `--thinking max`, `/settings` selector, Shift+Tab cycle, `settings.json` `defaultThinkingLevel`, thinking border color mapping.
- Extended `packages/coding-agent/src/core/model-registry.ts` so `models.json` (and `pi.registerProvider()`) accepts `extraBody` at both provider and per-model level. `getApiKeyAndHeaders` now resolves `extraBody`, and `sdk.ts` merges provider/model extraBody with any call-site `extraBody` before invoking `streamSimple`.
- This had to be done in core because `ThinkingLevel` is exported from `@mariozechner/pi-agent-core` and every UI/CLI/settings surface needed to be widened, and because `getApiKeyAndHeaders` + stream option composition live in core `ModelRegistry`/`sdk.ts`.
- Expected merge-conflict zone on upstream sync: `model-registry.ts` schemas + `getApiKeyAndHeaders`, `sdk.ts` stream option composition, `cli/args.ts` validator, `settings-manager.ts` thinking level type, `agent-session.ts` thinking cycle list, interactive TUI thinking selector and border color map.

## RPC prompt-level thinking and fallback level events (2026-07-22)

### What changed

- `agent-session.ts`: accepts a session-only `PromptOptions.thinkingLevel`, rejects queued prompts carrying it before queue mutation, and emits `thinking_level_changed` when retry fallback applies an ephemeral level.

### Why extension system couldn't handle this

- Prompt preflight, session-only level application, fallback model switching, and session event emission are private core lifecycle boundaries.

### Expected merge conflict zones

- HIGH: `agent-session.ts` prompt serialization and fallback model-switch logic.

## Extension event bus follows the loaded generation into runtime (2026-08-11)

`LoadExtensionsResult` now retains the event bus used to construct extension APIs, and
`AgentSession` passes that exact bus into `ExtensionRunner`. RPC subscriptions must bind to this
generation-owned bus rather than an unrelated runtime or resource-loader instance, especially after
extension reloads. Test extension results preserve the same ownership contract.
## Preserve extension event bus after project trust resolution (2026-08-11)

The trusted/untrusted extension result composition now carries forward the shared event bus used by
both pre-trust and remaining extensions. Dropping it caused `ExtensionRunner` to allocate an
unrelated fallback bus, silently disconnecting `pi.rpc.emit` on trust-requiring projects.

## 2026-08-25 - reject upstream Radius session sharing artifacts

### What changed

- `packages/coding-agent/src/core/radius.ts`: intentionally absent from Senpi; upstream Radius sharing is rejected under the fork sharing policy.

### Why

- Senpi retains its gist-based `/share` flow and `pi.dev` viewer instead of adopting the upstream Radius service.

### Why an extension could not handle it

- Sharing implementation ownership is a core product policy decision, not an extension-level adaptation.

### Expected merge conflict zones

- NONE: the upstream-only Radius artifact remains excluded from the fork tree.

## 2026-08-25 - Preserve upstream session event behavior

### What changed

- `packages/coding-agent/src/core/agent-session.ts` retains fork queue and compaction behavior while adopting upstream custom-message ordering.

### Why

- Session event ordering is a provider and persistence runtime contract.

### Why this lives in the fork

- Agent session orchestration executes below extension interception.

### Expected merge conflict zones

- Agent event dispatch and custom-message queue handling.
