package builtinext

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// --- resolveSessionHudRoot (ported from session-observer-scanner.test.ts) ----

func TestResolveSessionHudRoot(t *testing.T) {
	defaultRoot := "/home/user/.senpi/agent/sessions"
	cases := []struct {
		name       string
		sessionDir string
		want       string
	}{
		{"empty returns cross-cwd root", "", defaultRoot},
		{"equal to default returns default", defaultRoot, defaultRoot},
		{"subdir returns default", defaultRoot + "/encoded-cwd", defaultRoot},
		{"custom dir isolated", "/tmp/custom-sessions", "/tmp/custom-sessions"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ResolveSessionHudRoot(c.sessionDir, defaultRoot); got != c.want {
				t.Fatalf("ResolveSessionHudRoot(%q)=%q want %q", c.sessionDir, got, c.want)
			}
		})
	}
}

// --- scanSessionHudEntries (ported) -----------------------------------------

func TestScanSessionHudEntriesMissingRoot(t *testing.T) {
	root := t.TempDir()
	got, err := ScanSessionHudEntries(filepath.Join(root, "missing"), "")
	if err != nil || len(got) != 0 {
		t.Fatalf("missing root: got %v err %v", got, err)
	}
}

func TestScanSessionHudEntriesDiscoversAndSorts(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	writeSessionFile(t, sessionsDir, "20260520_old-session.jsonl", []string{
		sessionLine("old-session", "/repo-old", baseTime),
		userLine([]string{"old prompt"}, baseTime+1_000),
	})
	currentFile := writeSessionFile(t, sessionsDir, "20260520_new-session-abcdef.jsonl", []string{
		sessionLine("new-session-abcdef", "/repo-new", baseTime+2_000),
		userLine([]string{"new first"}, baseTime+3_000),
		userLine([]string{"new last"}, baseTime+4_000),
	})
	// flat top-level file directly under sessionsDir
	mustMkdirAll(t, sessionsDir)
	writeFileString(t, filepath.Join(sessionsDir, "20260520_flat-session.jsonl"), strings.Join([]string{
		sessionLine("flat-session", "/repo-flat", baseTime+1_000),
		userLine([]string{"flat prompt"}, baseTime+2_500),
	}, "\n"))

	sessions, err := ScanSessionHudEntries(sessionsDir, currentFile)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(sessions))
	for i, s := range sessions {
		ids[i] = s.ID
	}
	want := []string{"new-session-abcdef", "flat-session", "old-session"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("sort order = %v want %v", ids, want)
	}
	if sessions[0].ShortID != "new-sess" || sessions[0].CWD != "/repo-new" ||
		sessions[0].MessageCount != 2 || sessions[0].LastUserText != "new last" || !sessions[0].IsCurrent {
		t.Fatalf("newest session fields wrong: %#v", sessions[0])
	}
	if sessions[1].LastUserText != "flat prompt" {
		t.Fatalf("flat session lastUserText = %q", sessions[1].LastUserText)
	}
	if sessions[2].IsCurrent {
		t.Fatalf("old session should not be current")
	}
}

func TestScanSessionHudEntriesIgnoresMalformed(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	writeSessionFile(t, sessionsDir, "20260520_valid-session.jsonl", []string{
		sessionLine("valid-session", "/repo-valid", baseTime),
		userLine([]string{"valid prompt"}, baseTime+1_000),
	})
	// broken file directly under the encoded-cwd subdir
	writeFileString(t, filepath.Join(sessionsDir, "encoded-cwd", "20260520_broken-session.jsonl"), "{not json")

	sessions, err := ScanSessionHudEntries(sessionsDir, "")
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(sessions))
	for i, s := range sessions {
		ids[i] = s.ID
	}
	if !reflect.DeepEqual(ids, []string{"valid-session"}) {
		t.Fatalf("malformed session should be ignored, got %v", ids)
	}
}

// --- renderTranscript (ported from session-observer-overlay.test.ts) --------

