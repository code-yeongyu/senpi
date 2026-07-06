package editor

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// Ported from packages/tui/test/editor.test.ts:
//   "Grapheme-aware text wrapping", "Word wrapping".
//
// Render(width) returns border+content+border rows exactly like the tui editor.
// visibleWidth is the shared column-width function (CJK=2, emoji=2, etc.).

func vw(s string) int { return textwidth.Visible(s) }

func contentLines(lines []string) []string {
	if len(lines) < 2 {
		return nil
	}
	return lines[1 : len(lines)-1]
}

func TestWrap_wrapsWhenTextContainsWideEmojis(t *testing.T) {
	e := newTestEditor(t)
	width := 20
	e.SetText("Hello ✅ World")
	lines := e.Render(width)
	for i := 1; i < len(lines)-1; i++ {
		if w := vw(lines[i]); w != width {
			t.Fatalf("line %d width %d, want %d", i, w, width)
		}
	}
}

func TestWrap_wrapsLongTextWithEmojisAtCorrectPositions(t *testing.T) {
	e := newTestEditor(t)
	width := 10
	e.SetText("✅✅✅✅✅✅")
	lines := e.Render(width)
	for i := 1; i < len(lines)-1; i++ {
		if w := vw(lines[i]); w != width {
			t.Fatalf("line %d width %d, want %d", i, w, width)
		}
	}
}

func TestWrap_rendersIsolatedThaiLaoAMClustersWithoutWidthDrift(t *testing.T) {
	for _, text := range []string{"ำabc", "ຳabc"} {
		e := newTestEditor(t)
		width := 8
		e.SetText(text)
		for _, line := range e.Render(width) {
			if w := vw(line); w != width {
				t.Fatalf("width drift for %q: %q (w=%d)", text, line, w)
			}
		}
	}
}

func TestWrap_wrapsCJKEachTwoColumnsWide(t *testing.T) {
	e := newTestEditor(t)
	width := 10 + 1 // +1 col reserved for cursor
	e.SetText("日本語テスト")
	lines := e.Render(width)
	for i := 1; i < len(lines)-1; i++ {
		if w := vw(lines[i]); w != width {
			t.Fatalf("line %d width %d, want %d", i, w, width)
		}
	}
	cl := contentLines(lines)
	if len(cl) != 2 {
		t.Fatalf("got %d content lines, want 2", len(cl))
	}
	if got := strings.TrimSpace(textwidth.StripANSI(cl[0])); got != "日本語テス" {
		t.Fatalf("line0 = %q, want 日本語テス", got)
	}
	if got := strings.TrimSpace(textwidth.StripANSI(cl[1])); got != "ト" {
		t.Fatalf("line1 = %q, want ト", got)
	}
}

func TestWrap_handlesMixedAsciiAndWideCharsInWrapping(t *testing.T) {
	e := newTestEditor(t)
	width := 15 + 1
	e.SetText("Test ✅ OK 日本")
	lines := e.Render(width)
	cl := contentLines(lines)
	if len(cl) != 1 {
		t.Fatalf("got %d content lines, want 1", len(cl))
	}
	if w := vw(cl[0]); w != width {
		t.Fatalf("width %d, want %d", w, width)
	}
}

func TestWrap_rendersCursorCorrectlyOnWideCharacters(t *testing.T) {
	e := newTestEditor(t)
	width := 20
	e.SetText("A✅B")
	lines := e.Render(width)
	cl := lines[1]
	if !strings.Contains(cl, "\x1b[7m") {
		t.Fatal("should have reverse video cursor")
	}
	if w := vw(cl); w != width {
		t.Fatalf("width %d, want %d", w, width)
	}
}

func TestWrap_doesNotExceedWidthWithEmojiAtWrapBoundary(t *testing.T) {
	e := newTestEditor(t)
	width := 11
	e.SetText("0123456789✅")
	lines := e.Render(width)
	for i := 1; i < len(lines)-1; i++ {
		if w := vw(lines[i]); w > width {
			t.Fatalf("line %d width %d exceeds max %d", i, w, width)
		}
	}
}

