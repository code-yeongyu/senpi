package editor

import "testing"

// Ported from packages/tui/test/editor.test.ts > "Kill ring".

func TestKill_CtrlWSavesAndCtrlYYanks(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("foo bar baz")
	e.HandleInput("\x17")
	assertText(t, e, "foo bar ")
	e.HandleInput("\x01")
	e.HandleInput("\x19")
	assertText(t, e, "bazfoo bar ")
}

func TestKill_CtrlUSavesToKillRing(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x15")
	assertText(t, e, "world")
	e.HandleInput("\x19")
	assertText(t, e, "hello world")
}

func TestKill_CtrlKSavesToKillRing(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	e.HandleInput("\x0b")
	assertText(t, e, "")
	e.HandleInput("\x19")
	assertText(t, e, "hello world")
}

func TestKill_CtrlYDoesNothingWhenEmpty(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("test")
	e.HandleInput("\x19")
	assertText(t, e, "test")
}

func TestKill_AltYCyclesThroughKillRingAfterCtrlY(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("first")
	e.HandleInput("\x17")
	e.SetText("second")
	e.HandleInput("\x17")
	e.SetText("third")
	e.HandleInput("\x17")
	assertText(t, e, "")
	e.HandleInput("\x19")
	assertText(t, e, "third")
	e.HandleInput("\x1by")
	assertText(t, e, "second")
	e.HandleInput("\x1by")
	assertText(t, e, "first")
	e.HandleInput("\x1by")
	assertText(t, e, "third")
}

func TestKill_AltYDoesNothingIfNotPrecededByYank(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("test")
	e.HandleInput("\x17")
	e.SetText("other")
	e.HandleInput("x")
	assertText(t, e, "otherx")
	e.HandleInput("\x1by")
	assertText(t, e, "otherx")
}

func TestKill_AltYDoesNothingIfKillRingHasLEQ1Entry(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("only")
	e.HandleInput("\x17")
	e.HandleInput("\x19")
	assertText(t, e, "only")
	e.HandleInput("\x1by")
	assertText(t, e, "only")
}

func TestKill_ConsecutiveCtrlWAccumulatesIntoOneEntry(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("one two three")
	e.HandleInput("\x17")
	e.HandleInput("\x17")
	e.HandleInput("\x17")
	assertText(t, e, "")
	e.HandleInput("\x19")
	assertText(t, e, "one two three")
}

func TestKill_CtrlUAccumulatesMultilineDeletesIncludingNewlines(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("line1\nline2\nline3")
	e.HandleInput("\x15")
	assertText(t, e, "line1\nline2\n")
	e.HandleInput("\x15")
	assertText(t, e, "line1\nline2")
	e.HandleInput("\x15")
	assertText(t, e, "line1\n")
	e.HandleInput("\x15")
	assertText(t, e, "line1")
	e.HandleInput("\x15")
	assertText(t, e, "")
	e.HandleInput("\x19")
	assertText(t, e, "line1\nline2\nline3")
}

func TestKill_BackwardDeletionsPrependForwardAppend(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("prefix|suffix")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x0b") // Ctrl+K deletes "suffix" (forward)
	e.HandleInput("\x0b") // Ctrl+K deletes "|" (forward, appended)
	assertText(t, e, "prefix")
	e.HandleInput("\x19")
	assertText(t, e, "prefix|suffix")
}

func TestKill_NonDeleteActionsBreakKillAccumulation(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("foo bar baz")
	e.HandleInput("\x17")
	assertText(t, e, "foo bar ")
	e.HandleInput("x")
	assertText(t, e, "foo bar x")
	e.HandleInput("\x17")
	assertText(t, e, "foo bar ")
	e.HandleInput("\x19")
	assertText(t, e, "foo bar x")
	e.HandleInput("\x1by")
	assertText(t, e, "foo bar baz")
}

func TestKill_NonYankActionsBreakAltYChain(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("first")
	e.HandleInput("\x17")
	e.SetText("second")
	e.HandleInput("\x17")
	e.SetText("")
	e.HandleInput("\x19")
	assertText(t, e, "second")
	e.HandleInput("x")
	assertText(t, e, "secondx")
	e.HandleInput("\x1by")
	assertText(t, e, "secondx")
}

func TestKill_RotationPersistsAfterCycling(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("first")
	e.HandleInput("\x17")
	e.SetText("second")
	e.HandleInput("\x17")
	e.SetText("third")
	e.HandleInput("\x17")
	e.SetText("")
	e.HandleInput("\x19")
	e.HandleInput("\x1by")
	assertText(t, e, "second")
	e.HandleInput("x")
	e.SetText("")
	e.HandleInput("\x19")
	assertText(t, e, "second")
}

func TestKill_ConsecutiveDeletionsAcrossLinesCoalesce(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("1\n2\n3")
	e.HandleInput("\x17")
	assertText(t, e, "1\n2\n")
	e.HandleInput("\x17")
	assertText(t, e, "1\n2")
	e.HandleInput("\x17")
	assertText(t, e, "1\n")
	e.HandleInput("\x17")
	assertText(t, e, "1")
	e.HandleInput("\x17")
	assertText(t, e, "")
	e.HandleInput("\x19")
	assertText(t, e, "1\n2\n3")
}

func TestKill_CtrlKAtLineEndDeletesNewlineAndCoalesces(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("")
	e.HandleInput("a")
	e.HandleInput("b")
	e.HandleInput("\n")
	e.HandleInput("c")
	e.HandleInput("d")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x05") // Ctrl+E
	e.HandleInput("\x0b") // Ctrl+K deletes newline
	assertText(t, e, "abcd")
	e.HandleInput("\x0b")
	assertText(t, e, "ab")
	e.HandleInput("\x19")
	assertText(t, e, "ab\ncd")
}

func TestKill_HandlesYankInMiddleOfText(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("word")
	e.HandleInput("\x17")
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x19")
	assertText(t, e, "hello wordworld")
}

func TestKill_HandlesYankPopInMiddleOfText(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("FIRST")
	e.HandleInput("\x17")
	e.SetText("SECOND")
	e.HandleInput("\x17")
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x19")
	assertText(t, e, "hello SECONDworld")
	e.HandleInput("\x1by")
	assertText(t, e, "hello FIRSTworld")
}

func TestKill_MultilineYankAndYankPopInMiddleOfText(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("SINGLE")
	e.HandleInput("\x17")
	e.SetText("A\nB")
	e.HandleInput("\x15")
	e.HandleInput("\x15")
	e.HandleInput("\x15")
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x19")
	assertText(t, e, "hello A\nBworld")
	e.HandleInput("\x1by")
	assertText(t, e, "hello SINGLEworld")
}

func TestKill_AltDDeletesWordForwardAndSavesToKillRing(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world test")
	e.HandleInput("\x01")
	e.HandleInput("\x1bd")
	assertText(t, e, " world test")
	e.HandleInput("\x1bd")
	assertText(t, e, " test")
	e.HandleInput("\x19")
	assertText(t, e, "hello world test")
}

func TestKill_AltDAtEndOfLineDeletesNewline(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("line1\nline2")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x05")
	e.HandleInput("\x1bd")
	assertText(t, e, "line1line2")
	e.HandleInput("\x19")
	assertText(t, e, "line1\nline2")
}
