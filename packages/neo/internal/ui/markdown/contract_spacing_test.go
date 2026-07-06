package markdown

import (
	"strings"
	"testing"
)

// Ported from markdown.test.ts: Spacing after code blocks / dividers / headings
// / blockquotes.

func firstNonEmptyOffset(lines []string) int {
	for i, l := range lines {
		if l != "" {
			return i
		}
	}
	return -1
}

func TestSpacing_OneBlankAfterCodeBlock(t *testing.T) {
	src := "hello world\n\n```js\nconst hello = \"world\";\n```\n\nagain, hello world"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	// pi test uses plainLines.indexOf("```"): the opening fence renders as
	// "```js" (not an exact match), so the first exact "```" is the closing fence.
	closing := indexOf(pl, "```")
	if closing == -1 {
		t.Fatal("should have closing backticks")
	}
	after := pl[closing+1:]
	if got := firstNonEmptyOffset(after); got != 1 {
		t.Fatalf("expected 1 empty line after code block, got %d; after=%#v", got, after)
	}
}

func TestSpacing_NormalizeParagraphCodeSpacing(t *testing.T) {
	cases := []string{
		"hello this is text\n```\ncode block\n```\nmore text",
		"hello this is text\n\n```\ncode block\n```\n\nmore text",
	}
	want := []string{"hello this is text", "", "```", "  code block", "```", "", "more text"}
	for _, src := range cases {
		m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
		pl := plain(m.Render(80))
		assertLinesEqual(t, pl, want)
	}
}

func TestSpacing_NoTrailingBlankAfterCodeBlock(t *testing.T) {
	cases := []string{
		"```js\nconst hello = 'world';\n```",
		"hello world\n\n```js\nconst hello = 'world';\n```",
	}
	for _, src := range cases {
		m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
		pl := plain(m.Render(80))
		if len(pl) > 0 && pl[len(pl)-1] == "" {
			t.Fatalf("expected code block to end without a blank line: %#v", pl)
		}
	}
}

func TestSpacing_OneBlankAfterDivider(t *testing.T) {
	src := "hello world\n\n---\n\nagain, hello world"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	div := -1
	for i, l := range pl {
		if strings.Contains(l, "─") {
			div = i
			break
		}
	}
	if div == -1 {
		t.Fatal("should have divider")
	}
	after := pl[div+1:]
	if got := firstNonEmptyOffset(after); got != 1 {
		t.Fatalf("expected 1 empty line after divider, got %d; after=%#v", got, after)
	}
}

func TestSpacing_NoTrailingBlankAfterDivider(t *testing.T) {
	m := New("---", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	if len(pl) > 0 && pl[len(pl)-1] == "" {
		t.Fatalf("expected divider to end without a blank line: %#v", pl)
	}
}

func TestSpacing_OneBlankAfterHeading(t *testing.T) {
	src := "# Hello\n\nThis is a paragraph"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	h := -1
	for i, l := range pl {
		if strings.Contains(l, "Hello") {
			h = i
			break
		}
	}
	if h == -1 {
		t.Fatal("should have heading")
	}
	after := pl[h+1:]
	if got := firstNonEmptyOffset(after); got != 1 {
		t.Fatalf("expected 1 empty line after heading, got %d; after=%#v", got, after)
	}
}

func TestSpacing_NoTrailingBlankAfterHeading(t *testing.T) {
	m := New("# Hello", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	if len(pl) > 0 && pl[len(pl)-1] == "" {
		t.Fatalf("expected heading to end without a blank line: %#v", pl)
	}
}

func TestSpacing_OneBlankAfterBlockquote(t *testing.T) {
	src := "hello world\n\n> This is a quote\n\nagain, hello world"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	q := -1
	for i, l := range pl {
		if strings.Contains(l, "This is a quote") {
			q = i
			break
		}
	}
	if q == -1 {
		t.Fatal("should have blockquote")
	}
	after := pl[q+1:]
	if got := firstNonEmptyOffset(after); got != 1 {
		t.Fatalf("expected 1 empty line after blockquote, got %d; after=%#v", got, after)
	}
}

func TestSpacing_NoTrailingBlankAfterBlockquote(t *testing.T) {
	m := New("> This is a quote", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(80))
	if len(pl) > 0 && pl[len(pl)-1] == "" {
		t.Fatalf("expected blockquote to end without a blank line: %#v", pl)
	}
}

// helpers

func indexOf(lines []string, s string) int {
	for i, l := range lines {
		if l == s {
			return i
		}
	}
	return -1
}
