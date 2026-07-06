package store_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// sessionSafeDir mirrors getDefaultSessionDirPath (session-manager.ts:484-489):
// --<cwd, leading slash stripped, /\: -> ->--.
func sessionSafeDir(t *testing.T, agentDir, cwd string) string {
	t.Helper()
	safe := store.SessionDirNameForCwd(cwd)
	return filepath.Join(agentDir, "sessions", safe)
}

// TestSessionDirNameForCwd asserts the safe-path encoding is byte-exact to the
// TS scheme for a POSIX cwd.
func TestSessionDirNameForCwd(t *testing.T) {
	got := store.SessionDirNameForCwd("/Users/me/proj")
	want := "--Users-me-proj--"
	if got != want {
		t.Fatalf("SessionDirNameForCwd = %q, want %q", got, want)
	}
}

// TestScanSessionsPicker builds a fixture sessions tree and asserts the scanner
// returns picker-sufficient info (id/name/first-user-message/mtime/count)
// mirroring buildSessionInfo (session-manager.ts:668-742).
func TestScanSessionsPicker(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/proj"
	dir := sessionSafeDir(t, agentDir, cwd)

	// Session A: header + two user/assistant messages + a session_info name.
	sessA := "2026-01-02T03-04-05-000Z_sess-aaaa.jsonl"
	writeFile(t, filepath.Join(dir, sessA), joinLines(
		`{"type":"session","version":3,"id":"sess-aaaa","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/Users/me/proj"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"user","content":"first user question"}}`,
		`{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"an answer"}]}}`,
		`{"type":"session_info","id":"e3","parentId":"e2","timestamp":"2026-01-02T03:04:08.000Z","name":"My Named Session"}`,
	))

	// Session B: header + one user message, no name.
	sessB := "2026-01-01T00-00-00-000Z_sess-bbbb.jsonl"
	writeFile(t, filepath.Join(dir, sessB), joinLines(
		`{"type":"session","version":3,"id":"sess-bbbb","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/Users/me/proj"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello there"}}`,
	))

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2", len(sessions))
	}

	byID := map[string]store.SessionInfo{}
	for _, s := range sessions {
		byID[s.ID] = s
	}

	a, ok := byID["sess-aaaa"]
	if !ok {
		t.Fatalf("session sess-aaaa not found")
	}
	if a.Name != "My Named Session" {
		t.Errorf("A.Name = %q, want My Named Session", a.Name)
	}
	if a.FirstMessage != "first user question" {
		t.Errorf("A.FirstMessage = %q, want first user question", a.FirstMessage)
	}
	if a.MessageCount != 2 {
		t.Errorf("A.MessageCount = %d, want 2", a.MessageCount)
	}
	if a.CWD != "/Users/me/proj" {
		t.Errorf("A.CWD = %q, want /Users/me/proj", a.CWD)
	}

	b := byID["sess-bbbb"]
	if b.Name != "" {
		t.Errorf("B.Name = %q, want empty", b.Name)
	}
	if b.FirstMessage != "hello there" {
		t.Errorf("B.FirstMessage = %q, want hello there", b.FirstMessage)
	}
	if b.MessageCount != 1 {
		t.Errorf("B.MessageCount = %d, want 1", b.MessageCount)
	}
}

// TestScanSessionsNoMessages mirrors buildSessionInfo fallback: a header-only
// session reports "(no messages)".
func TestScanSessionsNoMessages(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/tmp/empty-proj"
	dir := sessionSafeDir(t, agentDir, cwd)
	writeFile(t, filepath.Join(dir, "2026-03-03T03-03-03-000Z_sess-empty.jsonl"),
		`{"type":"session","version":3,"id":"sess-empty","timestamp":"2026-03-03T03:03:03.000Z","cwd":"/tmp/empty-proj"}`+"\n")

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}
	if sessions[0].FirstMessage != "(no messages)" {
		t.Errorf("FirstMessage = %q, want (no messages)", sessions[0].FirstMessage)
	}
	if sessions[0].MessageCount != 0 {
		t.Errorf("MessageCount = %d, want 0", sessions[0].MessageCount)
	}
}

