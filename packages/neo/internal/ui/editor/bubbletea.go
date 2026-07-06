package editor

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// KeyToRaw converts a bubbletea v2 KeyPressMsg into the raw terminal byte
// sequence the editor's HandleInput expects. This is the integration seam: the
// editor core stays byte-oriented (so the ported tui contract runs verbatim),
// while bubbletea delivers structured key events. Only the sequences the editor
// acts on are mapped; anything else falls back to the key's text.
func KeyToRaw(k tea.Key) string {
	mod := k.Mod
	ctrl := mod&tea.ModCtrl != 0
	alt := mod&tea.ModAlt != 0
	shift := mod&tea.ModShift != 0

	switch k.Code {
	case tea.KeyUp:
		return "\x1b[A"
	case tea.KeyDown:
		return "\x1b[B"
	case tea.KeyLeft:
		if ctrl {
			return "\x1b[1;5D"
		}
		return "\x1b[D"
	case tea.KeyRight:
		if ctrl {
			return "\x1b[1;5C"
		}
		return "\x1b[C"
	case tea.KeyHome:
		return "\x01"
	case tea.KeyEnd:
		return "\x05"
	case tea.KeyPgUp:
		return "\x1b[5~"
	case tea.KeyPgDown:
		return "\x1b[6~"
	case tea.KeyBackspace:
		return "\x7f"
	case tea.KeyDelete:
		return "\x1b[3~"
	case tea.KeyTab:
		return "\t"
	case tea.KeyEnter:
		if shift {
			return "\x1b[13;2u"
		}
		return "\r"
	case tea.KeyEscape:
		return "\x1b"
	}

	// Control-letter combos (Ctrl+A..Ctrl+Z) map to their control byte.
	if ctrl && !alt && k.Code >= 'a' && k.Code <= 'z' {
		return string(rune(k.Code - 'a' + 1))
	}
	// Alt+letter -> ESC + letter (alt+d, alt+y).
	if alt && !ctrl && k.Code >= 'a' && k.Code <= 'z' {
		return "\x1b" + string(rune(k.Code))
	}
	if k.Text != "" {
		return k.Text
	}
	if k.Code >= 32 {
		return string(k.Code)
	}
	return ""
}

// Update feeds a bubbletea message to the editor, returning it for chaining.
// Handles KeyPressMsg (via KeyToRaw) and PasteMsg (atomic HandlePaste).
func (e *Editor) Update(msg tea.Msg) *Editor {
	switch m := msg.(type) {
	case tea.KeyPressMsg:
		e.HandleInput(KeyToRaw(tea.Key(m)))
	case tea.PasteMsg:
		// bubbletea delivers bracketed paste as one atomic message. Route it
		// through the same path as the raw "\x1b[200~...\x1b[201~" form so the
		// stdin-buffer boundary semantics are equivalent.
		e.handlePasteEntry(m.Content)
	}
	return e
}

// handlePasteEntry runs a paste through the same normalization + marker logic as
// a bracketed-paste sequence (see handlePaste), which is what PasteMsg carries.
func (e *Editor) handlePasteEntry(content string) {
	if content == "" {
		return
	}
	e.handlePaste(content)
}

// ViewCursor returns the hardware-cursor position for the bubbletea View, given
// the editor's rendered rows and the top-left origin (originX, originY) where
// Render's output is placed. It locates the zero-width cursor marker emitted by
// Render (when focused) and reports the terminal cell just after it — the
// logical insertion point the real cursor (and IME candidate window) must track.
// Returns nil when the editor is unfocused or no marker is present.
func (e *Editor) ViewCursor(rows []string, originX, originY int) *tea.Cursor {
	if !e.focused {
		return nil
	}
	for y, row := range rows {
		idx := strings.Index(row, cursorMarker)
		if idx < 0 {
			continue
		}
		before := row[:idx]
		col := textwidth.Visible(before)
		return tea.NewCursor(originX+col, originY+y)
	}
	return nil
}

// StripCursorMarker removes the zero-width hardware-cursor marker from a rendered
// row so it is not written to the screen as literal bytes.
func StripCursorMarker(row string) string {
	return strings.ReplaceAll(row, cursorMarker, "")
}
