# TUI delta rendering fork changes

## Alt-screen Kitty teardown keeps its disambiguated helper name after the 59a71b23 sync (2026-08-19)

### What changed

- `packages/tui/src/tui-alt-screen.ts`: re-diverges from upstream `59a71b235d` by exactly one
  identifier. The private teardown helper stays `deleteAltScreenKittyImages()` (upstream calls it
  `deleteKittyImages()`), and both call sites keep the fork name: the `stop()` synchronized-output
  teardown sequence and the full-clear branch that falls back to it when no Kitty placements were
  uploaded. The emitted escape bytes are byte-identical to upstream in every branch.

### Why

- The fork's alt-screen class shares a file-scope namespace with the module-level Kitty helpers
  imported from `terminal-image.ts` (`deleteAllKittyImages`, `deleteAllKittyPlacements`). The
  alt-screen-scoped name states which of the two deletion semantics the method wraps, so a reader
  resolving the full-clear branch does not have to check whether `deleteKittyImages` is the imported
  protocol helper or the class method that gates it on `imageProtocol === "kitty"`.

### Why an extension could not handle it

- `TuiAltScreen` teardown and its full-clear frame construction are private renderer internals that
  emit terminal bytes directly; no extension surface exists between the class and the terminal.

### Expected merge conflict zones

- LOW: `packages/tui/src/tui-alt-screen.ts` — the `stop()` teardown write, the private helper
  declaration, and the `clearImages` ternary in the full-clear path. Upstream edits to the same three
  hunks resolve by keeping the fork identifier and taking upstream's byte content.

## Image markers canonicalize on insert/prune and carry owner payloads across undo (2026-08-18)

### What changed

- `packages/tui/src/components/editor.ts`: `insertImageMarker()` renumbers the
  visible markers to canonical 1..k in reading order (via
  `ImageMarkerRegistry.canonicalize`, previously dead code) and returns the
  marker's FINAL canonical id instead of the insertion counter; `setText()`
  canonicalizes after pruning so a surviving high id displays as `[Image #1]`;
  `EditorSnapshot` carries an opaque `attachmentState` captured through the new
  owner hooks and `undo()` restores it BEFORE firing the marker-order
  notification; cursor position is preserved across the renumbering rewrite.
- `packages/tui/src/editor-component.ts`: new optional paired
  `snapshotAttachmentState`/`restoreAttachmentState` contract next to
  `onImageMarkersChanged`, documented together with the tightened
  `insertImageMarker` id semantics.
- Regression coverage: `test/editor-image-marker.test.ts` pins out-of-order
  insert canonicalization, post-prune renumbering, and multi-marker
  delete+undo payload restoration.

### Why

- The insertion counter only produces reading-order numbers when the cursor
  sits after every existing marker, so pasting in front of one displayed
  `[Image #2][Image #1]`; the owner's reconcile-by-position then mispaired or
  destroyed payloads. Undo restored marker text and registry ids but the
  payloads live with the owner, so a delete+undo permanently lost the deleted
  marker's image.

### Why an extension could not handle it

- The marker registry, undo stack, and the id semantics of
  `insertImageMarker` are `Editor` internals below the component contract;
  extensions cannot renumber marker text or hook the undo pop.

### Expected merge conflict zones

- MEDIUM: `insertImageMarker()` and the undo snapshot/restore block in
  `packages/tui/src/components/editor.ts`.
- LOW: the image-marker section of `packages/tui/src/editor-component.ts`.

## Repository-wide changes.md audit backfill for renderer, terminal, and component surfaces (2026-08-17)

### What changed

- Backfill from the repository-wide changes.md audit (pin `914cf147`, tag v0.84.2): this entry names every upstream-owned TUI production path that still diverges from the pinned upstream tree, so the next upstream sync can resolve each file's fork intent. Behavioral history for most paths lives in the dated sections of this file; the entries added by this backfill carry the rest.
- Renderer core: `packages/tui/src/tui.ts` holds the fork's differential renderer in `TuiBase` — synchronized autowrap-guarded frames, viewport-bounded normalize/diff, scrollback replay, the insert-scroll fast path, the configurable render fps cap, over-wide containment, the component `dispose()` contract, and mode-gated tmux focus routing (see the focus-routing entry below plus the 2026-08-14, 2026-07-31, 2026-07-04, 2026-07-03, and 2026-07-02 sections). `packages/tui/src/tui-main-screen.ts` is reduced to a thin main-screen subclass that owns render-state capture/restore; `packages/tui/src/tui-alt-screen.ts` differs from the pin only by the `deleteAltScreenKittyImages()` teardown rename (its focus, clipboard, and mouse-release behavior is upstream v0.84.2 parity, delivered by PR #892).
- Terminal I/O: `packages/tui/src/terminal.ts` (external stdout guard while started, control-stripped OSC 0 titles, best-effort raw-mode restoration on dead terminals), `packages/tui/src/stdin-buffer.ts` (stateful UTF-8 reassembly of split multibyte chunks), and `packages/tui/src/terminal-image.ts` (Kitty graphics through tmux allow-passthrough, Unicode placeholder placement, tmux-reported cell dimensions).
- Components and primitives: `packages/tui/src/components/box.ts` (disposal contract), `packages/tui/src/components/editor.ts` (paste-marker registry with provenance, atomic cursor discipline, autocomplete trigger characters), `packages/tui/src/components/image.ts` (per-row Kitty placeholder lines), `packages/tui/src/components/loader.ts` (`messageFormatter` animation plus `dispose()`), `packages/tui/src/components/markdown.ts` (LaTeX tokenizers and the bounded highlight cache), `packages/tui/src/components/select-list.ts` (the `renderRow` theme composer), `packages/tui/src/autocomplete.ts` (mixed `$`/`/` invocation picker and skill-namespace filtering), `packages/tui/src/editor-component.ts` (the paired paste-state API), `packages/tui/src/fuzzy.ts` (hot-path scoring and alphanumeric swap variants), `packages/tui/src/utils.ts` (two-generation width cache, terminal-output normalization, the `coalesceAdjacentSgr` utility), and `packages/tui/src/index.ts` (the fork export surface: paste markers, select-list row types, tmux helpers, markdown cache controls).
- `packages/tui/src/latex.ts` is the upstream LaTeX module path, deleted in this fork: the converter was rewritten dependency-free and relocated to `packages/tui/src/components/latex.ts` (see the relocation entry below).