func writeTranscriptFile(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "sessions", "encoded-cwd")
	mustMkdirAll(t, dir)
	file := filepath.Join(dir, "20260520_session-observer.jsonl")
	assistant := messageLine("assistant", baseTime+2_000, map[string]any{
		"role": "assistant",
		"content": []any{
			map[string]any{"type": "thinking", "thinking": "Need plan\nThen act"},
			map[string]any{"type": "text", "text": "Run tests after reading."},
			map[string]any{"type": "toolCall", "id": "tool-read", "name": "read", "arguments": map[string]any{"path": "src/index.ts"}},
		},
		"model": "gpt-5",
	})
	toolResult := messageLine("tool-result", baseTime+3_000, map[string]any{
		"role":       "toolResult",
		"toolCallId": "tool-read",
		"toolName":   "read",
		"content":    []any{map[string]any{"type": "text", "text": "read ok\nsecond line"}},
		"isError":    false,
	})
	custom := messageLine("custom", baseTime+4_000, map[string]any{
		"role": "custom", "customType": "notice", "content": "custom note", "display": true,
	})
	bash := messageLine("bash", baseTime+5_000, map[string]any{
		"role": "bashExecution", "command": "npm test", "output": "pass", "exitCode": 0,
	})
	lines := []string{
		sessionLine("session-observer", "/workspace/repo", baseTime),
		modelChangeLine(baseTime + 100),
		userLine([]string{"Inspect src", "now"}, baseTime+1_000),
		assistant, toolResult, custom, bash,
	}
	writeFileString(t, file, strings.Join(lines, "\n")+"\n")
	return file
}

func TestRenderTranscript(t *testing.T) {
	initTestTheme(t)
	file := writeTranscriptFile(t)
	snap, err := LoadTranscriptSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Model != "openai/gpt-5" {
		t.Fatalf("model = %q want openai/gpt-5", snap.Model)
	}
	rendered := RenderTranscript(snap.Entries, TranscriptRenderOptions{
		Width:           100,
		SelectedIndex:   3,
		ExpandedEntries: map[int]bool{1: true},
		Theme:           testThemeOrNil(t),
	})
	kinds := make([]string, len(rendered.Ranges))
	for i, r := range rendered.Ranges {
		kinds[i] = r.Kind
	}
	want := []string{"user", "thinking", "response", "tool", "system", "tool"}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("range kinds = %v want %v", kinds, want)
	}
	text := stripANSI(strings.Join(rendered.Lines, "\n"))
	for _, sub := range []string{"Need plan", "Run tests after reading.", "path: src/index.ts", "read ok", "[notice]", "$ npm test", "▶ ▸ read"} {
		if !strings.Contains(text, sub) {
			t.Fatalf("transcript missing %q\n---\n%s", sub, text)
		}
	}
}

// --- SessionHudOverlay picker (ported from session-observer-picker.test.ts) --

func baseHudSession() SessionHudEntry {
	return SessionHudEntry{
		ID:           "session-alpha",
		ShortID:      "session-",
		Path:         "/tmp/session-alpha.jsonl",
		CWD:          "/Users/yeongyu/local-workspaces/senpi/packages/coding-agent",
		CreatedAt:    time.Date(2026, 5, 26, 8, 0, 0, 0, time.UTC),
		ModifiedAt:   time.Date(2026, 5, 26, 8, 9, 0, 0, time.UTC),
		MessageCount: 2,
		LastUserText: "Reply exactly: ok",
		IsCurrent:    false,
	}
}

func newHudOverlay(t *testing.T, sessions []SessionHudEntry) *SessionHudOverlay {
	t.Helper()
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	return NewSessionHudOverlay(SessionHudOptions{
		Sessions:      sessions,
		Theme:         th,
		Keybindings:   km,
		Done:          func() {},
		RequestRender: func() {},
	})
}