func TestWrap_showsCursorAtEndBeforeWrapWrapsOnNextChar(t *testing.T) {
	width := 10
	for _, paddingX := range []int{0, 1} {
		e := New(Options{PaddingX: paddingX})
		e.SetViewport(width+paddingX, 24)
		for _, ch := range "aaaaaaaaa" {
			e.HandleInput(string(ch))
		}
		lines := e.Render(width + paddingX)
		cl := contentLines(lines)
		if len(cl) != 1 {
			t.Fatalf("paddingX=%d: got %d content lines before wrap, want 1", paddingX, len(cl))
		}
		if !strings.HasSuffix(cl[0], "\x1b[7m \x1b[0m") {
			t.Fatalf("paddingX=%d: cursor should be at end of line, got %q", paddingX, cl[0])
		}
		e.HandleInput("a")
		lines = e.Render(width + paddingX)
		cl = contentLines(lines)
		if len(cl) != 2 {
			t.Fatalf("paddingX=%d: got %d content lines, want 2 after wrap", paddingX, len(cl))
		}
	}
}

func TestWordWrap_wrapsAtWordBoundaries(t *testing.T) {
	e := newTestEditor(t)
	width := 40
	e.SetText("Hello world this is a test of word wrapping functionality")
	lines := e.Render(width)
	cl := contentLines(lines)
	for _, l := range cl {
		trimmed := strings.TrimRight(textwidth.StripANSI(l), " ")
		if strings.HasSuffix(trimmed, "-") {
			t.Fatalf("line should not end with hyphen: %q", trimmed)
		}
	}
}

func TestWordWrap_doesNotStartLinesWithLeadingWhitespace(t *testing.T) {
	e := newTestEditor(t)
	width := 20
	e.SetText("Word1 Word2 Word3 Word4 Word5 Word6")
	lines := e.Render(width)
	cl := contentLines(lines)
	for i, l := range cl {
		line := textwidth.StripANSI(l)
		if strings.TrimSpace(line) == "" {
			continue
		}
		trimmed := strings.TrimRight(line, " ")
		if len(trimmed) > 0 && (trimmed[0] == ' ' || trimmed[0] == '\t') {
			t.Fatalf("line %d starts with whitespace: %q", i, trimmed)
		}
	}
}

func TestWordWrap_breaksLongURLsAtCharacterLevel(t *testing.T) {
	e := newTestEditor(t)
	width := 30
	e.SetText("Check https://example.com/very/long/path/that/exceeds/width here")
	lines := e.Render(width)
	for i := 1; i < len(lines)-1; i++ {
		if w := vw(lines[i]); w != width {
			t.Fatalf("line %d width %d, want %d", i, w, width)
		}
	}
}

func TestWordWrap_preservesMultipleSpacesWithinWordsOnSameLine(t *testing.T) {
	e := newTestEditor(t)
	width := 50
	e.SetText("Word1   Word2    Word3")
	lines := e.Render(width)
	cl := strings.TrimSpace(textwidth.StripANSI(lines[1]))
	if !strings.Contains(cl, "Word1   Word2") {
		t.Fatalf("multiple spaces not preserved: %q", cl)
	}
}

func TestWordWrap_handlesEmptyString(t *testing.T) {
	e := newTestEditor(t)
	e.SetText("")
	lines := e.Render(40)
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3", len(lines))
	}
}

func TestWordWrap_handlesSingleWordThatFitsExactly(t *testing.T) {
	e := newTestEditor(t)
	width := 10 + 1
	e.SetText("1234567890")
	lines := e.Render(width)
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3", len(lines))
	}
	if !strings.Contains(textwidth.StripANSI(lines[1]), "1234567890") {
		t.Fatalf("content missing the word: %q", lines[1])
	}
}

// --- WordWrapLine unit tests (no pre-segmented data) ---