### Why

- Merges resolve tracker files to `ours`, so every divergent upstream-owned path needs an entry in its exact nearest tracker that names it; without this inventory the divergence is invisible to the audit and to the next sync.

### Why an extension could not handle it

- These paths are the renderer, terminal-protocol, and primitive layer itself: frame bytes, stdin framing, capability probes, paste registries, and package exports sit below the extension API that would otherwise carry such behavior.

### Expected merge conflict zones

- HIGH: `packages/tui/src/tui.ts` (`TuiBase` render paths, scheduler, dispose, focus routing) and `packages/tui/src/tui-main-screen.ts` (the thin-subclass split itself).
- MEDIUM: `packages/tui/src/components/editor.ts`, `packages/tui/src/components/markdown.ts`, `packages/tui/src/terminal-image.ts`, `packages/tui/src/terminal.ts`, and `packages/tui/src/utils.ts`.
- LOW: `packages/tui/src/components/box.ts`, `packages/tui/src/components/image.ts`, `packages/tui/src/components/loader.ts`, `packages/tui/src/components/select-list.ts`, `packages/tui/src/autocomplete.ts`, `packages/tui/src/editor-component.ts`, `packages/tui/src/fuzzy.ts`, `packages/tui/src/stdin-buffer.ts`, `packages/tui/src/tui-alt-screen.ts`, and the `packages/tui/src/index.ts` export lists; `packages/tui/src/latex.ts` is a whole-file deletion to reconcile against `packages/tui/src/components/latex.ts`.

## Component-tree disposal bounds long-session cleanup (2026-08-17)

Landed 2026-06-17 (commit 4f6749bb7).

### What changed

- `packages/tui/src/tui.ts`: `Component` declares optional `dispose?()` and `Container` implements tree-wide disposal — `dispose()` runs once (guarded by a `disposed` flag), `clear()` disposes the children it removes, `removeChild()` disposes the removed child, and `detachAll()` detaches without disposing for callers that reuse components.
- `packages/tui/src/components/box.ts`: the same contract locally — `clear()` and `removeChild()` dispose affected children, `dispose()` is idempotent, and `detachAll()` preserves the previous non-disposing clear semantics for cache-preserving reuse.
- `packages/tui/src/components/loader.ts`: `dispose()` stops the animation timer so a disposed loader cannot keep ticking.
- `packages/tui/src/components/markdown.ts`: the module-level syntax-highlight cache is bounded with insertion accounting, and `clearRenderCache()` plus highlight call counters are exported through `packages/tui/src/index.ts` for teardown and tests.
- Coverage: `packages/tui/test/component-dispose.test.ts` and `packages/tui/test/markdown-highlight.test.ts`.

### Why

- Resumed multi-thousand-entry sessions replace whole component subtrees; without a disposal contract, stale animation timers and unbounded module-level highlight caches accumulate for the process lifetime.

### Why an extension could not handle it

- Component lifecycle and module-level caches are TUI internals; extensions compose components but cannot inject tree-wide teardown or clear renderer-owned caches.

### Expected merge conflict zones

- LOW: the disposal methods in `packages/tui/src/components/box.ts` and `packages/tui/src/components/loader.ts`.
- MEDIUM: `packages/tui/src/components/markdown.ts` cache accounting; LOW: its `packages/tui/src/index.ts` re-exports.
- LOW: the `Container` method block in `packages/tui/src/tui.ts`.

## SelectList theme renderRow composer (2026-08-17)

Landed 2026-07-26 (commit 8abee395c).

### What changed

