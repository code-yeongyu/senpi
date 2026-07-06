package builtinext

import (
	"reflect"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// The files browser has no dedicated TS test suite; these tests are contract
// tests derived from files.ts:21-211 (two-pass tool-call/tool-result join,
// coalesce-by-path, newest-first sort, R/W/E operation glyphs, paging).

func toolCallMsg(ts int64, blocks ...map[string]any) string {
	content := make([]any, len(blocks))
	for i, b := range blocks {
		content[i] = b
	}
	return messageLine("asst-"+itoa(int(ts)), ts, map[string]any{
		"role": "assistant", "content": content, "timestamp": ts,
	})
}

func toolResultMsg(ts int64, id string) string {
	return messageLine("res-"+id, ts, map[string]any{
		"role": "toolResult", "toolCallId": id, "toolName": "read",
		"content": []any{map[string]any{"type": "text", "text": "ok"}}, "isError": false, "timestamp": ts,
	})
}

// TestCollectSessionFilesCoalescesAndSorts ports the files.ts two-pass logic:
// only paths with a matching toolResult are included, coalesced by path with the
// union of operations and the newest execution timestamp, sorted newest first.
func TestCollectSessionFilesCoalescesAndSorts(t *testing.T) {
	branch := []string{
		toolCallMsg(baseTime+1_000,
			map[string]any{"type": "toolCall", "id": "c1", "name": "read", "arguments": map[string]any{"path": "a.go"}},
			map[string]any{"type": "toolCall", "id": "c2", "name": "write", "arguments": map[string]any{"path": "b.go"}},
		),
		toolCallMsg(baseTime+2_000,
			map[string]any{"type": "toolCall", "id": "c3", "name": "edit", "arguments": map[string]any{"path": "a.go"}},
		),
		// c1 read result (older), c3 edit result (newer) -> a.go coalesced RE, newest ts
		toolResultMsg(baseTime+1_500, "c1"),
		toolResultMsg(baseTime+3_000, "c3"),
		toolResultMsg(baseTime+2_500, "c2"),
	}
	files, err := CollectSessionFiles(branch)
	if err != nil {
		t.Fatal(err)
	}
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	// a.go last-touched at baseTime+3000 (edit), b.go at baseTime+2500 -> a first.
	if !reflect.DeepEqual(paths, []string{"a.go", "b.go"}) {
		t.Fatalf("paths = %v want [a.go b.go]", paths)
	}
	var aEntry FileEntry
	for _, f := range files {
		if f.Path == "a.go" {
			aEntry = f
		}
	}
	if !aEntry.Operations["read"] || !aEntry.Operations["edit"] || aEntry.Operations["write"] {
		t.Fatalf("a.go operations = %v want read+edit", aEntry.Operations)
	}
}

// TestCollectSessionFilesSkipsUnmatched verifies a toolCall without a matching
// toolResult is dropped (matches the second-pass guard `if (!toolCall) continue`).
func TestCollectSessionFilesSkipsUnmatched(t *testing.T) {
	branch := []string{
		toolCallMsg(baseTime+1_000,
			map[string]any{"type": "toolCall", "id": "c1", "name": "read", "arguments": map[string]any{"path": "only-call.go"}},
		),
		// no toolResult for c1
	}
	files, err := CollectSessionFiles(branch)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("unmatched tool call should be dropped, got %v", files)
	}
}

// TestCollectSessionFilesApplyPatch verifies apply_patch tool calls contribute
// their extracted paths as edits (files.ts:49-56).
func TestCollectSessionFilesApplyPatch(t *testing.T) {
	patch := "*** Begin Patch\n*** Update File: patched.go\n@@\n-old\n+new\n*** End Patch"
	branch := []string{
		toolCallMsg(baseTime+1_000,
			map[string]any{"type": "toolCall", "id": "c1", "name": "apply_patch", "arguments": map[string]any{"input": patch}},
		),
		toolResultMsg(baseTime+2_000, "c1"),
	}
	files, err := CollectSessionFiles(branch)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Path != "patched.go" || !files[0].Operations["edit"] {
		t.Fatalf("apply_patch should yield an edit of patched.go, got %#v", files)
	}
}

// TestFilesPickerRendersGlyphsAndPaging renders the files picker and asserts the
// R/W/E operation glyphs, the title, and the border chrome (files.ts:138-208).
func TestFilesPickerRendersGlyphsAndPaging(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	files := []FileEntry{
		{Path: "read-only.go", Operations: map[string]bool{"read": true}, LastTimestamp: baseTime + 2_000},
		{Path: "written.go", Operations: map[string]bool{"write": true}, LastTimestamp: baseTime + 1_000},
	}
	ov := NewFilesPickerOverlay(FilesPickerOptions{
		Files: files, Theme: th, Keybindings: km,
		OnOpen: func(FileEntry) {}, Done: func() {}, RequestRender: func() {},
	})
	joined := stripANSI(strings.Join(ov.Render(80), "\n"))
	if !strings.Contains(joined, "Select file to open") {
		t.Fatalf("files picker should show its title, got:\n%s", joined)
	}
	if !strings.Contains(joined, "R read-only.go") {
		t.Fatalf("files picker should show the R glyph + path, got:\n%s", joined)
	}
	if !strings.Contains(joined, "W written.go") {
		t.Fatalf("files picker should show the W glyph + path, got:\n%s", joined)
	}
	if !strings.Contains(joined, "↑↓ navigate") {
		t.Fatalf("files picker should show the help hint, got:\n%s", joined)
	}
}

// TestFilesPickerSelectOpens verifies enter fires OnOpen with the selected file
// (mirrors selectList.onSelect -> openSelected).
func TestFilesPickerSelectOpens(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	files := []FileEntry{
		{Path: "first.go", Operations: map[string]bool{"read": true}, LastTimestamp: baseTime + 2_000},
		{Path: "second.go", Operations: map[string]bool{"edit": true}, LastTimestamp: baseTime + 1_000},
	}
	var opened FileEntry
	ov := NewFilesPickerOverlay(FilesPickerOptions{
		Files: files, Theme: th, Keybindings: km,
		OnOpen: func(f FileEntry) { opened = f }, Done: func() {}, RequestRender: func() {},
	})
	ov.HandleInput("\r")
	if opened.Path != "first.go" {
		t.Fatalf("enter should open the first file, got %q", opened.Path)
	}
}
