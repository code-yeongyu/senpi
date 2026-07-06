package overlays

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// textinput.go is the lightweight single-line search input the filtering overlays
// (model selector, session picker) embed. It is grapheme-safe (multi-byte / CJK /
// emoji move as single clusters) and exposes CursorCol — the visible-width column
// of the insertion point — so the app shell can place the REAL terminal cursor
// there, satisfying the task-5 hardware-cursor/IME contract (CJK candidate
// windows anchor at the logical insertion point). The full editor is used for the
// prompt; overlays need only this reduced input, mirroring the classic Input
// component the selectors embed.

// textInput is a single-line grapheme-cluster text buffer with a cursor.
type textInput struct {
	graphemes []string // one entry per grapheme cluster
	cursor    int      // insertion index in [0,len(graphemes)]
}

// newTextInput builds an empty input.
func newTextInput() *textInput { return &textInput{} }

// SetValue replaces the buffer and puts the cursor at the end.
func (in *textInput) SetValue(s string) {
	in.graphemes = clustersOf(s)
	in.cursor = len(in.graphemes)
}

// Value returns the current text.
func (in *textInput) Value() string { return strings.Join(in.graphemes, "") }

// CursorCol returns the visible-width column of the insertion point — where the
// hardware cursor must sit for correct IME candidate-window anchoring.
func (in *textInput) CursorCol() int {
	return textwidth.Visible(strings.Join(in.graphemes[:in.cursor], ""))
}

// clustersOf splits a string into grapheme clusters via textwidth.Graphemes so
// composed characters (한글 syllables, emoji ZWJ sequences) stay atomic.
func clustersOf(s string) []string {
	gs := textwidth.Graphemes(s)
	out := make([]string, 0, len(gs))
	for _, g := range gs {
		out = append(out, g.Text)
	}
	return out
}

// handleKey processes editing keys resolved through the keybinding manager. It
// returns changed=true when the buffer changed (so the caller re-filters).
// Printable input (single grapheme, no control bytes) inserts at the cursor.
func (in *textInput) handleKey(data string, kb *keybindings.Manager) (changed bool) {
	switch {
	case kb.Matches(data, "tui.editor.cursorLeft"):
		if in.cursor > 0 {
			in.cursor--
		}
		return false
	case kb.Matches(data, "tui.editor.cursorRight"):
		if in.cursor < len(in.graphemes) {
			in.cursor++
		}
		return false
	case kb.Matches(data, "tui.editor.cursorLineStart"):
		in.cursor = 0
		return false
	case kb.Matches(data, "tui.editor.cursorLineEnd"):
		in.cursor = len(in.graphemes)
		return false
	case kb.Matches(data, "tui.editor.deleteCharBackward"):
		if in.cursor > 0 {
			in.graphemes = append(in.graphemes[:in.cursor-1], in.graphemes[in.cursor:]...)
			in.cursor--
			return true
		}
		return false
	case kb.Matches(data, "tui.editor.deleteCharForward"):
		if in.cursor < len(in.graphemes) {
			in.graphemes = append(in.graphemes[:in.cursor], in.graphemes[in.cursor+1:]...)
			return true
		}
		return false
	}
	// Printable insertion: accept data that is not a control sequence.
	if isPrintableInput(data) {
		clusters := clustersOf(data)
		in.graphemes = append(in.graphemes[:in.cursor], append(clusters, in.graphemes[in.cursor:]...)...)
		in.cursor += len(clusters)
		return true
	}
	return false
}

// isPrintableInput reports whether data is ordinary text to insert (no ESC/CSI,
// no bare control byte). Multi-byte UTF-8 (CJK/emoji) is printable.
func isPrintableInput(data string) bool {
	if data == "" {
		return false
	}
	for _, b := range []byte(data) {
		if b == 0x1b { // ESC — control sequence
			return false
		}
		if b < 0x20 && b != 0x09 { // control byte other than TAB
			return false
		}
	}
	return true
}
