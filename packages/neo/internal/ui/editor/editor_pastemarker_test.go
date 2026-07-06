package editor

import (
	"regexp"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// Ported from packages/tui/test/editor.test.ts > "Paste marker atomic behavior".

var markerLinesRe = regexp.MustCompile(`\[paste #\d+ \+\d+ lines\]`)
var markerCharsRe = regexp.MustCompile(`\[paste #\d+ \d+ chars\]`)

// pasteWithMarker simulates a large paste that yields a "+N lines" marker.
func pasteWithMarker(e *Editor) string {
	big := strings.TrimRight(strings.Repeat("line\n", 20), "\n")
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	return e.GetText()
}

func TestMarker_createsPasteMarkerForLargePastes(t *testing.T) {
	e := newTestEditor(t)
	text := pasteWithMarker(e)
	if !markerLinesRe.MatchString(text) {
		t.Fatalf("no marker in %q", text)
	}
}

func TestMarker_treatsMarkerAsSingleUnitForRightArrow(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("A")
	pasteWithMarker(e)
	e.HandleInput("B")
	e.HandleInput("\x01")
	assertCursor(t, e, 0, 0)
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, 1)
	e.HandleInput("\x1b[C")
	marker := markerLinesRe.FindString(e.GetText())
	ml := runeLen(marker)
	assertCursor(t, e, 0, 1+ml)
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, 1+ml+1)
}

func TestMarker_treatsMarkerAsSingleUnitForLeftArrow(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("A")
	pasteWithMarker(e)
	e.HandleInput("B")
	e.HandleInput("\x1b[D")
	marker := markerLinesRe.FindString(e.GetText())
	ml := runeLen(marker)
	assertCursor(t, e, 0, 1+ml)
	e.HandleInput("\x1b[D")
	assertCursor(t, e, 0, 1)
	e.HandleInput("\x1b[D")
	assertCursor(t, e, 0, 0)
}

func TestMarker_treatsMarkerAsSingleUnitForBackspace(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("A")
	pasteWithMarker(e)
	e.HandleInput("B")
	marker := markerLinesRe.FindString(e.GetText())
	ml := runeLen(marker)
	e.HandleInput("\x01")
	e.HandleInput("\x1b[C")
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, 1+ml)
	e.HandleInput("\x7f")
	assertText(t, e, "AB")
	assertCursor(t, e, 0, 1)
}

func TestMarker_treatsMarkerAsSingleUnitForForwardDelete(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("A")
	pasteWithMarker(e)
	e.HandleInput("B")
	e.HandleInput("\x01")
	e.HandleInput("\x1b[C")
	e.HandleInput("\x1b[3~")
	assertText(t, e, "AB")
	assertCursor(t, e, 0, 1)
}

func TestMarker_treatsMarkerAsSingleUnitForWordMovement(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("X")
	e.HandleInput(" ")
	pasteWithMarker(e)
	e.HandleInput(" ")
	e.HandleInput("Y")
	marker := markerLinesRe.FindString(e.GetText())
	ml := runeLen(marker)
	e.HandleInput("\x01")
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 1)
	e.HandleInput("\x1b[1;5C")
	assertCursor(t, e, 0, 2+ml)
}

func TestMarker_undoRestoresMarkerAfterBackspaceDeletion(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput("A")
	pasteWithMarker(e)
	e.HandleInput("B")
	before := e.GetText()
	e.HandleInput("\x01")
	e.HandleInput("\x1b[C")
	e.HandleInput("\x1b[C")
	e.HandleInput("\x7f")
	assertText(t, e, "AB")
	e.HandleInput(undoKey)
	assertText(t, e, before)
}

func TestMarker_handlesMultipleMarkersInSameLine(t *testing.T) {
	e := newTestEditor(t)
	pasteWithMarker(e)
	e.HandleInput(" ")
	pasteWithMarker(e)
	text := e.GetText()
	markers := markerLinesRe.FindAllString(text, -1)
	if len(markers) != 2 {
		t.Fatalf("got %d markers, want 2", len(markers))
	}
	m0 := runeLen(markers[0])
	m1 := runeLen(markers[1])
	e.HandleInput("\x01")
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, m0)
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, m0+1)
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, m0+1+m1)
}