func hasBorderOnlyLine(lines []string) bool {
	for _, l := range lines {
		trimmed := strings.TrimRight(l, " ")
		if trimmed == "" {
			continue
		}
		allDash := true
		for _, r := range trimmed {
			if r != '─' {
				allDash = false
				break
			}
		}
		if allDash {
			return true
		}
	}
	return false
}

func nonEmptyStripped(overlay *SessionHudOverlay, width int) []string {
	out := []string{}
	for _, l := range overlay.Render(width) {
		s := stripANSI(l)
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func TestHudPickerHeadingFirstNoBorder(t *testing.T) {
	ov := newHudOverlay(t, []SessionHudEntry{baseHudSession()})
	lines := nonEmptyStripped(ov, 100)
	if len(lines) == 0 || !strings.Contains(lines[0], "Sessions") {
		t.Fatalf("first visible row should be the Sessions heading, got %v", lines)
	}
	if hasBorderOnlyLine(lines) {
		t.Fatalf("picker should not render full-width horizontal rules")
	}
	if !strings.Contains(strings.Join(lines, "\n"), "❯ Reply exactly: ok") {
		t.Fatalf("picker should keep the selected session row, got %v", lines)
	}
}

func TestHudPickerEmptyNoBorder(t *testing.T) {
	ov := newHudOverlay(t, nil)
	lines := nonEmptyStripped(ov, 80)
	if !strings.Contains(strings.Join(lines, "\n"), "Sessions") {
		t.Fatalf("empty picker should identify the sessions surface, got %v", lines)
	}
	if hasBorderOnlyLine(lines) {
		t.Fatalf("empty picker should not render full-width horizontal rules")
	}
}

func TestHudPickerLongMetadataWithinViewport(t *testing.T) {
	s := baseHudSession()
	s.LastUserText = "Summarize every changed TypeScript file in the coding agent package and keep the answer extremely concise"
	s.CWD = "/Users/yeongyu/local-workspaces/senpi/packages/coding-agent/src/core/extensions/builtin/session-observer"
	ov := newHudOverlay(t, []SessionHudEntry{s})
	lines := nonEmptyStripped(ov, 72)
	if hasBorderOnlyLine(lines) {
		t.Fatalf("long metadata picker should not render full-width horizontal rules")
	}
	for _, l := range lines {
		if visibleCells(l) > 72 {
			t.Fatalf("picker row exceeds viewport width: %q (%d cells)", l, visibleCells(l))
		}
	}
}

// --- SessionHudOverlay viewer + observe keybinding (ported) ------------------

func TestHudOverlayViewerExpandAndEscape(t *testing.T) {
	initTestTheme(t)
	file := writeTranscriptFile(t)
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	renderRequests := 0
	doneCalls := 0
	ov := NewSessionHudOverlay(SessionHudOptions{
		Sessions: []SessionHudEntry{{
			ID: "session-observer", ShortID: "session-", Path: file, CWD: "/workspace/repo",
			CreatedAt: time.UnixMilli(baseTime).UTC(), ModifiedAt: time.UnixMilli(baseTime + 5_000).UTC(),
			MessageCount: 6, LastUserText: "Inspect src now", IsCurrent: true,
		}},
		Theme:         th,
		Keybindings:   km,
		Done:          func() { doneCalls++ },
		RequestRender: func() { renderRequests++ },
	})
	if !strings.Contains(strings.Join(ov.Render(90), "\n"), "Sessions") {
		t.Fatalf("picker should show Sessions heading")
	}
	ov.HandleInput("\r") // confirm -> open viewer (synchronous load in Go)
	if ov.Mode() != "viewer" {
		t.Fatalf("mode = %q want viewer", ov.Mode())
	}
	if renderRequests == 0 {
		t.Fatalf("opening viewer should request a render")
	}
	if ov.SelectedEntryIndex() < 0 {
		t.Fatalf("viewer should auto-select the last entry, got %d", ov.SelectedEntryIndex())
	}
	if !strings.Contains(stripANSI(strings.Join(ov.Render(90), "\n")), "Sessions > /workspace/repo · session-") {
		t.Fatalf("viewer title should show the session path + short id")
	}
	ov.HandleInput("\r") // confirm -> toggle expand
	if ov.ExpandedEntryCount() != 1 {
		t.Fatalf("expanded count = %d want 1", ov.ExpandedEntryCount())
	}
	ov.HandleInput("\x1b") // esc -> back to picker
	if ov.Mode() != "picker" {
		t.Fatalf("esc should return to picker, mode = %q", ov.Mode())
	}
	ov.HandleInput("\x1b") // esc -> done
	if doneCalls != 1 {
		t.Fatalf("doneCalls = %d want 1", doneCalls)
	}
}

func TestHudOverlayObserveKeyClosesViewer(t *testing.T) {
	initTestTheme(t)
	file := writeTranscriptFile(t)
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	doneCalls := 0
	ov := NewSessionHudOverlay(SessionHudOptions{
		Sessions: []SessionHudEntry{{
			ID: "session-observer", ShortID: "session-", Path: file, CWD: "/workspace/repo",
			CreatedAt: time.UnixMilli(baseTime).UTC(), ModifiedAt: time.UnixMilli(baseTime + 5_000).UTC(),
			MessageCount: 6, LastUserText: "Inspect src now", IsCurrent: false,
		}},
		Theme:         th,
		Keybindings:   km,
		Done:          func() { doneCalls++ },
		RequestRender: func() {},
	})
	ov.HandleInput("\r")   // open viewer
	ov.HandleInput("\x13") // ctrl+s (app.sessions.observe) -> close
	if doneCalls != 1 {
		t.Fatalf("observe key should close the viewer, doneCalls = %d", doneCalls)
	}
}

// --- live tail (the ctrl+s failure scenario: growing session file) ----------

// TestObserverTailGrowingFile is the QA-failure contract: an observer viewing an
// actively-growing session file re-reads appended entries on Refresh without
// crashing and without losing already-rendered content. This is the tail
// behavior that the manual-QA "observer on an actively-growing session file"
// scenario exercises.
func TestObserverTailGrowingFile(t *testing.T) {
	initTestTheme(t)
	dir := filepath.Join(t.TempDir(), "sessions", "encoded-cwd")
	mustMkdirAll(t, dir)
	file := filepath.Join(dir, "20260520_growing.jsonl")

	// Initial content: header + one user message.
	writeFileString(t, file, strings.Join([]string{
		sessionLine("growing", "/workspace/repo", baseTime),
		userLine([]string{"first"}, baseTime+1_000),
	}, "\n")+"\n")

	tail := NewSessionTail(file)
	snap, err := tail.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := len(snap.Entries); got != 1 {
		t.Fatalf("initial entries = %d want 1", got)
	}

	// Append more entries, as a live session would.
	appendLines(t, file, []string{
		userLine([]string{"second"}, baseTime+2_000),
		messageLine("a1", baseTime+3_000, map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "reply"}},
			"model":   "gpt-5",
		}),
	})

	snap2, err := tail.Load()
	if err != nil {
		t.Fatalf("reload after growth must not error: %v", err)
	}
	if got := len(snap2.Entries); got != 3 {
		t.Fatalf("after growth entries = %d want 3", got)
	}
	// tail must report growth
	if !tail.Grew() {
		t.Fatalf("tail should report that the file grew")
	}

	// Truncation / rewrite (a rare but real event: session compaction) must not
	// panic; it must resync to the new content.
	writeFileString(t, file, strings.Join([]string{
		sessionLine("growing", "/workspace/repo", baseTime),
	}, "\n")+"\n")
	snap3, err := tail.Load()
	if err != nil {
		t.Fatalf("reload after truncation must not error: %v", err)
	}
	if len(snap3.Entries) != 0 {
		t.Fatalf("after truncation entries = %d want 0", len(snap3.Entries))
	}
}

func appendLines(t *testing.T, file string, lines []string) {
	t.Helper()
	f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatal(err)
		}
	}
}

func visibleCells(s string) int { return visibleWidthTest(s) }
