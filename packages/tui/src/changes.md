# TUI delta rendering fork changes

## 2026-07-04: terminal ownership and restart hardening

### What changed

- `packages/tui/src/terminal.ts` (+ `index.ts` export): `ProcessTerminal` accepts `onExternalStdoutWrite`. While
  started, `process.stdout.write` is patched so writes not issued by the terminal itself are forwarded to the handler
  instead of reaching the screen; the terminal's own output goes through the captured raw writer. External writes
  previously interleaved with frames, scrolled the viewport, and permanently desynchronized differential rendering.
  Passthrough restores on `stop()`, and a throwing handler falls back to raw stdout so output is never lost.
- `packages/tui/src/terminal.ts`: `setTitle` strips C0/C1 control characters before emitting OSC 0 — an embedded
  BEL/ESC in session, tool, or extension titles terminated the sequence early and dumped the remainder as raw output.
- `packages/tui/src/tui.ts`: `renderRequested` and `inputRenderPending` are reset in both `stop()` and `start()`.
  A render requested within the pending window (nextTick or the 16ms throttle) or while stopped left
  `renderRequested` set, so every plain `requestRender()` after restart silently no-oped until a keypress.

### Why this cannot be expressed externally

- stdout ownership, OSC emission, and render-scheduling flags are `ProcessTerminal`/`TUI` internals; components and
  extensions cannot patch process streams or reset private scheduler state safely.

### Expected merge conflict zones

- MEDIUM: `packages/tui/src/terminal.ts` around `start()`/`stop()` stream handling and `setTitle`.
- LOW: `packages/tui/src/tui.ts` `stop()`/`start()` scheduling-state resets.
- LOW: `packages/tui/test/external-stdout-guard.test.ts`, `packages/tui/test/terminal.test.ts`.

## 2026-07-03: TUI rendering excellence gates

### What changed

- `packages/tui/src/tui.ts`: added multiplexer-aware full-render policy, bounded mux viewport repaint, opt-in
  viewport-bounded normalize/diff, scroll-then-diff for bounded concurrent mutations, cursor visibility write
  coalescing, SGR reset-after-clear coverage, and release-mode render-failure containment.
- `packages/tui/src/utils.ts`: replaced the width cache with a two-generation cache and added the measured
  SGR coalescing utility/report path; runtime SGR coalescing remains unwired because the measured byte reduction
  was below the adoption gate.

### Why this cannot be expressed externally

These behaviors depend on `TUI`'s private render state: previous and raw line snapshots, viewport offsets,
terminal dimensions, cursor bookkeeping, synchronized output framing, mux detection, image-row handling, and
row-clear invariants. Components and extensions can reduce churn or request renders, but they cannot safely
replace the renderer's terminal-byte decisions or update its internal cursor/viewport state.

### Expected merge conflict zones

- HIGH: `packages/tui/src/tui.ts` around `doRender()`, `fullRender()`, `renderViewportInsertScroll()`,
  `renderScrollbackReplay()`, `positionHardwareCursor()`, and render-error diagnostic handling.
- MEDIUM: `packages/tui/src/utils.ts` around width caching, terminal-output normalization, and ANSI parsing helpers.
- LOW: `packages/tui/test/tui-render.test.ts` flicker-budget and scrollback assertions when upstream changes
  renderer byte expectations.

## 2026-07-02: autowrap disabled during frame writes (ghost-line fix)

### What changed

- In `packages/tui/src/tui.ts`, every frame write is bracketed by `TUI.FRAME_BEGIN` (`DECSET 2026` + `DECRST 7`) and `TUI.FRAME_END` (`DECSET 7` + `DECRST 2026`) instead of bare synchronized-output markers.
- New regression: `packages/tui/test/regression-wrap-desync-ghost-line.test.ts`.

### Why