- `packages/tui/src/components/select-list.ts`: `SelectListTheme` gains optional `renderRow`, a composer receiving decomposed `SelectListRowParts` — selection prefix (with `selectedPrefix` already applied), truncated primary, column-aligned description, and selection state — and taking over row composition. Without a composer, rendering funnels through one legacy branch that reproduces the previous composition operand-for-operand; the previously dead `selectedPrefix` callback is now honored for selected prefixes.
- `packages/tui/src/components/editor.ts`: threads the composer through the existing theme plumbing without widening the public editor API.
- `packages/tui/src/index.ts` exports `SelectListRenderRow` and `SelectListRowParts`.
- Coverage: `packages/tui/test/select-list-render-row.test.ts`, `packages/tui/test/select-list-characterization.test.ts` (byte-identical legacy output including truncation suffixes, column math, CJK widths, and the narrow-width path), and `packages/tui/test/editor-render-row.test.ts`.

### Why

- Row composition was hard-coded (prefix, primary, and description wrapped in one `selectedText()` call), which made it impossible to color a slash-command prefix independently of the selected-row background — the requirement the grok chrome's colored slash menu brought in.

### Why an extension could not handle it

- SelectList is the shared selector primitive consumed by editors and dialogs before any coding-agent extension UI hook runs; only the library can expose row decomposition.

### Expected merge conflict zones

- MEDIUM: `packages/tui/src/components/select-list.ts` around `composeRow()` and the theme interface.
- LOW: the theme plumbing in `packages/tui/src/components/editor.ts` and the `packages/tui/src/index.ts` export list.

## Fuzzy matcher hot path and alphanumeric swap variants (2026-08-17)

Landed 2026-06-08 (commit af0ab07a0).

### What changed

- `packages/tui/src/fuzzy.ts`: `fuzzyMatch` scoring moved from a per-call closure into a top-level `scoreMatch`, and the per-character regex word-boundary test became char-code classification (`isWordBoundaryPrefix`). The whole-token letter/digit swap regex is generalized into `buildAlphanumericSwapQueries()`: every adjacent letter/digit transposition plus whole-token swaps, each scored with the flat `ALPHANUMERIC_SWAP_PENALTY` (5), best matching variant wins — so queries like `gpt5a` match `gpt-a5`.
- Exact-match priority and slash-separated filter tokens are upstream v0.84.2 behavior (in the pin) and are not fork deltas.
- Coverage: `packages/tui/test/fuzzy.test.ts` pins the adjacent-swap case.

### Why

- Selector filtering runs on every keystroke against large model registries; the closure allocation and per-character regex dominated the hot path, and single transposed alphanumerics previously failed to match.

### Why an extension could not handle it

- `fuzzyFilter` is the ranking primitive inside the shared autocomplete and selector stack; extensions receive filtered lists and cannot replace the matcher.

### Expected merge conflict zones

- MEDIUM: scoring and swap-variant construction in `packages/tui/src/fuzzy.ts`; upstream edits to the same functions will conflict textually.

## LaTeX converter relocated under components (2026-08-17)

Landed 2026-07-29 (commit 5655c1cd8).

### What changed

- `packages/tui/src/latex.ts` — the upstream-owned module path — no longer exists in this fork. The LaTeX converter was rewritten as the dependency-free, budgeted parser described in the 2026-07-29 "Native Unicode LaTeX in Markdown conversations" section and lives at `packages/tui/src/components/latex.ts`, beside its only consumer, the Markdown tokenizers in `packages/tui/src/components/markdown.ts`.
- `packages/tui/src/index.ts` no longer re-exports `renderLatex` from the old path; conversion is internal to the Markdown component (the paste-marker exports took that slot).

### Why

- The fork's converter is a deliberate rewrite (bounded nesting budgets, balanced parsing, fallback to literal text), not an edit of upstream's module. Keeping it beside its consumer matches the package layout, and recording the deleted upstream path maps the next sync's deletion to this entry instead of resurrecting upstream's module at `packages/tui/src/latex.ts`.

### Why an extension could not handle it

- Math tokenization happens inside the Markdown component before extension-facing UI hooks; consistent rendering across every Markdown consumer requires the parser seam.

### Expected merge conflict zones

- The deleted `packages/tui/src/latex.ts` is a whole-file divergence: an upstream sync touching it must reconcile against `packages/tui/src/components/latex.ts`. LOW: the `packages/tui/src/index.ts` export slot.

## Fullscreen focus routing and the PR #892 v0.84.2 sync repairs (2026-08-17)

