package markdown

import (
	"strings"
	"testing"
)

// Ported from packages/tui/test/markdown.test.ts: Combined features, Backslash
// escapes, Pre-styled text, Heading-with-inline-code, Strikethrough, HTML-like.

func grayItalicStyle() *DefaultTextStyle {
	// chalk.gray == \x1b[90m ... \x1b[39m
	return &DefaultTextStyle{
		Color:  sgr(90, 39),
		Italic: true,
	}
}

func TestCombined_ListsAndTables(t *testing.T) {
	src := "# Test Document\n\n- Item 1\n  - Nested item\n- Item 2\n\n| Col1 | Col2 |\n| --- | --- |\n| A | B |"
	pl := render80Plain(t, src)
	for _, want := range []string{"Test Document", "- Item 1", "    - Nested item", "Col1", "│"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestBackslash_NormalizeByDefault(t *testing.T) {
	m := New(`"\"`, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	assertLinesEqual(t, pl, []string{`""`})
}

func TestBackslash_PreserveWhenConfigured(t *testing.T) {
	m := New(`"\"`, 0, 0, defaultMarkdownTheme(), nil, &Options{PreserveBackslashEscapes: true})
	pl := plain(m.Render(80))
	assertLinesEqual(t, pl, []string{`"\"`})
}

func TestPreStyled_GrayItalicAfterInlineCode(t *testing.T) {
	m := New("This is thinking with `inline code` and more text after", 1, 0,
		defaultMarkdownTheme(), grayItalicStyle(), nil)
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "inline code") {
		t.Fatal("should contain inline code text")
	}
	if !strings.Contains(joined, "\x1b[90m") {
		t.Fatal("should have gray color code")
	}
	if !strings.Contains(joined, "\x1b[3m") {
		t.Fatal("should have italic code")
	}
	if !strings.Contains(joined, "\x1b[33m") {
		t.Fatal("should style inline code (yellow)")
	}
}

func TestPreStyled_GrayItalicAfterBold(t *testing.T) {
	m := New("This is thinking with **bold text** and more after", 1, 0,
		defaultMarkdownTheme(), grayItalicStyle(), nil)
	joined := strings.Join(m.Render(80), "\n")
	for _, want := range []string{"bold text", "\x1b[90m", "\x1b[3m", "\x1b[1m"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q", want)
		}
	}
}

func TestHeadingInlineCode_PreserveH3StyleAfterCode(t *testing.T) {
	m := New("### Why `sourceInfo` should not be optional", 0, 0, defaultMarkdownTheme(), nil, nil)
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "\x1b[33m") {
		t.Fatal("should have yellow for inline code")
	}
	idx := strings.Index(joined, "should not be optional")
	if idx <= 0 {
		t.Fatal("should contain text after inline code")
	}
	start := idx - 40
	if start < 0 {
		start = 0
	}
	preceding := joined[start:idx]
	if !strings.Contains(preceding, "\x1b[1m") {
		t.Fatalf("should re-apply bold before text after code: %q", preceding)
	}
	if !strings.Contains(preceding, "\x1b[36m") {
		t.Fatalf("should re-apply cyan before text after code: %q", preceding)
	}
}

func TestHeadingInlineCode_PreserveH1StyleAfterCode(t *testing.T) {
	m := New("# Title with `code` inside", 0, 0, defaultMarkdownTheme(), nil, nil)
	joined := strings.Join(m.Render(80), "\n")
	idx := strings.Index(joined, "inside")
	if idx <= 0 {
		t.Fatal("should contain text after inline code")
	}
	start := idx - 40
	if start < 0 {
		start = 0
	}
	preceding := joined[start:idx]
	for _, want := range []string{"\x1b[1m", "\x1b[36m", "\x1b[4m"} {
		if !strings.Contains(preceding, want) {
			t.Fatalf("h1 should re-apply %q: %q", want, preceding)
		}
	}
}

func TestHeadingInlineCode_PreserveH2StyleAfterBold(t *testing.T) {
	m := New("## Heading with **bold** and more", 0, 0, defaultMarkdownTheme(), nil, nil)
	joined := strings.Join(m.Render(80), "\n")
	idx := strings.Index(joined, "and more")
	if idx <= 0 {
		t.Fatal("should contain text after bold")
	}
	start := idx - 40
	if start < 0 {
		start = 0
	}
	preceding := joined[start:idx]
	if !strings.Contains(preceding, "\x1b[1m") || !strings.Contains(preceding, "\x1b[36m") {
		t.Fatalf("h2 should re-apply bold+cyan: %q", preceding)
	}
}

func TestStrikethrough_DoubleTilde(t *testing.T) {
	m := New("Use ~~strikethrough~~ here", 0, 0, defaultMarkdownTheme(), nil, nil)
	lines := m.Render(80)
	joined := strings.Join(lines, "\n")
	joinedPlain := strings.Join(mapLines(lines, stripANSI), " ")
	if !strings.Contains(joined, "\x1b[9m") {
		t.Fatal("should apply strikethrough styling")
	}
	if !strings.Contains(joinedPlain, "strikethrough") {
		t.Fatal("should include struck text content")
	}
	if strings.Contains(joinedPlain, "~~strikethrough~~") {
		t.Fatal("should not render delimiters as text")
	}
}

func TestStrikethrough_SingleTildePlain(t *testing.T) {
	m := New("Use ~strikethrough~ literally", 0, 0, defaultMarkdownTheme(), nil, nil)
	lines := m.Render(80)
	joined := strings.Join(lines, "\n")
	joinedPlain := strings.Join(mapLines(lines, stripANSI), " ")
	if !strings.Contains(joinedPlain, "~strikethrough~") {
		t.Fatal("single-tilde delimiters should remain visible")
	}
	if strings.Contains(joined, "\x1b[9m") {
		t.Fatal("single-tilde text should not use strikethrough styling")
	}
}

func TestHTMLLike_InlineTagsAsText(t *testing.T) {
	m := New("This is text with <thinking>hidden content</thinking> that should be visible", 0, 0,
		defaultMarkdownTheme(), nil, nil)
	joinedPlain := strings.Join(mapLines(m.Render(80), stripANSI), " ")
	if !strings.Contains(joinedPlain, "hidden content") && !strings.Contains(joinedPlain, "<thinking>") {
		t.Fatalf("should render tags or content as text, got %q", joinedPlain)
	}
}

func TestHTMLLike_TagsInCodeBlock(t *testing.T) {
	m := New("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme(), nil, nil)
	joinedPlain := strings.Join(mapLines(m.Render(80), stripANSI), "\n")
	if !strings.Contains(joinedPlain, "<div>") || !strings.Contains(joinedPlain, "</div>") {
		t.Fatalf("should render HTML in code blocks, got %q", joinedPlain)
	}
}
