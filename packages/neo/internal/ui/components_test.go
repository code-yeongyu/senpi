package ui

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// Contract sources:
//   loader.ts            -> Loader display composition (indicator + message)
//   spacer.ts            -> Spacer emits N empty lines
//   dynamic-border.ts    -> a single rule line "─"*width, width>=1
//   box.ts               -> padding + full-width lines
//   cancellable-loader.ts-> cancel binding + aborted flag

func testTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	return th
}

// Loader: with a static single frame and a message formatter, the composed line
// is "<frame> <message>" (mirrors loader.test.ts "uses a message formatter").
func TestLoader_ComposesIndicatorAndMessage(t *testing.T) {
	l := NewLoader(testTheme(t), "Working")
	l.SetFrames([]string{"•"})
	line := StripANSI(l.Line())
	if !strings.Contains(line, "• ") || !strings.Contains(line, "Working") {
		t.Fatalf("loader line: want indicator+message, got %q", line)
	}
}

// Loader: a message formatter receives the message + a finite elapsed-animation
// time and its return value replaces the colored message. Ported from
// loader.test.ts "uses a message formatter with elapsed animation time": with a
// static "•" frame and identity color fns, the composed line is "• [true]Working"
// where "[true]" proves the formatter saw a finite (non-negative) elapsed value.
func TestLoader_MessageFormatterElapsedTime(t *testing.T) {
	l := NewLoader(testTheme(t), "Working")
	// Identity color fns so the formatter output is asserted verbatim, matching
	// the TS test's (text) => text spinner/message color fns.
	l.SetColors(func(s string) string { return s }, func(s string) string { return s })
	l.SetFrames([]string{"•"})
	l.SetMessageFormatter(func(message string, animationElapsedMs int64) string {
		finite := animationElapsedMs >= 0 // Go int64 is always finite; assert non-negative
		return "[" + boolStr(finite) + "]" + message
	})
	line := l.Line()
	if !strings.Contains(line, "• [true]Working") {
		t.Fatalf("want formatted loader line containing %q, got %q", "• [true]Working", line)
	}
}

// Loader: when the indicator is hidden AND a message formatter is set, the
// formatter output renders alone (loader.test.ts "formats messages when the
// indicator is hidden" uses messageFormatter: (m) => `[${m}]`).
func TestLoader_MessageFormatterHiddenIndicator(t *testing.T) {
	l := NewLoader(testTheme(t), "Working")
	l.SetColors(func(s string) string { return s }, func(s string) string { return s })
	l.SetFrames(nil)
	l.SetMessageFormatter(func(message string, _ int64) string { return "[" + message + "]" })
	if got := strings.TrimSpace(l.Line()); got != "[Working]" {
		t.Fatalf("hidden-indicator formatted line: want %q, got %q", "[Working]", got)
	}
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// Loader: an empty frames slice hides the indicator entirely (loader.test.ts
// "formats messages when the indicator is hidden").
func TestLoader_HiddenIndicator(t *testing.T) {
	l := NewLoader(testTheme(t), "Working")
	l.SetFrames(nil)
	line := StripANSI(l.Line())
	if strings.TrimSpace(line) != "Working" {
		t.Fatalf("hidden-indicator line: want %q, got %q", "Working", line)
	}
}

// Loader: advancing the frame cycles through the theme's braille spinner family
// including the grok ⠹ frame.
func TestLoader_AdvancesThroughBrailleFrames(t *testing.T) {
	l := NewLoader(testTheme(t), "x")
	seen := map[string]bool{}
	for i := 0; i < 10; i++ {
		seen[l.Frame()] = true
		l.Advance()
	}
	if !seen["⠹"] {
		t.Fatalf("spinner should include grok frame ⠹, saw %v", seen)
	}
}

// CancellableLoader: the cancel key aborts and flips the aborted flag + fires
// onAbort (cancellable-loader.ts).
func TestCancellableLoader_CancelAborts(t *testing.T) {
	l := NewCancellableLoader(testTheme(t), "Working")
	fired := false
	l.OnAbort = func() { fired = true }
	if l.Aborted() {
		t.Fatalf("should not start aborted")
	}
	l.Cancel()
	if !l.Aborted() {
		t.Fatalf("should be aborted after Cancel")
	}
	if !fired {
		t.Fatalf("onAbort should fire on Cancel")
	}
}

// Spacer: N empty lines (spacer.ts).
func TestSpacer_EmitsEmptyLines(t *testing.T) {
	s := NewSpacer(3)
	lines := s.Render(40)
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %d", len(lines))
	}
	for i, l := range lines {
		if l != "" {
			t.Fatalf("line %d should be empty, got %q", i, l)
		}
	}
}

// DynamicBorder: single rule line of width, min 1 (dynamic-border.ts).
func TestDynamicBorder_RuleLineWidth(t *testing.T) {
	b := NewDynamicBorder(testTheme(t))
	lines := b.Render(20)
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d", len(lines))
	}
	if w := VisibleWidth(lines[0]); w != 20 {
		t.Fatalf("rule width: want 20, got %d", w)
	}
	if !strings.Contains(StripANSI(lines[0]), "─") {
		t.Fatalf("want box-drawing rule char, got %q", lines[0])
	}
}

func TestDynamicBorder_MinWidthOne(t *testing.T) {
	b := NewDynamicBorder(testTheme(t))
	lines := b.Render(0)
	if len(lines) != 1 || VisibleWidth(lines[0]) != 1 {
		t.Fatalf("zero width should degrade to a 1-col rule, got %d lines width %d", len(lines), VisibleWidth(lines[0]))
	}
}

// Box: pads each content line to full width and adds vertical padding (box.ts).
func TestBox_PadsToWidthWithPadding(t *testing.T) {
	b := NewBox(1, 1)
	b.AddChild(NewTruncatedText("hi", 0, 0))
	lines := b.Render(20)
	// 1 top pad + 1 content + 1 bottom pad
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %d", len(lines))
	}
	for i, l := range lines {
		if w := VisibleWidth(l); w != 20 {
			t.Fatalf("box line %d width: want 20, got %d", i, w)
		}
	}
}

func TestBox_EmptyChildrenRendersNothing(t *testing.T) {
	b := NewBox(1, 1)
	if lines := b.Render(20); len(lines) != 0 {
		t.Fatalf("empty box should render no lines, got %d", len(lines))
	}
}