- Differential rendering tracks the cursor with relative moves only. When the terminal draws a row wider than `visibleWidth()` measured (East-Asian-ambiguous glyphs, emoji newer than the terminal's Unicode tables, decomposed Hangul jamo), the row physically wraps, the cursor drifts one row down, and every later single-row diff (e.g. the loader seconds tick) paints one row too low — leaving a stale, partially overwritten ghost line such as `Working (0s • esc to interrupt)` above the fresh one. With autowrap off during the frame, over-wide rows clip at the last column and the drift cannot happen. Autowrap is restored at frame end so the shell never observes the disabled state, even after a crash between frames.

### Expected upstream conflict zone

- MEDIUM: every `let buffer = "\x1b[?2026h"` / `buffer += "\x1b[?2026l"` site in `TUI.doRender()`, `fullRender()`, `renderViewportInsertScroll()`, and `renderScrollbackReplay()` — upstream edits to those literals will conflict with the `FRAME_BEGIN`/`FRAME_END` constants.

## 2026-05-20: Loader message animation is part of the shipped normal TUI

### What changed

- `packages/tui/src/components/loader.ts` supports `messageFormatter` with an independent message animation interval.
- Senpi's normal TUI depends on this for `Working (Xs • esc to interrupt)` shimmer; a loader that only animates the
  indicator frame is not compatible with the forked CLI.

### Why this cannot be expressed externally

The loader is instantiated by `InteractiveMode` during streaming. Extensions can replace the indicator options, but a
globally installed CLI must ship a TUI runtime whose `Loader` honors `messageFormatter`.

### Expected upstream conflict zone

- HIGH: `packages/tui/src/components/loader.ts` around `LoaderIndicatorOptions`, `setIndicator()`,
  `restartAnimation()`, and `updateDisplay()`.
- HIGH: package/release wiring that decides whether `@code-yeongyu/senpi` bundles this forked TUI runtime or installs
  upstream npm `@earendil-works/pi-tui`.

## 2026-05-18: flicker-free scrollback replay for offscreen expansion

### What changed

- In `packages/tui/src/tui.ts` `TUI.doRender()`, structural changes that begin above the previous viewport now replay the latest canonical transcript from the top of the visible viewport when the visible rows would otherwise be unchanged.
- In `packages/tui/test/tui-render.test.ts`, the Ctrl+O regression now checks the latest xterm scrollback suffix for multiple offscreen expanded blocks, not only the visible tail viewport.

### Why

- Terminal scrollback rows above the visible viewport cannot be rewritten in place. The earlier fork-only differential remap updated `previousLines` without writing a new canonical transcript, so older collapsed tool/read blocks stayed visually collapsed while the bottom block appeared updated. A full screen clear fixed the stale scrollback but reintroduced visible flicker, so the replay now avoids both `ESC[2J` and `ESC[3J` and validates the newest canonical suffix instead of trying to delete historical rows.

### Expected merge conflict zones

- HIGH: `TUI.doRender()` around the `firstChanged < prevViewportTop` branch, because this preserves the fork's no-viewport-clear behavior while adding a scrollback-only replay path.
- LOW: `packages/tui/test/tui-render.test.ts` under `TUI viewport remap for above-viewport growth`.

## 2026-05-15: in-place repaint for above-viewport collapse

### What changed

- In `packages/tui/src/tui.ts` `TUI.doRender()`, content shrinkage that starts above the current viewport now remaps the viewport to the new bottom and uses the existing in-place viewport repaint path instead of forcing `fullRender(true)`.
- In `packages/tui/test/tui-render.test.ts`, regressions now cover a direct above-viewport collapse and repeated Ctrl+O-equivalent expand/collapse toggles.

### Why

- Ctrl+O toggles every expandable chat item. When expanded tool output collapses above the visible rows, the old shrink branch cleared the screen and scrollback (`ESC[2J`/`ESC[3J]`), which produced a visible TUI flash even when the final visible tail rows were unchanged.

### Expected merge conflict zones

- MEDIUM: `TUI.doRender()` around the `firstChanged < prevViewportTop` remap branch, because this fork already carries upstream-divergent differential repaint logic there.
- LOW: `packages/tui/test/tui-render.test.ts` under `TUI viewport remap for above-viewport growth`.

## 2026-05-11: insert-scroll fast path for expanded streaming output

### What changed

- In `packages/tui/src/tui.ts` `TUI.doRender()`, streaming inserts that move the viewport down while leaving a stable bottom suffix now use a scroll-region update for the changed viewport prefix, then paint only the newly inserted rows.
- The fast path skips image rows and overlays, preserving the existing safer repaint paths for cases where terminal-owned image placement or overlay composition makes scroll-region edits risky.
- In `packages/tui/test/tui-render.test.ts`, an expanded-output regression now asserts repeated appends avoid viewport/scrollback clears, keep DECSET 2026 balanced, preserve the final viewport, and avoid repainting stable tail rows every tick.

### Why this cannot be expressed externally

The decision depends on internal renderer state: previous and next viewport slices, line-count delta, stable suffix detection, image-line detection, hardware cursor bookkeeping, and synchronized terminal writes. Components and extensions can reduce churn, but cannot safely emit scroll-region edits or update `TUI`'s private viewport/cursor state.

### Expected upstream conflict zone

- `packages/tui/src/tui.ts` near the viewport remap and differential render branches in `doRender()`.
- `packages/tui/test/tui-render.test.ts` in `TUI viewport remap for above-viewport growth`.

## 2026-05-10: viewport remap repaint fix for Ctrl-O expansion

### What changed

- In `packages/tui/src/tui.ts` `TUI.doRender()`, above-viewport growth that remaps `viewportTop` now repaints only the visible viewport rows in place under synchronized output instead of falling back to a post-init full replay path.
- The repaint path deletes only kitty images in the previously visible viewport slice before rewriting rows, preserving image cleanup without clearing scrollback.
- In `packages/tui/test/tui-render.test.ts`, the above-viewport expansion regression now also asserts no raw `\x1b[2J`/`\x1b[3J` appears and verifies visible expanded rows are repainted while DECSET 2026 remains balanced.

### Why this cannot be expressed externally

The decision point depends on internal renderer bookkeeping (`prevViewportTop`, `viewportTop`, `hardwareCursorRow`, kitty image ID tracking, and synchronized write boundaries). Extensions/components can trigger renders but cannot replace this internal fallback behavior or safely rewrite only viewport rows at this stage.

### Expected upstream conflict zone

- `packages/tui/src/tui.ts` around the `firstChanged < prevViewportTop` branch inside `doRender()` (viewport remap handling and fallback path).
- `packages/tui/test/tui-render.test.ts` in `TUI viewport remap for above-viewport growth` assertions.

## What changed

- Tighten `TUI.doRender()` fallback paths so streaming updates can stay on the differential renderer instead of clearing the full screen when unchanged visible viewport rows are stable.
- Keep synchronized output (`DECSET 2026`) balanced around every differential write path.
- Add flicker-budget regression tests for synthetic streaming workloads in `packages/tui/test/tui-render.test.ts`.

## Why this cannot be expressed externally

The fallback decisions live inside `TUI.doRender()` and depend on private renderer state: `previousLines`, viewport offsets, terminal dimensions, cursor row tracking, and the line-diff window. Extension hooks and components can request renders, but they cannot override the internal decision to call `fullRender(true)` or wrap terminal writes with synchronized output.

Component-level caching is added in coding-agent components because high-frequency assistant/tool updates rebuild render trees during streaming. External extensions can register alternate renderers, but they cannot memoize the built-in assistant and tool execution components without replacing core interactive-mode rendering.

## Expected upstream conflict zones

- `packages/tui/src/tui.ts`: `TUI.doRender()` fallback branches around width/height changes, `clearOnShrink`, deleted-line handling, viewport-shift handling, and synchronized output writes.
- `packages/tui/src/tui.ts`: `fullRender` paths and `fullRedrawCount` accounting.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`: assistant streaming render cache.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`: tool execution streaming render cache.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: streaming render request audit comments near `message_update` and `tool_execution_update`.

## Test surface added

- `flicker budget under streaming` in `packages/tui/test/tui-render.test.ts` verifies:
  - full clear sequence count stays at the initial render only,
  - ANSI escape bytes remain below the content-byte budget,
  - every `DECSET 2026` begin has a matching end,
  - no `fullRender(true)` equivalent clear occurs after the init phase.