Landed 2026-08-16 (commit 03f46f57e, shipped in PR #892).

### What changed

- `packages/tui/src/tui.ts`: `TuiBase.handleTerminalInput()` consumes tmux focus events only when `mode !== "fullscreen"`. Fullscreen renderers own focus events so they can clear exactly an active drag selection without forcing idle or completed-selection repaints; the main screen still refreshes terminal capabilities when focus returns to a multiplexer pane.
- PR #892 (merge/upstream-20260816) delivered upstream v0.84.2, whose focus behaviors — skipping repaints of idle fullscreen sessions on focus loss, giving focused fullscreen overlays wheel and viewport keys, and fullscreen transcript search — previously failed here because the fork's `TuiBase` focus interception forced a redraw before the alt-screen selection logic ran. The routing above is the fork-side repair; `b25d5bdeb` realigned the upstream assertions with fork branding.
- The upstream focus-loss tests carried by that sync (`packages/tui/test/tui-alt-screen.test.ts`) now run against the fork renderer.

### Why

- Three upstream focus-loss behaviors failed after the v0.84.2 merge until fork-side focus consumption was scoped to the main screen; without this entry the next sync would re-break or silently drop the repair.

### Why an extension could not handle it

- Focus events are consumed inside the renderer's input path before any component or extension sees the bytes.

### Expected merge conflict zones

- MEDIUM: the `handleTerminalInput()` focus branch in `packages/tui/src/tui.ts`. LOW: `packages/tui/src/index.ts` import ordering.

## Selection copy routes through the host clipboard (2026-08-17)

### What changed

- `packages/tui/src/tui-alt-screen.ts` carries upstream v0.84.2's selection-copy behavior (upstream issue #8110, delivered here by the PR #892 sync): copying an alt-screen selection writes through the host-clipboard seam that interactive mode wires on its side. The fork tree matches the pin for this behavior.
- The residual fork delta in this file is the teardown rename `deleteAltScreenKittyImages()`, which keeps alt-screen image teardown distinct from the shared kitty deletion helpers.

### Why

- Recorded so the next upstream sync treats the clipboard path as upstream-owned parity rather than a fork delta to re-port, and so the audit's divergence for this file is attributed to the rename.

### Why an extension could not handle it

- Selection copy executes inside the fullscreen renderer's mouse/selection handler; no extension seam intercepts terminal mouse bytes.

### Expected merge conflict zones

- LOW: the `deleteAltScreenKittyImages()` rename sites; the clipboard path itself is upstream-owned.

## Generic SGR mouse releases finish selection (2026-08-17)

### What changed

- `packages/tui/src/tui-alt-screen.ts` carries upstream v0.84.2's generic SGR mouse-release handling (upstream issue #7963, delivered by the PR #892 sync): `handleSelectionMouseEvent` accepts release events reporting the no-button code (`button === 3`) in addition to button 0, so a release that does not name a drag button still completes selection instead of being dropped.

### Why

- Recorded for sync parity like the host-clipboard entry: the behavior is upstream-owned and at pin parity here, and the file's only fork divergence remains the teardown rename.

### Why an extension could not handle it

- SGR mouse parsing and selection state are private to the fullscreen renderer's input path.

### Expected merge conflict zones

- LOW: the release guard in `handleSelectionMouseEvent`; upstream-owned otherwise.

## 2026-08-16: add a prompt-leading mixed dollar invocation picker ([PR #909](https://github.com/code-yeongyu/senpi/pull/909))

### What changed

- `CombinedAutocompleteProvider` recognizes a prompt-leading `$` run.
- The editor treats `$` as a built-in symbol autocomplete trigger, so the mixed picker opens on real keystrokes
  rather than only through direct provider calls.
- The first `$` token lists canonical `/command` rows before `$skill` rows and filters both with the same query.
- Selecting a command inserts `/name `; selecting a skill inserts `$name `.
- A second leading `$` token reopens only known skills, while inline or unknown-prefix dollar text stays literal.

### Why

- OmO Desktop and Senpi RPC now expose one mixed command/skill surface; the terminal needs the same invocation
  affordance without teaching providers a new `$command` execution syntax.
- Canonical insertion keeps existing slash command dispatch and the shared dollar skill parser authoritative.

### Expected merge conflict zones

- MEDIUM: `autocomplete.ts` trigger ordering and completion replacement.
- LOW: `components/editor.ts` default autocomplete trigger characters.
- LOW: additive `dollar-invocation-autocomplete.ts` and its focused test.

## 2026-08-14: replay above-viewport growth in the viewport-remap branch

### What changed

- When a frame's content grows above the viewport and a visible row also changes (`viewportTop !== prevViewportTop` with `lineCountDelta !== 0`), the renderer now falls back to the canonical `renderScrollbackReplay` / mux dispatch instead of repainting only the visible rows in place.

### Why

- The in-place repaint emitted exactly `height` rows and returned, so rows inserted above the viewport (e.g. Ctrl+O expanding several tool blocks in one frame) never reached terminal scrollback even though `setPreviousLines` marked them painted — leaving mismatched headers and truncated results. The replay path re-emits the full canonical transcript.

### Expected merge conflict zones

- LOW: `tui.ts` the `viewportTop !== prevViewportTop` branch; LOW in `tui-render.test.ts`.

## 2026-08-05: dead-terminal raw-mode restoration is best-effort during shutdown

### What changed

- `packages/tui/src/terminal.ts`: `ProcessTerminal.stop()` still restores the raw-mode state captured by `start()`, but now treats `EIO`, `EPIPE`,
  and `ENOTCONN` from the teardown-time `setRawMode()` call as a dead terminal instead of crashing the exiting CLI.
- The EIO classifier accepts both Node's string `code: "EIO"` shape and Bun's macOS raw positive `errno: 5`
  shape, using numeric errno only when no string code is available.
- The separate coding-agent classifier handles asynchronous stdout/stderr stream `error` events; this numeric fallback
  stays scoped to the synchronous stdin `setRawMode()` ioctl that produced the observed Bun error shape.
- Unexpected raw-mode restoration errors still propagate so shutdown does not hide unrelated defects.
- `test/terminal.test.ts` covers successful restoration, the dead-terminal `EIO` regression, and unexpected-error
  propagation.

### Why

- An SSH or PTY peer can disappear after input draining but before raw-mode restoration. Node/Bun then throws a
  synchronous stdin ioctl error, which bypasses the coding-agent's stdout/stderr error handlers and replaces the
  requested exit with an uncaught `setRawMode failed with errno: 5` stack.

### Why this cannot be expressed externally

- Raw-mode ownership and restoration are private `ProcessTerminal` lifecycle responsibilities. Extensions receive
  neither the saved raw-mode state nor a teardown hook around the stdin ioctl.

### Expected merge conflict zones

- LOW: `packages/tui/src/terminal.ts` around the terminal error classifier and `ProcessTerminal.stop()` raw-mode
  restoration.
- LOW: `packages/tui/test/terminal.test.ts` around lifecycle coverage.

## 2026-07-31: atomic visible-cursor frames for IME and animations

### What changed

- Cursor restoration and visibility bytes now stay inside each synchronized
  render frame instead of being written after `FRAME_END`.
- The editor stops drawing its inverse-video fake cursor when the hardware
  cursor is visible; it still emits `CURSOR_MARKER` for IME placement.
- The renderer also removes a colocated inverse-video cursor after
  `CURSOR_MARKER`, covering focused single-line `Input` consumers and both
  inverse-off (`CSI 27 m`) and full-reset (`CSI 0 m`) terminators without
  discarding full-reset semantics.
- Runtime cursor-mode toggles defer visibility changes to the replacement
  frame, and shutdown no longer blanks content beneath a hardware cursor.

### Why

- With `showHardwareCursor: true`, animated Working updates briefly published
  the real cursor on the loader row before a second write returned it to the
  editor, producing rapid flicker.
- The visible hardware cursor and fake cursor were both drawn at the editor
  insertion point, making Korean IME composition look duplicated. The same
  ownership conflict affected search, selector, login, and extension inputs.
- This cannot be implemented as an extension: cursor-marker extraction,
  synchronized-frame boundaries, and final ANSI cursor writes are renderer
  invariants below the extension API.

### Expected merge conflict zones

- HIGH: `tui.ts` synchronized render exits and cursor positioning.
- LOW: `components/editor.ts` cursor rendering.

## 2026-07-31: memoized line normalization and viewport-bounded rendering by default

### What changed

- `tui.ts` reuses `normalizeTerminalOutput` results across frames through a per-instance memo keyed by the raw
  line string. Full normalization passes swap in a fresh map holding only the lines used by the current frame, so
  the memo never outgrows the transcript it mirrors (whose normalized strings it shares by reference). Unchanged
  lines now keep their string identity across frames, which also restores O(1) reference-equality diff compares
  that fresh normalization allocations previously defeated. Image lines keep bypassing normalization unchanged.
- `mux.ts` `viewportRenderEnabled()` now defaults on; `PI_TUI_VIEWPORT_RENDER=0` opts out of viewport-bounded
  normalize+diff and `1` still forces it on. Output byte-equivalence between the bounded and full paths is pinned
  by `test/viewport-render.test.ts` (streaming, offscreen line-count changes, offscreen in-place mutations).
- `scripts/perf-trend-local.sh` pins the two baseline frame-cost lanes to `PI_TUI_VIEWPORT_RENDER=0` so their
  historical meaning (unbounded full pass) survives the default flip.
- `bench/frame-cost.ts` 300-frame p50 on Apple M5 Max, stable components: 100k-line transcript 16.20ms -> 1.97ms
  (new default; 8.2x) and 16.20ms -> 12.34ms with bounding opted out (memo only); 30k lines 4.51ms -> 1.66ms;
  10k lines 2.23ms -> 1.34ms. Emitted bytes per frame stay identical (131) across all lanes.
- Coverage: `test/viewport-render.test.ts` proves the unset-flag default bounds normalization, the opted-out full
  pass renormalizes only new content after the first frame, and byte-identical writes across both paths;
  `test/mux.test.ts` pins the default-on/opt-out switch semantics.

### Why this cannot be expressed externally

The normalize/diff pipeline is private render state inside `TUI.doRender()` (`previousLines`, `previousRawLines`,
viewport offsets). No component or extension seam can deduplicate normalization work or change the bounded-path
default without owning that state.

### Expected merge conflict zones

- MEDIUM: `tui.ts` `normalizeLine()` / `applyLineResets()` bodies and the render-state field block.
- LOW: `mux.ts` `viewportRenderEnabled()`, `test/mux.test.ts`, `test/viewport-render.test.ts`,
  `scripts/perf-trend-local.sh` bench lanes.

## 2026-07-31: Contextual skill slash-command discovery

### What changed

- Bare `/` no longer lists every `skill:<name>` command, and partial `/skill` input exposes one `skill:` namespace hint
  instead of flooding the palette with every child skill.
- `/skill:` and case variants such as `/SKILL:` open the full skill namespace, while `/` followed by a skill's full
  name or leading letters finds matching child skills directly.

### Why

- The shared `skill:` prefix flooded the root slash-command overview and obscured the smaller set of general commands,
  while filtering every child also left `/skill` as a discoverability dead end.

### Why this cannot be expressed externally

The shared autocomplete provider owns slash-command filtering before coding-agent extensions receive input, so an
extension cannot change which registered skill commands appear for each typed prefix.

### Expected merge conflict zones

- LOW: `slash-command-autocomplete.ts` skill filtering and its focused autocomplete regression test.

## 2026-07-29: Native Unicode LaTeX in Markdown conversations

### What changed

- `components/markdown.ts` registers bounded Marked block and inline tokenizers for `$...$`, `$$...$$`, `\(...\)`,
  and `\[...\]` math. Dollar delimiters require non-word outer boundaries, and bracket/parenthesis candidates stop at
  inline-code or competing opener boundaries. Currency, shell variables, code spans, and malformed delimiters remain
  literal, including partial streamed currency/shell pairs and math-like text after an unclosed inline-code opener.
- The dependency-free `components/latex.ts` converter uses a balanced parser for nested fractions, roots, text
  wrappers, symbols, and Unicode sub/superscripts. Formula length and nesting budgets fall back to the original text
  instead of partially converting or repeatedly rescanning untrusted input. A leading combining mark receives a
  dotted-circle anchor so terminal cell width agrees with the differential renderer.
- TeX epsilon/phi variants and escaped script markers stay distinct, complete command names prevent prefix
  corruption, and unknown commands remain readable. Display formulas inherit their surrounding style context.
- Coverage: `test/markdown.test.ts` proves ordinary-text boundaries, nested/budgeted conversion, streamed partial
  currency/shell and inline-code frames, CJK wide cells, inherited styles, malformed preservation, and focused
  `VirtualTerminal` cell widths including a column-zero combining mark.

### Why this cannot be expressed externally

The `Markdown` component owns tokenization before extension-facing coding-agent UI hooks run. Rendering formulas
consistently in assistant messages, nested Markdown structures, and every direct TUI consumer requires the parser seam.

### Expected merge conflict zones

- MEDIUM: `components/markdown.ts` parser construction and custom token branches.
- LOW: `components/latex.ts` symbol/script conversion tables and `test/markdown.test.ts` LaTeX cases.

## 2026-07-28: over-wide diagnostics stop rescanning settled large histories

### What changed

- `tui.ts` now formats the full over-wide render diagnostic only when strict mode needs it or before the first
  release-mode crash dump. Later over-wide release frames still truncate safely, but no longer map every rendered
  line through `visibleWidth()` after the one-shot dump has already been written.
- `__renderDiagnosticStats()` exposes diagnostic line-scan counts only under `PI_TUI_TEST_SEAMS=1`.
- `test/render-contract.test.ts` proves the first over-wide release frame scans diagnostic input and a second frame
  neither writes nor rescans the transcript.

### Why

The existing `overWideCrashDumpWritten` guard covered only the filesystem write. Building `crashData` happened before
that guard, so an animated row could rescan a large resumed transcript on every frame even though no second dump was
possible. Before the companion coding-agent throttle, a 34 MB session's 32 ms Working shimmer turned that
diagnostic work into a continuous CPU loop.

### Expected merge conflict zones

- LOW: `tui.ts` around release-mode over-wide truncation and crash diagnostics.
- LOW: `test/render-contract.test.ts` over-wide release behavior.

## 2026-07-28: setText prunes instead of clearing the paste registry; paste-state transfer API

### What changed

- `components/editor.ts` `setText()` no longer unconditionally clears the large-paste registry. It now prunes only entries whose markers do not appear in the new text (and resets numbering when the registry empties). Markers that survive a programmatic `getText()` → `setText()` round-trip stay live: they remain atomic segments and still expand to the full pasted body on submit and in `getExpandedText()`.
- Pruning matches the exact canonical marker string reconstructed from the stored body via the shared `formatPasteMarker()` helper (also used at insert time), so arbitrary new text that merely looks like a live marker (`[paste #1 +5 lines]` with a mismatched suffix) cannot accidentally revive a registry entry and expand to unrelated content.
- Provenance check: `setText()` retains an entry only if its canonical marker appears in BOTH the previous and the new text (a genuine carried-over round-trip). Stale registry entries — kill-line/word-delete remove marker text without touching the registry, intentionally, so yank can restore a killed marker — can no longer be revived by replacement text that coincidentally contains their exact marker. Explicit cross-instance transfers use `setPasteState()`, which skips the provenance check by design.
- New `getPasteState()` / `setPasteState()` on `Editor` plus optional `getPasteState?`/`setPasteState?` on the `EditorComponent` interface (exported `EditorPasteState`): snapshots the registry for transfer between editor instances. `setPasteState()` raises the paste counter above transferred ids (no collisions) and prunes entries whose markers are absent from the current text. The interface documents the paired contract: implement both together — callers treat an editor with `setPasteState` but no `getPasteState` as paste-unaware, because it could not re-export collapsed markers on a later hand-off.
- The submit/`getExpandedText()` expansion logic is extracted as the exported `expandPasteMarkers(text, state)` helper so consumers holding a paste snapshot (e.g. an editor hand-off where the source lacks `getExpandedText`) can expand markers without duplicating the marker grammar.
- Expansion and atomic segmentation are both canonical-exact and therefore consistent: only the exact marker string produced at paste time expands or merges into an atomic segment. Same-id text with a different suffix (e.g. a literal `[paste #1 +5 lines]` while entry #1 stores 12 lines) stays literal and is not treated atomically. Previously expansion was suffix-lenient and segmentation was id-based, so a coincidental same-id literal could be replaced by the stored body at submit.
- Previously any `setText` round-trip (dialog save/restore, queued-message restore, editor hand-off) orphaned live markers into dead literal text, so submitting sent the literal `[paste #1 +18 lines]` placeholder to the model instead of the pasted content.
- Tests: `test/editor.test.ts` "Paste marker atomic behavior" — round-trip preservation, queued-restore combination, selective/exact pruning, coincidental-marker rejection, cross-instance transfer, counter collision safety, and numbering reset.

### Why this cannot be expressed externally

The paste registry and marker segmentation are `Editor`-private state; consumers only see `getText()`/`setText()`/`getExpandedText()` and cannot preserve the registry across a round-trip themselves. Cross-instance transfer needs a first-class snapshot API for the same reason.

### Expected merge conflict zones

- LOW: `components/editor.ts` `setText()`, `prunePastes()`, `formatPasteMarker()`, `getPasteState()`/`setPasteState()`, and the handlePaste marker-insertion line.
- LOW: `editor-component.ts` optional paste-state methods; `index.ts` `EditorPasteState` export.
- LOW: `test/editor.test.ts` paste marker suite.

## 2026-07-17: Kitty graphics through tmux passthrough

### What changed

- `terminal-image.ts`: `detectCapabilities` no longer hard-disables images under tmux. It probes the
  effective `#{allow-passthrough}` value for the current pane (plus `#{client_termname}`) via
  `tmux display-message -p`; when passthrough is `on`/`all` and the outer terminal implements the Kitty
  graphics protocol (kitty/Ghostty/WezTerm via `client_termname` or leaked env hints), capabilities become
  `images: "kitty", tmuxPassthrough: true`. Both probes are dependency-injectable for tests.
- `terminal-image.ts`: new exported `wrapTmuxPassthrough(sequence)` wraps a sequence in a tmux DCS envelope
  (`ESC Ptmux; … ESC \` with every payload ESC doubled). `encodeKitty` wraps each APC chunk individually and
  `deleteKittyImage`/`deleteAllKittyImages` wrap their delete commands when `tmuxPassthrough` is active.
- `terminal-image.ts`: Kitty Unicode placeholder placement for split-safe tmux rendering. Direct passthrough
  placement draws at the outer terminal's cursor and breaks in split panes, so placeholder-capable outer
  terminals (kitty, Ghostty) get `kittyUnicodePlaceholders: true`: `encodeKitty` gains a `virtual` option
  (`U=1` virtual placement), `buildKittyPlaceholderRow` emits U+10EEEE cells with row/column (and id
  high-byte) diacritics plus the image id in the 24-bit foreground color, and `renderImage` returns per-row
  `lines` (first line carries the wrapped transmission). Placeholder cells are plain 1-column text, so tmux
  clips/scrolls/moves them with the pane. WezTerm (no placeholder support) stays on direct placement;
  `PI_TUI_TMUX_KITTY_PLACEMENT=placeholder|direct` overrides the heuristic. The `Image` component uses
  `result.lines` when present instead of one sequence line plus empty padding rows.
- `terminal-image.ts`: the tmux probe also reports `client_cell_width`/`client_cell_height`; when tmux images
  are enabled the detected cell size is adopted via `setCellDimensions` because tmux never answers the
  `CSI 16 t` cell-size query (verified against tmux 3.6), keeping image aspect ratios correct.
- `terminal-image.ts`/`index.ts`: `outerKittyGraphicsMode(clientTermname)` is exported so the coding-agent
  startup guidance can decide whether recommending `allow-passthrough` is useful for the attached terminal.
- `utils.ts`: `extractAnsiCode` learned DCS sequences (`ESC P … ST`), skipping doubled-ESC pairs so the
  escaped inner ST does not terminate the envelope early. Wrapped image lines therefore keep
  `visibleWidth === 0` and stay compatible with the TUI's Kitty image-line bookkeeping (id/row extraction in
  `tui.ts` uses `indexOf("\x1b_G")`, which still matches inside the doubled-ESC payload).

### Why this cannot be expressed externally

Image capability detection and Kitty sequence emission are `terminal-image.ts` internals consumed by the
`Image` component and the `TUI` renderer's image deletion/diff paths; extensions cannot re-wrap sequences the
renderer emits.

### Expected merge conflict zones

- MEDIUM: `terminal-image.ts` tmux branch of `detectCapabilities`, `encodeKitty` chunk assembly, and
  `renderImage` kitty branches.
- LOW: `utils.ts` `extractAnsiCode` escape-sequence branches; `components/image.ts` kitty line assembly.
- LOW: `index.ts` terminal-image export list; `test/terminal-image.test.ts` tmux capability tests.

## 2026-07-26: composable leading skill autocomplete

### What changed

- `autocomplete.ts` reopens slash suggestions for a `/skill:` token after a completed, known leading skill command and offers only skill commands there. Completion inserts the selected second skill command with its leading slash and trailing space.
- Other slash commands remain leading-only, and skill suggestions do not appear after prose or an unknown leading skill. This keeps the autocomplete contract aligned with the executable leading-run parser in coding-agent.

### Why this cannot be expressed externally

The shared autocomplete provider owns the suggestion and insertion decisions that editor consumers use before the coding-agent session receives a prompt.

### Expected merge conflict zones

- LOW: `autocomplete.ts` slash-command suggestion and completion branches. This fork-local diff is deliberately minimal because the file is shared with upstream pi.

## 2026-07-19: configurable render fps cap and shared segmenter exports

### What changed

- `packages/tui/src/tui.ts`: the static 16ms render throttle (`MIN_RENDER_INTERVAL_MS`) is now an instance field
  `#minRenderIntervalMs` (default 16ms — behavior unchanged for existing callers) plus `setMaxRenderFps(fps)`:
  fps is clamped to 30-120 and stored as `Math.floor(1000 / fps)` (120fps ⇒ 8ms interval).
- `packages/tui/src/index.ts`: exports `getGraphemeSegmenter` and `getWordSegmenter` from `utils.ts` so consumers
  (smooth-streaming reveal in coding-agent) share the single `Intl.Segmenter` instances.
- Tests: `packages/tui/test/render-fps-cap.test.ts` (mocked-timer throttle-delay assertions) and
  `packages/tui/test/segmenter-exports.test.ts` (root re-export identity).

### Why this cannot be expressed externally

The render throttle is `TUI`-private scheduler state; extensions and components can request renders but cannot
safely replace the minimum frame interval. The segmenters already existed as module singletons in `utils.ts` — only
the package-root export surface was missing.

### Expected merge conflict zones

- LOW: `packages/tui/src/tui.ts` around the scheduler field declarations and `scheduleRender()`.
- LOW: `packages/tui/src/index.ts` around the `utils.ts` re-export list.

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

## Atomic image markers for clipboard-pasted images (2026-08-18)

### What changed

- `packages/tui/src/image-markers.ts` (new): `ImageMarkerRegistry` tracks the ids of atomic `[Image #N]` markers living in editor text, storing ids only and never image bytes. It guarantees the visible numbers stay a contiguous `1..k` sequence (via `canonicalize()`), exposes `authorizedMarkers()` for markers occurring exactly once (the only ones safe to treat as atomic), and supports single-occurrence removal plus `EditorImageState` snapshots for transfer between editor instances.
- `packages/tui/src/paste-markers.ts`: marker segmentation generalized so paste markers and image markers share the same atomic-segment machinery instead of the paste path owning a private tokenizer.
- `packages/tui/src/components/editor.ts`: image markers are treated as atomic editor segments. `insertImageMarker()` inserts the next `[Image #N]` marker at the cursor and returns its id, backspace/delete removes a marker whole, `getImageMarkerState()`/`setImageMarkerState()` export and install registry snapshots, and `onImageMarkersChanged` reports the ids in text reading order whenever markers are added, removed, pruned, or renumbered.
- `packages/tui/src/editor-component.ts`: the `EditorComponent` interface gains the optional image-marker API (`insertImageMarker`, `getImageMarkerState`, `setImageMarkerState`, `onImageMarkersChanged`) with paired-contract docs: an editor exposing insertion without the change callback is treated as image-unaware and receives the plain text path instead.
- `packages/tui/src/index.ts`: exports the image-marker surface (`ImageMarkerRegistry`, `EditorImageState`, `ImageMarkerCanonicalization`, `ImageMarkerRemoval`, `IMAGE_MARKER_REGEX`, `IMAGE_MARKER_SINGLE`, `formatImageMarker`, `isImageMarker`, `imageMarkerId`).

### Why

- Pasting a clipboard image used to insert the raw temp file path into the composer, leaking local filesystem paths into prompts and transcripts. Atomic markers let the editor display `[Image #1]` while the payload lives outside the text, and contiguous renumbering keeps the Nth marker mapped to the Nth submitted image.

### Why an extension could not handle it

- Cursor discipline, segment atomics, and the editor's text model are TUI internals; an extension can compose components but cannot make backspace delete a marker whole or keep registry ids synchronized with visible numbers across editor instances.

### Expected merge conflict zones

- MEDIUM: `packages/tui/src/components/editor.ts` (segment handling around cursor movement and deletion) and `packages/tui/src/paste-markers.ts` (the generalized segmentation shared with paste markers).
- LOW: `packages/tui/src/image-markers.ts` (new fork-owned file, no upstream counterpart), `packages/tui/src/editor-component.ts` (additive optional interface members), and the `packages/tui/src/index.ts` export lists.
