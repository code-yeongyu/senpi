package editor

import "testing"

// Ported from packages/tui/test/editor.test.ts > "Character jump (Ctrl+])".
// Ctrl+] legacy sequence is "\x1d"; backward is ESC + Ctrl+] = "\x1b\x1d".

func TestJump_forwardToFirstOccurrenceOnSameLine(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("o")
	assertCursor(t, e, 0, 4)
}

func TestJump_forwardToNextOccurrenceAfterCursor(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 4; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 4)
	e.HandleInput("\x1d")
	e.HandleInput("o")
	assertCursor(t, e, 0, 7)
}

func TestJump_forwardAcrossMultipleLines(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("abc\ndef\nghi")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("g")
	assertCursor(t, e, 2, 0)
}

func TestJump_backwardToFirstOccurrenceBeforeCursorOnSameLine(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	assertCursor(t, e, 0, 11)
	e.HandleInput("\x1b\x1d")
	e.HandleInput("o")
	assertCursor(t, e, 0, 7)
}

func TestJump_backwardAcrossMultipleLines(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("abc\ndef\nghi")
	assertCursor(t, e, 2, 3)
	e.HandleInput("\x1b\x1d")
	e.HandleInput("a")
	assertCursor(t, e, 0, 0)
}

func TestJump_doesNothingWhenCharNotFoundForward(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("z")
	assertCursor(t, e, 0, 0)
}

func TestJump_doesNothingWhenCharNotFoundBackward(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	assertCursor(t, e, 0, 11)
	e.HandleInput("\x1b\x1d")
	e.HandleInput("z")
	assertCursor(t, e, 0, 11)
}

func TestJump_isCaseSensitive(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("Hello World")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("h")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("W")
	assertCursor(t, e, 0, 6)
}

func TestJump_cancelsWhenCtrlBracketPressedAgain(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("\x1d")
	e.HandleInput("o")
	assertText(t, e, "ohello world")
}

func TestJump_cancelsOnEscapeAndProcessesEscape(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("\x1b")
	assertCursor(t, e, 0, 0)
	e.HandleInput("o")
	assertText(t, e, "ohello world")
}

func TestJump_cancelsBackwardWhenCtrlAltBracketPressedAgain(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	assertCursor(t, e, 0, 11)
	e.HandleInput("\x1b\x1d")
	e.HandleInput("\x1b\x1d")
	e.HandleInput("o")
	assertText(t, e, "hello worldo")
}

func TestJump_searchesForSpecialCharacters(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("foo(bar) = baz;")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("(")
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x1d")
	e.HandleInput("=")
	assertCursor(t, e, 0, 9)
}

func TestJump_handlesEmptyTextGracefully(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1d")
	e.HandleInput("x")
	assertCursor(t, e, 0, 0)
}

func TestJump_resetsLastActionWhenJumping(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	e.HandleInput("x")
	assertText(t, e, "xhello world")
	e.HandleInput("\x1d")
	e.HandleInput("o")
	e.HandleInput("Y")
	assertText(t, e, "xhellYo world")
	e.HandleInput(undoKey)
	assertText(t, e, "xhello world")
}