func chunkTexts(chunks []TextChunk) []string {
	out := make([]string, len(chunks))
	for i, c := range chunks {
		out[i] = c.Text
	}
	return out
}

func assertChunks(t *testing.T, chunks []TextChunk, want ...string) {
	t.Helper()
	got := chunkTexts(chunks)
	if len(got) != len(want) {
		t.Fatalf("got %d chunks %q, want %d %q", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("chunk %d = %q, want %q (all: %q)", i, got[i], want[i], got)
		}
	}
}

func TestWordWrapLine_wrapsWordWhenItEndsExactlyAtWidth(t *testing.T) {
	assertChunks(t, WordWrapLine("hello world test", 11), "hello ", "world test")
}

func TestWordWrapLine_keepsWhitespaceAtWidthBoundaryOnSameLine(t *testing.T) {
	assertChunks(t, WordWrapLine("hello world test", 12), "hello world ", "test")
}

func TestWordWrapLine_handlesUnbreakableWordFillingWidthFollowedBySpace(t *testing.T) {
	assertChunks(t, WordWrapLine("aaaaaaaaaaaa aaaa", 12), "aaaaaaaaaaaa", " aaaa")
}

func TestWordWrapLine_wrapsWordWhenFitsWidthButNotRemainingSpace(t *testing.T) {
	assertChunks(t, WordWrapLine("      aaaaaaaaaaaa", 12), "      ", "aaaaaaaaaaaa")
}

func TestWordWrapLine_keepsWordWithMultiSpaceAndFollowingWordWhenTheyFit(t *testing.T) {
	assertChunks(t, WordWrapLine("Lorem ipsum dolor sit amet,    consectetur", 30),
		"Lorem ipsum dolor sit ", "amet,    consectetur")
}

func TestWordWrapLine_keepsWordWithMultiSpaceWhenTheyFillWidthExactly(t *testing.T) {
	assertChunks(t, WordWrapLine("Lorem ipsum dolor sit amet,              consectetur", 30),
		"Lorem ipsum dolor sit ", "amet,              consectetur")
}

func TestWordWrapLine_splitsWhenWordPlusMultiSpacePlusWordExceedsWidth(t *testing.T) {
	assertChunks(t, WordWrapLine("Lorem ipsum dolor sit amet,               consectetur", 30),
		"Lorem ipsum dolor sit ", "amet,               ", "consectetur")
}

func TestWordWrapLine_breaksLongWhitespaceAtLineBoundary(t *testing.T) {
	assertChunks(t, WordWrapLine("Lorem ipsum dolor sit amet,                         consectetur", 30),
		"Lorem ipsum dolor sit ", "amet,                         ", "consectetur")
}

func TestWordWrapLine_breaksLongWhitespaceAtLineBoundary2(t *testing.T) {
	assertChunks(t, WordWrapLine("Lorem ipsum dolor sit amet,                          consectetur", 30),
		"Lorem ipsum dolor sit ", "amet,                         ", " consectetur")
}

func TestWordWrapLine_breaksWhitespaceSpanningFullLines(t *testing.T) {
	assertChunks(t, WordWrapLine("Lorem ipsum dolor sit amet,                                     consectetur", 30),
		"Lorem ipsum dolor sit ", "amet,                         ", "            consectetur")
}

func TestWordWrapLine_forceBreaksWhenWideCharAfterWordBoundaryStillOverflows(t *testing.T) {
	line := " " + strings.Repeat("a", 186) + "你"
	chunks := WordWrapLine(line, 187)
	for _, c := range chunks {
		if vw(c.Text) > 187 {
			t.Fatalf("chunk width %d exceeds 187", vw(c.Text))
		}
	}
	reconstructReport(t, line, chunks)
}

// --- WordWrapLine with pre-segmented (paste-marker) data ---

