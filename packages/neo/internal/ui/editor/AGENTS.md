# packages/neo/internal/ui/editor

Independent Go multiline editor. Contract-faithful port of `packages/tui/src/components/editor.ts`; `keys.go` ports `packages/tui/src/keys.ts`. Source parity with the TS originals is a convention, not a mechanical sync.

## FILE MAP

| File | Contents |
|---|---|
| `editor.go` | Public `Editor` struct, `New`, `SetText`, `InsertTextAtCursor`, `Cursor`, `SetFocused`, `AddToHistory` |
| `bubbletea.go` | `Update(msg tea.Msg)`, `ViewCursor(rows, originX, originY)` |
| `render.go` | `Render(width int) []string`, fake reverse-video cursor marker |
| `edit_ops.go` | Character/line insertion and deletion |
| `kill_ops.go` | Kill-to-line-end/start, kill-word |
| `killring.go` | Kill ring accumulation + yank-pop state |
| `movement.go` | Cursor movement, sticky columns |
| `wordnav.go`, `wordnav_find.go` | UAX-29 word navigation |
| `autocomplete.go` | `SetAutocompleteProvider`, `AdvanceDebounce`, `WaitForAutocompleteInFlight`, `WaitForAutocompleteRequestsSettled`, debounce gate |
| `autocomplete_req.go` | In-flight async request lifecycle, cancel-on-keystroke |
| `acpopup.go` | Completion popup rendering |
| `keymap.go` | `Action` string constants, `Keymap` interface (`Matches`, `SubmitKeys`), `DefaultKeymap()` |
| `keys.go` | Kitty CSI-u (`kittyCSIuRe`) + xterm modifyOtherKeys (`modifyOtherKeysRe`) decoders |
| `visualmap.go` | Logical-to-visual line mapping |
| `wrap.go`, `wrapcache.go` | Soft-wrap layout, invalidation cache |
| `markers.go` | `cursorMarker` constant and paste-marker helpers |
| `state.go` | `editorState` (lines, cursor), `undoStack` |
| `textwidth/` | Terminal-cell grapheme width (wraps `uniseg`) |
| `dispatch.go`, `helpers.go`, `runes.go` | Internal utilities |

Tests: `editor_<feature>_test.go` (cursor, history, killring, pastemarker, sticky, undo, unicode, wrap, autocomplete, jump). Manual entry: `qaharness/main.go`.

## KEY ENTRY POINTS

- `New(opts Options) *Editor` constructs with defaults (keymap, acMaxVisible clamp 3..20, paddingX clamp >= 0).
- `Update(msg tea.Msg) *Editor` feeds a Bubble Tea message; returns receiver for chaining.
- `Render(width int) []string` produces display rows with the fake reverse-video cursor embedded (when focused).
- `ViewCursor(rows []string, originX, originY int) *tea.Cursor` locates the zero-width cursor marker in Render output to pin the hardware cursor for IME.
- `SetAutocompleteProvider(p AutocompleteProvider)` installs a provider and resets trigger chars.

## INVARIANTS

**Keys**: Every raw sequence resolves through `Keymap.Matches(raw, action)`. No feature code compares raw byte sequences inline.

**Column math**: Logical columns are rune indices into a line string. Display width uses `textwidth/` (grapheme cluster width, CJK/emoji aware). Never use byte offsets or UTF-16 code unit counts.

**Cursor**: `Render` embeds `cursorMarker` for fake reverse-video when `focused = false` or terminal lacks hardware cursor. `ViewCursor` finds the marker and returns the hardware cursor position for IME candidate window placement. Both invariants must survive viewport resize.

**Undo**: `undoStack` push happens before every mutation. Insert runs coalesce (history draft is saved on `exitHistoryBrowsing`).

**Kill ring**: `ctrl+w/u/k` accumulate into the ring when `lastAction == actionKill`. `ctrl+y` yanks, `alt+y` pops. Stored in `killRing` field.

**Sticky columns**: Vertical movement preserves `preferredVisualCol`; horizontal movement clears it via `setCursorCol`.

**Paste**: CRLF and CR normalized to `\n`. Tabs expanded. Control characters filtered. Large pastes stored in `pastes` map and referenced via `[paste #N]` markers; `GetExpandedText` expands them back.

**Async autocomplete**: Tests use `AdvanceDebounce()`, `WaitForAutocompleteInFlight()`, `WaitForAutocompleteRequestsSettled()` as deterministic seams. No wall-clock sleeps.

## CONSUMERS

- `internal/app/input.go`: `EditorBuffer` interface; `var _ EditorBuffer = (*editor.Editor)(nil)` compile check.
- `internal/ui/extui/dialogs.go`: dialog text-entry fields.

## ANTI-PATTERNS

- Feature code with `if raw == "\x1b[A"` or any hardcoded escape sequence. Use `keymap.Matches`.
- `len(line)` for column positions. Use rune index or grapheme width from `textwidth/`.
- `time.Sleep` or polling in tests. Use the `WaitFor*` / `AdvanceDebounce` seams.
- Snapshot acceptance that masks a changed cursor column or cell width. Inspect the cell grid first.
