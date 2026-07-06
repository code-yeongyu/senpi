package builtinext

import (
	"reflect"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// Diff has no dedicated TS test suite; these are contract tests derived from
// diff.ts:40-62 (git status --porcelain parsing) and diff.ts:135-217 (picker).

// TestParseGitStatus ports the diff.ts porcelain parser: two-char XY status,
// filename after column 2, status-code -> short label translation, min length.
func TestParseGitStatus(t *testing.T) {
	out := strings.Join([]string{
		" M src/modified.go",
		"A  src/added.go",
		" D src/deleted.go",
		"?? src/untracked.go",
		"R  old.go -> new.go",
		"C  copied.go",
		"UU conflict.go",
	}, "\n")
	files := ParseGitStatus(out)
	want := []FileDiffInfo{
		{Status: "M", File: "src/modified.go"},
		{Status: "A", File: "src/added.go"},
		{Status: "D", File: "src/deleted.go"},
		{Status: "?", File: "src/untracked.go"},
		{Status: "R", File: "old.go -> new.go"},
		{Status: "C", File: "copied.go"},
		// "UU" has no M/A/D/?/R/C -> status.trim() "UU"
		{Status: "UU", File: "conflict.go"},
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("ParseGitStatus:\n got %#v\nwant %#v", files, want)
	}
}

// TestParseGitStatusSkipsShortLines verifies lines shorter than 4 chars are
// skipped (diff.ts:46 `if (line.length < 4) continue`).
func TestParseGitStatusSkipsShortLines(t *testing.T) {
	out := " M a\n\nXY\n M valid.go"
	files := ParseGitStatus(out)
	// " M a" is exactly 4 chars -> file "a"; "XY" too short; blank skipped.
	want := []FileDiffInfo{
		{Status: "M", File: "a"},
		{Status: "M", File: "valid.go"},
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("got %#v want %#v", files, want)
	}
}

// TestDiffPickerRendersStatusAndPaging renders the diff picker and asserts the
// status column + file, title, and help hint (diff.ts:135-217).
func TestDiffPickerRendersStatusAndPaging(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	files := []FileDiffInfo{
		{Status: "M", File: "changed.go"},
		{Status: "A", File: "new.go"},
		{Status: "D", File: "gone.go"},
	}
	ov := NewDiffPickerOverlay(DiffPickerOptions{
		Files: files, Theme: th, Keybindings: km,
		OnOpen: func(FileDiffInfo) {}, Done: func() {}, RequestRender: func() {},
	})
	joined := stripANSI(strings.Join(ov.Render(80), "\n"))
	if !strings.Contains(joined, "Select file to diff") {
		t.Fatalf("diff picker should show its title, got:\n%s", joined)
	}
	if !strings.Contains(joined, "M changed.go") {
		t.Fatalf("diff picker should show the status + file, got:\n%s", joined)
	}
	if !strings.Contains(joined, "↑↓ navigate") {
		t.Fatalf("diff picker should show the help hint, got:\n%s", joined)
	}
}

func TestDiffPickerSelectOpens(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	files := []FileDiffInfo{
		{Status: "M", File: "first.go"},
		{Status: "A", File: "second.go"},
	}
	var opened FileDiffInfo
	ov := NewDiffPickerOverlay(DiffPickerOptions{
		Files: files, Theme: th, Keybindings: km,
		OnOpen: func(f FileDiffInfo) { opened = f }, Done: func() {}, RequestRender: func() {},
	})
	ov.HandleInput("\r")
	if opened.File != "first.go" {
		t.Fatalf("enter should open the first file, got %q", opened.File)
	}
}
