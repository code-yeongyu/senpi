package editor

import "testing"

// Ported from packages/tui/test/editor.test.ts > "Undo".
// Undo is Ctrl+- delivered as Kitty CSI-u "\x1b[45;5u".

const undoKey = "\x1b[45;5u"

func typeStr(e *Editor, s string) {
	for _, ch := range s {
		e.HandleInput(string(ch))
	}
}

func TestUndo_doesNothingWhenStackEmpty(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput(undoKey)
	assertText(t, e, "")
}

func TestUndo_coalescesConsecutiveWordCharsIntoOneUnit(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello world")
	assertText(t, e, "hello world")
	e.HandleInput(undoKey)
	assertText(t, e, "hello")
	e.HandleInput(undoKey)
	assertText(t, e, "")
}

func TestUndo_undoesSpacesOneAtATime(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello  ")
	assertText(t, e, "hello  ")
	e.HandleInput(undoKey)
	assertText(t, e, "hello ")
	e.HandleInput(undoKey)
	assertText(t, e, "hello")
	e.HandleInput(undoKey)
	assertText(t, e, "")
}

func TestUndo_undoesNewlinesAndSignalsNextWordToCaptureState(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello")
	e.HandleInput("\n")
	typeStr(e, "world")
	assertText(t, e, "hello\nworld")
	e.HandleInput(undoKey)
	assertText(t, e, "hello\n")
	e.HandleInput(undoKey)
	assertText(t, e, "hello")
	e.HandleInput(undoKey)
	assertText(t, e, "")
}

func TestUndo_undoesBackspace(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello")
	e.HandleInput("\x7f")
	assertText(t, e, "hell")
	e.HandleInput(undoKey)
	assertText(t, e, "hello")
}

func TestUndo_undoesForwardDelete(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello")
	e.HandleInput("\x01")
	e.HandleInput("\x1b[C")
	e.HandleInput("\x1b[3~")
	assertText(t, e, "hllo")
	e.HandleInput(undoKey)
	assertText(t, e, "hello")
}

func TestUndo_undoesCtrlW(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello world")
	assertText(t, e, "hello world")
	e.HandleInput("\x17")
	assertText(t, e, "hello ")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
}

func TestUndo_undoesCtrlK(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello world")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x0b")
	assertText(t, e, "hello ")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
	e.HandleInput("|")
	assertText(t, e, "hello |world")
}

func TestUndo_undoesCtrlU(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello world")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x15")
	assertText(t, e, "world")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
}

func TestUndo_undoesYank(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello ")
	e.HandleInput("\x17")
	e.HandleInput("\x19")
	assertText(t, e, "hello ")
	e.HandleInput(undoKey)
	assertText(t, e, "")
}

func TestUndo_undoesSingleLinePasteAtomically(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[200~beep boop\x1b[201~")
	assertText(t, e, "hellobeep boop world")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
	e.HandleInput("|")
	assertText(t, e, "hello| world")
}

func TestUndo_doesNotTriggerAutocompleteDuringSingleLinePaste(t *testing.T) {
	e := newTestEditor(t)
	calls := 0
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			calls++
			return nil, nil
		},
	})
	e.HandleInput("\x1b[200~look at @node_modules/react/index.js please\x1b[201~")
	assertText(t, e, "look at @node_modules/react/index.js please")
	if calls != 0 {
		t.Fatalf("suggestionCalls = %d, want 0", calls)
	}
	if e.IsShowingAutocomplete() {
		t.Fatal("autocomplete should not be showing")
	}
}

