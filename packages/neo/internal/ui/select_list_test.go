package ui

import (
	"strings"
	"testing"
)

// Contract source: packages/tui/test/select-list.test.ts.
// The binding contract is column layout: descriptions stay vertically aligned
// when the primary column is truncated, the configured min/max primary-column
// widths are honored, an override truncator preserves alignment, and multiline
// descriptions collapse to a single line. Visual styling (grok highlight,
// scrollbar, count marker) is asserted separately by the harness goldens.

// plainSelectTheme is an identity theme so VisibleWidth math is unaffected by
// SGR — mirrors the TS testTheme (all pass-through functions).
func plainSelectTheme() SelectListTheme {
	id := func(s string) string { return s }
	return SelectListTheme{
		SelectedPrefix: id,
		SelectedText:   id,
		Description:    id,
		ScrollInfo:     id,
		NoMatch:        id,
	}
}

// visibleIndexOf returns the visible column at which `text` starts in `line`.
func visibleIndexOf(t *testing.T, line, text string) int {
	t.Helper()
	idx := strings.Index(line, text)
	if idx < 0 {
		t.Fatalf("substring %q not found in %q", text, line)
	}
	return VisibleWidth(line[:idx])
}

func TestSelectList_NormalizesMultilineDescriptionToSingleLine(t *testing.T) {
	items := []SelectItem{
		{Value: "test", Label: "test", Description: "Line one\nLine two\nLine three"},
	}
	list := NewSelectList(items, 5, plainSelectTheme(), SelectListLayout{})
	rendered := list.Render(100)
	if len(rendered) == 0 {
		t.Fatalf("expected rendered lines")
	}
	if strings.Contains(rendered[0], "\n") {
		t.Fatalf("row must not contain a newline: %q", rendered[0])
	}
	if !strings.Contains(rendered[0], "Line one Line two Line three") {
		t.Fatalf("multiline description must collapse to single line, got %q", rendered[0])
	}
}

func TestSelectList_KeepsDescriptionsAlignedWhenPrimaryTruncated(t *testing.T) {
	items := []SelectItem{
		{Value: "short", Label: "short", Description: "short description"},
		{
			Value:       "very-long-command-name-that-needs-truncation",
			Label:       "very-long-command-name-that-needs-truncation",
			Description: "long description",
		},
	}
	list := NewSelectList(items, 5, plainSelectTheme(), SelectListLayout{})
	rendered := list.Render(80)
	a := visibleIndexOf(t, rendered[0], "short description")
	b := visibleIndexOf(t, rendered[1], "long description")
	if a != b {
		t.Fatalf("descriptions misaligned: row0 col %d, row1 col %d", a, b)
	}
}

func TestSelectList_UsesConfiguredMinimumPrimaryColumnWidth(t *testing.T) {
	items := []SelectItem{
		{Value: "a", Label: "a", Description: "first"},
		{Value: "bb", Label: "bb", Description: "second"},
	}
	list := NewSelectList(items, 5, plainSelectTheme(), SelectListLayout{
		MinPrimaryColumnWidth: 12,
		MaxPrimaryColumnWidth: 20,
	})
	rendered := list.Render(80)
	// Contract is the VISIBLE column, not the byte offset (the TS test's literal
	// 14 is a UTF-16 code-unit index tied to its 1-unit prefix glyph; the grok ❯
	// prefix is 2 visible cells, so the description column is prefix(2)+primary
	// column(12) = 14 in visible cells for both rows).
	if got := visibleIndexOf(t, rendered[0], "first"); got != 14 {
		t.Fatalf("row0 'first' visible col: want 14, got %d (line=%q)", got, rendered[0])
	}
	if got := visibleIndexOf(t, rendered[1], "second"); got != 14 {
		t.Fatalf("row1 'second' visible col: want 14, got %d (line=%q)", got, rendered[1])
	}
}

func TestSelectList_UsesConfiguredMaximumPrimaryColumnWidth(t *testing.T) {
	items := []SelectItem{
		{
			Value:       "very-long-command-name-that-needs-truncation",
			Label:       "very-long-command-name-that-needs-truncation",
			Description: "first",
		},
		{Value: "short", Label: "short", Description: "second"},
	}
	list := NewSelectList(items, 5, plainSelectTheme(), SelectListLayout{
		MinPrimaryColumnWidth: 12,
		MaxPrimaryColumnWidth: 20,
	})
	rendered := list.Render(80)
	if got := visibleIndexOf(t, rendered[0], "first"); got != 22 {
		t.Fatalf("row0 'first' col: want 22, got %d", got)
	}
	if got := visibleIndexOf(t, rendered[1], "second"); got != 22 {
		t.Fatalf("row1 'second' col: want 22, got %d", got)
	}
}

func TestSelectList_OverrideTruncationPreservesAlignment(t *testing.T) {
	items := []SelectItem{
		{
			Value:       "very-long-command-name-that-needs-truncation",
			Label:       "very-long-command-name-that-needs-truncation",
			Description: "first",
		},
		{Value: "short", Label: "short", Description: "second"},
	}
	list := NewSelectList(items, 5, plainSelectTheme(), SelectListLayout{
		MinPrimaryColumnWidth: 12,
		MaxPrimaryColumnWidth: 12,
		TruncatePrimary: func(c SelectTruncateContext) string {
			if VisibleWidth(c.Text) <= c.MaxWidth {
				return c.Text
			}
			end := c.MaxWidth - 1
			if end < 0 {
				end = 0
			}
			return TruncateToWidth(c.Text, end, "") + "…"
		},
	})
	rendered := list.Render(80)
	if !strings.Contains(rendered[0], "…") {
		t.Fatalf("expected custom ellipsis in %q", rendered[0])
	}
	a := visibleIndexOf(t, rendered[0], "first")
	b := visibleIndexOf(t, rendered[1], "second")
	if a != b {
		t.Fatalf("descriptions misaligned with override: row0 %d row1 %d", a, b)
	}
}

// Edge-case contract required by the plan QA: empty list + single-item list.
func TestSelectList_EmptyListRendersNoMatch(t *testing.T) {
	list := NewSelectList(nil, 5, plainSelectTheme(), SelectListLayout{})
	rendered := list.Render(80)
	if len(rendered) != 1 {
		t.Fatalf("empty list should render exactly the no-match line, got %d lines", len(rendered))
	}
	if !strings.Contains(rendered[0], "No matching") {
		t.Fatalf("empty list should show no-match hint, got %q", rendered[0])
	}
}

func TestSelectList_SingleItemNoScrollIndicator(t *testing.T) {
	items := []SelectItem{{Value: "only", Label: "only", Description: "the one"}}
	list := NewSelectList(items, 5, plainSelectTheme(), SelectListLayout{})
	rendered := list.Render(80)
	if len(rendered) != 1 {
		t.Fatalf("single item should render exactly one row (no scroll marker), got %d", len(rendered))
	}
	if !strings.Contains(StripANSI(rendered[0]), "only") {
		t.Fatalf("single row should contain the item, got %q", rendered[0])
	}
}
