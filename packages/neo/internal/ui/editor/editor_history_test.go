package editor

import "testing"

// Ported from packages/tui/test/editor.test.ts > "Prompt history navigation".
// Each Go test name maps 1:1 to a tui `it(...)` case; the mapping table lives in
// .omo/evidence/task-5-neo-go-tui.md.
//
// HandleInput accepts the SAME raw terminal byte sequences the tui suite feeds
// (e.g. "\x1b[A" for Up, "\x17" for Ctrl+W). The editor decodes them through its
// keybinding resolver — never with inline hardcoded key comparisons.

func TestHistory_doesNothingOnUpWhenEmpty(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("\x1b[A") // Up arrow
	assertText(t, e, "")
}

func TestHistory_showsMostRecentOnUpWhenEmpty(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("first prompt")
	e.AddToHistory("second prompt")
	e.HandleInput("\x1b[A")
	assertText(t, e, "second prompt")
}

func TestHistory_cyclesThroughEntriesOnRepeatedUp(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("first")
	e.AddToHistory("second")
	e.AddToHistory("third")

	e.HandleInput("\x1b[A")
	assertText(t, e, "third")
	e.HandleInput("\x1b[A")
	assertText(t, e, "second")
	e.HandleInput("\x1b[A")
	assertText(t, e, "first")
	e.HandleInput("\x1b[A")
	assertText(t, e, "first")
}

func TestHistory_jumpsToStartBeforeEnteringHistoryFromNonEmptyDraft(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("prompt")
	e.SetText("draft")
	e.HandleInput("\x1b[D")
	e.HandleInput("\x1b[D")

	e.HandleInput("\x1b[A")
	assertText(t, e, "draft")
	assertCursor(t, e, 0, 0)

	e.HandleInput("\x1b[A")
	assertText(t, e, "prompt")

	e.HandleInput("\x1b[B")
	assertText(t, e, "draft")
	assertCursor(t, e, 0, 0)
}

func TestHistory_navigatesForwardWithDown(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("first")
	e.AddToHistory("second")
	e.AddToHistory("third")
	e.SetText("draft")

	e.HandleInput("\x1b[A") // start of draft
	e.HandleInput("\x1b[A") // third
	e.HandleInput("\x1b[A") // second
	e.HandleInput("\x1b[A") // first

	e.HandleInput("\x1b[B")
	assertText(t, e, "second")
	e.HandleInput("\x1b[B")
	assertText(t, e, "third")
	e.HandleInput("\x1b[B")
	assertText(t, e, "draft")
}

func TestHistory_exitsHistoryModeWhenTyping(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("old prompt")
	e.HandleInput("\x1b[A")
	e.HandleInput("x")
	assertText(t, e, "xold prompt")
}

func TestHistory_exitsHistoryModeOnSetText(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("first")
	e.AddToHistory("second")
	e.HandleInput("\x1b[A")
	e.SetText("")
	e.HandleInput("\x1b[A")
	assertText(t, e, "second")
}

func TestHistory_doesNotAddEmptyStrings(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("")
	e.AddToHistory("   ")
	e.AddToHistory("valid")
	e.HandleInput("\x1b[A")
	assertText(t, e, "valid")
	e.HandleInput("\x1b[A")
	assertText(t, e, "valid")
}

func TestHistory_doesNotAddConsecutiveDuplicates(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("same")
	e.AddToHistory("same")
	e.AddToHistory("same")
	e.HandleInput("\x1b[A")
	assertText(t, e, "same")
	e.HandleInput("\x1b[A")
	assertText(t, e, "same")
}

func TestHistory_allowsNonConsecutiveDuplicates(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("first")
	e.AddToHistory("second")
	e.AddToHistory("first")
	e.HandleInput("\x1b[A")
	assertText(t, e, "first")
	e.HandleInput("\x1b[A")
	assertText(t, e, "second")
	e.HandleInput("\x1b[A")
	assertText(t, e, "first")
}

func TestHistory_usesCursorMovementWhenEditorHasContent(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("history item")
	e.SetText("line1\nline2")
	e.HandleInput("\x1b[A") // Up - cursor movement
	e.HandleInput("X")
	assertText(t, e, "line1X\nline2")
}

func TestHistory_limitsTo100Entries(t *testing.T) {
	e := newTestEditor(t)
	for i := 0; i < 105; i++ {
		e.AddToHistory(sprintf("prompt %d", i))
	}
	for i := 0; i < 100; i++ {
		e.HandleInput("\x1b[A")
	}
	assertText(t, e, "prompt 5")
	e.HandleInput("\x1b[A")
	assertText(t, e, "prompt 5")
}

func TestHistory_placesCursorAtStartAfterBrowsingUpward(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("older entry")
	e.AddToHistory("line1\nline2\nline3")

	e.HandleInput("\x1b[A")
	assertText(t, e, "line1\nline2\nline3")
	assertCursor(t, e, 0, 0)

	e.HandleInput("\x1b[A")
	assertText(t, e, "older entry")
	assertCursor(t, e, 0, 0)
}

func TestHistory_placesCursorAtEndAfterBrowsingDownward(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("older entry")
	e.AddToHistory("line1\nline2\nline3")
	e.AddToHistory("newer entry")

	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")
	e.HandleInput("\x1b[A")

	e.HandleInput("\x1b[B")
	assertText(t, e, "line1\nline2\nline3")
	assertCursor(t, e, 2, 5)

	e.HandleInput("\x1b[B")
	assertText(t, e, "newer entry")
}

func TestHistory_allowsOppositeDirectionCursorMovementWithinMultilineEntry(t *testing.T) {
	e := newTestEditor(t)
	e.AddToHistory("line1\nline2\nline3")

	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 0)

	e.HandleInput("\x1b[B")
	assertText(t, e, "line1\nline2\nline3")
	assertCursor(t, e, 1, 0)

	e.HandleInput("\x1b[A")
	assertText(t, e, "line1\nline2\nline3")
	assertCursor(t, e, 0, 0)
}
