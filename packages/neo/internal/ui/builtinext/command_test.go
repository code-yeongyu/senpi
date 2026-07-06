package builtinext

import (
	"path/filepath"
	"testing"
)

// These table tests port the command-handler *integration* cases from the TS
// vitest suites that the initial parity table omitted (audit F3). The classic
// extensions decide, inside their registerCommand handler, whether to open the
// overlay or emit a notify() — a decision layer distinct from the data layer
// (IndexSessions / ScanSessionHudEntries) and the UI layer (the overlays). The
// resolvers under test mirror exactly that decision:
//
//   history-search/index.ts:28-55  -> ResolveHistoryCommandOutcome
//   session-observer/index.ts:11-44 -> ResolveSessionsCommandOutcome
//
// Source cases ported here:
//   history-search-extension.test.ts  "registers /history and handles no-UI
//       command execution" (no session messages emitted; the no-UI/empty path
//       notifies instead of opening).
//   session-observer-scanner.test.ts  "registers /sessions and no-ops safely
//       without interactive UI"; "opens session picker when sessions exist"
//       (custom called once); "shows empty state when no sessions exist"
//       (notify "No sessions found", custom NOT called).

// --- history command handler (ported from history-search-extension.test.ts) --

func TestResolveHistoryCommandOutcomeNoUI(t *testing.T) {
	got := ResolveHistoryCommandOutcome(false, nil)
	if got.OpenOverlay {
		t.Fatalf("no-UI must not open overlay: %#v", got)
	}
	if got.NotifyMessage != "No UI available" || got.NotifyLevel != "info" {
		t.Fatalf("no-UI notify mismatch: %#v", got)
	}
}

func TestResolveHistoryCommandOutcomeEmptyHistory(t *testing.T) {
	got := ResolveHistoryCommandOutcome(true, []HistoryEntry{})
	if got.OpenOverlay {
		t.Fatalf("empty history must not open overlay: %#v", got)
	}
	if got.NotifyMessage != "No prompt history found" || got.NotifyLevel != "info" {
		t.Fatalf("empty-history notify mismatch: %#v", got)
	}
}

func TestResolveHistoryCommandOutcomeOpensWhenEntriesExist(t *testing.T) {
	entries := []HistoryEntry{{Text: "ship it", SessionID: "s1", Timestamp: baseTime}}
	got := ResolveHistoryCommandOutcome(true, entries)
	if !got.OpenOverlay {
		t.Fatalf("non-empty history must open overlay: %#v", got)
	}
	if got.NotifyMessage != "" {
		t.Fatalf("open path must not notify: %#v", got)
	}
}

// --- sessions command handler (ported from session-observer-scanner.test.ts) -

func TestResolveSessionsCommandOutcomeNoUI(t *testing.T) {
	got := ResolveSessionsCommandOutcome(false, nil)
	if got.OpenOverlay {
		t.Fatalf("no-UI must not open picker: %#v", got)
	}
	if got.NotifyMessage != "No UI available" || got.NotifyLevel != "info" {
		t.Fatalf("no-UI notify mismatch: %#v", got)
	}
}

func TestResolveSessionsCommandOutcomeEmptyState(t *testing.T) {
	got := ResolveSessionsCommandOutcome(true, []SessionHudEntry{})
	if got.OpenOverlay {
		t.Fatalf("empty sessions must not open picker: %#v", got)
	}
	if got.NotifyMessage != "No sessions found" || got.NotifyLevel != "info" {
		t.Fatalf("empty-state notify mismatch: %#v", got)
	}
}

func TestResolveSessionsCommandOutcomeOpensWhenSessionsExist(t *testing.T) {
	sessions := []SessionHudEntry{{ID: "valid-session", ShortID: "valid-se", CWD: "/repo-valid", MessageCount: 1}}
	got := ResolveSessionsCommandOutcome(true, sessions)
	if !got.OpenOverlay {
		t.Fatalf("non-empty sessions must open picker: %#v", got)
	}
	if got.NotifyMessage != "" {
		t.Fatalf("open path must not notify: %#v", got)
	}
}

// TestSessionsCommandOutcomeMatchesScanResult wires the data layer to the
// decision layer end-to-end, mirroring the scanner suite's "opens session
// picker when sessions exist" integration path: a real session file on disk is
// scanned, and the non-empty result routes to OpenOverlay (the TS
// getCustomCallCount()===1 assertion).
func TestSessionsCommandOutcomeMatchesScanResult(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	writeSessionFile(t, sessionsDir, "20260520_valid-session.jsonl", []string{
		sessionLine("valid-session", "/repo-valid", baseTime),
		userLine([]string{"valid prompt"}, baseTime+1_000),
	})
	sessions, err := ScanSessionHudEntries(sessionsDir, "")
	if err != nil {
		t.Fatal(err)
	}
	got := ResolveSessionsCommandOutcome(true, sessions)
	if !got.OpenOverlay {
		t.Fatalf("scanned non-empty sessions must open picker: %#v", got)
	}
}
