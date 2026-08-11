# changes

## Correct extension-command immediate-dispatch comments (2026-08-09)

### What changed

- Updated the comments in the `onSubmit` handler and in `handleFollowUp` inside `src/modes/interactive/interactive-mode.ts` so they describe the post-fix dispatch flow accurately: extension commands short-circuit at the `isExtensionCommand` branch (the Enter path returns there) and dispatch immediately inside `AgentSession.prompt()` — including during compaction and barrier-held continuation runs — because `prompt()` now hoists the extension-command branch above the settled-work gate.
- The `onSubmit` compaction branch comment now states that only non-command text reaches it (queued for post-compaction delivery) and notes that its `isExtensionCommand` re-check is already unreachable today (the earlier `isExtensionCommand` branch returns first) and stays harmless after the fix.
- `handleFollowUp` is bound directly to `app.message.followUp` (Alt+Enter) and does NOT pass through `onSubmit`, so its `isExtensionCommand` check IS reachable and is the live dispatch point on that path; its comments say so explicitly instead of claiming an `onSubmit` short-circuit.
- The streaming branch comment now clarifies that the steer/followUp behavior applies only to ordinary text, prompt template expansion, and queueing — extension commands are already dispatched immediately by `prompt()`.

### Why

- The previous comments claimed "extension commands execute immediately" in the compaction and streaming paths, which was false for the barrier-held and compaction cases until the parallel `AgentSession.prompt()` hoist landed. The corrected comments align the code's narrative with the actual post-fix control flow.

### Why extension system couldn't handle this

- The gate that serialized extension commands lives inside `AgentSession.prompt()` (core), not in the interactive mode. The TUI comments merely needed to stop asserting a behavior the TUI does not control.

### Expected merge conflict zones

- `src/modes/interactive/interactive-mode.ts`: the `onSubmit` dispatch block (compaction branch comment ~line 3591, streaming branch comment ~line 3608) and the `handleFollowUp` comments (~line 4785, ~line 4808).

## model selector search ranking and frozen ordering

- Added `src/modes/interactive/model-search-rank.ts` so model search ranks each query token against the independent fields `id`, `name`, `provider`, and `provider/id` through a tier ladder (exact, whole token, boundary substring, substring, then `fuzzyMatch` as a last resort), with a canonical provider-path check and a favorites-first partition ahead of the relevance costs in the composite sort key.
- Changed `src/modes/interactive/components/model-selector.ts` so `/model` search ranks through `rankModelSearchItems` with favorites-first partitioning in the all-models scope, and so both the base sort and the search partition read a favorite-ids snapshot taken when the selector opens; a `Ctrl+F` toggle updates only the favorite marker and no longer re-sorts rows mid-session.
- Changed `src/modes/interactive/components/favorite-models-selector.ts` so `/favorite-models` row order is frozen at screen open (a `displayIds` snapshot), favoriting or unfavoriting flips only the marker, explicit reorder keys mirror-swap the snapshot so rows still visibly move, and search ranks through the same module without a favorites partition.
- Why: user-reported UX bugs. Unfavoriting a row made the whole list jump under the cursor, and the query `opus` ranked `claude-sonnet-4-5` above `claude-opus-5` because the old concatenated-string `fuzzyFilter` let a greedy subsequence match scattered letters across "anthropic…claude…sonnet" and score better than the literal word in the opus id.
- This was changed in core UI because the selector components and their ranking are internal `InteractiveMode` behavior; no extension hook can replace selector search ranking or row ordering without reimplementing the built-in selectors.
- Expected merge-conflict zone on upstream sync: `src/modes/interactive/components/model-selector.ts` and `favorite-models-selector.ts` (extending the zone already declared by the favorite model cycling entry), plus `src/modes/interactive/model-search.ts` and the new `src/modes/interactive/model-search-rank.ts`.

## Server fallback abort uses one TUI notice (2026-08-05)

### What changed

- `components/assistant-render-descriptors.ts` now owns assistant transcript descriptor construction and no longer
  emits the provider's refusal-shaped `Error:` row when the message carries the `server_fallback_aborted` diagnostic.
  The dedicated interactive warning widget remains the single visible explanation and still reports the server
  transition plus configured-chain behavior.
- `components/assistant-message.ts` delegates descriptor construction to that focused module, keeping both renderer
  files below the repository's 250 pure-LOC ceiling.
- Assistant render signatures now include diagnostics, so a diagnostic added to the active message removes any stale
  error descriptor during incremental rendering.
- `../../../test/assistant-message-incremental-render.test.ts` covers both initial diagnosed rendering and same-message
  diagnostic updates.

### Why

- The provider error and the dedicated fallback widget described the same client-policy abort back to back, making one
  fallback transition look like two separate failures.

### Why extension system couldn't handle this

- Assistant stop-reason descriptors and their incremental render cache are private built-in TUI behavior. An extension
  cannot suppress one diagnostic-specific error row while preserving the session message and dedicated warning event.

### Expected merge conflict zones

- LOW: `components/assistant-message.ts` descriptor integration and `components/assistant-render-descriptors.ts`
  error-tail construction.

## Fallback transitions render as shared notice boxes (2026-08-04)

### What changed

- `retry_fallback_applied`/`succeeded`/`reverted`/`exhausted` and `server_fallback_aborted` now render through `InteractiveMode.showNoticeBox` (shared `buildNoticeBox` from `src/core/extensions/notice/`) as titled notice boxes with per-event tones, replacing the one-line `showWarning`/`showStatus`/`showError` texts. The `FALLBACK_STATUS_KEY` footer indicator is unchanged.
- `showNoticeBox` sanitizes every rendered line with `sanitizeTuiErrorMessage`, preserving the OSC/control-strip invariant previously carried by the `showError` exhausted path; `interactive-mode-fallback-error-sanitization.test.ts` re-pins that property against the box.

### Why

- Fallback transitions join loop-guard detections, ttsr injections, and goal cache-warm entries on one notice widget, so transient one-liners no longer scroll away unnoticed.

### Expected merge conflict zones

- LOW: five `case` bodies in `handleEvent` and one additive method beside `showError` in `interactive-mode.ts`.

## Bun console diagnostics stay behind the interactive terminal guard (2026-08-03)

### What changed

- While the TUI owns the terminal, the interactive stderr guard now routes `console.info`, `console.warn`, and
  `console.error` through its hidden, redacted debug-log sink and restores the exact console methods whenever the
  terminal is released.
- Coverage models Bun's native console behavior, which bypasses a replaced `process.stderr.write`, and pins
  terminal silence, debug-log redaction, and restoration.

### Why

- omo-senpi emits ulw-loop and start-work diagnostics through `console.*`. Node routes those calls through the
  patched stderr writer, but Bun writes them through its native console implementation, so the diagnostics could
  corrupt the interactive footer even though direct `process.stderr.write` coverage was green.

### Why this cannot be expressed externally

- Extensions cannot protect the host TUI from runtime-specific console output before it reaches the terminal.
  The host must own console interception for exactly the interval in which it owns the terminal.

### Expected merge conflict zones

- LOW: `interactive-stderr-guard.ts` and its focused regression test.

## Backfill: exit alias and footer provider priority (2026-08-01)

### What changed

- Interactive slash-command dispatch accepts the fork's exit-command alias.
- Provider counts appear immediately and provider prefixes win the footer layout priority they need.

### Why

- Exit behavior must remain discoverable and the active provider must stay visible under constrained terminal width.

### Why this cannot be expressed externally

- Both behaviors depend on the built-in command registry and interactive footer layout scheduler.

### Expected merge conflict zones

- `interactive-mode.ts`, slash-command registration, and footer/status layout code.

## Global queue chronology for compaction recovery (2026-07-31)

- Queue submissions reserve one monotonic order across native steer/follow-up buckets and TUI-owned compaction input. Native delivery priority remains unchanged.
- `AgentSession.clearQueue()` preserves its enumerable `{ steering, followUp }` shape and exposes global recovery chronology through a non-enumerable `ordered` side channel.
- Retry handoff carries reserved order into native queues; legacy messages without order retain deterministic compatibility ordering. Matching records leave chronology when native delivery starts.
- The existing `clearQueue({ abortWillFollow })` contract remains intact, so terminal restore does not leak abort state.
- Coverage: `test/suite/regressions/compaction-terminal-queue-order.test.ts`, `535-terminal-compaction-abort-flag.test.ts`, and `post-compaction-queued-input-resume.test.ts`.

### Expected merge conflict zones

- MEDIUM: `core/agent-session.ts` queue bookkeeping and `interactive-mode.ts` compaction transfer/restoration.

## Model-switch status uses optimized-prompt wording (2026-07-31)

### What changed

- `cycleModel` and `selectModelFromUi` status lines now read `optimized system prompt applied: <preset>` instead of `system prompt: <preset>`, and stay silent when the switch emits no preset name (unmatched models fall back to the senpi dynamic prompt without announcement). Behavior counterpart: `builtin/prompt-preset` (see its changes.md, 2026-07-31).

### Why

- User request: switch messages should convey that a model-optimized system prompt was applied, and say nothing for models without one.
## Queue restoration does not leak abort state (2026-07-31)

### What changed

- Native queue draining now records cleared messages for `session_abort` only when the caller will immediately abort the session.
- Terminal compaction restoration and manual dequeue-to-editor drains leave later idle aborts silent, while the deliberate clear-then-abort paths retain their existing `session_abort` behavior.
- Coverage: `test/suite/regressions/535-terminal-compaction-abort-flag.test.ts` drives terminal `compaction_end` restoration with native steer and follow-up messages and pins both sides of the abort-event distinction.

### Why

- Terminal compaction failure restoration previously left `_hadClearedQueuedMessages` set indefinitely. A later unrelated idle abort emitted `session_abort`, which extensions can interpret as a control-plane instruction such as blocking an active goal.

### Expected merge conflict zones

- LOW: queue draining in `core/agent-session.ts` and the queue restoration helpers in `interactive-mode.ts`.

## Footer marks fast mode on the model label (2026-07-31)

### What changed

- `components/footer.ts` prefixes the right-hand model label with a lightning bolt whenever
  `session.isFastModeActive()` is true, so a priority-tier session is visible without running
  `/fast` again to check. The glyph is part of the `FooterSegment` plain text, so the width ladder
  in `footer-layout.ts` accounts for it instead of overflowing narrow terminals, and
  `colorRightSide()` paints it `warning` while the model keeps `accent` and `:thinking` keeps `dim`.
- Coverage: `test/footer-fast-mode-icon.test.ts` pins the indicator, its absence when fast mode is
  off, and width safety with a wide CJK model id at width 60.

### Why

- Both fast paths (an `openai` `-fast` catalog variant and the Codex session toggle) were invisible
  in the footer, which is the only always-on surface showing the active model.

## Double-Escape history recovers after refusal fallback exhaustion (2026-07-31)

### What changed

- Terminal classifier-refusal fallback exhaustion now returns `AgentSession.retryAttempt` to zero and emits the failed `auto_retry_end` event consumed by interactive retry cleanup.
- The existing empty-editor double-Escape handler therefore reaches the session tree again after the final `Aborted after N retry attempts` result; no keybinding or timing semantics changed.
- Coverage: `test/suite/regressions/fallback-abort-double-escape-session-history.test.ts`.

### Why

- The interactive Escape handler intentionally prioritizes active retry cancellation over session history. A stale positive retry attempt made that active-retry branch permanent even after the turn had settled.

### Expected merge conflict zones

- NONE in interactive source; the behavioral fix is isolated to `core/agent-session.ts` retry lifecycle cleanup.

## Failed compaction restores queued input (2026-07-30)

### What changed

- Terminal compaction failures, rejections, and aborts restore messages queued during compaction to the editable composer instead of leaving them pending indefinitely. Native session steer and follow-up queues are drained into the composer too.
- Failed pre-prompt overflow compaction now emits `willRetry: false`, so queued input follows the terminal restoration path instead of waiting for a retry that cannot run.
- The defensive retryable-failure branch keeps the native-queue handoff (`flushCompactionQueue({ willRetry: true, deferAdmission: true })`) for any producer that can truthfully promise a retry.
- Coverage: `test/interactive-mode-compaction.test.ts` pins truncated, timed-out, rejected, retryable, and successful compaction outcomes; `test/suite/regressions/post-compaction-queued-input-resume.test.ts` drives the real failed pre-prompt overflow path and real editor-restoration helper.

