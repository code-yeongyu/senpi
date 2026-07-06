package markdown

import (
	"strings"
	"testing"
)

// Ported from packages/tui/test/markdown.test.ts describe("Lists").
// tui test name -> Go test (see evidence mapping table).

func render80Plain(t *testing.T, src string) []string {
	t.Helper()
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	return plain(m.Render(80))
}

func containsLine(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func TestLists_SimpleNested(t *testing.T) {
	pl := render80Plain(t, "- Item 1\n  - Nested 1.1\n  - Nested 1.2\n- Item 2")
	for _, want := range []string{"- Item 1", "    - Nested 1.1", "    - Nested 1.2", "- Item 2"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestLists_DeeplyNested(t *testing.T) {
	pl := render80Plain(t, "- Level 1\n  - Level 2\n    - Level 3\n      - Level 4")
	for _, want := range []string{"- Level 1", "    - Level 2", "        - Level 3", "            - Level 4"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestLists_OrderedNested(t *testing.T) {
	pl := render80Plain(t, "1. First\n   1. Nested first\n   2. Nested second\n2. Second")
	for _, want := range []string{"1. First", "    1. Nested first", "    2. Nested second", "2. Second"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestLists_NormalizeOrderedMarkers(t *testing.T) {
	pl := render80Plain(t, "1. alpha\n1. beta\n1. gamma")
	want := []string{"1. alpha", "2. beta", "3. gamma"}
	assertLinesEqual(t, pl, want)
}

func TestLists_PreserveSourceMarkers(t *testing.T) {
	m := New("  4. forth\n  3. third\n\n10) ten\n7) seven\n\n+ plus\n* star\n- minus\n+", 0, 0,
		defaultMarkdownTheme(), nil, &Options{PreserveOrderedListMarkers: true})
	pl := plain(m.Render(80))
	want := []string{"4. forth", "3. third", "", "10) ten", "7) seven", "", "+ plus", "* star", "- minus", "+"}
	assertLinesEqual(t, pl, want)
}

func TestLists_MixedOrderedUnordered(t *testing.T) {
	pl := render80Plain(t, "1. Ordered item\n   - Unordered nested\n   - Another nested\n2. Second ordered\n   - More nested")
	for _, want := range []string{"1. Ordered item", "    - Unordered nested", "2. Second ordered"} {
		if !containsLine(pl, want) {
			t.Fatalf("missing %q in %#v", want, pl)
		}
	}
}

func TestLists_LooseBlankLines(t *testing.T) {
	src := "1. Lorem ipsum dolor sit amet.\n\n   Ut enim ad minim veniam.\n\n2. Duis aute irure dolor.\n\n   Excepteur sint occaecat cupidatat.\n\n3. Beep boop"
	pl := render80Plain(t, src)
	want := []string{
		"1. Lorem ipsum dolor sit amet.", "", "   Ut enim ad minim veniam.", "",
		"2. Duis aute irure dolor.", "", "   Excepteur sint occaecat cupidatat.", "", "3. Beep boop",
	}
	assertLinesEqual(t, pl, want)
}

func TestLists_TaskMarkers(t *testing.T) {
	pl := render80Plain(t, "- [ ] beep\n- [x] boop")
	assertLinesEqual(t, pl, []string{"- [ ] beep", "- [x] boop"})
}

func TestLists_NumberingAcrossCodeBlocks(t *testing.T) {
	src := "1. First item\n\n```typescript\n// code block\n```\n\n2. Second item\n\n```typescript\n// another code block\n```\n\n3. Third item"
	m := New(src, 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := mapLines(m.Render(80), func(l string) string { return strings.TrimSpace(stripANSI(l)) })
	var numbered []string
	for _, l := range pl {
		if len(l) > 0 && l[0] >= '0' && l[0] <= '9' && strings.Contains(l, ".") {
			// crude /^\d+\./ check
			dot := strings.IndexByte(l, '.')
			if dot > 0 && allDigits(l[:dot]) {
				numbered = append(numbered, l)
			}
		}
	}
	if len(numbered) != 3 {
		t.Fatalf("expected 3 numbered items, got %v", numbered)
	}
	if !strings.HasPrefix(numbered[0], "1.") || !strings.HasPrefix(numbered[1], "2.") || !strings.HasPrefix(numbered[2], "3.") {
		t.Fatalf("expected 1./2./3. got %v", numbered)
	}
}

func TestLists_WrapUnordered(t *testing.T) {
	m := New("- alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(20))
	assertLinesEqual(t, pl, []string{"- alpha beta gamma", "  delta epsilon"})
}

func TestLists_WrapOrdered(t *testing.T) {
	m := New("1. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(20))
	assertLinesEqual(t, pl, []string{"1. alpha beta gamma", "   delta epsilon"})
}

func TestLists_WrapOrderedMultiDigit(t *testing.T) {
	m := New("10. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(21))
	assertLinesEqual(t, pl, []string{"10. alpha beta gamma", "    delta epsilon"})
}

func TestLists_WrapNested(t *testing.T) {
	m := New("- parent\n  - alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(24))
	assertLinesEqual(t, pl, []string{"- parent", "    - alpha beta gamma", "      delta epsilon"})
}

func TestLists_WrapNestedUnderOrdered(t *testing.T) {
	m := New("1. parent\n   - alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(24))
	assertLinesEqual(t, pl, []string{"1. parent", "    - alpha beta gamma", "      delta epsilon"})
}

func TestLists_BlockquoteInside(t *testing.T) {
	m := New("- > alpha beta gamma delta epsilon zeta", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(24))
	assertLinesEqual(t, pl, []string{"- │ alpha beta gamma", "  │ delta epsilon zeta"})
}

func TestLists_CodeBlockInside(t *testing.T) {
	m := New("- ```ts\n  alpha beta gamma delta epsilon zeta\n  ```", 0, 0, defaultMarkdownTheme(), nil, nil)
	pl := plain(m.Render(24))
	assertLinesEqual(t, pl, []string{"- ```ts", "    alpha beta gamma", "  delta epsilon zeta", "  ```"})
}

// --- helpers shared across contract test files ---

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func assertLinesEqual(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("line count mismatch: got %d want %d\n got=%#v\nwant=%#v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d mismatch:\n got=%q\nwant=%q\n(all got=%#v)", i, got[i], want[i], got)
		}
	}
}