func TestWordWrapLine_splitsOversizedAtomicSegmentAcrossMultipleChunks(t *testing.T) {
	marker := "[paste #1 +20 lines]" // 21 chars
	line := "A" + marker + "B"
	segs := []Segment{
		{Text: "A", Index: 0},
		{Text: marker, Index: 1},
		{Text: "B", Index: 1 + len([]rune(marker))},
	}
	chunks := WordWrapLinePreseg(line, 10, segs)
	for _, c := range chunks {
		if vw(c.Text) > 10 {
			t.Fatalf("chunk %q width %d exceeds 10", c.Text, vw(c.Text))
		}
	}
	reconstructReport(t, line, chunks)
}

func TestWordWrapLine_splitsOversizedAtomicSegmentAtStartOfLine(t *testing.T) {
	marker := "[paste #1 +20 lines]"
	line := marker + "B"
	segs := []Segment{
		{Text: marker, Index: 0},
		{Text: "B", Index: len([]rune(marker))},
	}
	chunks := WordWrapLinePreseg(line, 10, segs)
	for _, c := range chunks {
		if vw(c.Text) > 10 {
			t.Fatalf("chunk %q width %d exceeds 10", c.Text, vw(c.Text))
		}
	}
	if !strings.Contains(chunks[len(chunks)-1].Text, "B") {
		t.Fatalf("last chunk should contain B: %q", chunks[len(chunks)-1].Text)
	}
	reconstructReport(t, line, chunks)
}

func TestWordWrapLine_splitsOversizedAtomicSegmentAtEndOfLine(t *testing.T) {
	marker := "[paste #1 +20 lines]"
	line := "A" + marker
	segs := []Segment{
		{Text: "A", Index: 0},
		{Text: marker, Index: 1},
	}
	chunks := WordWrapLinePreseg(line, 10, segs)
	for _, c := range chunks {
		if vw(c.Text) > 10 {
			t.Fatalf("chunk %q width %d exceeds 10", c.Text, vw(c.Text))
		}
	}
	if chunks[0].Text != "A" {
		t.Fatalf("first chunk = %q, want A", chunks[0].Text)
	}
	reconstructReport(t, line, chunks)
}

func TestWordWrapLine_splitsConsecutiveOversizedAtomicSegments(t *testing.T) {
	m1 := "[paste #1 +20 lines]"
	m2 := "[paste #2 +30 lines]"
	line := m1 + m2
	segs := []Segment{
		{Text: m1, Index: 0},
		{Text: m2, Index: len([]rune(m1))},
	}
	chunks := WordWrapLinePreseg(line, 10, segs)
	for _, c := range chunks {
		if vw(c.Text) > 10 {
			t.Fatalf("chunk %q width %d exceeds 10", c.Text, vw(c.Text))
		}
	}
	reconstructReport(t, line, chunks)
}

func TestWordWrapLine_wrapsNormallyAfterOversizedAtomicSegment(t *testing.T) {
	marker := "[paste #1 +20 lines]"
	line := marker + " hello world"
	base := len([]rune(marker))
	segs := []Segment{{Text: marker, Index: 0}, {Text: " ", Index: base}}
	for i, ch := range "hello world" {
		segs = append(segs, Segment{Text: string(ch), Index: base + 1 + i})
	}
	chunks := WordWrapLinePreseg(line, 10, segs)
	for _, c := range chunks {
		if vw(c.Text) > 10 {
			t.Fatalf("chunk %q width %d exceeds 10", c.Text, vw(c.Text))
		}
	}
	if chunks[len(chunks)-1].Text != "world" {
		t.Fatalf("last chunk = %q, want world", chunks[len(chunks)-1].Text)
	}
	reconstructReport(t, line, chunks)
}

// reconstructReport asserts no content is lost: joining line[start:end] over all
// chunks reproduces the original line (rune-indexed slices).
func reconstructReport(t *testing.T, line string, chunks []TextChunk) {
	t.Helper()
	runes := []rune(line)
	var sb strings.Builder
	for _, c := range chunks {
		sb.WriteString(string(runes[c.StartIndex:c.EndIndex]))
	}
	if sb.String() != line {
		t.Fatalf("reconstruction mismatch:\n got %q\nwant %q", sb.String(), line)
	}
}
