package markdown

import (
	"strings"
	"testing"
)

// Ported from markdown.test.ts describe("Blockquotes with multiline content").

func TestBlockquote_LazyContinuationConsistentStyling(t *testing.T) {
	// magenta default color must NOT be applied to blockquotes.
	m := New(">Foo\nbar", 0, 0, defaultMarkdownTheme(),
		&DefaultTextStyle{Color: sgr(35, 39)}, nil)
	lines := m.Render(80)
	pl := mapLines(lines, stripANSI)
	quoted := 0
	for _, l := range pl {
		if strings.HasPrefix(l, "│ ") {
			quoted++
		}
	}
	if quoted != 2 {
		t.Fatalf("expected 2 quoted lines, got %#v", pl)
	}
	var fooLine, barLine string
	for _, l := range lines {
		if strings.Contains(l, "Foo") {
			fooLine = l
		}
		if strings.Contains(l, "bar") {
			barLine = l
		}
	}
	if fooLine == "" || barLine == "" {
		t.Fatal("should have Foo and bar lines")
	}
	if !strings.Contains(fooLine, "\x1b[3m") || !strings.Contains(barLine, "\x1b[3m") {
		t.Fatalf("both lines should have italic: foo=%q bar=%q", fooLine, barLine)
	}
	if strings.Contains(fooLine, "\x1b[35m") || strings.Contains(barLine, "\x1b[35m") {
		t.Fatalf("blockquotes should NOT have magenta color: foo=%q bar=%q", fooLine, barLine)
	}
}

func TestBlockquote_ExplicitMultilineConsistentStyling(t *testing.T) {
	m := New(">Foo\n>bar", 0, 0, defaultMarkdownTheme(),
		&DefaultTextStyle{Color: sgr(36, 39)}, nil)
	lines := m.Render(80)
	pl := mapLines(lines, stripANSI)
	quoted := 0
	for _, l := range pl {
		if strings.HasPrefix(l, "│ ") {
			quoted++
		}
	}
	if quoted != 2 {
		t.Fatalf("expected 2 quoted lines, got %#v", pl)
	}
	var fooLine, barLine string
	for _, l := range lines {
		if strings.Contains(l, "Foo") {
			fooLine = l
		}
		if strings.Contains(l, "bar") {
			barLine = l
		}
	}
	if !strings.Contains(fooLine, "\x1b[3m") || !strings.Contains(barLine, "\x1b[3m") {
		t.Fatalf("both lines should have italic")
	}
	if strings.Contains(fooLine, "\x1b[36m") || strings.Contains(barLine, "\x1b[36m") {
		t.Fatalf("blockquotes should NOT have cyan color")
	}
}

func TestBlockquote_ListContentInside(t *testing.T) {
	m := New("> 1. bla bla\n> - nested bullet", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := mapLines(m.Render(80), stripANSI)
	var quoted []string
	for _, l := range pl {
		if strings.HasPrefix(l, "│ ") {
			quoted = append(quoted, l)
		}
	}
	if !containsLine(quoted, "1. bla bla") {
		t.Fatalf("missing ordered list item: %#v", quoted)
	}
	if !containsLine(quoted, "- nested bullet") {
		t.Fatalf("missing unordered list item: %#v", quoted)
	}
}

func TestBlockquote_WrapLongLinesWithBorder(t *testing.T) {
	long := "This is a very long blockquote line that should wrap to multiple lines when rendered"
	m := New("> "+long, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(30))
	var content []string
	for _, l := range pl {
		if len(l) > 0 {
			content = append(content, l)
		}
	}
	if len(content) <= 1 {
		t.Fatalf("expected multiple wrapped lines: %#v", content)
	}
	for _, l := range content {
		if !strings.HasPrefix(l, "│ ") {
			t.Fatalf("wrapped line should have quote border: %q", l)
		}
	}
	all := strings.Join(content, " ")
	for _, want := range []string{"very long", "blockquote", "multiple"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing %q", want)
		}
	}
}

func TestBlockquote_IndentWrappedWithStyling(t *testing.T) {
	m := New("> This is styled text that is long enough to wrap", 0, 0, defaultMarkdownTheme(),
		&DefaultTextStyle{Color: sgr(33, 39), Italic: true}, nil)
	lines := m.Render(25)
	pl := plain(lines)
	var content []string
	for _, l := range pl {
		if len(l) > 0 {
			content = append(content, l)
		}
	}
	for _, l := range content {
		if !strings.HasPrefix(l, "│ ") {
			t.Fatalf("line should have quote border: %q", l)
		}
	}
	all := strings.Join(lines, "\n")
	if !strings.Contains(all, "\x1b[3m") {
		t.Fatal("should have italic")
	}
	if strings.Contains(all, "\x1b[33m") {
		t.Fatal("should NOT have yellow color from default style")
	}
}

func TestBlockquote_InlineFormattingReapplyQuoteStyle(t *testing.T) {
	m := New("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme(), nil, nil)
	lines := m.Render(80)
	pl := mapLines(lines, stripANSI)
	hasBorder := false
	for _, l := range pl {
		if strings.HasPrefix(l, "│ ") {
			hasBorder = true
		}
	}
	if !hasBorder {
		t.Fatal("should have quote border")
	}
	allPlain := strings.Join(pl, " ")
	for _, want := range []string{"Quote with", "bold", "code"} {
		if !strings.Contains(allPlain, want) {
			t.Fatalf("missing %q", want)
		}
	}
	all := strings.Join(lines, "\n")
	for _, want := range []string{"\x1b[1m", "\x1b[33m", "\x1b[3m"} {
		if !strings.Contains(all, want) {
			t.Fatalf("missing style %q", want)
		}
	}
}
