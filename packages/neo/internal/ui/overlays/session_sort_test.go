package overlays_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// mkSession builds a SessionText for the ported session-selector-search.test.ts
// cases. id/name/modified/allMessagesText are the fields the search+sort read.
func mkSession(id, name string, modified time.Time, allMessages string) overlays.SessionText {
	return overlays.SessionText{
		Info: store.SessionInfo{
			Path:     "/tmp/" + id + ".jsonl",
			ID:       id,
			Name:     name,
			Modified: modified,
		},
		AllMessagesText: allMessages,
	}
}

func ids(list []overlays.SessionText) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = s.Info.ID
	}
	return out
}

func eqStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func date(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t.UTC()
}

// TestFilterByQuotedPhrase ports "filters by quoted phrase with whitespace
// normalization".
func TestFilterByQuotedPhrase(t *testing.T) {
	sessions := []overlays.SessionText{
		mkSession("a", "", date("2026-01-01T00:00:00Z"), "node\n\n   cve was discussed"),
		mkSession("b", "", date("2026-01-02T00:00:00Z"), "node something else"),
	}
	got := ids(overlays.FilterAndSortSessions(sessions, `"node cve"`, overlays.SortRecent, overlays.NameFilterAll))
	if !eqStrings(got, []string{"a"}) {
		t.Errorf("got %v, want [a]", got)
	}
}

// TestFilterByRegex ports "filters by regex (re:) and is case-insensitive".
func TestFilterByRegex(t *testing.T) {
	sessions := []overlays.SessionText{
		mkSession("a", "", date("2026-01-02T00:00:00Z"), "Brave is great"),
		mkSession("b", "", date("2026-01-03T00:00:00Z"), "bravery is not the same"),
	}
	got := ids(overlays.FilterAndSortSessions(sessions, `re:\bbrave\b`, overlays.SortRecent, overlays.NameFilterAll))
	if !eqStrings(got, []string{"a"}) {
		t.Errorf("got %v, want [a]", got)
	}
}

// TestRecentSortPreservesInputOrder ports "recent sort preserves input order".
func TestRecentSortPreservesInputOrder(t *testing.T) {
	sessions := []overlays.SessionText{
		mkSession("newer", "", date("2026-01-03T00:00:00Z"), "brave"),
		mkSession("older", "", date("2026-01-01T00:00:00Z"), "brave"),
		mkSession("nomatch", "", date("2026-01-04T00:00:00Z"), "something else"),
	}
	got := ids(overlays.FilterAndSortSessions(sessions, `"brave"`, overlays.SortRecent, overlays.NameFilterAll))
	if !eqStrings(got, []string{"newer", "older"}) {
		t.Errorf("got %v, want [newer older]", got)
	}
}

// TestRelevanceSortByScoreThenModified ports "relevance sort orders by score and
// tie-breaks by modified desc".
func TestRelevanceSortByScoreThenModified(t *testing.T) {
	sessions := []overlays.SessionText{
		mkSession("late", "", date("2026-01-03T00:00:00Z"), "xxxx brave"),
		mkSession("early", "", date("2026-01-01T00:00:00Z"), "brave xxxx"),
	}
	got := ids(overlays.FilterAndSortSessions(sessions, `"brave"`, overlays.SortRelevance, overlays.NameFilterAll))
	if !eqStrings(got, []string{"early", "late"}) {
		t.Errorf("score order: got %v, want [early late]", got)
	}

	tie := []overlays.SessionText{
		mkSession("newer", "", date("2026-01-03T00:00:00Z"), "brave"),
		mkSession("older", "", date("2026-01-01T00:00:00Z"), "brave"),
	}
	got2 := ids(overlays.FilterAndSortSessions(tie, `"brave"`, overlays.SortRelevance, overlays.NameFilterAll))
	if !eqStrings(got2, []string{"newer", "older"}) {
		t.Errorf("tie-break modified desc: got %v, want [newer older]", got2)
	}
}

// TestInvalidRegexEmpty ports "returns empty list for invalid regex".
func TestInvalidRegexEmpty(t *testing.T) {
	sessions := []overlays.SessionText{mkSession("a", "", date("2026-01-01T00:00:00Z"), "brave")}
	got := overlays.FilterAndSortSessions(sessions, "re:(", overlays.SortRecent, overlays.NameFilterAll)
	if len(got) != 0 {
		t.Errorf("got %v, want empty", ids(got))
	}
}

