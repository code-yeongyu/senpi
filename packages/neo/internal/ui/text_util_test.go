package ui

import "testing"

// Contract source: packages/tui/src/utils.ts (visibleWidth, truncateToWidth).
// These are the width primitives every primitive component builds on; the
// grapheme/CJK/ANSI cases mirror the TS behavior the components depend on.

func TestVisibleWidth_ASCII(t *testing.T) {
	if w := VisibleWidth("hello"); w != 5 {
		t.Fatalf("want 5, got %d", w)
	}
}

func TestVisibleWidth_StripsANSI(t *testing.T) {
	// SGR-wrapped text has the same visible width as the raw text.
	if w := VisibleWidth("\x1b[31mhello\x1b[0m"); w != 5 {
		t.Fatalf("ANSI-wrapped: want 5, got %d", w)
	}
}

func TestVisibleWidth_CJKWide(t *testing.T) {
	// Korean syllables are width-2 each.
	if w := VisibleWidth("한글"); w != 4 {
		t.Fatalf("CJK width: want 4, got %d", w)
	}
}

func TestVisibleWidth_Empty(t *testing.T) {
	if w := VisibleWidth(""); w != 0 {
		t.Fatalf("want 0, got %d", w)
	}
}

func TestTruncateToWidth_FitsUnchanged(t *testing.T) {
	if got := TruncateToWidth("hello", 10, "..."); got != "hello" {
		t.Fatalf("want hello, got %q", got)
	}
}

func TestTruncateToWidth_TruncatesWithEllipsis(t *testing.T) {
	got := TruncateToWidth("hello world", 8, "...")
	if VisibleWidth(got) != 8 {
		t.Fatalf("truncated width: want 8, got %d (%q)", VisibleWidth(got), got)
	}
	if StripANSI(got)[len(StripANSI(got))-3:] != "..." {
		t.Fatalf("want trailing ellipsis, got %q", got)
	}
}

func TestTruncateToWidth_NoEllipsisArg(t *testing.T) {
	got := TruncateToWidth("hello world", 5, "")
	if got != "hello" {
		t.Fatalf("want hello, got %q", got)
	}
}

func TestTruncateToWidth_ZeroWidth(t *testing.T) {
	if got := TruncateToWidth("hello", 0, "..."); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

func TestTruncateToWidth_CJKGraphemeSafe(t *testing.T) {
	// Truncating "한글테스트" (10 cols) to 5 cols must not split a wide cell:
	// it fits "한" (2) + no room for ellipsis-less next → width stays <= 5.
	got := TruncateToWidth("한글테스트", 5, "")
	if VisibleWidth(got) > 5 {
		t.Fatalf("width overflow: %d (%q)", VisibleWidth(got), got)
	}
}
