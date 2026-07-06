package editor

import "testing"

// Ported from packages/tui/test/editor.test.ts:
//   "public state accessors", "Backslash+Enter newline workaround",
//   "Kitty CSI-u handling", "Unicode text editing behavior".

func TestAccessors_returnsCursorPosition(t *testing.T) {
	e := newTestEditor(t)
	assertCursor(t, e, 0, 0)
	e.HandleInput("a")
	e.HandleInput("b")
	e.HandleInput("c")
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x1b[D")
	assertCursor(t, e, 0, 2)
}

func TestAccessors_returnsLinesAsDefensiveCopy(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("a\nb")
	lines := e.GetLines()
	if len(lines) != 2 || lines[0] != "a" || lines[1] != "b" {
		t.Fatalf("GetLines() = %v, want [a b]", lines)
	}
	lines[0] = "mutated"
	got := e.GetLines()
	if got[0] != "a" || got[1] != "b" {
		t.Fatalf("GetLines() mutated: %v", got)
	}
}

func TestBackslash_insertsImmediately(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\\")
	assertText(t, e, "\\")
}

func TestBackslash_convertsStandaloneToNewlineOnEnter(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\\")
	e.HandleInput("\r")
	assertText(t, e, "\n")
}

func TestBackslash_insertsNormallyWhenFollowedByOtherChars(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\\")
	e.HandleInput("x")
	assertText(t, e, "\\x")
}

func TestBackslash_doesNotTriggerNewlineWhenNotBeforeCursor(t *testing.T) {
	e := newTestEditor(t)
	submitted := false
	e.OnSubmit = func(string) { submitted = true }
	e.HandleInput("\\")
	e.HandleInput("x")
	e.HandleInput("\r")
	if !submitted {
		t.Fatal("expected submit, not newline")
	}
}

func TestBackslash_onlyRemovesOneWhenMultiplePresent(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\\")
	e.HandleInput("\\")
	e.HandleInput("\\")
	assertText(t, e, "\\\\\\")
	e.HandleInput("\r")
	assertText(t, e, "\\\\\n")
}

func TestKittyCSIu_insertsNewlineForShiftEnterWithoutSubmitting(t *testing.T) {
	e := newTestEditor(t)
	submitted := false
	e.OnSubmit = func(string) { submitted = true }
	e.SetText("hello")
	e.HandleInput("\x1b[13;2u")
	assertText(t, e, "hello\n")
	if submitted {
		t.Fatal("should not submit")
	}
}

func TestKittyCSIu_ignoresPrintableWithUnsupportedModifiers(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\x1b[99;9u")
	assertText(t, e, "")
}

func TestKittyCSIu_insertsShiftedCSIuLettersAsText(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\x1b[69;2u")
	assertText(t, e, "E")
}

func TestKittyCSIu_insertsShiftedModifyOtherKeysLettersAsText(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\x1b[27;2;69~")
	assertText(t, e, "E")
}

func TestUnicode_insertsMixedAsciiUmlautsEmojis(t *testing.T) {
	e := newTestEditor(t)
	for _, ch := range []string{"H", "e", "l", "l", "o", " ", "ä", "ö", "ü", " ", "😀"} {
		e.HandleInput(ch)
	}
	assertText(t, e, "Hello äöü 😀")
}

func TestUnicode_deletesSingleCodeUnitUmlautsWithBackspace(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("ä")
	e.HandleInput("ö")
	e.HandleInput("ü")
	e.HandleInput("\x7f")
	assertText(t, e, "äö")
}

func TestUnicode_deletesMultiCodeUnitEmojisWithSingleBackspace(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("😀")
	e.HandleInput("👍")
	e.HandleInput("\x7f")
	assertText(t, e, "😀")
}

func TestUnicode_insertsAtCorrectPositionAfterCursorMovementOverUmlauts(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("ä")
	e.HandleInput("ö")
	e.HandleInput("ü")
	e.HandleInput("\x1b[D")
	e.HandleInput("\x1b[D")
	e.HandleInput("x")
	assertText(t, e, "äxöü")
}

func TestUnicode_movesCursorAcrossEmojisWithSingleArrow(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("😀")
	e.HandleInput("👍")
	e.HandleInput("🎉")
	e.HandleInput("\x1b[D")
	e.HandleInput("\x1b[D")
	e.HandleInput("x")
	assertText(t, e, "😀x👍🎉")
}

func TestUnicode_preservesUmlautsAcrossLineBreaks(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("ä")
	e.HandleInput("ö")
	e.HandleInput("ü")
	e.HandleInput("\n")
	e.HandleInput("Ä")
	e.HandleInput("Ö")
	e.HandleInput("Ü")
	assertText(t, e, "äöü\nÄÖÜ")
}

func TestUnicode_replacesDocumentViaSetText(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("Hällö Wörld! 😀 äöüÄÖÜß")
	assertText(t, e, "Hällö Wörld! 😀 äöüÄÖÜß")
}

func TestUnicode_movesToDocStartOnCtrlAAndInsertsAtBeginning(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("a")
	e.HandleInput("b")
	e.HandleInput("\x01") // Ctrl+A
	e.HandleInput("x")
	assertText(t, e, "xab")
}

func TestUnicode_deletesWordsWithCtrlWAndAltBackspace(t *testing.T) {
	e := newTestEditor(t)

	e.SetText("foo bar baz")
	e.HandleInput("\x17")
	assertText(t, e, "foo bar ")

	e.SetText("foo bar   ")
	e.HandleInput("\x17")
	assertText(t, e, "foo ")

	e.SetText("foo bar...")
	e.HandleInput("\x17")
	assertText(t, e, "foo bar")

	e.SetText("foo.bar")
	e.HandleInput("\x17")
	assertText(t, e, "foo.")

	e.SetText("foo:bar")
	e.HandleInput("\x17")
	assertText(t, e, "foo:")

	e.SetText("line one\nline two")
	e.HandleInput("\x17")
	assertText(t, e, "line one\nline ")

	e.SetText("line one\n")
	e.HandleInput("\x17")
	assertText(t, e, "line one")

	e.SetText("foo 😀😀 bar")
	e.HandleInput("\x17")
	assertText(t, e, "foo 😀😀 ")
	e.HandleInput("\x17")
	assertText(t, e, "foo ")

	e.SetText("foo bar")
	e.HandleInput("\x1b\x7f") // Alt+Backspace (legacy)
	assertText(t, e, "foo ")
}

func TestUnicode_navigatesWordsWithCtrlLeftRight(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("foo bar... baz")

	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 11)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 7)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 4)

	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 7)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 10)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 14)

	e.SetText("   foo bar")
	e.HandleInput("\x01")
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 6)

	e.SetText("foo.bar baz")
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 8)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 4)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 3)

	e.HandleInput("\x01")
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 4)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 7)
}

func TestUnicode_stopsAtFullwidthChinesePunctuation(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("你好，世界")

	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 2)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 0)

	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 2)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 5)
}

func TestUnicode_handlesMixedCJKAndAsciiWordMovement(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello你好，world世界")

	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 13)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 8)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 7)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 5)
	e.HandleInput("\x1b[1;5D")
	assertCursor(t, e, 0, 0)

	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 5)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 7)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 8)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 13)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 15)
}