### Why

- Retrying queued delivery against the unchanged over-threshold context repeats the same required-compaction failure; restoring the draft lets the user edit or retry explicitly.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` in the `compaction_end` queue handoff branch.

## Risky main-model selection warning (2026-07-30)

- Interactive startup, `/model` (including exact references), the full and favorite-model selectors, post-auth default selection, and favorite rotation now pass the selected main model through one shared warning predicate.
- Provider/model identifiers and displayed model names containing `minimax` or `qwen`, case-insensitively, render a prominent `error`-red Korean warning box. Safe model families render no warning.
- The warning is confined to the interactive main-session model surface; task/subagent routing is unchanged.
- Coverage: `test/risky-main-model-warning-tui.test.ts` pins matching fields, case-insensitivity, Korean/CJK output, red styling, selector/rotation paths, and a safe-model negative case.

## high_reasoning_warning TUI box (2026-07-30)

- `interactive-mode.ts` consumes `high_reasoning_warning` and renders a scary red (`error`-themed) warning box via `showHighReasoningWarning`, urging use via the ultrabrain subagent. Mirrors `showNewVersionNotification` styling.
- QA: `local-ignore/qa-evidence/20260730-high-reasoning-warning/` (ans/html/grid triplet; 916 red cells; WARNING+ultrabrain+responsibility confirmed).

## Omo-senpi coding workflow tips (2026-07-30)

### What changed

- `tips/catalog/subagent-tips.ts` now advertises the shipped `init-deep`, debugging, refactor,
  remove-ai-slops, and visual-qa skills alongside the existing plan, ultrawork, research, and review tips.
- Every new entry uses the existing `tasks` command gate so users only see omo-senpi workflow tips when
  the task extension surface is available.
- Coverage: `test/suite/list-tips.test.ts` pins each ID, rendered line, and command gate.

### Why

- The tip rotation covered the headline orchestration workflows but skipped the everyday project
  initialization, diagnosis, cleanup, and visual-verification skills that omo-senpi also installs.

### Expected merge conflict zones

- LOW: additive entries in `tips/catalog/subagent-tips.ts` and one focused catalog assertion.

## Footer hides low cache hit rates (2026-07-29)

### What changed

- `components/footer.ts`: the cache-hit segment is omitted when the latest hit rate is below 10%; rates at 10% and above continue to render.
- Coverage: `test/footer-token-format.test.ts` pins the 9.9% hidden case and the 10% boundary.

### Why

- Very low hit rates add a footer block without providing useful cache-health signal.

### Expected merge conflict zones

- LOW: `components/footer.ts` around optional middle-stat construction.

## Long footer paths yield before cache and cost stats (2026-07-29)

### What changed

- `components/footer-layout.ts`: when the pwd consumes more than one third of the available footer width, the responsive ladder shortens the indexed pwd anchor from the head at each right-label/middle-stat richness rung before dropping another middle segment. Ordinary shorter paths retain the existing provider-prefix and middle-elision order. The explicit pwd index keeps leading badges intact; the `pwd-elided` plan carries the retained middle count, ellipsis-marker state, and full/minimal model-label choice.
- `components/footer.ts`: pwd-elided rendering keeps the middle segments selected by the layout plan, so cache hit rate and total cost remain visible when shortening the leading path is enough to fit them.
- Coverage: `test/footer-width.test.ts` pins a width-110 long-cwd case that retains the `coding-agent` tail, `CH25.0%`, `$1.234`, and the model label without overflowing, plus an OmO Native case proving the badge stays intact while the actual path elides.

### Why

- Long workspace paths consumed footer width before the layout considered shortening them, so the right-most telemetry fields (cost first, then cache hit rate) disappeared even when eliding the non-identifying path head could preserve both.

### Expected merge conflict zones

- LOW: `components/footer-layout.ts` around the width-priority ladder and `pwd-elided` plan shape.
- LOW: `components/footer.ts` around `pwd-elided` materialization.

## Ethos tips: tool-call repair now names Kimi K3 (2026-07-29)

### What changed

- `tips/catalog/ethos-tips.ts`: the `ethos.tool-call-repair` copy now covers Kimi K3 alongside Claude - "claude's sloppy invokes, kimi k3's leaked XTML channels, all of it" - matching the new normal-mode XTML recovery in `packages/ai` (Kimi models get the same leaked tool-call auto-correction Claude has).
- Coverage: `test/suite/ethos-tips.test.ts` pin updated verbatim.

### Why

- The repair tip only described the Claude/antml case. With XTML recovery shipped for Kimi models, the brag undersells the feature.

### Expected merge conflict zones

- LOW: single render string in `ethos-tips.ts` and its verbatim pin.

## Footer omits cumulative input and output counters (2026-07-29)

### What changed

- `components/footer.ts` no longer adds the cumulative `↑<input>` and `↓<output>` token segments to the interactive footer.
- Context-window usage, cache-hit rate, session name, cost, model, working directory, branch, and extension statuses remain unchanged.
- Coverage: `test/footer-token-format.test.ts` asserts that the usage arrows are absent while the neighboring cache-hit and context details still render.

### Why

- The cumulative input/output counters add visual noise to the always-visible footer without helping the active context decision; the context-window segment remains the relevant token signal.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the optional middle-stat segment construction.

## Tip lines point at the give-me-tips skill (2026-07-29)

### What changed

- `tips/startup-tip.ts` and `tips/working-tip.ts`: the resolved `line` now carries a second pointer
  line - `↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.` -
  appended under the byte-identical `Tip: ${body}` first line. Both render sites draw the tip as a
  single `Text` component, so the pointer lands directly below the tip row.
- Coverage: `test/suite/startup-tip.test.ts` and `test/suite/working-tip.test.ts` pin the two-line
  shape and the `give-me-tips` literal.

### Why

- A one-line tip cannot tell the whole story; the pointer teaches users that the give-me-tips skill
  can expand any tip on ask.

### Expected merge conflict zones

- LOW: the `line` template in both resolvers.

## Ethos tips: the fork's voice in the tip rotation (2026-07-29)

### What changed

- `tips/catalog/ethos-tips.ts` (new): a `ETHOS_TIPS` catalog of seven manifesto tips framing how `@code-yeongyu/senpi` is tuned - system-prompt discipline for `gpt-5.6-sol`, tools that stay out of the way, spending tokens to buy time, and pointers to `ulw-plan` on `fable-5 xhigh` and the `ulw loop`.
- `tips/registry.ts`: `TIP_DEFINITIONS` now concatenates `...ETHOS_TIPS` after `SUBAGENT_TIPS`.
- The two command-referencing tips (`ethos.ulw-plan-sage`, `ethos.ulw-loop-shallow`) declare `requiresCommand: "tasks"`, so they only surface when the omo plugin's `tasks` command is registered - matching the `workflow-skills.*` tips in `subagent-tips.ts`. The eight pure manifesto tips (including the monitor/cache bragging tips) are keyless and ungated.
- Three additional tips brag about the harness's monitor tool (subscribe to stdout, never sleep), the prompt-cache budget (never block past cache TTL), and the live cache-hit rate in the footer. All three are keyless and ungated.
- Three more tips brag about multimodal vision (the agent sees screenshots, PDFs, diagrams), Claude Code OAuth multi-account (switch logins, not env vars), and the agent-SDK foundation (no ToS gray zone, no ban anxiety). All three are keyless and ungated.
- One tip brags about the tool-call repair middleware (malformed antml:invoke calls are intercepted, corrected, and salvaged instead of failing the turn). Keyless and ungated.
- Coverage: `test/suite/ethos-tips.test.ts` pins the fourteen ids, the verbatim approved English copy, the `tasks` gating, and the unbound/ungated manifesto set.

### Why

- The tip line taught mechanics and commands but had no voice for the fork's tuning philosophy. These tips surface the system-prompt-tuning claim (a 5-minute job takes 5 minutes, a 12-hour job takes 12), the anti-tool-study stance, and the spend-tokens-for-time trade, which are the fork's reason for existing.
- Gating the ulw command tips on `tasks` preserves the existing honesty invariant: never advertise commands the session cannot run.

### Expected merge conflict zones

- LOW: `tips/registry.ts` import block and the `TIP_DEFINITIONS` concatenation tail.

## Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)

### What changed

- `components/footer.ts`: `render()` prepends an `(OmO Native)` anchor segment (colored `success`) as the leftmost footer element when `footerData.isOmoNative()` returns true, before pwd and branch. The badge participates in the existing width-elision ladder as an anchor (never dropped, only elided with pwd when space is exhausted).
- The badge is fed by `FooterDataProvider.isOmoNative()`, set once at startup by `interactive-mode.ts` from `detectOmoNativeInstall()` (see root `src/changes.md`).
- Coverage: `test/omo-native-footer.test.ts` asserts the segment is the leftmost rendered text when active and absent when inactive.

### Why

- Makes the OMO native install state visible in the bottom-left footer without a separate status line.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the anchor segment construction.

## Large resumed sessions use event-driven Working updates (2026-07-28)

### What changed

- `working-status.ts` adds `largeSessionWorkingStatusInterval()`: sessions below 1,000 persisted entries retain the
  existing 32 ms message shimmer and 600 ms indicator cadence. Larger histories refresh informational Working text
  and hook rows every second while limiting the decorative indicator fallback to once per 60 seconds.
- `interactive-mode.ts` applies the policy to the default Working indicator, message, and tool-hook timers. Tool,
  stream, status, and message events still request immediate renders, so large sessions remain live without
  continuously repainting an unchanged transcript.
- The persisted-entry threshold is sampled when a default indicator is created (and when a hook ticker starts);
  custom `setWorkingIndicator()` options bypass this policy by design.
- `test/interactive-mode-working-status.test.ts` locks both sides of the threshold and both large-session cadences;
  `test/hook-status-ticker.test.ts` locks the one-second large-session hook timer.

### Why

Each animation tick asks the TUI to render the complete component tree. That is cheap for ordinary sessions but can
become continuous CPU work after resuming a multi-thousand-entry transcript. One-second informational updates keep
elapsed labels honest, while event-driven renders and the 60-second decorative fallback avoid continuous repainting
of settled history.

### Expected merge conflict zones

- LOW: `working-status.ts` around animation timing helpers.
- LOW/MED: `interactive-mode.ts` around `getWorkingIndicatorOptions()` and `startToolHookStatusTimer()`.

## Paste markers survive editor hand-off; unset is a same-instance no-op (2026-07-28)

### What changed

- `interactive-mode.ts` `setCustomEditorComponent()`: switching between the default and a custom editor now transfers raw text plus the paste registry snapshot when the source exposes a snapshot AND the target implements the paired paste-state API (`setPasteState` with `getPasteState` — a target that could not re-export collapsed markers on the next hand-off receives expanded text instead), so `[paste #N ...]` markers stay collapsed across the swap. Otherwise it falls back to the expanded text via `getExpandedEditorText()`.
- New `getExpandedEditorText()` helper used by every full-editor-text consumer (`ctx.ui.getEditorText()`, Alt+Enter follow-up, external-editor open, and the hand-off fallback): prefers the editor's `getExpandedText()`, then expansion from `getPasteState()` via pi-tui's exported `expandPasteMarkers()`, then raw text (an editor with neither capability never had expandable markers).
- `setCustomEditorComponent(undefined)` is a draft no-op when the default editor is already active (`resetExtensionUI()` calls it unconditionally during extension resets and session invalidation): no hand-off happens, so no setText round-trip touches the user's draft.
- Previously the raw text alone was copied into the destination editor, whose empty registry turned live markers into dead literals — submit then sent the `[paste #N ...]` placeholder to the model instead of the pasted body.

### Why

- Companion to the pi-tui paste-registry fix (`packages/tui/src/changes.md`, same date). The hand-off is interactive-mode logic: only this layer knows both editor instances and their optional capabilities.

### Expected merge conflict zones

- LOW: `setCustomEditorComponent()` around the transfer helper and the factory/unset branches.
- LOW: `packages/coding-agent/test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` (drives the real method with real tui editors).

## /reload honors the session_before_reload extension veto (2026-07-28)

### What changed

- `interactive-mode.ts` `handleReloadCommand()`: before building the reload box, the handler calls
  `session.checkReloadVeto()`; when an extension cancels (`session_before_reload` returning
  `cancel: true`), the command shows the extension's `reason` as a warning and returns — no reload box,
  no focus steal, no teardown. A cancelled result from `session.reload()` itself (late veto) dismisses
  the box back to the previous editor and shows the same warning.

### Why

- Reload destroys the extension runtime; extensions owning live background work (running subagents in
  omo-senpi) need a way to block it. The streaming/compaction guards already set the warning precedent.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around `handleReloadCommand()`.

## Fix: the startup tip is destroyed by extension headers (2026-07-27)

### What changed

- `tips/startup-header.ts` (new): `appendStartupHeader()` attaches the built-in header and the startup tip to the header container as **separate children**.
- `interactive-mode.ts`: the tip is no longer interpolated into the `ExpandableText` header closures.

### Why

`ui.setHeader()` replaces the built-in header component in place, and the builtin `prompt-preset` extension calls it on every `session_start`. Because the tip was part of the header's own text, that replacement silently discarded it: the tip resolved and was recorded into `tipsHistory`, but never reached the terminal. Keeping the tip as a sibling of the header makes it survive any extension header override.

## Tips cover the whole feature surface, and command tips are gated (2026-07-28)

### What changed

- `tips/catalog/` (new): the tip catalog is split by domain into `model-tips.ts`, `input-tips.ts`, `session-tips.ts`, `workspace-tips.ts`, `settings-tips.ts`, `cli-tips.ts`, and `subagent-tips.ts`, with the shared `TipDefinition` in `catalog/types.ts`. `tips/registry.ts` is now a barrel that concatenates them, so `TIP_DEFINITIONS` and `TipDefinition` keep their import paths.
- The catalog grew from 25 to 70 tips: model fallback chains and `/fallback`, `/login`, `--models` scoping, `thinkingBudgets`, `promptPreset`, `@` file references, Tab path completion, the `?` overlay, steering vs follow-up delivery, `escape` restoring the queue, `/clone`, `-c`/`-r`, `/name`, `/session`, `/export`, `/share`, `/compact`, auto-compaction, AGENTS.md context loading, `/skill:name` and prompt templates, `/files`, `/diff`, `/todo`, `/goal`, `/btw`, `/lookat`, `/mcp`, `/rules`, `/hooks`, `/websearch`, settings locations, `permissionPreset`, `packages`, custom themes, `/reload`, `/trust`, the `tips` toggle, print mode, tool/allow deny flags, subagent categories, `/tasks`, `~/.omo/omo.jsonc`, and teams.
- `TipDefinition.requiresCommand` (new): a tip that teaches an extension-provided command names it, and `selectTip()` skips that tip when the injected `hasCommand` resolver reports the command is not registered. `interactive-mode.ts` injects `hasRegisteredCommand()` (backed by `extensionRunner.getCommand()`) into both the startup and working tip resolvers.

### Why

The tip line was teaching a small slice of the product while most of the surface - retry fallback chains, session branching, permissions, subagent categories, the omo config file - stayed invisible. Gating by registered command keeps that breadth honest: builtin extensions can be disabled and the omo workflow tips only apply when the omo plugin is loaded, so those tips no longer advertise commands the session cannot run.

## Feature discoverability: tips, `?` overlay, live favorite hints, `/keybindings` (2026-07-27)

### What changed

- `tips/registry.ts` (new): a `TIP_DEFINITIONS` catalog teaching existing senpi features and workflow skills (`ulw plan`, `$start-work`, `ulw`/`ulw loop`, `ulw-research`, `hyperplan`, `review work`). Each tip declares its `bindings` and renders through an injected key resolver, so displayed keys always reflect the user's live configuration.
- `tips/scheduler.ts` (new): `selectTip()` picks the least-recently-shown eligible tip, honoring an injected key-availability resolver and a caller-owned exclusion set. `tips/history-writer.ts` (new): pure `recordTipShown()` merge with no module state; persistence is explicit via `settings-manager`.
- `tips/startup-tip.ts` (new): `resolveStartupTipLine()` resolves one banner tip line, gated by the `tips` setting and `quietStartup`. `interactive-mode.ts` renders it in both compact and expanded startup variants and records it once through the shared writer with a per-session shown-set.
- `tips/working-tip.ts` (new): `resolveWorkingTipLine()` resolves the tip under the working status. `interactive-mode.ts` wraps the indicator and tip in one Container so the single-child `statusContainer` contract holds, caches the pick per turn, excludes the banner tip, and resets on turn end.
- `tips/favorite-messages.ts` (new): `buildFavoriteCycleStatusMessage()` renders the favorite-model empty/single states with live `app.model.select` / `app.models.toggleFavorite` keys instead of the previous hardcoded copy.
- `components/shortcut-overlay.ts` (new): `ShortcutOverlay` plus the pure `shouldShowShortcutOverlay()` predicate. `interactive-mode.ts` mounts it only on a typed `?` in an empty editor (paste and non-empty text never trigger) and dismisses it on any further input or submit.
- `keybindings-command.ts` (new): `seedKeybindingsFile()` writes the effective bindings when the config is missing, and `applyKeybindingsFileEdit()` reloads only valid JSON. `interactive-mode.ts` adds a `/keybindings` dispatch that opens the real config via the new `editFileInExternalEditor()` seam in `external-editor.ts` and reloads the live manager without restart.

### Why

- The product already cycles favorites, toggles thinking, and exposes dozens of shortcuts, but none of that was discoverable in-product; users (including the owner) did not know `Ctrl+F` toggles favorites or that a favorite cycle existed.

### Merge-conflict zones

- `interactive-mode.ts` imports block, the startup banner assembly, the `defaultEditor.onChange` / `onSubmit` handlers, `showStatusIndicator`/`clearStatusIndicator`, and the slash-command text dispatch beside `/hotkeys` (five serialized edits).

## Footer cache segment removal and anchor-pinned layout (2026-07-27)

### What changed

- `components/footer-layout.ts` (new): pure width planning for the classic footer. `planFooterLayout()` picks the
  richest layout that fits the terminal: full line, then middle segments elided right-most-first behind a single
  dim "…" marker, then the pwd head-elided ("…/senpi"), then the whole left block head-elided, with the model
  label truncated only as the last resort. `elideHead()` keeps the tail of a path, which carries the most
  identifying information.
- `components/footer.ts`: the `cache <read>/<write>` totals segment was removed (the `CH<x>%` cache-hit-rate
  segment stays); rendering now builds plain/colored `FooterSegment` pairs and delegates fitting to
  `planFooterLayout()`, so the model label and the pwd • branch • context-usage block stay visible at any width
  instead of the right side being truncated away first.

### Why

- The cache read/write totals cost footer space out of proportion to their value, and the old truncation logic
  sacrificed the right-side model label whenever the left overflowed — the two anchors users watch (context
  usage, current model) were the first things to disappear on narrow terminals.

### Expected merge conflict zones

- MEDIUM: `components/footer.ts` `render()` was rewritten around `FooterSegment` pairs; upstream footer layout
  changes will conflict textually. `components/footer-layout.ts` is additive.

## Adaptive smooth-streaming buffer (2026-07-27)

### What changed

- `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, and `streaming-reveal-content.ts`: smooth assistant output
  waits for an 80ms startup buffer, estimates the provider's grapheme arrival rate with an EWMA, and follows that
  learned base rate without a hard ceiling. Individual outlier samples are limited to four times the prior
  estimate, extra catch-up is bounded independently, and signed backlog correction converges toward roughly
  140ms of queued text across provider chunk cadences.
- Fully drained bursts reset fractional progress so a later chunk cannot inherit reveal budget from an earlier
  burst. Streaming tool arguments retain one-code-unit progress and parse in bounded 64-unit batches, preserving
  surrogate pairs while sharing the assistant pacing helper.
- `../../../test/streaming-reveal-{content,pacing}.test.ts`, `../../../test/streaming-reveal.test.ts`, and
  `../../../test/helpers/streaming-reveal.ts`: split grapheme, pacing, and controller coverage into focused modules
  and exercise timed 45/90/180/240/500-unit-per-second arrivals, multiple cadences, sustained fast streams,
  convergence and final-tail bounds, lifecycle flushes, and drained-burst carry reset.

### Why

- The previous fixed 267ms catch-up policy drained each provider burst completely, while the first adaptive
  implementation capped the total reveal rate at 240 graphemes per second. Providers above that rate accumulated
## Footer omits cumulative input and output counters (2026-07-29)

### What changed

- `components/footer.ts` no longer adds the cumulative `↑<input>` and `↓<output>` token segments to the interactive footer.
- Context-window usage, cache-hit rate, session name, cost, model, working directory, branch, and extension statuses remain unchanged.
- Coverage: `test/footer-token-format.test.ts` asserts that the usage arrows are absent while the neighboring cache-hit and context details still render.

### Why

- The cumulative input/output counters add visual noise to the always-visible footer without helping the active context decision; the context-window segment remains the relevant token signal.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the optional middle-stat segment construction.

## Tip lines point at the give-me-tips skill (2026-07-29)

### What changed

- `tips/startup-tip.ts` and `tips/working-tip.ts`: the resolved `line` now carries a second pointer
  line - `↳ Want the full story on any tip? Ask about it — the give-me-tips skill has the tour.` -
  appended under the byte-identical `Tip: ${body}` first line. Both render sites draw the tip as a
  single `Text` component, so the pointer lands directly below the tip row.
- Coverage: `test/suite/startup-tip.test.ts` and `test/suite/working-tip.test.ts` pin the two-line
  shape and the `give-me-tips` literal.

### Why

- A one-line tip cannot tell the whole story; the pointer teaches users that the give-me-tips skill
  can expand any tip on ask.

### Expected merge conflict zones

- LOW: the `line` template in both resolvers.

## Ethos tips: the fork's voice in the tip rotation (2026-07-29)

### What changed

- `tips/catalog/ethos-tips.ts` (new): a `ETHOS_TIPS` catalog of seven manifesto tips framing how `@code-yeongyu/senpi` is tuned - system-prompt discipline for `gpt-5.6-sol`, tools that stay out of the way, spending tokens to buy time, and pointers to `ulw-plan` on `fable-5 xhigh` and the `ulw loop`.
- `tips/registry.ts`: `TIP_DEFINITIONS` now concatenates `...ETHOS_TIPS` after `SUBAGENT_TIPS`.
- The two command-referencing tips (`ethos.ulw-plan-sage`, `ethos.ulw-loop-shallow`) declare `requiresCommand: "tasks"`, so they only surface when the omo plugin's `tasks` command is registered - matching the `workflow-skills.*` tips in `subagent-tips.ts`. The eight pure manifesto tips (including the monitor/cache bragging tips) are keyless and ungated.
- Three additional tips brag about the harness's monitor tool (subscribe to stdout, never sleep), the prompt-cache budget (never block past cache TTL), and the live cache-hit rate in the footer. All three are keyless and ungated.
- Three more tips brag about multimodal vision (the agent sees screenshots, PDFs, diagrams), Claude Code OAuth multi-account (switch logins, not env vars), and the agent-SDK foundation (no ToS gray zone, no ban anxiety). All three are keyless and ungated.
- One tip brags about the tool-call repair middleware (malformed antml:invoke calls are intercepted, corrected, and salvaged instead of failing the turn). Keyless and ungated.
- Coverage: `test/suite/ethos-tips.test.ts` pins the fourteen ids, the verbatim approved English copy, the `tasks` gating, and the unbound/ungated manifesto set.

### Why

- The tip line taught mechanics and commands but had no voice for the fork's tuning philosophy. These tips surface the system-prompt-tuning claim (a 5-minute job takes 5 minutes, a 12-hour job takes 12), the anti-tool-study stance, and the spend-tokens-for-time trade, which are the fork's reason for existing.
- Gating the ulw command tips on `tasks` preserves the existing honesty invariant: never advertise commands the session cannot run.

### Expected merge conflict zones

- LOW: `tips/registry.ts` import block and the `TIP_DEFINITIONS` concatenation tail.

## Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)

### What changed

- `components/footer.ts`: `render()` prepends an `(OmO Native)` anchor segment (colored `success`) as the leftmost footer element when `footerData.isOmoNative()` returns true, before pwd and branch. The badge participates in the existing width-elision ladder as an anchor (never dropped, only elided with pwd when space is exhausted).
- The badge is fed by `FooterDataProvider.isOmoNative()`, set once at startup by `interactive-mode.ts` from `detectOmoNativeInstall()` (see root `src/changes.md`).
- Coverage: `test/omo-native-footer.test.ts` asserts the segment is the leftmost rendered text when active and absent when inactive.

### Why

- Makes the OMO native install state visible in the bottom-left footer without a separate status line.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the anchor segment construction.

## Large resumed sessions use event-driven Working updates (2026-07-28)

### What changed

- `working-status.ts` adds `largeSessionWorkingStatusInterval()`: sessions below 1,000 persisted entries retain the
  existing 32 ms message shimmer and 600 ms indicator cadence. Larger histories refresh informational Working text
  and hook rows every second while limiting the decorative indicator fallback to once per 60 seconds.
- `interactive-mode.ts` applies the policy to the default Working indicator, message, and tool-hook timers. Tool,
  stream, status, and message events still request immediate renders, so large sessions remain live without
  continuously repainting an unchanged transcript.
- The persisted-entry threshold is sampled when a default indicator is created (and when a hook ticker starts);
  custom `setWorkingIndicator()` options bypass this policy by design.
- `test/interactive-mode-working-status.test.ts` locks both sides of the threshold and both large-session cadences;
  `test/hook-status-ticker.test.ts` locks the one-second large-session hook timer.

### Why

Each animation tick asks the TUI to render the complete component tree. That is cheap for ordinary sessions but can
become continuous CPU work after resuming a multi-thousand-entry transcript. One-second informational updates keep
elapsed labels honest, while event-driven renders and the 60-second decorative fallback avoid continuous repainting
of settled history.

### Expected merge conflict zones

- LOW: `working-status.ts` around animation timing helpers.
- LOW/MED: `interactive-mode.ts` around `getWorkingIndicatorOptions()` and `startToolHookStatusTimer()`.

## Paste markers survive editor hand-off; unset is a same-instance no-op (2026-07-28)

### What changed

- `interactive-mode.ts` `setCustomEditorComponent()`: switching between the default and a custom editor now transfers raw text plus the paste registry snapshot when the source exposes a snapshot AND the target implements the paired paste-state API (`setPasteState` with `getPasteState` — a target that could not re-export collapsed markers on the next hand-off receives expanded text instead), so `[paste #N ...]` markers stay collapsed across the swap. Otherwise it falls back to the expanded text via `getExpandedEditorText()`.
- New `getExpandedEditorText()` helper used by every full-editor-text consumer (`ctx.ui.getEditorText()`, Alt+Enter follow-up, external-editor open, and the hand-off fallback): prefers the editor's `getExpandedText()`, then expansion from `getPasteState()` via pi-tui's exported `expandPasteMarkers()`, then raw text (an editor with neither capability never had expandable markers).
- `setCustomEditorComponent(undefined)` is a draft no-op when the default editor is already active (`resetExtensionUI()` calls it unconditionally during extension resets and session invalidation): no hand-off happens, so no setText round-trip touches the user's draft.
- Previously the raw text alone was copied into the destination editor, whose empty registry turned live markers into dead literals — submit then sent the `[paste #N ...]` placeholder to the model instead of the pasted body.

### Why

- Companion to the pi-tui paste-registry fix (`packages/tui/src/changes.md`, same date). The hand-off is interactive-mode logic: only this layer knows both editor instances and their optional capabilities.

### Expected merge conflict zones

- LOW: `setCustomEditorComponent()` around the transfer helper and the factory/unset branches.
- LOW: `packages/coding-agent/test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` (drives the real method with real tui editors).

## /reload honors the session_before_reload extension veto (2026-07-28)

### What changed

- `interactive-mode.ts` `handleReloadCommand()`: before building the reload box, the handler calls
  `session.checkReloadVeto()`; when an extension cancels (`session_before_reload` returning
  `cancel: true`), the command shows the extension's `reason` as a warning and returns — no reload box,
  no focus steal, no teardown. A cancelled result from `session.reload()` itself (late veto) dismisses
  the box back to the previous editor and shows the same warning.

### Why

- Reload destroys the extension runtime; extensions owning live background work (running subagents in
  omo-senpi) need a way to block it. The streaming/compaction guards already set the warning precedent.

## Fix: the startup tip is destroyed by extension headers (2026-07-27)

### What changed

- `tips/startup-header.ts` (new): `appendStartupHeader()` attaches the built-in header and the startup tip to the header container as **separate children**.
- `interactive-mode.ts`: the tip is no longer interpolated into the `ExpandableText` header closures.

### Why

`ui.setHeader()` replaces the built-in header component in place, and the builtin `prompt-preset` extension calls it on every `session_start`. Because the tip was part of the header's own text, that replacement silently discarded it: the tip resolved and was recorded into `tipsHistory`, but never reached the terminal. Keeping the tip as a sibling of the header makes it survive any extension header override.

## Tips cover the whole feature surface, and command tips are gated (2026-07-28)

### What changed

- `tips/catalog/` (new): the tip catalog is split by domain into `model-tips.ts`, `input-tips.ts`, `session-tips.ts`, `workspace-tips.ts`, `settings-tips.ts`, `cli-tips.ts`, and `subagent-tips.ts`, with the shared `TipDefinition` in `catalog/types.ts`. `tips/registry.ts` is now a barrel that concatenates them, so `TIP_DEFINITIONS` and `TipDefinition` keep their import paths.
- The catalog grew from 25 to 70 tips: model fallback chains and `/fallback`, `/login`, `--models` scoping, `thinkingBudgets`, `promptPreset`, `@` file references, Tab path completion, the `?` overlay, steering vs follow-up delivery, `escape` restoring the queue, `/clone`, `-c`/`-r`, `/name`, `/session`, `/export`, `/share`, `/compact`, auto-compaction, AGENTS.md context loading, `/skill:name` and prompt templates, `/files`, `/diff`, `/todo`, `/goal`, `/btw`, `/lookat`, `/mcp`, `/rules`, `/hooks`, `/websearch`, settings locations, `permissionPreset`, `packages`, custom themes, `/reload`, `/trust`, the `tips` toggle, print mode, tool allow/deny flags, subagent categories, `/tasks`, `~/.omo/omo.jsonc`, and teams.
- `TipDefinition.requiresCommand` (new): a tip that teaches an extension-provided command names it, and `selectTip()` skips that tip when the injected `hasCommand` resolver reports the command is not registered. `interactive-mode.ts` injects `hasRegisteredCommand()` (backed by `extensionRunner.getCommand()`) into both the startup and working tip resolvers.

### Why

The tip line was teaching a small slice of the product while most of the surface - retry fallback chains, session branching, permissions, subagent categories, the omo config file - stayed invisible. Gating by registered command keeps that breadth honest: builtin extensions can be disabled and the omo workflow tips only apply when the omo plugin is loaded, so those tips no longer advertise commands the session cannot run.

## Feature discoverability: tips, `?` overlay, live favorite hints, `/keybindings` (2026-07-27)

### What changed

- `tips/registry.ts` (new): a `TIP_DEFINITIONS` catalog teaching existing senpi features and workflow skills (`ulw plan`, `$start-work`, `ulw`/`ulw loop`, `ulw-research`, `hyperplan`, `review work`). Each tip declares its `bindings` and renders through an injected key resolver, so displayed keys always reflect the user's live configuration.
- `tips/scheduler.ts` (new): `selectTip()` picks the least-recently-shown eligible tip, honoring an injected key-availability resolver and a caller-owned exclusion set. `tips/history-writer.ts` (new): pure `recordTipShown()` merge with no module state; persistence is explicit via `settings-manager`.
- `tips/startup-tip.ts` (new): `resolveStartupTipLine()` resolves one banner tip line, gated by the `tips` setting and `quietStartup`. `interactive-mode.ts` renders it in both compact and expanded startup variants and records it once through the shared writer with a per-session shown-set.
- `tips/working-tip.ts` (new): `resolveWorkingTipLine()` resolves the tip under the working status. `interactive-mode.ts` wraps the indicator and tip in one Container so the single-child `statusContainer` contract holds, caches the pick per turn, excludes the banner tip, and resets on turn end.
- `tips/favorite-messages.ts` (new): `buildFavoriteCycleStatusMessage()` renders the favorite-model empty/single states with live `app.model.select` / `app.models.toggleFavorite` keys instead of the previous hardcoded copy.
- `components/shortcut-overlay.ts` (new): `ShortcutOverlay` plus the pure `shouldShowShortcutOverlay()` predicate. `interactive-mode.ts` mounts it only on a typed `?` in an empty editor (paste and non-empty text never trigger) and dismisses it on any further input or submit.
- `keybindings-command.ts` (new): `seedKeybindingsFile()` writes the effective bindings when the config is missing, and `applyKeybindingsFileEdit()` reloads only valid JSON. `interactive-mode.ts` adds a `/keybindings` dispatch that opens the real config via the new `editFileInExternalEditor()` seam in `external-editor.ts` and reloads the live manager without restart.

### Why

- The product already cycles favorites, toggles thinking, and exposes dozens of shortcuts, but none of that was discoverable in-product; users (including the owner) did not know `Ctrl+F` toggles favorites or that a favorite cycle existed.

### Merge-conflict zones

- `interactive-mode.ts` imports block, the startup banner assembly, the `defaultEditor.onChange` / `onSubmit` handlers, `showStatusIndicator`/`clearStatusIndicator`, and the slash-command text dispatch beside `/hotkeys` (five serialized edits).

## Footer cache segment removal and anchor-pinned layout (2026-07-27)

### What changed

- `components/footer-layout.ts` (new): pure width planning for the classic footer. `planFooterLayout()` picks the
  richest layout that fits the terminal: full line, then middle segments elided right-most-first behind a single
  dim "…" marker, then the pwd head-elided ("…/senpi"), then the whole left block head-elided, with the model
  label truncated only as the last resort. `elideHead()` keeps the tail of a path, which carries the most
  identifying information.
- `components/footer.ts`: the `cache <read>/<write>` totals segment was removed (the `CH<x>%` cache-hit-rate
  segment stays); rendering now builds plain/colored `FooterSegment` pairs and delegates fitting to
  `planFooterLayout()`, so the model label and the pwd • branch • context-usage block stay visible at any width
  instead of the right side being truncated away first.

### Why

- The cache read/write totals cost footer space out of proportion to their value, and the old truncation logic
  sacrificed the right-side model label whenever the left overflowed — the two anchors users watch (context
  usage, current model) were the first things to disappear on narrow terminals.

### Expected merge conflict zones

- MEDIUM: `components/footer.ts` `render()` was rewritten around `FooterSegment` pairs; upstream footer layout
  changes will conflict textually. `components/footer-layout.ts` is additive.

## Adaptive smooth-streaming buffer (2026-07-27)

### What changed

- `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, and `streaming-reveal-content.ts`: smooth assistant output
  waits for an 80ms startup buffer, estimates the provider's grapheme arrival rate with an EWMA, and follows that
  learned base rate without a hard ceiling. Individual outlier samples are limited to four times the prior
  estimate, extra catch-up is bounded independently, and signed backlog correction converges toward roughly
  140ms of queued text across provider chunk cadences.
- Fully drained bursts reset fractional progress so a later chunk cannot inherit reveal budget from an earlier
  burst. Streaming tool arguments retain one-code-unit progress and parse in bounded 64-unit batches, preserving
  surrogate pairs while sharing the assistant pacing helper.
- `../../../test/streaming-reveal-{content,pacing}.test.ts`, `../../../test/streaming-reveal.test.ts`, and
  `../../../test/helpers/streaming-reveal.ts`: split grapheme, pacing, and controller coverage into focused modules
  and exercise timed 45/90/180/240/500-unit-per-second arrivals, multiple cadences, sustained fast streams,
  convergence and final-tail bounds, lifecycle flushes, and drained-burst carry reset.

### Why

- The previous fixed 267ms catch-up policy drained each provider burst completely, while the first adaptive
  implementation capped the total reveal rate at 240 graphemes per second. Providers above that rate accumulated
  an unbounded tail that snapped onscreen at `message_end`; separating the learned base rate from bounded
  correction keeps immediate completion flushes small without delaying lifecycle events.

### Expected merge conflict zones

## Footer prepends (OmO Native) badge when the OMO native stack is active (2026-07-28)

### What changed

- `components/footer.ts`: `render()` prepends an `(OmO Native)` anchor segment (colored `success`) as the leftmost footer element when `footerData.isOmoNative()` returns true, before pwd and branch. The badge participates in the existing width-elision ladder as an anchor (never dropped, only elided with pwd when space is exhausted).
- The badge is fed by `FooterDataProvider.isOmoNative()`, set once at startup by `interactive-mode.ts` from `detectOmoNativeInstall()` (see root `src/changes.md`).
- Coverage: `test/omo-native-footer.test.ts` asserts the segment is the leftmost rendered text when active and absent when inactive.

### Why

- Makes the OMO native install state visible in the bottom-left footer without a separate status line.

### Expected merge conflict zones

- LOW: `components/footer.ts` around the anchor segment construction.

## Large resumed sessions use event-driven Working updates (2026-07-28)

### What changed

- `working-status.ts` adds `largeSessionWorkingStatusInterval()`: sessions below 1,000 persisted entries retain the
  existing 32 ms message shimmer and 600 ms indicator cadence. Larger histories refresh informational Working text
  and hook rows every second while limiting the decorative indicator fallback to once per 60 seconds.
- `interactive-mode.ts` applies the policy to the default Working indicator, message, and tool-hook timers. Tool,
  stream, status, and message events still request immediate renders, so large sessions remain live without
  continuously repainting an unchanged transcript.
- The persisted-entry threshold is sampled when a default indicator is created (and when a hook ticker starts);
  custom `setWorkingIndicator()` options bypass this policy by design.
- `test/interactive-mode-working-status.test.ts` locks both sides of the threshold and both large-session cadences;
  `test/hook-status-ticker.test.ts` locks the one-second large-session hook timer.

### Why

Each animation tick asks the TUI to render the complete component tree. That is cheap for ordinary sessions but can
become continuous CPU work after resuming a multi-thousand-entry transcript. One-second informational updates keep
elapsed labels honest, while event-driven renders and the 60-second decorative fallback avoid continuous repainting
of settled history.

### Expected merge conflict zones

- LOW: `working-status.ts` around animation timing helpers.
- LOW/MED: `interactive-mode.ts` around `getWorkingIndicatorOptions()` and `startToolHookStatusTimer()`.

## Paste markers survive editor hand-off; unset is a same-instance no-op (2026-07-28)

### What changed

- `interactive-mode.ts` `setCustomEditorComponent()`: switching between the default and a custom editor now transfers raw text plus the paste registry snapshot when the source exposes a snapshot AND the target implements the paired paste-state API (`setPasteState` with `getPasteState` — a target that could not re-export collapsed markers on the next hand-off receives expanded text instead), so `[paste #N ...]` markers stay collapsed across the swap. Otherwise it falls back to the expanded text via `getExpandedEditorText()`.
- New `getExpandedEditorText()` helper used by every full-editor-text consumer (`ctx.ui.getEditorText()`, Alt+Enter follow-up, external-editor open, and the hand-off fallback): prefers the editor's `getExpandedText()`, then expansion from `getPasteState()` via pi-tui's exported `expandPasteMarkers()`, then raw text (an editor with neither capability never had expandable markers).
- `setCustomEditorComponent(undefined)` is a draft no-op when the default editor is already active (`resetExtensionUI()` calls it unconditionally during extension resets and session invalidation): no hand-off happens, so no setText round-trip touches the user's draft.
- Previously the raw text alone was copied into the destination editor, whose empty registry turned live markers into dead literals — submit then sent the `[paste #N ...]` placeholder to the model instead of the pasted body.

### Why

- Companion to the pi-tui paste-registry fix (`packages/tui/src/changes.md`, same date). The hand-off is interactive-mode logic: only this layer knows both editor instances and their optional capabilities.

### Expected merge conflict zones

- LOW: `setCustomEditorComponent()` around the transfer helper and the factory/unset branches.
- LOW: `packages/coding-agent/test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` (drives the real method with real tui editors).

## /reload honors the session_before_reload extension veto (2026-07-28)

### What changed

- `interactive-mode.ts` `handleReloadCommand()`: before building the reload box, the handler calls
  `session.checkReloadVeto()`; when an extension cancels (`session_before_reload` returning
  `cancel: true`), the command shows the extension's `reason` as a warning and returns — no reload box,
  no focus steal, no teardown. A cancelled result from `session.reload()` itself (late veto) dismisses
  the box back to the previous editor and shows the same warning.

### Why

- Reload destroys the extension runtime; extensions owning live background work (running subagents in
  omo-senpi) need a way to block it. The streaming/compaction guards already set the warning precedent.

## Fix: the startup tip is destroyed by extension headers (2026-07-27)

### What changed

- `tips/startup-header.ts` (new): `appendStartupHeader()` attaches the built-in header and the startup tip to the header container as **separate children**.
- `interactive-mode.ts`: the tip is no longer interpolated into the `ExpandableText` header closures.

### Why

`ui.setHeader()` replaces the built-in header component in place, and the builtin `prompt-preset` extension calls it on every `session_start`. Because the tip was part of the header's own text, that replacement silently discarded it: the tip resolved and was recorded into `tipsHistory`, but never reached the terminal. Keeping the tip as a sibling of the header makes it survive any extension header override.

## Tips cover the whole feature surface, and command tips are gated (2026-07-28)

### What changed

- `tips/catalog/` (new): the tip catalog is split by domain into `model-tips.ts`, `input-tips.ts`, `session-tips.ts`, `workspace-tips.ts`, `settings-tips.ts`, `cli-tips.ts`, and `subagent-tips.ts`, with the shared `TipDefinition` in `catalog/types.ts`. `tips/registry.ts` is now a barrel that concatenates them, so `TIP_DEFINITIONS` and `TipDefinition` keep their import paths.
- The catalog grew from 25 to 70 tips: model fallback chains and `/fallback`, `/login`, `--models` scoping, `thinkingBudgets`, `promptPreset`, `@` file references, Tab path completion, the `?` overlay, steering vs follow-up delivery, `escape` restoring the queue, `/clone`, `-c`/`-r`, `/name`, `/session`, `/export`, `/share`, `/compact`, auto-compaction, AGENTS.md context loading, `/skill:name` and prompt templates, `/files`, `/diff`, `/todo`, `/goal`, `/btw`, `/lookat`, `/mcp`, `/rules`, `/hooks`, `/websearch`, settings locations, `permissionPreset`, `packages`, custom themes, `/reload`, `/trust`, the `tips` toggle, print mode, tool allow/deny flags, subagent categories, `/tasks`, `~/.omo/omo.jsonc`, and teams.
- `TipDefinition.requiresCommand` (new): a tip that teaches an extension-provided command names it, and `selectTip()` skips that tip when the injected `hasCommand` resolver reports the command is not registered. `interactive-mode.ts` injects `hasRegisteredCommand()` (backed by `extensionRunner.getCommand()`) into both the startup and working tip resolvers.

### Why

The tip line was teaching a small slice of the product while most of the surface - retry fallback chains, session branching, permissions, subagent categories, the omo config file - stayed invisible. Gating by registered command keeps that breadth honest: builtin extensions can be disabled and the omo workflow tips only apply when the omo plugin is loaded, so those tips no longer advertise commands the session cannot run.

## Feature discoverability: tips, `?` overlay, live favorite hints, `/keybindings` (2026-07-27)

### What changed

- `tips/registry.ts` (new): a `TIP_DEFINITIONS` catalog teaching existing senpi features and workflow skills (`ulw plan`, `$start-work`, `ulw`/`ulw loop`, `ulw-research`, `hyperplan`, `review work`). Each tip declares its `bindings` and renders through an injected key resolver, so displayed keys always reflect the user's live configuration.
- `tips/scheduler.ts` (new): `selectTip()` picks the least-recently-shown eligible tip, honoring an injected key-availability resolver and a caller-owned exclusion set. `tips/history-writer.ts` (new): pure `recordTipShown()` merge with no module state; persistence is explicit via `settings-manager`.
- `tips/startup-tip.ts` (new): `resolveStartupTipLine()` resolves one banner tip line, gated by the `tips` setting and `quietStartup`. `interactive-mode.ts` renders it in both compact and expanded startup variants and records it once through the shared writer with a per-session shown-set.
- `tips/working-tip.ts` (new): `resolveWorkingTipLine()` resolves the tip under the working status. `interactive-mode.ts` wraps the indicator and tip in one Container so the single-child `statusContainer` contract holds, caches the pick per turn, excludes the banner tip, and resets on turn end.
- `tips/favorite-messages.ts` (new): `buildFavoriteCycleStatusMessage()` renders the favorite-model empty/single states with live `app.model.select` / `app.models.toggleFavorite` keys instead of the previous hardcoded copy.
- `components/shortcut-overlay.ts` (new): `ShortcutOverlay` plus the pure `shouldShowShortcutOverlay()` predicate. `interactive-mode.ts` mounts it only on a typed `?` in an empty editor (paste and non-empty text never trigger) and dismisses it on any further input or submit.
- `keybindings-command.ts` (new): `seedKeybindingsFile()` writes the effective bindings when the config is missing, and `applyKeybindingsFileEdit()` reloads only valid JSON. `interactive-mode.ts` adds a `/keybindings` dispatch that opens the real config via the new `editFileInExternalEditor()` seam in `external-editor.ts` and reloads the live manager without restart.

### Why

- The product already cycles favorites, toggles thinking, and exposes dozens of shortcuts, but none of that was discoverable in-product; users (including the owner) did not know `Ctrl+F` toggles favorites or that a favorite cycle existed.

### Merge-conflict zones

- `interactive-mode.ts` imports block, the startup banner assembly, the `defaultEditor.onChange` / `onSubmit` handlers, `showStatusIndicator`/`clearStatusIndicator`, and the slash-command text dispatch beside `/hotkeys` (five serialized edits).

## Footer cache segment removal and anchor-pinned layout (2026-07-27)

### What changed

- `components/footer-layout.ts` (new): pure width planning for the classic footer. `planFooterLayout()` picks the
  richest layout that fits the terminal: full line, then middle segments elided right-most-first behind a single
  dim "…" marker, then the pwd head-elided ("…/senpi"), then the whole left block head-elided, with the model
  label truncated only as the last resort. `elideHead()` keeps the tail of a path, which carries the most
  identifying information.
- `components/footer.ts`: the `cache <read>/<write>` totals segment was removed (the `CH<x>%` cache-hit-rate
  segment stays); rendering now builds plain/colored `FooterSegment` pairs and delegates fitting to
  `planFooterLayout()`, so the model label and the pwd • branch • context-usage block stay visible at any width
  instead of the right side being truncated away first.

### Why

- The cache read/write totals cost footer space out of proportion to their value, and the old truncation logic
  sacrificed the right-side model label whenever the left overflowed — the two anchors users watch (context
  usage, current model) were the first things to disappear on narrow terminals.

### Expected merge conflict zones

- MEDIUM: `components/footer.ts` `render()` was rewritten around `FooterSegment` pairs; upstream footer layout
  changes will conflict textually. `components/footer-layout.ts` is additive.

## Adaptive smooth-streaming buffer (2026-07-27)

### What changed

- `streaming-reveal.ts`, `streaming-reveal-pacing.ts`, and `streaming-reveal-content.ts`: smooth assistant output
  waits for an 80ms startup buffer, estimates the provider's grapheme arrival rate with an EWMA, and follows that
  learned base rate without a hard ceiling. Individual outlier samples are limited to four times the prior
  estimate, extra catch-up is bounded independently, and signed backlog correction converges toward roughly
  140ms of queued text across provider chunk cadences.
- Fully drained bursts reset fractional progress so a later chunk cannot inherit reveal budget from an earlier
  burst. Streaming tool arguments retain one-code-unit progress and parse in bounded 64-unit batches, preserving
  surrogate pairs while sharing the assistant pacing helper.
- `../../../test/streaming-reveal-{content,pacing}.test.ts`, `../../../test/streaming-reveal.test.ts`, and
  `../../../test/helpers/streaming-reveal.ts`: split grapheme, pacing, and controller coverage into focused modules
  and exercise timed 45/90/180/240/500-unit-per-second arrivals, multiple cadences, sustained fast streams,
  convergence and final-tail bounds, lifecycle flushes, and drained-burst carry reset.

### Why

- The previous fixed 267ms catch-up policy drained each provider burst completely, while the first adaptive
  implementation capped the total reveal rate at 240 graphemes per second. Providers above that rate accumulated
  an unbounded tail that snapped onscreen at `message_end`; separating the learned base rate from bounded
  correction keeps immediate completion flushes small without delaying lifecycle events.

### Expected merge conflict zones

- LOW: the fork-only streaming reveal modules, focused tests, and the shared pacing call in `tool-args-reveal.ts`.

## Runtime-error headline rendering (2026-07-27)

### What changed

- `extension-error-format.ts` (new): `formatExtensionErrorHeadline()` renders runtime-emitted errors
  (`extensionPath === RUNTIME_EXTENSION_PATH`) as `Runtime error (<event>): <message>`; real extensions keep the
  `Extension "<path>" error: <message>` framing.
- `extension-error-format.ts` also owns `sanitizeTuiErrorMessage()`, moved out of `interactive-mode.ts`, and the
  formatter applies it to the message, event name, and extension path. Provider error bodies are JSON-decoded
  before rendering, so `\u001b` escapes that were previously inert become live OSC/CSI sequences on an
  ANSI-preserving row; sanitizing inside the formatter means every consumer is protected by default.
- `interactive-mode.ts`: `showExtensionError()` consumes the full error object and uses the shared formatter, and
  imports the sanitizer from the format module instead of defining its own copy.

### Why

- Background session-title failures rendered as `Extension "<runtime>" error: {raw provider json}` — misattributed
  to an extension and unreadable.

### Expected merge conflict zones

- LOW: `showExtensionError()` in `interactive-mode.ts`; the formatter module is additive.

## combined tmux setup warning with allow-passthrough guidance (2026-07-17)

### What changed

- `checkTmuxKeyboardSetup` became `checkTmuxSetup` and reports every missing recommended tmux setting in one
  startup warning instead of one setting per restart. The message renders a copy-pasteable `~/.tmux.conf`
  block with aligned reason comments.
- New `tmux-setup.ts` owns the pure `buildTmuxSetupWarning` builder (unit-tested in
  `test/tmux-setup.test.ts`): `set -g extended-keys on` (unless `on`/`always`),
  `set -g extended-keys-format csi-u` (only when `xterm`), and `set -g allow-passthrough all` for inline
  Kitty images. The passthrough recommendation only appears when images are not already flowing
  (`getCapabilities().tmuxPassthrough !== true`) and the outer terminal can render Kitty graphics
  (`outerKittyGraphicsMode` from pi-tui, fed by `#{client_termname}`); users who chose
  `allow-passthrough on` are not nagged to switch to `all`.

### Why

- The tmux Kitty passthrough support in pi-tui needs `allow-passthrough`; the startup guidance is where users
  discover tmux configuration, and the previous one-at-a-time flow forced repeated tmux restarts.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `checkTmuxSetup` and its `run()` call site; `tmux-setup.ts` is additive.

## grok chrome seam for interactive mode (2026-07-26)

### What changed

- `interactive-mode.ts`: new optional `chrome` seam. `chrome: "grok"` constructs the `GrokChrome` strategy (`grok/chrome.ts`), which owns the base editor (wrapped in the rounded `GrokInputCard`), the compact `GrokFooter` (model and cwd only), the `GrokWelcomeCard` startup content, the braille working indicator (`⠹`, accent-tinted), the editor theme and border colour, overlay decoration, and root arrangement. Extensions continue to own their editor factory; the default no-chrome path is unchanged.
- `grok/tool-row.ts`: single-line tool presentation with a stable guide column (`┃` guide, `◆` marker), selected when the chrome's `toolPresentation` is `"grok"`.
- `grok/palette.ts` + `grok/chrome-tokens.ts`: capture-measured hex constants and glyphs, with chrome tokens delegating to the active theme so `grok-day` and custom themes stay coherent.

### Why

- The experimental `--grok-neo` mode reuses the ordinary interactive loop; the seam injects presentation without forking interactive-mode logic.

### Expected merge conflict zones

- LOW: the `chrome` constructor option and the `this.chrome ?` branches in `interactive-mode.ts`; the `grok/` directory is additive.

## Inspector VM-import rejection recovery (2026-07-24)

### What changed

- With `SENPI_RECOVER_INSPECTOR_VM_IMPORT=1` set at process start, interactive mode keeps running when an active Node
  Inspector evaluation creates the exact `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` unhandled rejection from an
  `<anonymous>` timer callback. Recovery remains disabled by default and is documented in
  `../../../docs/environment-variables.md`.
- The TUI shows guidance to use `require()` or a target-side loader.
- `cli-main.ts` installs the recovery seam before the asynchronous bootstrap, so a rejection fired while paused at an
  `--inspect-brk` breakpoint (before `registerSignalHandlers()` runs) is also recovered; the TUI warning is deferred
  until the handler registration consumes the pending recovery count.
- Crash-policy inspection is non-throwing: hostile rejection values with throwing `has` traps or `code`/`stack`
  getters are classified as non-recoverable instead of terminating the process inside the uncaughtException handler.
- Application-owned `evalmachine.<anonymous>` failures and every unrelated uncaught exception retain the existing
  terminal restoration and exit-1 behavior.

### Why

- Node's Inspector evaluator does not provide a dynamic-import callback. A delayed `import()` from `node inspect exec`
  previously surfaced as a process-wide uncaught exception and terminated an otherwise healthy debugging session.

### Why extension system couldn't handle this

- The rejection reaches the process-wide fatal handler before extension-level tool or event hooks can intercept it.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around `uncaughtCrash()` and `registerSignalHandlers()`.

## bounded compaction progress row (2026-07-24)

### What changed

- `components/status-indicator.ts`: the combined compaction spinner, status, and streamed preview is truncated to the
  actual terminal width. The status label (including its cancellation hint) is allocated first and the preview only
  receives the leftover columns; when a preview appears, the reason-specific label collapses to the shortest form that
  still shows the hint. The preview keeps the newest trailing columns of the accumulated summary, and the indicator is
  a single row both before and after the first progress event.
- `../../../test/interactive-mode-compaction.test.ts`: pins a hostile multiline, 600-column progress update to one
  rendered row no wider than the requested terminal width, with the cancellation hint retained and the newest streamed
  text (not the frozen opening words) visible.

### Why

- Long streamed summaries could wrap the otherwise single-row lifecycle indicator, push the composer upward, and make
  previous output appear erased as the terminal viewport remapped. A fixed half-width preview reservation could also
  starve the `esc to cancel` hint out of the row, head-first truncation froze the preview on the opening words of the
  summary, and the empty-preview state rendered a second spacer row that shifted the composer when progress arrived.

### Expected merge conflict zones

- LOW: `components/status-indicator.ts` compaction progress rendering.

## accepted-only compaction queue transfer (2026-07-24)

### What changed

- `interactive-mode.ts`: input queued while compaction owns the editor is automatically transferred only after an
  accepted compaction result. Rejected, failed, or aborted compaction retains the input in the editor-owned queue
  instead of resubmitting it through the unchanged required-compaction gate and recursively starting compaction.
- Consecutive `compaction_start` events share one Escape override. The original editor handler is preserved through
  supersession and restored exactly once on terminal cleanup, session rebind, invalidation, or TUI stop.
- Compaction progress, errors, and summaries are stripped of terminal control sequences only when rendered. Persisted
  summaries and provider/session content remain unchanged.
- The shared compaction-summary component applies the same display-only sanitization, covering rebuilt chat and
  reopened-session expansion in addition to live `compaction_end` rendering.
- Provider-derived fallback exhaustion errors are sanitized at the shared `showError()` render boundary; raw retry
  events and persisted/provider error content remain unchanged.

### Why

- Rejection and cancellation do not create a new admissible context. Automatically replaying the same prompt caused an
  unbounded compaction-start/rejection/restore loop.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` `compaction_end` handling around `flushCompactionQueue()`.

## per-section thinking duration headers (2026-07-22)

### What changed

- `components/assistant-message.ts`: consecutive thinking sections with `startedAt` timing now show an italic
  `Thought: <duration>` header above visible reasoning, or replace the collapsed `Thinking...` label when reasoning is
  hidden. Active timed sections keep the configured thinking label; untimed and all-empty legacy sections retain their
  prior rendering.
- `../../../test/assistant-message.test.ts`: covers finished, active, legacy, empty/redacted, custom-label, and
  all-empty thinking-duration rendering states.
- `../../../test/streaming-reveal.test.ts`: verifies partially revealed thinking blocks retain their timing metadata.

### Why

- Per-section elapsed time makes completed reasoning runs legible without exposing hidden reasoning or introducing a
  live timer into the transcript.

### Why extension system couldn't handle this

- Thinking-section coalescing, hidden-label selection, streaming display slices, and transcript descriptor
  reconciliation are private core renderer behavior; an extension cannot insert a stable header into that sequence or
  preserve its metadata through the host-owned reveal path.

### Expected merge conflict zones

- LOW: `components/assistant-message.ts` around consecutive-thinking descriptor construction.
- LOW: `changes.md` fork-entry prepend.

## unified tool progress durations (2026-07-22)

### What changed

- `tool-progress.ts`: elapsed and maximum wait durations now share `formatWorkingElapsedSeconds()`, so progress rows use
  one seconds/minutes/hours grammar (`4m 28s / max 5m 00s`) instead of mixing humanized elapsed time with raw maximum
  seconds (`4m 28s / max 300s`).

### Why

- A single progress row should not force users to mentally convert the timeout while the elapsed side is already
  human-readable.

### Why extension system couldn't handle this

- The progress suffix is composed by the built-in interactive tool renderer after extension result rendering.

### Expected merge conflict zones

- LOW: `tool-progress.ts` around the maximum-wait suffix.
## braille tool progress spinner (2026-07-22)

### What changed

- `tool-progress.ts`: partial tool progress rows now use the same ten-frame braille spinner sequence as other Senpi
  waiting surfaces instead of cycling directional triangles (`⏵`, `⏷`, `⏴`, `⏶`).

### Why

- Long-running task, team-wait, and terminal progress rows should read as active work rather than a rotating disclosure
  marker. The existing 80ms component ticker already advances frames; the formatter now presents that animation with
  standard terminal spinner glyphs.

### Why extension system couldn't handle this

- Generic partial-progress rows are composed by the built-in `ToolExecutionRenderer` after extension result renderers
  run, so an individual tool extension cannot replace the host-owned progress prefix consistently.

### Expected merge conflict zones

- LOW: `tool-progress.ts` around `formatToolProgressLine()`.

## todo completion strike reveal (2026-07-21)

### What changed

- `components/todo-strike.ts` (new): pure, zero-import module exporting the strike
  reveal constants (`TODO_STRIKE_HOLD_FRAMES = 2`, `TODO_STRIKE_REVEAL_FRAMES = 12`,
  `TODO_STRIKE_TOTAL_FRAMES = 14`, `TODO_STRIKE_FRAME_INTERVAL_MS = 65`),
  `strikeRevealCount(text, frame)` (frame-to-visible-char-count math over code
  points), `partialStrikethrough(text, visibleChars, strike)` (code-point-safe
  splitter; strike styling comes ONLY from the injected `strike` callback — no
  raw ANSI literals), and `hasCompletedTodoTasks(details)`. Purity keeps the
  todotools extension free of interactive-runtime dependencies on non-interactive
  load paths and keeps the interactive core free of built-in-extension imports.
- `components/tool-execution.ts`: `updateResult()` also calls
  `updateTodoStrikeAnimation()`, which starts an `unref`'d, self-terminating
  `setInterval` (65ms, stops after `TODO_STRIKE_TOTAL_FRAMES`) when the result is
  a final non-error `todo` result with non-empty `completedTasks` AND
  `this.executionStarted` is set. Each tick advances `spinnerFrame`, busts the
  render cache, repaints, and requests a render; the settle tick restores the
  static full-strike rendering. `stopTodoStrikeAnimation()` clears the interval
  and resets `spinnerFrame` only when no spinner is running.
  `stopSpinnerAnimation()` leaves `spinnerFrame` to the strike owner while a
  strike is in flight. `stopAnimation()` also stops the strike. New
  `override dispose()` calls `stopAnimation()` before `super.dispose()` so pi-tui
  `Container.clear()`/`Container.dispose()` child propagation kills a mid-flight
  interval on chat teardown (also closes the pre-existing spinner teardown hole).
- `interactive-mode.ts`: new private `stopChatToolAnimations()` iterates
  `this.chatContainer.children` and calls `stopAnimation()` on every
  `ToolExecutionComponent`; `stop()` calls it immediately after
  `clearPendingTools()`. A completed mid-strike todo block has already left
  `pendingTools` (deleted at `tool_execution_end`) and `ui.stop()` does not
  dispose the component tree, so without this the interval would repaint a
  stopped UI until self-termination.

### Why

- A completion checkmark should land visibly. Without an animation, a finished
  task row silently switches from accent to dim+strikethrough and the user can
  miss which item just completed. A bounded ~910ms left-to-right reveal (2 hold
  frames + 12 sweep frames at 65ms/frame) makes the just-completed task
  unmistakable, then settles to byte-identical pre-change rendering.

### Why extension system couldn't handle this

- The strike interval is component-scoped and drives `ToolExecutionComponent`'s
  render-cache invalidation, `spinnerFrame` render signature, and lifecycle hooks
  (`updateResult`, `stopAnimation`, `dispose`); extensions cannot own built-in
  component private state or hook `Container.clear()`/`dispose()` propagation,
  and the per-frame repaint must route through the host's `requestRender` to
  respect the TUI FPS cap.
- The `executionStarted` rebuild-replay suppressor is core-private state set
  only on the live path (`renderSessionItems` rebuilds never call
  `markExecutionStarted()`); an extension cannot gate historical replay this way.

### Expected merge conflict zones

- MEDIUM: `components/tool-execution.ts` around `updateResult`, `stopAnimation`,
  `dispose`, and the `spinnerFrame`-reset guard in `stopSpinnerAnimation`.
- LOW: `interactive-mode.ts` around `stop()` and the new `stopChatToolAnimations`
  helper.
- LOW: the fork-only `components/todo-strike.ts` module.

## model fallback lifecycle notices (2026-07-20)

### What changed

- `interactive-mode.ts`: renders fallback apply, success, revert, and exhaustion notices; maintains a keyed `fallback`
  footer status while a fallback model is active; and suppresses the retry spinner for immediate fallback retries.
- Startup now shows fallback-chain validation warnings that were calculated by `AgentSession` when the session was created.

### Why

- A fallback model change is user-visible state. The chat and footer now make the active model and its lifecycle clear
  without adding synthetic messages to model context.

### Why extension system couldn't handle this

- Retry lifecycle events and session-start validation state are owned by the core session and rendered through the
  built-in interactive event handler.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` retry event switch and startup warning block.

## exhaustive compaction_end rendering (2026-07-20)

### What changed

- `interactive-mode.ts`: the `compaction_end` handler no longer silently falls
  through when a rejection carries no `errorMessage` (e.g. legacy shape). It
  prefers the extension-provided `errorMessage` inside the `aborted` branch so
  per-turn-cap / circuit-breaker / provider-error cancels render the real cause
  instead of the generic "Compaction cancelled", and adds a fallback
  `showError("Compaction failed (no result); cause: <rejectionCause>")` so no
  future `compaction_end` shape can be ignored.

### Why

- Manual `/compact` used to render nothing when core rejected the summary as
  overflow-would-still-happen. The handler only branched on `aborted / result /
  errorMessage` and `_rejectCompaction` used to emit none of those fields for
  `would-overflow`. Combined with core now populating `errorMessage`, the
  interactive fallback closes plan §1.

## abbreviated footer token notation (2026-07-20)

### What changed

- `components/footer.ts`: `formatTokens` now renders oh-my-pi-style K/M/B abbreviations (e.g. `546K`, `1M`, `1.5M`)
  instead of comma-grouped `toLocaleString` output. The footer context-usage display now reads
  `546K/1M (54.6%)` instead of `545,661/1,000,000 (54.6%)`; the same notation applies to the ↑/↓/cache counters and
  the `interactive-mode.ts` token readouts that reuse `formatTokens`.

### Why

- Comma-grouped raw counts are wide and hard to scan in the status line; abbreviated notation matches oh-my-pi's
  status-line style and keeps the footer compact at narrow widths.

### Why extension system couldn't handle this

- Footer token formatting is a core display primitive, not an extension-registered status segment.
## paced streaming tool argument previews (2026-07-20)

### What changed

- `tool-args-reveal.ts`: adds per-tool-call pacing for streaming partial JSON. The first usable prefix appears
  immediately, later append-only growth follows the smooth-streaming cadence, parsing is batched in at least 64
  UTF-16-unit increments, and reveal boundaries never split surrogate pairs.
- `interactive-mode.ts`: routes in-flight tool arguments through the controller, flushes exact arguments at message and
  execution boundaries, cancels stale state on direct-update paths, publishes buffered arguments before teardown, and
  refreshes timers after live smooth streaming setting changes.

### Why

- Large tool arguments can arrive in provider bursts. Parsing and rendering every burst makes previews jump abruptly
  and repeatedly reparses nearly identical JSON prefixes.

### Why extension system couldn't handle this

- Extensions cannot own the built-in pending-tool component map or coordinate its private argument updates with
  assistant-message, tool-execution, settings, and teardown lifecycles.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` around streamed tool-call handling and lifecycle flushes.
- LOW: the fork-only argument reveal controller.

## smooth streaming reveal (2026-07-20)

### What changed

- `streaming-reveal.ts`: adds append-aware grapheme counting/slicing and a real-time reveal controller with 90
  units/second minimum velocity, a 267ms catchup horizon, 1–100ms delta clamping, and configurable 30–120fps ticks.
- `interactive-mode.ts`: routes assistant start/update events through one controller, flushes final content directly,
  stops pacing on abort/session teardown, resyncs live thinking visibility, and applies the TUI FPS cap.
- `components/settings-selector.ts`: adds “Smooth streaming” and “Streaming fps” controls.

### Why

- Bursty provider deltas should appear as a readable, steady reveal without splitting Korean, emoji ZWJ, combining, or
  other grapheme clusters.

### Why extension system couldn't handle this

- Extensions cannot replace the built-in in-flight assistant component or coordinate its render timer with session
  teardown and TUI scheduling.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` assistant event handling and settings callbacks.
- LOW: the fork-only controller and new selector items.

## incremental assistant message re-render (2026-07-19)

### What changed

- `components/assistant-message.ts`: replaces full child teardown on every assistant streaming delta with a flat
  descriptor reconciliation. Stable children are reused, same-kind Markdown changes update in place, and the first
  kind/text/list divergence rebuilds only the remaining suffix.
- `../../../test/assistant-message-incremental-render.test.ts`: compares incremental output byte-for-byte with fresh
  components across the supported block shapes and verifies leading and growing Markdown identities remain stable.

### Why

- Clearing the content container made every streamed token recreate preceding Markdown components, keeping their
  instance caches cold and repeatedly re-lexing already-finished blocks.

### Why extension system couldn't handle this

- Assistant transcript child reconciliation is private host-renderer state; an extension cannot retain or replace the
  built-in component's nested children.

### Expected merge conflict zones

- MEDIUM: `components/assistant-message.ts` around descriptor construction, child reconciliation, and render-cache
  invalidation.

## eval tool call single-box render (2026-07-17)

### What changed

- `components/tool-execution-renderer.ts`: `getRenderContext()` now sets `hasResult: this.state.result !== undefined`
  so a self-framing call renderer can yield once a result exists (see `../../core/extensions/changes.md` 2026-07-17).

### Why

- The codemode `eval` tool draws a full `╭─ … ╰─` frame in BOTH `renderCall` and `renderResult`. Because
  `update()` renders call-then-result into one container, a finished eval showed two stacked boxes (a stale
  pending/running frame above the live done frame). With `hasResult`, the call renderer yields and the result
  renderer owns a single frame that updates in place pending -> running -> done.

### Why extension system couldn't handle this

- Result presence for a tool row is private host renderer state; only the interactive renderer can populate the
  public `ToolRenderContext.hasResult` field the extension renderer reads.

### Expected merge conflict zones

- LOW: `components/tool-execution-renderer.ts` around `getRenderContext()`.

## Transactional post-compaction queue transfer (2026-07-13)

### What changed

- `compaction-queue-transfer.ts`: transfers one captured interactive batch entry by entry, commits exact accepted identities, searches past hook-handled entries until prompt work has an owner, and restores only the still-owned undelivered suffix ahead of later input.
- `interactive-mode.ts`: post-compaction rollback no longer clears unrelated native session queues. Transferred-but-unaccepted entries remain visible to Alt-Up/Esc, cancellation restores them without a later prompt start, and detached continuation-launch failures surface in the TUI while native work remains retryable. Overlapping flush requests run in call order, stop when exact ownership is cleared, and are invalidated when a session rebind advances the transfer generation.
- Mixed steer/follow-up batches adopt the native queue contract after the first prompt owns work: steering runs before follow-ups, with FIFO preserved within each mode rather than across modes.

### Why extension system couldn't handle this

- `compactionQueuedMessages` and the first-prompt handoff are private TUI state. Extensions can add native continuations, but cannot transactionally own or restore the host's interactive queue.

### Expected merge conflict zones

- HIGH: `interactive-mode.ts` around `flushCompactionQueue()` and pending-message display updates.
- LOW: `compaction-queue-transfer.ts` (fork-only helper).

## eval/tool image renderer lifecycle (2026-07-10)

### What changed

- `components/tool-execution.ts`: keeps tool lifecycle state, spinner updates, and bounded render caching while
  delegating renderer composition and image handling to focused collaborators.
- `components/tool-execution-renderer.ts`: resolves built-in/custom renderer slots, preserves reusable renderer
  components and shared state, and passes the active terminal image protocol through the renderer context (see
  `../../core/extensions/changes.md` 2026-07-10).
- `components/tool-execution-images.ts`: owns host image/fallback composition and Kitty conversion. Converted images
  are keyed by source identity, and generation checks prevent late conversion callbacks from replacing newer results.

### Why

- Eval/tool results can reuse renderer components across partial and final updates. Without the host fallback and
  conversion invalidation, non-PNG Kitty results could remain blank or cached instead of being replaced by the
  converted PNG.

### Why extension system couldn't handle this

- Extensions can inspect `imageProtocol` and return a result component, but they do not own the host's image conversion,
  post-renderer child composition, or display-cache invalidation across reused `ToolExecutionComponent` results.

### Expected merge conflict zones

- MEDIUM: `components/tool-execution.ts`, `tool-execution-renderer.ts`, and `tool-execution-images.ts` around lifecycle
  snapshots, renderer context/reuse, render signatures, and Kitty image conversion.

## preserve steer intent when draining queued input (2026-07-10)

### What changed

- `interactive-mode.ts`: the classic TUI main loop dispatches drained user input with explicit `steer` behavior so an
  automatic continuation that starts between input capture and dispatch queues the message instead of rejecting it as
  an unspecified concurrent prompt.

### Why

- Input can be accepted while the session is idle and remain pending until the main loop resumes. If processing becomes
  active during that interval, dropping the interactive queue intent surfaces a false `Agent is already processing`
  error even though the user submitted through the TUI's steer path.

### Why extension system couldn't handle this

- The race occurs in `InteractiveMode.run()` after the built-in editor/input queue hands control back to the main loop;
  extensions cannot replace that host-owned dispatch boundary.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around the main `getUserInput()` / `session.prompt()` loop.

## live hook identity in tool hook status rows (2026-07-04)

### What changed

- `interactive-mode.ts`: the `Running PreToolUse/PostToolUse hook` row renders live status text published through the
  new tool-hook `update` phase (`ctx.updateToolHookStatus()`, see `core/extensions/changes.md` 2026-07-04) instead of
  a static per-extension guess like `running builtin:hooks`.

### Why

- Users could not tell which hook was running or what it was doing; command-hook `statusMessage` configs were parsed
  but never rendered live.

### Why extension system couldn't handle this

- The hook status row is InteractiveMode's built-in UI; extensions publish status, the mode renders it.

### Expected merge conflict zones

- LOW/MED: `interactive-mode.ts` hook status row rendering and ticker lifecycle.

## external stdout/stderr guards while the TUI is active (2026-07-04)

### What changed

- `interactive-mode.ts`: wires the `ProcessTerminal` external stdout guard (hidden writes go redacted to the debug
  log via `core/hidden-stdout-log.ts`) and the stderr guard (`interactive-stderr-guard.ts`, fork-only) so no stray
  library/extension output reaches the screen while the TUI owns the terminal.

### Why

- External writes interleaved with frames and permanently desynchronized differential rendering (TUI-side guard in
  `packages/tui/src/changes.md` 2026-07-04; startup-dialog wiring in `cli/changes.md` 2026-07-04).

### Why extension system couldn't handle this

- Terminal stream ownership during interactive mode is the mode's own lifecycle concern.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` TUI start/stop wiring; `interactive-stderr-guard.ts` (fork-only).

## hook-status ticker unref (2026-07-03)

### What changed

- `interactive-mode.ts`: the hook-status ticker interval is unref'd after creation.
- `packages/coding-agent/test/hook-status-ticker.test.ts`: verifies the timer exposes and calls `unref()`.

### Why

- The hook-status ticker should not keep the interactive process alive after other work completes.

### Why extension system couldn't handle this

- The timer is internal to `InteractiveMode`'s built-in hook status lifecycle.

### Expected merge conflict zones

- LOW/MED: `interactive-mode.ts` around `startToolHookStatusTimer`, `stopToolHookStatusTimer`, and hook status
  lifecycle methods.

## custom entry renderer display order sync (2026-07-02)

### What changed

- `interactive-mode.ts`: accepted upstream rendering for extension custom entry renderers and kept fork-specific
  hook/system-prompt UI behavior.
- `components/custom-entry.ts`: added the display component for custom session entries rendered by extension entry
  renderers.

### Why

- Display-only custom entries appended during assistant streaming must render in persisted session order and before the
  live assistant message, matching replayed sessions.

### Why extension system couldn't handle this

- Extensions provide renderer implementations, but the built-in interactive mode owns session-entry ordering and the
  default component host where persisted custom entries are displayed.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` around session entry rendering, live assistant message ordering, and extension renderer
  dispatch.
- LOW: `components/custom-entry.ts` if upstream changes custom-entry component shape.

## abort queue restoration during retry (2026-06-18)

### What changed

- `interactive-mode.ts`: Escape during streaming or retry now aborts the active operation, clears queued steering/follow-up
  rows, and restores the queued text to the editor instead of auto-submitting it as a fresh prompt.

### Why

- Auto-submitting restored queue text could race the abort barrier and surface `Agent is already processing` after the user
  had already aborted. It also made an aborted retry appear to keep working on queued input.

### Why extension system couldn't handle this

- The default Escape handler and pending-message display are owned by `InteractiveMode`; extensions can request aborts but
  cannot change the built-in queue restoration path.

### Expected merge conflict zones

- HIGH: `interactive-mode.ts` around `abortAndFireQueuedMessages()` and the default Escape handler.

## normal Working animation and packaged TUI runtime (2026-05-20)

### What changed

- `interactive-mode.ts`: the default normal TUI Working indicator uses two visible frames, `•` and `◦`, plus the
  animated `Working (Xs • esc to interrupt)` message formatter.
- `packages/coding-agent/package.json`: the public `@code-yeongyu/senpi` package bundles the private forked
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` workspaces.
- `scripts/release.mjs`: release no longer rewrites those dependencies to upstream npm `0.x` packages before publish.

### Why

- The normal TUI looked static after `@code-yeongyu/senpi` installed an upstream `@earendil-works/pi-tui` package whose
  `Loader` ignored `messageFormatter`, so the installed CLI rendered only `• Working`.
- The source tree already had richer Working text animation; the npm tarball must carry the forked TUI runtime that
  implements it.

### Why extension system couldn't handle this

- `InteractiveMode` owns the built-in Working row and the default `LoaderIndicatorOptions`.
- Extensions can override the row, but they cannot repair the packaged runtime dependency used by global npm installs.

### Expected merge conflict zones

- HIGH: `interactive-mode.ts` around `getWorkingIndicatorOptions()`; preserve two default frames plus message formatter.
- HIGH: release/package files around bundled workspace dependencies; do not pin `@earendil-works/pi-*` to upstream npm
  versions for `@code-yeongyu/senpi` publishing.
- MEDIUM: `packages/tui/src/components/loader.ts`; preserve `messageFormatter` and independent message animation.

## live tool hook status rows (2026-05-19)

### What changed

- `interactive-mode.ts`: active `tool_hook_status` events render in a dedicated status lane below the normal Working
  loader, with Codex-like `Running PreToolUse hook: ...` and `Running PostToolUse hook: ...` wording.
- `working-status.ts`: hook rows reuse the existing Working shimmer treatment and append live elapsed time without
  adding an interrupt hint.

### Why

- Extension hooks can perform visible work before and after tool execution. Showing the specific hook and elapsed time
  makes the TUI more informative than a generic Working row.

### Why extension system couldn't handle this

- The built-in interactive renderer owns the live status layout and shimmer styling. Extensions can inject widgets, but
  they cannot reliably render host-managed lifecycle rows beside the existing Working indicator.

### Expected merge conflict zones

- MEDIUM: `interactive-mode.ts` around status containers, Working loader helpers, and `handleEvent()`.
- LOW: `working-status.ts` around the shared shimmer formatting helpers.

## OpenAI remote compaction details (2026-05-15)

### What changed

- `interactive-mode.ts`: synthetic post-compaction summary messages now preserve `CompactionResult.details`.
- `components/compaction-summary-message.ts`: the compact summary card shows when OpenAI remote compaction was used,
  including requested input count, retained item count, original token pressure, and whether the route was Responses
  WebSocket compaction or the compact endpoint.

### Why

- Users need to tell whether a turn used the extension fallback summary route or OpenAI's provider-native compact API.

### Why extension system couldn't handle this

- The visible summary card is built by the interactive renderer, and the synthetic message is created by the built-in
  `compaction_end` event handler.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around the `compaction_end` handler.
- LOW: `components/compaction-summary-message.ts` around collapsed and expanded summary rendering.

## compaction feedback labels (2026-05-15)

### What changed

- `interactive-mode.ts`: `compaction_start` now renders clearer loader text for extension and pre-prompt compaction instead of labeling every non-manual route as auto-compaction.

### Why

- The fork's builtin compaction extension can run a blocking summary before the next turn. Once that route emits canonical compaction events, the TUI should say it is compacting context rather than implying an automatic threshold compaction.

### Why extension system couldn't handle this

- The loader label is produced by the built-in `InteractiveMode` handler for core session events.

### Expected merge conflict zones

- LOW: `interactive-mode.ts` around the `compaction_start` event handler.

## compact provider-native web search rendering (2026-05-14)

### What changed

- `components/assistant-message.ts`: provider-native web-search blocks render through the shared formatter in `../provider-native-rendering.ts` instead of dumping raw provider JSON.
- Recognized Anthropic, OpenAI, and Google native web-search metadata now show compact query/status/source summaries while unknown provider-native blocks keep the generic JSON fallback.

### Why

- The raw provider-native JSON exposed implementation fields such as `encrypted_content` and made native web search blocks visually inconsistent with normal tool widgets.

### Why extension system couldn't handle this

- Provider-native assistant content is rendered by the built-in assistant message component before extension tool renderers are involved.

### Expected merge conflict zones

- LOW: the provider-native branch in `components/assistant-message.ts` and shared formatting behavior in `../provider-native-rendering.ts`.

## Slash command path tilde expansion (2026-05-13)

### What changed

- `interactive-mode.ts`: `/export ~/...` and `/import ~/...` expand leading `~` to the user's home directory before invoking session import/export.

### Why

- Built-in slash commands previously treated `~` as a literal path segment, which could create or read files under `./~/...`.

### Why extension system couldn't handle this

- Slash-command path parsing is internal to `InteractiveMode`; extensions cannot normalize the built-in command argument after parsing.

### Expected merge conflict zones

- LOW: `getPathCommandArgument()` in `interactive-mode.ts`.

## bash execution command syntax highlighting

- Changed `src/modes/interactive/components/bash-execution.ts` so the command header for interactive/user shell execution highlights bash syntax with the existing TUI syntax palette instead of coloring the whole command as a single bash-mode string.
- This was changed in core UI because the live bash execution component owns the command header render path; extensions cannot intercept that component without replacing the built-in interactive renderer.
- Expected merge-conflict zone on upstream sync: the `BashExecutionComponent` command header setup and `updateDisplay()` rebuild path.

## non-blocking startup tool discovery

- Changed `src/modes/interactive/interactive-mode.ts` so interactive startup only probes an already-installed `fd` path for autocomplete instead of awaiting `fd`/`rg` downloads before showing the UI.
- Added `src/modes/interactive/startup-tools.ts` to keep the startup-only tool resolution behavior small and directly testable.
- This was changed in core UI because the blocking call happens inside `InteractiveMode.init()` before extension startup hooks can run, so a builtin extension cannot prevent the first-launch wait.
- Expected merge-conflict zone on upstream sync: tool setup in `InteractiveMode.init()` near the startup changelog/header initialization.

## favorite model cycling

- Changed `src/modes/interactive/interactive-mode.ts` so Ctrl+P reports missing favorite models instead of cycling through every available model, and `/favorite-models` saves selections to the new `favoriteModels` settings field.
- Changed `src/modes/interactive/components/model-selector.ts` and `favorite-models-selector.ts` so favorite rows can also select the active model, while `Ctrl+F` toggles the selected row's favorite state from either `/model` or `/favorite-models`; `/model` toggles persist immediately because that selector has no separate save command.
- This was changed in core UI because the built-in status text and favorite-model selector wiring are internal `InteractiveMode` behavior; extensions cannot replace the default Ctrl+P command semantics without racing the built-in binding.
- Expected merge-conflict zone on upstream sync: model cycling status, `/model` favorite toggle wiring, and `/favorite-models` selector wiring in `src/modes/interactive/interactive-mode.ts` plus the two model selector components.

## builtin extension display paths

- Changed `src/modes/interactive/interactive-mode.ts` so synthetic builtin extension ids render as `builtin/<name>` in the startup Extensions section.
- Changed `src/modes/interactive/interactive-mode.ts` so builtin extensions render in their own `builtin` group and `todowrite` is labeled as `todo` in the startup Extensions section.
- This was changed in core UI because the display formatting lives in `InteractiveMode.formatDisplayPath()`; the extension system cannot intercept that built-in startup formatter.
- Expected merge-conflict zone on upstream sync: `showLoadedResources()` helpers in `src/modes/interactive/interactive-mode.ts`.

## disable startup update checks

- Changed `src/modes/interactive/interactive-mode.ts` so startup no longer checks upstream npm registry version/package updates before entering the interactive loop.
- This was changed in core UI because those startup checks are internal `InteractiveMode` methods and there is no extension hook that can reliably suppress them before they run.
- Expected merge-conflict zone on upstream sync: startup helpers around `checkForNewVersion()` and `checkForPackageUpdates()` in `src/modes/interactive/interactive-mode.ts`.

## clipboard paste error surfacing

- Changed `src/modes/interactive/interactive-mode.ts` so `handleClipboardPaste()` failures show a `Clipboard paste failed: <reason>` status instead of being silently swallowed; an empty clipboard still stays quiet.
- This was changed in core UI because clipboard paste is internal `InteractiveMode` editor wiring (`onPasteImage`); extensions cannot observe that catch path.
- Expected merge-conflict zone on upstream sync: `handleClipboardPaste()` in `src/modes/interactive/interactive-mode.ts`.

## compaction queue delivery after unsuccessful compaction

- Changed `src/modes/interactive/interactive-mode.ts` and `compaction-queue-transfer.ts` so every terminal `compaction_end` flushes the TUI compaction queue: accepted compactions keep prompt-admission delivery, while failed/rejected/aborted ones route queued input through the native steer/followUp queues (`deferAdmission`) with a visible held-count status and a `compaction_queue_deferred` session-log event. Previously the queue was flushed only on success, so messages typed during a failing compaction were silently parked forever and lost on session switch (field report 2026-07-30).
- This was changed in core UI because the compaction queue and `compaction_end` handling are internal `InteractiveMode` state; extensions cannot observe or drain that queue.
- Expected merge-conflict zone on upstream sync: the `compaction_end` handler and `flushCompactionQueue()` in `src/modes/interactive/interactive-mode.ts`, plus `compaction-queue-transfer.ts` transfer options.
