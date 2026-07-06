package editor

import "testing"

// Ported from packages/tui/test/editor.test.ts > "Sticky column".

// positionCursor mirrors the tui helper: go to line 0, then down to target
// line, then Ctrl+A and right to target col.
func positionCursor(e *Editor, line, col int) {
	for i := 0; i < 20; i++ {
		e.HandleInput("\x1b[A")
	}
	for i := 0; i < line; i++ {
		e.HandleInput("\x1b[B")
	}
	e.HandleInput("\x01")
	for i := 0; i < col; i++ {
		e.HandleInput("\x1b[C")
	}
}

func TestSticky_preservesTargetColumnMovingUpThroughShorterLine(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("2222222222x222\n\n1111111111_111111111111")
	assertCursor(t, e, 2, 23)
	e.HandleInput("\x01")
	for i := 0; i < 10; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 2, 10)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 1, 0)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 10)
}

func TestSticky_preservesTargetColumnMovingDownThroughShorterLine(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1111111111_111\n\n2222222222x222222222222")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	for i := 0; i < 10; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 10)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 0)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 10)
}

func TestSticky_resetsOnLeftArrow(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 2, 5)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 5)
	e.HandleInput("\x1b[D")
	assertCursor(t, e, 0, 4)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 4)
}

func TestSticky_resetsOnRightArrow(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 5)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 5)
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 2, 6)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 6)
}

func TestSticky_resetsOnTyping(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 8; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 8)
	e.HandleInput("X")
	assertCursor(t, e, 0, 9)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 9)
}

func TestSticky_resetsOnBackspace(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 8; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 8)
	e.HandleInput("\x7f")
	assertCursor(t, e, 0, 7)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 7)
}

func TestSticky_resetsOnCtrlA(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 8; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	assertCursor(t, e, 1, 0)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 0)
}

func TestSticky_resetsOnCtrlE(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("12345\n\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 3; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x05")
	assertCursor(t, e, 0, 5)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 5)
}

func TestSticky_resetsOnCtrlLeft(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world\n\nhello world")
	assertCursor(t, e, 2, 11)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 11)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 6)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 6)
}

func TestSticky_resetsOnCtrlRight(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world\n\nhello world")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 0)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 2, 5)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 5)
}

func TestSticky_resetsOnUndo(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	for i := 0; i < 8; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 8)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 8)
	e.HandleInput("X")
	assertText(t, e, "1234567890\n\n12345678X90")
	assertCursor(t, e, 2, 9)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 9)
	e.HandleInput(undoKey)
	assertText(t, e, "1234567890\n\n1234567890")
	assertCursor(t, e, 2, 8)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 8)
}

func TestSticky_handlesMultipleConsecutiveUpDownMovements(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\nab\ncd\nef\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 7; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 4, 7)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 7)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 4, 7)
}

func TestSticky_movesCorrectlyThroughWrappedVisualLinesWithoutStuck(t *testing.T) {
	e := newTestEditorSized(t, 15, 24)
	e.SetText("short\n123456789012345678901234567890")
	e.Render(15)
	assertCursor(t, e, 1, 30)
	e.HandleInput("\x1b[A")
	if l, _ := e.Cursor(); l != 1 {
		t.Fatalf("line = %d, want 1", l)
	}
	e.HandleInput("\x1b[A")
	if l, _ := e.Cursor(); l != 1 {
		t.Fatalf("line = %d, want 1", l)
	}
	e.HandleInput("\x1b[A")
	if l, _ := e.Cursor(); l != 0 {
		t.Fatalf("line = %d, want 0", l)
	}
}

func TestSticky_handlesSetTextResettingStickyColumn(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1234567890\n\n1234567890")
	e.HandleInput("\x01")
	for i := 0; i < 8; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[A")
	e.SetText("abcdefghij\n\nabcdefghij")
	assertCursor(t, e, 2, 10)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 10)
}

func TestSticky_setsPreferredVisualColWhenPressingRightAtEndOfPrompt(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("111111111x1111111111\n\n333333333_")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x05")
	assertCursor(t, e, 0, 20)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 10)
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 2, 10)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 10)
}

func TestSticky_handlesResizesWhenPreferredOnSameLine(t *testing.T) {
	e := newTestEditorSized(t, 80, 24)
	e.SetText("12345678901234567890\n\n12345678901234567890")
	e.HandleInput("\x01")
	for i := 0; i < 15; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 15)
	e.Render(12)
	e.HandleInput("\x1b[B")
	e.HandleInput("\x1b[B")
	if _, c := e.Cursor(); c != 4 {
		t.Fatalf("col = %d, want 4", c)
	}
}

func TestSticky_handlesResizesWhenPreferredOnDifferentLine(t *testing.T) {
	e := newTestEditorSized(t, 80, 24)
	e.SetText("short\n12345678901234567890")
	e.HandleInput("\x01")
	for i := 0; i < 15; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 1, 15)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 5)
	e.Render(10)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 8)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 5)
	e.Render(80)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 15)
}

func TestSticky_rewrappedLinesTargetFitsCurrentVisualColumn(t *testing.T) {
	e := newTestEditorSized(t, 80, 24)
	e.SetText("abcdefghijklmnopqr\n123456789012345678")
	positionCursor(e, 0, 18)
	assertCursor(t, e, 0, 18)
	e.Render(10)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 8)
	e.Render(80)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 8)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 8)
}

func TestSticky_rewrappedLinesTargetShorterThanCurrentVisualColumn(t *testing.T) {
	e := newTestEditorSized(t, 80, 24)
	e.SetText("abcdefghijklmnopqr\n123456789012345678\nab")
	positionCursor(e, 0, 18)
	assertCursor(t, e, 0, 18)
	e.Render(10)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 8)
	e.Render(80)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 2)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 1, 8)
}
