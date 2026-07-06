package builtinext

import (
	"strings"
	"testing"
)

// Redraws (/tui) has no dedicated TS test suite; the contract lives in
// redraws.ts:10-24: it reads tui.fullRedraws and notifies
// `TUI full redraws: <n>` at "info" level.

// TestRedrawsNotice ports the redraws.ts formatting contract: it produces the
// exact "info" notification string from the current full-redraw count.
func TestRedrawsNotice(t *testing.T) {
	cases := []struct {
		count int
		want  string
	}{
		{0, "TUI full redraws: 0"},
		{7, "TUI full redraws: 7"},
		{12345, "TUI full redraws: 12345"},
	}
	for _, c := range cases {
		msg, level := RedrawsNotice(c.count)
		if msg != c.want {
			t.Fatalf("RedrawsNotice(%d) msg = %q want %q", c.count, msg, c.want)
		}
		if level != "info" {
			t.Fatalf("RedrawsNotice level = %q want info", level)
		}
	}
}

// TestRedrawsCounterIncrements verifies the counter primitive neo uses to back
// tui.fullRedraws increments on each full redraw and reports its total.
func TestRedrawsCounterIncrements(t *testing.T) {
	c := &RedrawCounter{}
	if c.FullRedraws() != 0 {
		t.Fatalf("initial count = %d want 0", c.FullRedraws())
	}
	c.RecordFullRedraw()
	c.RecordFullRedraw()
	c.RecordFullRedraw()
	if c.FullRedraws() != 3 {
		t.Fatalf("after 3 redraws = %d want 3", c.FullRedraws())
	}
	msg, _ := RedrawsNotice(c.FullRedraws())
	if !strings.Contains(msg, "3") {
		t.Fatalf("notice should reflect the counter, got %q", msg)
	}
}