// TestNameFilter ports the "name filter" describe block cases.
func TestNameFilter(t *testing.T) {
	sessions := []overlays.SessionText{
		mkSession("named1", "My Project", date("2026-01-03T00:00:00Z"), "blueberry"),
		mkSession("named2", "Another Named", date("2026-01-02T00:00:00Z"), "blueberry"),
		mkSession("other1", "", date("2026-01-04T00:00:00Z"), "blueberry"),
		mkSession("other2", "", date("2026-01-01T00:00:00Z"), "blueberry"),
	}
	all := ids(overlays.FilterAndSortSessions(sessions, "", overlays.SortRecent, overlays.NameFilterAll))
	if !eqStrings(all, []string{"named1", "named2", "other1", "other2"}) {
		t.Errorf("all: got %v", all)
	}
	named := ids(overlays.FilterAndSortSessions(sessions, "", overlays.SortRecent, overlays.NameFilterNamed))
	if !eqStrings(named, []string{"named1", "named2"}) {
		t.Errorf("named: got %v", named)
	}
	beforeSearch := ids(overlays.FilterAndSortSessions(sessions, "blueberry", overlays.SortRecent, overlays.NameFilterNamed))
	if !eqStrings(beforeSearch, []string{"named1", "named2"}) {
		t.Errorf("name filter before query: got %v", beforeSearch)
	}

	ws := []overlays.SessionText{
		mkSession("whitespace", "   ", date("2026-01-01T00:00:00Z"), "test"),
		mkSession("empty", "", date("2026-01-02T00:00:00Z"), "test"),
		mkSession("named", "Real Name", date("2026-01-03T00:00:00Z"), "test"),
	}
	wsNamed := ids(overlays.FilterAndSortSessions(ws, "", overlays.SortRecent, overlays.NameFilterNamed))
	if !eqStrings(wsNamed, []string{"named"}) {
		t.Errorf("whitespace-only names excluded: got %v", wsNamed)
	}
}

// TestModifiedSortUsesEntryTimestamp is the mandated carry-forward proof: the
// picker's Modified-sort must rank by the entry-level activity timestamp decoded
// by the store (getMessageActivityTime entry fallback, session-manager.ts:664).
// Two sessions share an identical HEADER timestamp; only their last message's
// ENTRY timestamp differs (and neither message carries a numeric
// message.timestamp). Scanning them through the real store and sorting by
// Modified descending must place the later-activity session first — which is
// only possible when the store decodes the entry timestamp.
func TestModifiedSortUsesEntryTimestamp(t *testing.T) {
	agentDir := t.TempDir()
	cwd := "/Users/me/sort"
	dir := store.SessionDirForCwd(agentDir, cwd)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Both headers stamped 03:04:05. Session "early" last activity 03:04:10;
	// session "late" last activity 03:05:00. No message.timestamp on any message.
	writeSession(t, filepath.Join(dir, "2026-01-02T03-04-05-000Z_sess-early.jsonl"),
		`{"type":"session","version":3,"id":"sess-early","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/Users/me/sort"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-02T03:04:10.000Z","message":{"role":"user","content":"early"}}`,
	)
	writeSession(t, filepath.Join(dir, "2026-01-02T03-04-05-000Z_sess-late.jsonl"),
		`{"type":"session","version":3,"id":"sess-late","timestamp":"2026-01-02T03:04:05.000Z","cwd":"/Users/me/sort"}`,
		`{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-02T03:05:00.000Z","message":{"role":"user","content":"late"}}`,
	)

	scanned, err := store.ScanSessions(agentDir, cwd)
	if err != nil {
		t.Fatalf("ScanSessions: %v", err)
	}
	if len(scanned) != 2 {
		t.Fatalf("got %d sessions, want 2", len(scanned))
	}

	// The picker's default Modified sort (recent scope) orders by Modified desc.
	sorted := overlays.SortByModifiedDesc(scanned)
	if sorted[0].ID != "sess-late" || sorted[1].ID != "sess-early" {
		t.Fatalf("Modified sort = [%s %s], want [sess-late sess-early] — picker must use the entry-timestamp activity fallback, not the (identical) header timestamp",
			sorted[0].ID, sorted[1].ID)
	}

	// Confirm the discriminator is the entry timestamp, not the header (which is
	// identical for both) or the file mtime.
	byID := map[string]store.SessionInfo{}
	for _, s := range scanned {
		byID[s.ID] = s
	}
	if !byID["sess-late"].Modified.Equal(date("2026-01-02T03:05:00Z")) {
		t.Errorf("sess-late.Modified = %v, want 03:05:00 (entry ts)", byID["sess-late"].Modified.UTC())
	}
	if !byID["sess-early"].Modified.Equal(date("2026-01-02T03:04:10Z")) {
		t.Errorf("sess-early.Modified = %v, want 03:04:10 (entry ts)", byID["sess-early"].Modified.UTC())
	}
}

func writeSession(t *testing.T, path string, lines ...string) {
	t.Helper()
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
