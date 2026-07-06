package editor

import (
	"fmt"
	"regexp"
	"testing"
)

var argtestRe = regexp.MustCompile(`^/argtest\s+(\S+)$`)
var modelRe = regexp.MustCompile(`^/model\s+(\S+)$`)

// matchArgtest returns the argument prefix when `before` is `/argtest <arg>`.
func matchArgtest(before string) string {
	m := argtestRe.FindStringSubmatch(before)
	if m == nil {
		return ""
	}
	return m[1]
}

// matchModel returns the argument prefix when `before` is `/model <arg>`.
func matchModel(before string) string {
	m := modelRe.FindStringSubmatch(before)
	if m == nil {
		return ""
	}
	return m[1]
}

// newTestEditor builds an Editor with a fixed test viewport (80x24 by default)
// matching the tui suite's createTestTUI(). Terminal rows drive the editor's
// max-visible-lines math; cols default to 80.
func newTestEditor(t *testing.T) *Editor {
	t.Helper()
	return newTestEditorSized(t, 80, 24)
}

func newTestEditorSized(t *testing.T, cols, rows int) *Editor {
	t.Helper()
	e := New(Options{})
	e.SetViewport(cols, rows)
	return e
}

func assertText(t *testing.T, e *Editor, want string) {
	t.Helper()
	if got := e.GetText(); got != want {
		t.Fatalf("GetText() = %q, want %q", got, want)
	}
}

func assertCursor(t *testing.T, e *Editor, line, col int) {
	t.Helper()
	gl, gc := e.Cursor()
	if gl != line || gc != col {
		t.Fatalf("Cursor() = {line:%d col:%d}, want {line:%d col:%d}", gl, gc, line, col)
	}
}

func sprintf(format string, a ...any) string {
	return fmt.Sprintf(format, a...)
}