func TestUndo_decodesCSIuCtrlLetterSequencesInsidePaste(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\x1b[200~line1\x1b[106;5uline2\x1b[106;5uline3\x1b[201~")
	assertText(t, e, "line1\nline2\nline3")
}

func TestUndo_undoesMultiLinePasteAtomically(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[C")
	}
	e.HandleInput("\x1b[200~line1\nline2\nline3\x1b[201~")
	assertText(t, e, "helloline1\nline2\nline3 world")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
	e.HandleInput("|")
	assertText(t, e, "hello| world")
}

func TestUndo_undoesInsertTextAtCursorAtomically(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[C")
	}
	e.InsertTextAtCursor("/tmp/image.png")
	assertText(t, e, "hello/tmp/image.png world")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
	e.HandleInput("|")
	assertText(t, e, "hello| world")
}

func TestUndo_insertTextAtCursorHandlesMultiline(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("hello world")
	e.HandleInput("\x01")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[C")
	}
	e.InsertTextAtCursor("line1\nline2\nline3")
	assertText(t, e, "helloline1\nline2\nline3 world")
	assertCursor(t, e, 2, 5)
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
}

func TestUndo_insertTextAtCursorNormalizesCRLFAndCR(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("")
	e.InsertTextAtCursor("a\r\nb\r\nc")
	assertText(t, e, "a\nb\nc")
	e.HandleInput(undoKey)
	assertText(t, e, "")
	e.InsertTextAtCursor("x\ry\rz")
	assertText(t, e, "x\ny\nz")
}

func TestUndo_undoesSetTextToEmptyString(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello world")
	assertText(t, e, "hello world")
	e.SetText("")
	assertText(t, e, "")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
}

func TestUndo_clearsUndoStackOnSubmit(t *testing.T) {
	e := newTestEditor(t)
	submitted := ""
	e.OnSubmit = func(text string) { submitted = text }
	typeStr(e, "hello")
	e.HandleInput("\r")
	if submitted != "hello" {
		t.Fatalf("submitted = %q, want hello", submitted)
	}
	assertText(t, e, "")
	e.HandleInput(undoKey)
	assertText(t, e, "")
}

func TestUndo_exitsHistoryBrowsingModeOnUndo(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("hello")
	assertText(t, e, "")
	typeStr(e, "world")
	assertText(t, e, "world")
	e.HandleInput("\x17")
	assertText(t, e, "")
	e.HandleInput("\x1b[A")
	assertText(t, e, "hello")
	e.HandleInput(undoKey)
	assertText(t, e, "")
	e.HandleInput(undoKey)
	assertText(t, e, "world")
}

func TestUndo_restoresToPreHistoryStateAfterMultipleNavigations(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("first")
	e.AddToHistory("second")
	e.AddToHistory("third")
	typeStr(e, "current")
	assertText(t, e, "current")
	e.HandleInput("\x17")
	assertText(t, e, "")
	e.HandleInput("\x1b[A")
	assertText(t, e, "third")
	e.HandleInput("\x1b[A")
	assertText(t, e, "second")
	e.HandleInput("\x1b[A")
	assertText(t, e, "first")
	e.HandleInput(undoKey)
	assertText(t, e, "")
	e.HandleInput(undoKey)
	assertText(t, e, "current")
}

func TestUndo_cursorMovementStartsNewUndoUnit(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello world")
	assertText(t, e, "hello world")
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[D")
	}
	typeStr(e, "lol")
	assertText(t, e, "hello lolworld")
	e.HandleInput(undoKey)
	assertText(t, e, "hello world")
	e.HandleInput("|")
	assertText(t, e, "hello |world")
}

func TestUndo_noOpDeleteOperationsDoNotPushSnapshots(t *testing.T) {
	e := newTestEditor(t)
	typeStr(e, "hello")
	assertText(t, e, "hello")
	e.HandleInput("\x17")
	assertText(t, e, "")
	e.HandleInput("\x17")
	e.HandleInput("\x17")
	e.HandleInput(undoKey)
	assertText(t, e, "hello")
}

func TestUndo_undoesAutocomplete(t *testing.T) {
	e := newTestEditor(t)
	e.SetAutocompleteProvider(&stubProvider{
		suggest: func(lines []string, cl, cc int, force bool) (*Suggestions, error) {
			text := ""
			if len(lines) > 0 {
				text = lines[0]
			}
			prefix := runeSlice(text, 0, cc)
			if prefix == "di" {
				return &Suggestions{Items: []Item{{Value: "dist/", Label: "dist/"}}, Prefix: "di"}, nil
			}
			return nil, nil
		},
	})
	e.HandleInput("d")
	e.HandleInput("i")
	assertText(t, e, "di")
	e.HandleInput("\t")
	e.FlushAutocomplete()
	assertText(t, e, "dist/")
	if e.IsShowingAutocomplete() {
		t.Fatal("autocomplete should be closed")
	}
	e.HandleInput(undoKey)
	assertText(t, e, "di")
}
