package ui

import (
	"strings"
	"testing"
)

// Contract source:
// packages/coding-agent/src/modes/interactive/components/visual-truncate.ts:42
// truncateToVisualLines(text, maxVisualLines, width, paddingX=0) wraps text to
// visual lines (accounting for width-based line wrapping), and when there are
// more than maxVisualLines it keeps the LAST N and reports how many were skipped.
// The visual lines are produced by a Text component (paddingX margins, padded to
// full width); empty/whitespace-only text yields zero visual lines.

func TestTruncateToVisualLines_EmptyTextNoLines(t *testing.T) {
	res := TruncateToVisualLines("", 5, 40, 0)
	if len(res.VisualLines) != 0 || res.SkippedCount != 0 {
		t.Fatalf("empty text: want {[],0}, got {%d lines,%d skipped}", len(res.VisualLines), res.SkippedCount)
	}
}

func TestTruncateToVisualLines_WhitespaceOnlyNoLines(t *testing.T) {
	res := TruncateToVisualLines("   \n  ", 5, 40, 0)
	if len(res.VisualLines) != 0 || res.SkippedCount != 0 {
		t.Fatalf("whitespace-only text: want {[],0}, got {%d lines,%d skipped}", len(res.VisualLines), res.SkippedCount)
	}
}

func TestTruncateToVisualLines_FewerThanMaxKeepsAll(t *testing.T) {
	res := TruncateToVisualLines("line one\nline two", 5, 40, 0)
	if len(res.VisualLines) != 2 {
		t.Fatalf("want 2 visual lines, got %d: %q", len(res.VisualLines), res.VisualLines)
	}
	if res.SkippedCount != 0 {
		t.Fatalf("want skippedCount 0, got %d", res.SkippedCount)
	}
	// Each returned line is padded to exactly the render width.
	for i, l := range res.VisualLines {
		if w := VisibleWidth(l); w != 40 {
			t.Fatalf("visual line %d width: want 40, got %d (%q)", i, w, l)
		}
	}
}

func TestTruncateToVisualLines_KeepsLastNAndCountsSkipped(t *testing.T) {
	text := "l1\nl2\nl3\nl4\nl5"
	res := TruncateToVisualLines(text, 2, 40, 0)
	if len(res.VisualLines) != 2 {
		t.Fatalf("want 2 kept visual lines, got %d", len(res.VisualLines))
	}
	if res.SkippedCount != 3 {
		t.Fatalf("want skippedCount 3, got %d", res.SkippedCount)
	}
	// The LAST two lines are kept (l4, l5), not the first two.
	if !strings.Contains(res.VisualLines[0], "l4") || !strings.Contains(res.VisualLines[1], "l5") {
		t.Fatalf("want last two lines l4,l5, got %q", res.VisualLines)
	}
}

func TestTruncateToVisualLines_WrapsLongLineByWidth(t *testing.T) {
	// A single logical line longer than the content width wraps into multiple
	// visual lines; width-based wrapping is what makes this a "visual" truncate.
	long := "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda"
	res := TruncateToVisualLines(long, 100, 20, 0)
	if len(res.VisualLines) < 2 {
		t.Fatalf("long line should wrap into >=2 visual lines at width 20, got %d: %q", len(res.VisualLines), res.VisualLines)
	}
	for i, l := range res.VisualLines {
		if w := VisibleWidth(l); w != 20 {
			t.Fatalf("wrapped line %d width: want 20, got %d (%q)", i, w, l)
		}
	}
}

func TestTruncateToVisualLines_PaddingXMargins(t *testing.T) {
	// paddingX=1 inset: content wraps at width-2 and each line still pads to the
	// full render width (Text component margin behavior).
	res := TruncateToVisualLines("hi", 5, 10, 1)
	if len(res.VisualLines) != 1 {
		t.Fatalf("want 1 visual line, got %d", len(res.VisualLines))
	}
	line := res.VisualLines[0]
	if w := VisibleWidth(line); w != 10 {
		t.Fatalf("padded width: want 10, got %d (%q)", w, line)
	}
	// A left margin space precedes the content.
	if !strings.HasPrefix(line, " hi") {
		t.Fatalf("want left margin before content, got %q", line)
	}
}
