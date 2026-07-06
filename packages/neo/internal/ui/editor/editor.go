// Package editor implements the neo multiline editor: a contract-faithful Go
// port of packages/tui/src/components/editor.ts. It provides snapshot undo with
// insert-run coalescing, an Emacs kill-ring (ctrl+w/u/k accumulation, ctrl+y
// yank, alt+y yank-pop, alt+d), prompt-history navigation preserving the draft,
// atomic bracketed-paste with CRLF normalization and large-paste markers,
// grapheme-safe movement/width via uniseg (CJK/Thai/Lao/emoji), UAX-29 word
// navigation, an autocomplete provider hook with debounce and force-file mode,
// and a placeholder. Every key resolves through a Keymap (no hardcoded key
// checks). Render() positions a fake reverse-video cursor; Cursor() exposes the
// logical insertion point so the bubbletea View can pin the hardware cursor at
// it for IME candidate-window placement.
package editor

import "sync"

type lastActionKind int

const (
	actionNone lastActionKind = iota
	actionKill
	actionYank
	actionTypeWord
)

type jumpDir int

const (
	jumpNone jumpDir = iota
	jumpForward
	jumpBackward
)

// Options configures a new Editor.
type Options struct {
	// PaddingX is the horizontal content padding in columns (clamped >= 0).
	PaddingX int
	// AutocompleteMaxVisible is the max rows in the autocomplete popup (3..20).
	AutocompleteMaxVisible int
	// Keymap resolves key sequences to actions; defaults to DefaultKeymap().
	Keymap Keymap
}

// Editor is the stateful multiline editor component.
type Editor struct {
	state    editorState
	keymap   Keymap
	focused  bool
	paddingX int

	cols int // terminal columns (viewport width)
	rows int // terminal rows (drives max-visible-lines)

	lastWidth   int // last render layout width (for cursor navigation)
	scrollOff   int
	placeholder string

	// Autocomplete
	provider          AutocompleteProvider
	triggerChars      []string
	acList            *acPopup
	acState           acStateKind
	acPrefix          string
	acMaxVisible      int
	pendingDebounce   bool
	pendingDebounceFn func()

	// In-flight async autocomplete request (context-aware providers). Mirrors the
	// tui AbortController: cancelAutocompleteRequest cancels the current context so
	// a new keystroke aborts the request the provider is still resolving. Sync
	// providers never populate these fields (they resolve inline).
	acInflight   *acRequest
	acRequestGen uint64
	acWG         sync.WaitGroup

	// Large-paste tracking
	pastes       map[int]string
	pasteCounter int

	// Bracketed-paste accumulation
	pasteActive bool
	pasteBuffer string

	// Prompt history
	history      []string
	historyIndex int // -1 = not browsing
	historyDraft *editorState

	// Kill ring
	killRing   killRing
	lastAction lastActionKind

	// Character jump
	jumpMode jumpDir

	// Sticky column for vertical movement
	preferredVisualCol *int
	snappedFromCol     *int

	// Undo
	undo undoStack

	// Callbacks
	OnSubmit func(text string)
	OnChange func(text string)

	DisableSubmit bool
}

// New constructs an Editor with the given options.
func New(opts Options) *Editor {
	km := opts.Keymap
	if km == nil {
		km = DefaultKeymap()
	}
	maxVisible := opts.AutocompleteMaxVisible
	if maxVisible == 0 {
		maxVisible = 5
	}
	if maxVisible < 3 {
		maxVisible = 3
	}
	if maxVisible > 20 {
		maxVisible = 20
	}
	px := opts.PaddingX
	if px < 0 {
		px = 0
	}
	e := &Editor{
		state:        editorState{lines: []string{""}, cursorLine: 0, cursorCol: 0},
		keymap:       km,
		paddingX:     px,
		cols:         80,
		rows:         24,
		lastWidth:    80,
		historyIndex: -1,
		acMaxVisible: maxVisible,
		pastes:       map[int]string{},
		triggerChars: append([]string(nil), defaultTriggerChars...),
	}
	return e
}

// SetViewport records the terminal size. rows drives the editor's max-visible-
// lines math (30% of rows, min 5); cols is the default render width.
func (e *Editor) SetViewport(cols, rows int) {
	if cols > 0 {
		e.cols = cols
	}
	if rows > 0 {
		e.rows = rows
	}
}

// SetFocused marks the editor focused; when focused Render emits a hardware-
// cursor marker for IME positioning.
func (e *Editor) SetFocused(v bool) { e.focused = v }

// Focused reports the focus state.
func (e *Editor) Focused() bool { return e.focused }

// SetPlaceholder sets text shown when the editor is empty.
func (e *Editor) SetPlaceholder(s string) { e.placeholder = s }

// GetText returns the document with lines joined by "\n" (markers unexpanded).
func (e *Editor) GetText() string { return joinLines(e.state.lines) }

// GetLines returns a defensive copy of the logical lines.
func (e *Editor) GetLines() []string {
	out := make([]string, len(e.state.lines))
	copy(out, e.state.lines)
	return out
}

// Cursor returns the logical insertion point (line index, rune column). This is
// the position the hardware cursor must track for IME candidate placement.
func (e *Editor) Cursor() (line, col int) {
	return e.state.cursorLine, e.state.cursorCol
}

// GetExpandedText returns the document with paste markers expanded to content.
func (e *Editor) GetExpandedText() string {
	return e.expandPasteMarkers(joinLines(e.state.lines))
}

// AddToHistory records a submitted prompt for up/down navigation.
func (e *Editor) AddToHistory(text string) {
	trimmed := trimSpace(text)
	if trimmed == "" {
		return
	}
	if len(e.history) > 0 && e.history[0] == trimmed {
		return
	}
	e.history = append([]string{trimmed}, e.history...)
	if len(e.history) > 100 {
		e.history = e.history[:100]
	}
}

// SetText replaces the document, normalizing line endings/tabs, resetting
// history browsing, and pushing an undo snapshot when content changes.
func (e *Editor) SetText(text string) {
	e.cancelAutocomplete()
	e.lastAction = actionNone
	e.exitHistoryBrowsing()
	normalized := normalizeText(text)
	if e.GetText() != normalized {
		e.pushUndo()
	}
	e.setTextInternal(normalized, placeEnd)
}

// InsertTextAtCursor inserts text at the cursor atomically (single undo).
func (e *Editor) InsertTextAtCursor(text string) {
	if text == "" {
		return
	}
	e.cancelAutocomplete()
	e.pushUndo()
	e.lastAction = actionNone
	e.exitHistoryBrowsing()
	e.insertTextAtCursorInternal(text)
}

func (e *Editor) emitChange() {
	if e.OnChange != nil {
		e.OnChange(e.GetText())
	}
}

func (e *Editor) pushUndo() { e.undo.push(e.state) }

// curLine returns the current cursor line, or "" if out of range.
func (e *Editor) curLine() string {
	if e.state.cursorLine < 0 || e.state.cursorLine >= len(e.state.lines) {
		return ""
	}
	return e.state.lines[e.state.cursorLine]
}

// setCursorCol sets the cursor column and clears sticky-column state (used for
// all non-vertical cursor movements).
func (e *Editor) setCursorCol(col int) {
	e.state.cursorCol = col
	e.preferredVisualCol = nil
	e.snappedFromCol = nil
}