func TestMarker_doesNotTreatManuallyTypedMarkerLikeTextAsAtomic(t *testing.T) {
	e := newTestEditor(t)
	fake := "[paste #99 +5 lines]"
	for _, ch := range fake {
		e.HandleInput(string(ch))
	}
	assertText(t, e, fake)
	e.HandleInput("\x01")
	e.HandleInput("\x1b[C")
	assertCursor(t, e, 0, 1)
}

func TestMarker_doesNotCrashWhenMarkerWiderThanTerminalWidth(t *testing.T) {
	e := newTestEditor(t)
	big := strings.TrimRight(strings.Repeat("line\n", 47), "\n")
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	marker := markerLinesRe.FindString(e.GetText())
	if marker == "" {
		t.Fatal("marker should be created")
	}
	if vw(marker) <= 8 {
		t.Fatal("marker should be wider than render width 8")
	}
	lines := e.Render(8)
	for _, l := range lines {
		if w := vw(l); w > 8 {
			t.Fatalf("line exceeds width 8: visible=%d text=%q", w, textwidth.StripANSI(l))
		}
	}
}

func TestMarker_doesNotCrashWhenTextPlusMarkerExceedsWidthWithCursorOnMarker(t *testing.T) {
	e := newTestEditor(t)
	for i := 0; i < 35; i++ {
		e.HandleInput("b")
	}
	big := strings.TrimRight(strings.Repeat("line\n", 27), "\n")
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	for i := 0; i < 4; i++ {
		e.HandleInput("b")
	}
	for i := 0; i < 5; i++ {
		e.HandleInput("\x1b[D")
	}
	renderWidth := 54
	for _, l := range e.Render(renderWidth) {
		if w := vw(l); w > renderWidth {
			t.Fatalf("line exceeds width %d: visible=%d text=%q", renderWidth, w, textwidth.StripANSI(l))
		}
	}
}

func TestMarker_wordWrapLineRechecksOverflowAfterBacktracking(t *testing.T) {
	e := newTestEditor(t)
	e.HandleInput(" ")
	for i := 0; i < 35; i++ {
		e.HandleInput("b")
	}
	big := strings.TrimRight(strings.Repeat("line\n", 27), "\n")
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	for i := 0; i < 4; i++ {
		e.HandleInput("b")
	}
	renderWidth := 54
	for _, l := range e.Render(renderWidth) {
		if w := vw(l); w > renderWidth {
			t.Fatalf("line exceeds width %d: visible=%d text=%q", renderWidth, w, textwidth.StripANSI(l))
		}
	}
}

func TestMarker_expandsLargePastedContentLiterallyInGetExpandedText(t *testing.T) {
	e := newTestEditor(t)
	pasted := strings.Join([]string{
		"line 1", "line 2", "line 3", "line 4", "line 5", "line 6",
		"line 7", "line 8", "line 9", "line 10", "tokens $1 $2 $& $$ $` $' end",
	}, "\n")
	e.HandleInput("\x1b[200~" + pasted + "\x1b[201~")
	if !markerLinesRe.MatchString(e.GetText()) {
		t.Fatalf("expected marker, got %q", e.GetText())
	}
	if got := e.GetExpandedText(); got != pasted {
		t.Fatalf("GetExpandedText() = %q, want %q", got, pasted)
	}
}

func TestMarker_snapsToMarkerStartWhenNavigatingDownIntoIt(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("12345678901234567890\n\nhello ")
	big := strings.Repeat("x", 2000)
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	e.Render(80)
	if !markerCharsRe.MatchString(e.GetText()) {
		t.Fatalf("expected chars marker, got %q", e.GetText())
	}
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
	assertCursor(t, e, 2, 6)
}

