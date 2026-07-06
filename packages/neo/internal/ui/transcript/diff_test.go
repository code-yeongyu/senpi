package transcript

// Ported contract for the diff renderer. Source:
// packages/coding-agent/src/modes/interactive/components/diff.ts renderDiff +
// renderIntraLineDiff. Style functions are injected (tagging removed/added/
// context/inverse spans) so the structural grouping + intra-line highlighting
// is asserted deterministically without depending on exact theme SGR bytes.
//
// RED first: RenderDiff / DiffStyles do not exist until the GREEN impl lands.

import (
	"strings"
	"testing"
)

// tagStyles wraps each span in <tag>...</tag> so tests can assert which lines
// were classified as removed/added/context and where inverse highlighting landed.
func tagStyles() DiffStyles {
	wrap := func(tag string) func(string) string {
		return func(s string) string { return "<" + tag + ">" + s + "</" + tag + ">" }
	}
	return DiffStyles{
		Removed: wrap("rem"),
		Added:   wrap("add"),
		Context: wrap("ctx"),
		Inverse: wrap("inv"),
	}
}

func TestRenderDiff_ContextLines(t *testing.T) {
	out := RenderDiff(" 12 unchanged line", tagStyles())
	if !strings.Contains(out, "<ctx>") {
		t.Fatalf("context line not styled: %q", out)
	}
	if strings.Contains(out, "<add>") || strings.Contains(out, "<rem>") {
		t.Fatalf("context misclassified: %q", out)
	}
}

func TestRenderDiff_StandaloneAdded(t *testing.T) {
	// diff.ts renders standalone added lines as `+${lineNum} ${content}`. The
	// lineNum capture group `(\s*\d*)` keeps leading whitespace, so "+ 5 new
	// line" → prefix "+", lineNum " 5", content "new line" → "+ 5 new line".
	out := RenderDiff("+ 5 new line", tagStyles())
	if !strings.Contains(out, "<add>+ 5 new line</add>") {
		t.Fatalf("added line = %q", out)
	}
	// A no-space line-number form: "+5 added".
	out2 := RenderDiff("+5 added", tagStyles())
	if !strings.Contains(out2, "<add>+5 added</add>") {
		t.Fatalf("added line (no space num) = %q", out2)
	}
}

func TestRenderDiff_SingleLineModificationIntraHighlight(t *testing.T) {
	// One removed + one added line → intra-line diff with inverse on the changed
	// token (renderIntraLineDiff). "foo" → "bar" is a single-word replacement.
	diff := "-10 foo\n+10 bar"
	out := RenderDiff(diff, tagStyles())
	// Removed line carries inverse on the removed token; added on the added.
	if !strings.Contains(out, "<rem>") || !strings.Contains(out, "<add>") {
		t.Fatalf("missing removed/added rows: %q", out)
	}
	if !strings.Contains(out, "<inv>foo</inv>") || !strings.Contains(out, "<inv>bar</inv>") {
		t.Fatalf("intra-line inverse not applied: %q", out)
	}
}

func TestRenderDiff_MultiRemovedMultiAddedNoIntra(t *testing.T) {
	// 2 removed + 2 added → show all removed then all added, no intra-line diff.
	diff := "-1 a\n-2 b\n+1 c\n+2 d"
	out := RenderDiff(diff, tagStyles())
	lines := strings.Split(out, "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d: %q", len(lines), out)
	}
	if !strings.HasPrefix(lines[0], "<rem>") || !strings.HasPrefix(lines[1], "<rem>") {
		t.Fatalf("removed block order wrong: %q", out)
	}
	if !strings.HasPrefix(lines[2], "<add>") || !strings.HasPrefix(lines[3], "<add>") {
		t.Fatalf("added block order wrong: %q", out)
	}
	// No intra-line inverse for multi-line blocks.
	if strings.Contains(out, "<inv>") {
		t.Fatalf("unexpected intra-line highlight in multi-line block: %q", out)
	}
}

func TestRenderDiff_TabsReplacedWithSpaces(t *testing.T) {
	out := RenderDiff("+ 1 \tindented", tagStyles())
	if strings.Contains(out, "\t") {
		t.Fatalf("tab not replaced: %q", out)
	}
	if !strings.Contains(out, "   indented") {
		t.Fatalf("tab->3 spaces not applied: %q", out)
	}
}

func TestRenderDiff_IdenticalContentNoHighlight(t *testing.T) {
	// renderIntraLineDiffFastPath: identical old/new returns unchanged (no inverse).
	diff := "-3 same\n+3 same"
	out := RenderDiff(diff, tagStyles())
	if strings.Contains(out, "<inv>") {
		t.Fatalf("identical content should not highlight: %q", out)
	}
}
