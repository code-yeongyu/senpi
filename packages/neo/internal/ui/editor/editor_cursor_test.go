package editor

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// Hardware-cursor / IME contract (packages/tui/README.md:187,219): when focused,
// Render emits a zero-width marker at the logical insertion point, and
// ViewCursor reports the terminal cell there so a host can pin the real cursor
// for IME candidate-window placement. These frame tests assert the cursor cell.

func cursorCell(t *testing.T, e *Editor, width int) (int, int, bool) {
	t.Helper()
	rows := e.Render(width)
	c := e.ViewCursor(rows, 0, 0)
	if c == nil {
		return 0, 0, false
	}
	return c.X, c.Y, true
}

func TestCursor_notEmittedWhenUnfocused(t *testing.T) {
	e := newTestEditor(t)
	e.SetFocused(false)
	e.SetText("hello")
	rows := e.Render(40)
	for _, r := range rows {
		if strings.Contains(r, cursorMarker) {
			t.Fatal("unfocused editor must not emit cursor marker")
		}
	}
	if _, _, ok := cursorCell(t, e, 40); ok {
		t.Fatal("ViewCursor should be nil when unfocused")
	}
}

func TestCursor_atInsertionPointAfterAscii(t *testing.T) {
	e := newTestEditor(t)
	e.SetFocused(true)
	typeStr(e, "hello")
	// Cursor at end (col 5) on the single content row (y=1: row 0 is top border).
	x, y, ok := cursorCell(t, e, 40)
	if !ok {
		t.Fatal("expected a cursor")
	}
	if x != 5 || y != 1 {
		t.Fatalf("cursor cell = (%d,%d), want (5,1)", x, y)
	}
}

func TestCursor_tracksCJKColumnWidth(t *testing.T) {
	e := newTestEditor(t)
	e.SetFocused(true)
	// Korean composition target: cursor after two Hangul syllables (each 2 cols).
	e.SetText("한글")
	x, _, ok := cursorCell(t, e, 40)
	if !ok {
		t.Fatal("expected a cursor")
	}
	// "한글" is 4 terminal columns wide, so the insertion cursor sits at col 4.
	if x != 4 {
		t.Fatalf("cursor x = %d, want 4 (한글 is 4 cols)", x)
	}
	if textwidth.Visible("한글") != 4 {
		t.Fatalf("한글 width = %d, want 4", textwidth.Visible("한글"))
	}
}

func TestCursor_tracksMidLineInsertionPoint(t *testing.T) {
	e := newTestEditor(t)
	e.SetFocused(true)
	e.SetText("abcdef")
	e.HandleInput("\x01") // Ctrl+A -> start
	e.HandleInput("\x1b[C")
	e.HandleInput("\x1b[C") // col 2
	x, _, ok := cursorCell(t, e, 40)
	if !ok {
		t.Fatal("expected a cursor")
	}
	if x != 2 {
		t.Fatalf("cursor x = %d, want 2", x)
	}
}

func TestKeyToRaw_mapsCommonKeys(t *testing.T) {
	cases := []struct {
		key  tea.Key
		want string
	}{
		{tea.Key{Code: tea.KeyUp}, "\x1b[A"},
		{tea.Key{Code: tea.KeyLeft, Mod: tea.ModCtrl}, "\x1b[1;5D"},
		{tea.Key{Code: 'w', Mod: tea.ModCtrl}, "\x17"},
		{tea.Key{Code: 'd', Mod: tea.ModAlt}, "\x1bd"},
		{tea.Key{Code: tea.KeyEnter}, "\r"},
		{tea.Key{Code: tea.KeyEnter, Mod: tea.ModShift}, "\x1b[13;2u"},
		{tea.Key{Code: 'a', Text: "a"}, "a"},
	}
	for _, c := range cases {
		if got := KeyToRaw(c.key); got != c.want {
			t.Fatalf("KeyToRaw(%+v) = %q, want %q", c.key, got, c.want)
		}
	}
}

func TestUpdate_pasteMsgIsAtomic(t *testing.T) {
	e := newTestEditor(t)
	big := strings.Repeat("x", 2000)
	e.Update(tea.PasteMsg{Content: big})
	if !markerCharsRe.MatchString(e.GetText()) {
		t.Fatalf("large PasteMsg should create a chars marker, got %q", e.GetText())
	}
	if e.GetExpandedText() != big {
		t.Fatal("PasteMsg content must expand losslessly")
	}
}
