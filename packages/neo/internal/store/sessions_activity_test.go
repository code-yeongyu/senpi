package store_test

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestScanSessionsEntryTimestampActivityFallback is the wave-0 oracle gate-23
// carry-forward fix. The picker's Modified-sort ranks sessions by
// SessionInfo.Modified, which the classic loader derives from the LAST message
// activity time. getMessageActivityTime (session-manager.ts:654-666) uses the
// numeric message.timestamp when present, and OTHERWISE falls back to the
// ENTRY-level timestamp: `new Date(entry.timestamp).getTime()` (line 664).
//
// The wave-0 sessions.go only decoded message.timestamp and returned (0,false)
// when it was absent, so Modified collapsed to the header timestamp and two
// sessions created at the same time but with different last-activity would sort
// identically (or by the wrong key). This test seeds sessions whose messages
// carry NO message.timestamp — only entry-level timestamps — and asserts that
// Modified reflects the LAST message's entry timestamp, so the Modified-sort is
// correct.
func TestScanSessionsEntryTimestampActivityFallback(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/activity"
	dir := sessionSafeDir(t, agentDir, cwd)

	// Header at 03:04:05. Messages have NO message.timestamp field; their entry
	// timestamps advance to 03:04:20 (the last user/assistant message). The TS
	// loader would set modified = 03:04:20; the buggy Go path would set it to the
	// header (03:04:05).
	writeFile(t, filepath.Join(dir, "2026-01-02T03-04-05-000Z_sess-act.jsonl"), joinLines(
		`{"type":"session","version":3,"id":"sess-act","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/Users/me/activity"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"user","content":"q"}}`,
		`{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-02T03:04:20.000Z","message":{"role":"assistant","content":[{"type":"text","text":"a"}]}}`,
	))

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}

	wantModified := time.Date(2026, 1, 2, 3, 4, 20, 0, time.UTC)
	if !sessions[0].Modified.Equal(wantModified) {
		t.Errorf("Modified = %v, want last-message ENTRY timestamp %v (getMessageActivityTime entry fallback, session-manager.ts:664)",
			sessions[0].Modified.UTC(), wantModified)
	}
}

// TestScanSessionsMessageTimestampWinsOverEntry asserts the precedence in
// getMessageActivityTime: a numeric message.timestamp (ms epoch) takes priority
// over the entry-level ISO timestamp for the SAME message.
func TestScanSessionsMessageTimestampWinsOverEntry(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/prec"
	dir := sessionSafeDir(t, agentDir, cwd)

	// The message carries an explicit numeric timestamp (ms) that is LATER than
	// its entry timestamp. Activity time must be the message.timestamp.
	msgMs := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC).UnixMilli()
	writeFile(t, filepath.Join(dir, "2026-01-02T03-04-05-000Z_sess-prec.jsonl"), joinLines(
		`{"type":"session","version":3,"id":"sess-prec","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/Users/me/prec"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"user","content":"q","timestamp":`+strconv.FormatInt(msgMs, 10)+`}}`,
	))

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}
	want := time.UnixMilli(msgMs).UTC()
	if !sessions[0].Modified.Equal(want) {
		t.Errorf("Modified = %v, want message.timestamp %v (precedence over entry ts)",
			sessions[0].Modified.UTC(), want)
	}
}

// TestScanSessionsToolMessageEntryTsIgnored guards the role gate: only
// user/assistant messages contribute activity time. A message whose role is
// neither (e.g. tool) with a later entry timestamp must NOT advance Modified.
func TestScanSessionsToolMessageEntryTsIgnored(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/role"
	dir := sessionSafeDir(t, agentDir, cwd)

	writeFile(t, filepath.Join(dir, "2026-01-02T03-04-05-000Z_sess-role.jsonl"), joinLines(
		`{"type":"session","version":3,"id":"sess-role","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/Users/me/role"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"user","content":"q"}}`,
		`{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-02T03:09:00.000Z","message":{"role":"tool","content":"tool output"}}`,
	))

	sessions, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}
	// The last user/assistant message is e1 at 03:04:10; the tool message must
	// not push Modified forward.
	wantModified := time.Date(2026, 1, 2, 3, 4, 10, 0, time.UTC)
	if !sessions[0].Modified.Equal(wantModified) {
		t.Errorf("Modified = %v, want last user/assistant entry ts %v (tool role ignored)",
			sessions[0].Modified.UTC(), wantModified)
	}
}
