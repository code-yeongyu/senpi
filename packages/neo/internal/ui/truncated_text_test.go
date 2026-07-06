package ui

import (
	"strings"
	"testing"
)

// Contract source: packages/tui/test/truncated-text.test.ts.
// TruncatedText renders exactly ONE content line (plus optional vertical
// padding), padded to EXACTLY the render width in visible columns, truncated to
// the first newline, with a "..." ellipsis when the first line overflows.

func TestTruncatedText_PadsToExactWidth(t *testing.T) {
	tt := NewTruncatedText("Hello world", 1, 0)
	lines := tt.Render(50)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 50 {
		t.Fatalf("line visible width: want 50, got %d", w)
	}
}

func TestTruncatedText_VerticalPaddingLinesToWidth(t *testing.T) {
	tt := NewTruncatedText("Hello", 0, 2)
	lines := tt.Render(40)
	if len(lines) != 5 { // 2 pad + 1 content + 2 pad
		t.Fatalf("want 5 lines, got %d", len(lines))
	}
	for i, l := range lines {
		if w := VisibleWidth(l); w != 40 {
			t.Fatalf("line %d visible width: want 40, got %d", i, w)
		}
	}
}

func TestTruncatedText_TruncatesLongTextWithEllipsis(t *testing.T) {
	long := "This is a very long piece of text that will definitely exceed the available width"
	tt := NewTruncatedText(long, 1, 0)
	lines := tt.Render(30)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 30 {
		t.Fatalf("visible width: want 30, got %d", w)
	}
	if !strings.Contains(StripANSI(lines[0]), "...") {
		t.Fatalf("expected ellipsis in %q", lines[0])
	}
}

func TestTruncatedText_FitsExactlyNoEllipsis(t *testing.T) {
	tt := NewTruncatedText("Hello world", 1, 0)
	lines := tt.Render(30)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 30 {
		t.Fatalf("visible width: want 30, got %d", w)
	}
	if strings.Contains(StripANSI(lines[0]), "...") {
		t.Fatalf("did not expect ellipsis in %q", lines[0])
	}
}

func TestTruncatedText_EmptyText(t *testing.T) {
	tt := NewTruncatedText("", 1, 0)
	lines := tt.Render(30)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 30 {
		t.Fatalf("visible width: want 30, got %d", w)
	}
}

func TestTruncatedText_StopsAtNewlineFirstLineOnly(t *testing.T) {
	tt := NewTruncatedText("First line\nSecond line\nThird line", 1, 0)
	lines := tt.Render(40)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 40 {
		t.Fatalf("visible width: want 40, got %d", w)
	}
	s := StripANSI(lines[0])
	if !strings.Contains(s, "First line") {
		t.Fatalf("want First line in %q", s)
	}
	if strings.Contains(s, "Second line") || strings.Contains(s, "Third line") {
		t.Fatalf("later lines must not appear in %q", s)
	}
}

func TestTruncatedText_TruncatesFirstLineEvenWithNewlines(t *testing.T) {
	tt := NewTruncatedText("This is a very long first line that needs truncation\nSecond line", 1, 0)
	lines := tt.Render(25)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 25 {
		t.Fatalf("visible width: want 25, got %d", w)
	}
	s := StripANSI(lines[0])
	if !strings.Contains(s, "...") {
		t.Fatalf("want ellipsis in %q", s)
	}
	if strings.Contains(s, "Second line") {
		t.Fatalf("second line must not appear in %q", s)
	}
}

// Ported from truncated-text.test.ts "preserves ANSI codes in output and pads
// correctly": a styled first line keeps its SGR codes and pads to exactly the
// render width (ANSI codes are zero-width). Uses raw SGR sequences (chalk level-3
// equivalent: red = ESC[31m, blue = ESC[34m, reset = ESC[0m).
func TestTruncatedText_PreservesANSICodesAndPads(t *testing.T) {
	styled := "\x1b[31mHello\x1b[39m \x1b[34mworld\x1b[39m"
	tt := NewTruncatedText(styled, 1, 0)
	lines := tt.Render(40)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 40 {
		t.Fatalf("visible width: want 40, got %d", w)
	}
	if !strings.Contains(lines[0], "\x1b[") {
		t.Fatalf("styled text must preserve ANSI codes, got %q", lines[0])
	}
}

// Ported from truncated-text.test.ts "truncates styled text and adds reset code
// before ellipsis": when a styled first line overflows, the emitted line must
// carry a reset (ESC[0m) immediately BEFORE the "..." ellipsis so the ellipsis
// renders unstyled — matching pi-tui truncateToWidth finalizeTruncatedResult.
func TestTruncatedText_TruncatesStyledWithResetBeforeEllipsis(t *testing.T) {
	styled := "\x1b[31mThis is a very long red text that will be truncated\x1b[39m"
	tt := NewTruncatedText(styled, 1, 0)
	lines := tt.Render(20)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 20 {
		t.Fatalf("visible width: want 20, got %d", w)
	}
	if !strings.Contains(lines[0], "\x1b[0m...") {
		t.Fatalf("want reset code before ellipsis (ESC[0m...), got %q", lines[0])
	}
}