func TestMarker_preservesStickyColumnWhenNavigatingThroughMarkerLine(t *testing.T) {
	e := newTestEditorSized(t, 30, 24)
	for _, ch := range "1234567890123456" {
		e.HandleInput(string(ch))
	}
	e.HandleInput("\n")
	e.HandleInput("\n")
	e.HandleInput("\x1b[200~" + strings.Repeat("x", 2000) + "\x1b[201~")
	e.HandleInput("\n")
	e.HandleInput("\n")
	for _, ch := range "abcdefghijklmnop" {
		e.HandleInput(string(ch))
	}
	e.Render(30)
	for i := 0; i < 4; i++ {
		e.HandleInput("\x1b[A")
	}
	e.HandleInput("\x01")
	for i := 0; i < 10; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 10)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 0)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 2, 0)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 3, 0)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 4, 10)
}

func TestMarker_doesNotGetStuckMovingDownFromMultiVisualLineMarker(t *testing.T) {
	e := newTestEditorSized(t, 20, 24)
	for _, ch := range "abcdefgh" {
		e.HandleInput(string(ch))
	}
	big := strings.TrimRight(strings.Repeat("line\n", 100), "\n")
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	for _, ch := range "ijklmnopqr" {
		e.HandleInput(string(ch))
	}
	e.HandleInput("\n")
	for _, ch := range "123456789012345678" {
		e.HandleInput(string(ch))
	}
	e.Render(20)
	marker := markerLinesRe.FindString(e.GetText())
	if marker == "" {
		t.Fatal("marker should be created")
	}
	ml := runeLen(marker)
	if ml <= 20 {
		t.Fatal("marker should be wider than terminal")
	}
	markerStart := 8
	markerEnd := markerStart + ml
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	for i := 0; i < 6; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 6)
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 0, markerStart)
	e.HandleInput("\x1b[B")
	if l, c := e.Cursor(); l != 0 || c != markerEnd {
		t.Fatalf("cursor = {%d,%d}, want {0,%d}", l, c, markerEnd)
	}
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, markerStart)
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 6)
}

func TestMarker_skipsMarkerContinuationVLsWhenPreferredColInMarkerTail(t *testing.T) {
	e := newTestEditorSized(t, 20, 24)
	for _, ch := range "abcdefgh" {
		e.HandleInput(string(ch))
	}
	big := strings.TrimRight(strings.Repeat("line\n", 100), "\n")
	e.HandleInput("\x1b[200~" + big + "\x1b[201~")
	for _, ch := range "ijklmnopqr" {
		e.HandleInput(string(ch))
	}
	e.HandleInput("\n")
	for _, ch := range "123456789012345678" {
		e.HandleInput(string(ch))
	}
	e.Render(20)
	e.HandleInput("\x1b[A")
	e.HandleInput("\x01")
	for i := 0; i < 3; i++ {
		e.HandleInput("\x1b[C")
	}
	assertCursor(t, e, 0, 3)
	e.HandleInput("\x1b[B")
	if _, c := e.Cursor(); c != 8 {
		t.Fatalf("col = %d, want 8", c)
	}
	e.HandleInput("\x1b[B")
	assertCursor(t, e, 1, 3)
	e.HandleInput("\x1b[A")
	if _, c := e.Cursor(); c != 8 {
		t.Fatalf("col = %d, want 8", c)
	}
	e.HandleInput("\x1b[A")
	assertCursor(t, e, 0, 3)
}

func TestMarker_submitsLargePastedContentLiterally(t *testing.T) {
	e := newTestEditor(t)
	pasted := strings.Join([]string{
		"line 1", "line 2", "line 3", "line 4", "line 5", "line 6",
		"line 7", "line 8", "line 9", "line 10", "tokens $1 $2 $& $$ $` $' end",
	}, "\n")
	submitted := ""
	e.OnSubmit = func(text string) { submitted = text }
	e.HandleInput("\x1b[200~" + pasted + "\x1b[201~")
	e.HandleInput("\r")
	if submitted != pasted {
		t.Fatalf("submitted = %q, want %q", submitted, pasted)
	}
}
