# changes

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
