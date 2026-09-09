
## 2026-09-08 - Shortcut context exposes the effective service tier

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the extension shortcut context built by `setupExtensionShortcuts` sets the new optional `effectiveServiceTier` field from `session.effectiveServiceTier`, next to `serviceTier`.

### Why

- `ExtensionContext.effectiveServiceTier` (code-yeongyu/oh-my-openagent#6795) is what delegating hosts read to inherit a parent's fast mode; the hand-built shortcut context must report the same value the runner's contexts do.

### Why an extension could not handle it

- The shortcut context literal is host code; extensions only receive it.

### Expected merge conflict zones

- LOW: the `createContext` literal in `setupExtensionShortcuts`.

## 2026-09-07 - Add a workflow tip for the report-bug skill

### What changed

- `packages/coding-agent/src/modes/interactive/tips/catalog/subagent-tips.ts`: added a workflow tip that points users to the report-bug skill and explains that it records provider and model details, routes the issue, and waits for confirmation before filing.
- The tip is gated with requiresCommand: "tasks" like every other workflow tip, so it only surfaces where the omo-senpi task command exists.

### Why

- Users need a concise discovery path when they encounter a bug.

### Why this lives in the fork

- This tip describes a workflow skill shipped by the fork.

### Expected merge conflict zones

- LOW: appended array element in `subagent-tips.ts` and the `expectedTips` list.

## 2026-09-07 - /settings auto-compaction toggle persists explicitly (#1422)

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: `onAutoCompactChange` calls `settingsManager.setCompactionEnabled` itself and then applies the session override through `session.setAutoCompactionEnabled`.

### Why

- `AgentSession.setAutoCompactionEnabled` no longer persists (it is the RPC session command's implementation), and the settings dialog is the one surface that should.

### Why this lives in the fork

- The settings dialog wiring is interactive-mode code.

### Expected merge conflict zones

- LOW: the `onAutoCompactChange` callback.

## 2026-09-05 - Restore Working text shimmer on turn start

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` now supplies the generated working indicator options when a turn starts.

### Why

- The turn-start path previously passed the unset raw options field, disabling the literal `Working` text shimmer formatter.

### Why this lives in the fork

- Interactive mode owns the working status indicator and its animation configuration.

### Why an extension could not handle it

- `InteractiveMode.showWorkingStatusIndicator` is engine-owned interactive TUI behavior below the extension API.

### Expected merge conflict zones

- LOW: `InteractiveMode.showWorkingStatusIndicator` working-indicator construction.

## 2026-09-05 - Render Astra configuration updates as non-interactive session entries

### What changed

- packages/coding-agent/src/modes/interactive/interactive-mode.ts: handle the configuration-update role without rendering it as a user-visible text message.

### Why

- The wire item affects provider configuration but is not user prose.

### Why this lives in the fork

- Interactive mode owns the terminal projection of session entries.

### Expected merge conflict zones

- Interactive session rendering and message-role handling.

## 2026-09-05 - Restore Working text shimmer formatter

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` no longer constructs a duplicate working status indicator, preserving the literal `Working` text shimmer and formatter wiring.

### Why

- The duplicate construction overwrote the beta.36 conditional chrome-vs-default indicator and its shimmer formatter.

### Why an extension could not handle it

- `InteractiveMode.setWorkingVisible` is engine-owned interactive TUI behavior below the extension API.

### Expected merge conflict zones

- LOW: `InteractiveMode.setWorkingVisible` working-indicator construction.

## 2026-09-05 - Ctrl+P skips favorites without context room

### What changed

- Favorite-model cycling emits a typed `model_change_skipped` event with the
  target budget projection and continues in the requested direction.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` renders a
  warning for each skipped model and a clear compact-or-new-session status when
  every other favorite is rejected. The event is also forwarded through existing
  session event transports, so desktop consumers do not need a desktop-specific
  change.

### Why

- Ctrl+P is an explicit request to switch models. A target that cannot admit
  the current context must be skipped rather than surfacing the later
  `ModelUsabilityBudgetError` as a failed switch.

### Why an extension could not handle it

- Favorite cycling, model usability admission, and the session event stream are
  core host seams below the extension API.

### Expected merge conflict zones

- LOW: `AgentSessionEvent`, `ModelCycleResult`, and `_cycleFavoriteModel`.
- LOW: the interactive `handleEvent` and cycle status path.

## 2026-09-04 - Branded build labels render verbatim in startup UI

### What changed

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: the non-chrome startup logo line renders through `formatDisplayVersion` instead of a hardcoded `v` prefix, so branded build labels such as `omo@c6e7dd7 2026-09-04 10:17 +09:00` display verbatim.
- `packages/coding-agent/src/modes/interactive/grok/welcome-card.ts`: both grok welcome card render sites route through the same helper.

### Why

- A branded distribution injects a free-form `SENPI_BRAND.displayVersion`, and the hardcoded `v` produced `OmO vomo@c6e7dd7 …` on every startup for those installs. The renderer only owns the prefix decision, so the fix belongs here rather than asking every brand to strip their label to a semver string.

### Why an extension could not handle it

- The logo line and the welcome card are engine-owned chrome. Extensions cannot replace their render paths; they only supply the brand profile string.

### Expected merge conflict zones

- LOW: the logo template literal in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` and the two template literals in `packages/coding-agent/src/modes/interactive/grok/welcome-card.ts`.

## 2026-09-04 - Mark the current thinking level in the selector

### What changed

- `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`: item labels gain a `✓ ` prefix on the active level (two-space pad otherwise), and fuzzy filtering matches the raw level value plus the description instead of the decorated label (upstream f2a622789, #8900); the fork's selector tests were aligned to the marker in 9e64e52d1.

### Why

- With the check mark embedded in the label, typing a level name would no longer fuzzy-match it; filtering on the value keeps search working while the marker stays visible while browsing.

### Why an extension could not handle it

- The selector is an interactive TUI component rendering inside the host's fullscreen UI.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/modes/interactive/components/thinking-selector.ts` label construction and `applyFilter`.

## 2026-09-03 - Restore interactive lifecycle seams and branded terminal overrides

### What changed

- Guarded early interactive TUI lifecycle reads when test or host construction has not yet provided session, terminal, or pending-tool state, while retaining the normal runtime behavior.
- Resolved unset terminal capability settings from `SENPI_HYPERLINKS`, `SENPI_IMAGE_PROTOCOL`, and `SENPI_TRUE_COLOR`, with legacy `PI_*` fallback.

### Why

- The upstream sync introduced lifecycle calls at construction and event boundaries where fork-owned fakes and early host events legitimately omit optional state.
- Branded deployments need their capability namespace to reach the TUI detection seam.

### Why an extension could not handle it

- Interactive lifecycle state and terminal capability detection are host-owned infrastructure below the extension API.

### Expected merge conflict zones

- MEDIUM: interactive constructor/event handling and terminal settings resolution during upstream syncs.

## 2026-09-03 - Record fork-owned interactive surfaces against the advanced upstream pin

### What changed

- No behavior changed in this entry. Advancing `.github/upstream.json` to `f41f80466` brought the
  following fork-owned interactive files into the audit's pin-divergence scope, so they are recorded
  here explicitly: `components/assistant-message.ts`, `components/bash-execution.ts`,
  `components/compaction-summary-message.ts`, `components/custom-editor.ts`, `components/diff.ts`,
  `components/earendil-announcement.ts`, `components/extension-selector.ts`, `components/footer.ts`,
  `components/index.ts`, `components/keybinding-hints.ts`, `components/settings-submenu.ts`,
  `components/status-indicator.ts`, `components/thinking-selector.ts`, `components/tool-execution.ts`,
  `components/tree-selector.ts`, `external-editor.ts`, `model-search.ts`, `session-share.ts`, and
  `theme/theme.ts`.
- Each of these is a long-standing fork divergence (senpi branding, footer/dock presentation, notice
  and diff rendering, session sharing, and the fork keybinding/theme surfaces) that predates this
  sync; they carry no upstream counterpart to reconcile at this pin.

### Why

- The tracker audit compares every production path against the pinned upstream tree. When the pin
  advances, fork-only interactive files become newly in-scope and must be named by a tracker entry
  even though the sync itself did not touch them.

### Why an extension could not handle it

- These are host-owned interactive rendering and lifecycle surfaces beneath the extension API; an
  extension cannot supply the footer, transcript components, selectors, or theme resolution.

### Expected merge conflict zones

- LOW: upstream rarely edits these files, but branding strings, footer composition, and component
  rendering will conflict whenever upstream restructures the interactive component tree.

## 2026-09-03 - Reconcile interactive upstream terminal and selector behavior

### What changed

- `interactive-mode.ts`: preserve fork steering-slot, working-dock, footer, shutdown, and notice-block behavior while adopting terminal capability overrides, fullscreen selection-copy wiring, turn-start working/progress restoration, and upstream diagnostics integration adapted to fork rendering.
- `components/model-selector.ts`, `components/scoped-models-selector.ts`, `components/settings-selector.ts`: preserve fork model/scoped-model/settings UX and favorite/availability semantics; retain cheap active/current markers where compatible.
- `interactive-mode.ts` and selector tests: keep fork-diverged selector behavior instead of upstream scope normalization and rejected thinking-selector UX assertions.

### Why

- The fork intentionally owns interactive rendering, steering queue presentation, and scoped-model persistence semantics; upstream additions must not regress those surfaces.

### Why an extension could not handle it

- Terminal capability setup, fullscreen selection behavior, selectors, and notice rendering are host-owned interactive infrastructure beneath extension hooks.

### Expected merge conflict zones

- LOW: interactive lifecycle, selector rendering, and settings submenu composition during upstream syncs.

## 2026-09-03 - Adapt upstream interactive regressions to fork contracts

### What changed

- `test/interactive-mode-assistant-diagnostics.test.ts` and pending-output regression coverage use the fork notice family and fork streaming/working component seams rather than upstream-only renderer details.

### Why

- These tests exercise machine-visible behavior while the fork deliberately diverges in notice-block and streaming rendering.

### Why an extension could not handle it

- The assertions target private interactive host rendering and component lifecycle, which extensions cannot replace.

### Expected merge conflict zones

- LOW: assistant diagnostics and thinking-toggle regression tests when upstream adds renderer-specific expectations.
# 2026-09-05 - Ctrl+P skips models without context room

### What changed

- Favorite-model cycling emits a typed `model_change_skipped` event and continues
  in the requested direction when a candidate model cannot leave the provider's
  minimum answer room for the current conversation.
- Interactive mode renders the event as a warning naming the skipped model and
  the current context/window measurements. The desktop app can consume the event
  without requiring a desktop-specific code change.

### Why

- Ctrl+P is an explicit request to switch, so a model that cannot admit the
  current context must not block the request or silently look like a failed
  switch. The next usable favorite is selected instead, while the skipped
  candidate remains visible to the user.

### Expected merge conflict zones

- LOW: `AgentSessionEvent` model event union and `_cycleFavoriteModel`.
- LOW: the interactive `handleEvent` switch.

## Bound omitted render-signature hashing (2026-08-10)

### What changed

- `components/render-signature.ts` now hashes omitted array items and sorted object entries with an iterative FNV-1a
  accumulator instead of recursively summarizing sliced tails. This prevents omitted sibling counts in wide arrays and
  objects from increasing call-stack depth while preserving cache invalidation and the existing nested-tail depth budget.

### Why this cannot be expressed externally

- Assistant-message and tool-execution render signatures are private built-in TUI cache keys; extensions cannot replace
  their hashing or invalidation behavior.

### Expected merge conflict zones

- LOW: the omitted array/object branches in `components/render-signature.ts` and
  `test/render-signature.test.ts`.
# 2026-09-05 - Ctrl+P skips models without context room

### What changed

- Favorite-model cycling emits a typed `model_change_skipped` event and continues
  in the requested direction when a candidate model cannot leave the provider's
  minimum answer room for the current conversation.
- Interactive mode renders the event as a warning naming the skipped model and
  the current context/window measurements. The desktop app can consume the event
  without requiring a desktop-specific code change.

### Why

- Ctrl+P is an explicit request to switch, so a model that cannot admit the
  current context must not block the request or silently look like a failed
  switch. The next usable favorite is selected instead, while the skipped
  candidate remains visible to the user.

### Expected merge conflict zones

- LOW: `AgentSessionEvent` model event union and `_cycleFavoriteModel`.
- LOW: the interactive `handleEvent` switch.