// TestScanSessionsCorruptLineSkipped is the mandated corrupted-JSONL-line
// fixture: a bad line mid-file is skipped with a warning, not fatal — the rest
// of the session still parses.
func TestScanSessionsCorruptLineSkipped(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/tmp/corrupt-proj"
	dir := sessionSafeDir(t, agentDir, cwd)
	writeFile(t, filepath.Join(dir, "2026-04-04T04-04-04-000Z_sess-corrupt.jsonl"), joinLines(
		`{"type":"session","version":3,"id":"sess-corrupt","timestamp":"2026-04-04T04:04:04.000Z","cwd":"/tmp/corrupt-proj"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-04-04T04:04:05.000Z","message":{"role":"user","content":"good line"}}`,
		`{this is a corrupted jsonl line`,
		`{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-04-04T04:04:06.000Z","message":{"role":"assistant","content":"after corrupt"}}`,
	))

	var warned []string
	sessions, err := store.ScanSessionsWithWarn(agentDir, cwd, func(msg string) {
		warned = append(warned, msg)
	})
	if err != nil {
		t.Fatalf("ScanSessionsWithWarn returned fatal error on corrupt line: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1 (corrupt line must not drop the session)", len(sessions))
	}
	s := sessions[0]
	if s.FirstMessage != "good line" {
		t.Errorf("FirstMessage = %q, want good line", s.FirstMessage)
	}
	// Two valid message entries survive; the corrupt line is skipped.
	if s.MessageCount != 2 {
		t.Errorf("MessageCount = %d, want 2 (corrupt line skipped, valid ones kept)", s.MessageCount)
	}
	if len(warned) == 0 {
		t.Errorf("expected a warning for the skipped corrupt line, got none")
	}
}

// TestScanSessionsMissingDirCleanDefaults mirrors listSessionsFromDir
// (session-manager.ts:799-801): a non-existent sessions dir yields an empty
// list, no error — the failure branch of the manual-QA scenario.
func TestScanSessionsMissingDirCleanDefaults(t *testing.T) {
	agentDir := t.TempDir() // exists, but no sessions/ subtree for this cwd
	sessions, err := store.ScanSessions(agentDir, "/nonexistent/cwd")
	if err != nil {
		t.Fatalf("ScanSessions on missing dir returned error: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions for missing dir, got %d", len(sessions))
	}
}

// TestScanSessionsMtimeFallback asserts modified falls back to file mtime when
// no message activity time and no header timestamp are usable.
func TestScanSessionsMtimeFallback(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/tmp/mtime-proj"
	dir := sessionSafeDir(t, agentDir, cwd)
	path := filepath.Join(dir, "2026-05-05T05-05-05-000Z_sess-mtime.jsonl")
	// Header with an unparseable timestamp and no messages -> mtime fallback.
	writeFile(t, path, `{"type":"session","version":3,"id":"sess-mtime","timestamp":"not-a-date","cwd":"/tmp/mtime-proj"}`+"\n")

	fixedMtime := time.Date(2026, 6, 6, 6, 6, 6, 0, time.UTC)
	if err := os.Chtimes(path, fixedMtime, fixedMtime); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}
	if !sessions[0].Modified.Equal(fixedMtime) {
		t.Errorf("Modified = %v, want mtime fallback %v", sessions[0].Modified, fixedMtime)
	}
}

// TestScanSessionsLongLine guards against a bufio.Scanner token-too-long
// truncation: real session files carry base64 image lines multiple MB long
// (observed up to ~4.7MB). A message AFTER a >1MB line must still be counted —
// the scan must not silently stop mid-file. The classic TS loader
// (loadEntriesFromFile) accumulates across reads and never caps line length.
func TestScanSessionsLongLine(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/tmp/longline-proj"
	dir := sessionSafeDir(t, agentDir, cwd)

	// A ~3MB text block inside a valid message, well over bufio.Scanner's
	// default and our previous 1MB cap.
	big := strings.Repeat("A", 3*1024*1024)
	writeFile(t, filepath.Join(dir, "2026-07-07T07-07-07-000Z_sess-long.jsonl"), joinLines(
		`{"type":"session","version":3,"id":"sess-long","timestamp":"2026-07-07T07:07:07.000Z","cwd":"/tmp/longline-proj"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-07-07T07:07:08.000Z","message":{"role":"user","content":"`+big+`"}}`,
		`{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-07-07T07:07:09.000Z","message":{"role":"assistant","content":"after the big line"}}`,
	))

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}
	// Both messages counted -> the reader did NOT stop at the oversized line.
	if sessions[0].MessageCount != 2 {
		t.Errorf("MessageCount = %d, want 2 (message after >1MB line must be read)", sessions[0].MessageCount)
	}
}

func joinLines(lines ...string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}
