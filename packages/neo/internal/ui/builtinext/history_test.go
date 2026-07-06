package builtinext

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// baseTime mirrors the TS fixture BASE_TIME (history-search-fixtures.ts:7),
// Date.parse("2026-05-20T12:00:00.000Z") in ms.
const baseTime int64 = 1_779_019_200_000

// --- filterHistory (ported from history-search-extension.test.ts) -----------

func historyEntryFixture(text string, ts int64) HistoryEntry {
	return HistoryEntry{Text: text, SessionID: "s", SessionFile: "/tmp/s.jsonl", CWD: "/repo", Timestamp: ts}
}

// TestFilterHistoryEmptyQueryAndFuzzy ports the "keeps empty-query order and
// fuzzy filters case-insensitively" case.
func TestFilterHistoryEmptyQueryAndFuzzy(t *testing.T) {
	entries := []HistoryEntry{
		historyEntryFixture("Newest prompt", 3),
		historyEntryFixture("Deploy production", 2),
		historyEntryFixture("older", 1),
	}
	if got := FilterHistory(entries, ""); !reflect.DeepEqual(got, entries) {
		t.Fatalf("empty query should keep order, got %#v", got)
	}
	got := textsOf(FilterHistory(entries, "DProd"))
	if !reflect.DeepEqual(got, []string{"Deploy production"}) {
		t.Fatalf("case-insensitive fuzzy filter: got %v", got)
	}
}

// TestFilterHistoryRanksTighterMatches ports the "ranks tighter matches above
// looser matches" case.
func TestFilterHistoryRanksTighterMatches(t *testing.T) {
	entries := []HistoryEntry{
		historyEntryFixture("deploy dev prod", 2),
		historyEntryFixture("deploy production", 1),
	}
	got := textsOf(FilterHistory(entries, "dprod"))
	want := []string{"deploy production", "deploy dev prod"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ranking: got %v want %v", got, want)
	}
}

// --- resolveSearchRoot (ported) ---------------------------------------------

func TestResolveSearchRoot(t *testing.T) {
	defaultRoot := "/home/user/.senpi/agent/sessions"
	cases := []struct {
		name       string
		sessionDir string
		want       string
	}{
		{"empty sessionDir returns default", "", defaultRoot},
		{"equal to default returns default", defaultRoot, defaultRoot},
		{"cwd subdir returns default", defaultRoot + "/-encoded-cwd", defaultRoot},
		{"deep nested subdir returns default", defaultRoot + "/deep/nested/path", defaultRoot},
		{"outside default returns custom", "/custom/session/dir", "/custom/session/dir"},
		{"other tmp returns custom", "/tmp/my-sessions", "/tmp/my-sessions"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ResolveSearchRoot(c.sessionDir, defaultRoot); got != c.want {
				t.Fatalf("ResolveSearchRoot(%q) = %q want %q", c.sessionDir, got, c.want)
			}
		})
	}
}

// --- indexSessions (ported from history-search-indexer.test.ts) -------------

func TestIndexSessionsEmpty(t *testing.T) {
	root := t.TempDir()
	if got, err := IndexSessions(filepath.Join(root, "missing")); err != nil || len(got) != 0 {
		t.Fatalf("missing dir: got %v err %v", got, err)
	}
	empty := filepath.Join(root, "sessions")
	mustMkdir(t, empty)
	if got, err := IndexSessions(empty); err != nil || len(got) != 0 {
		t.Fatalf("empty dir: got %v err %v", got, err)
	}
}

func TestIndexSessionsSingleUserPrompt(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	file := writeSessionFile(t, sessionsDir, "20260520_session-1.jsonl", []string{
		sessionLine("session-1", "/repo", baseTime),
		userLine([]string{"ship it"}, baseTime+2_000),
	})
	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	want := []HistoryEntry{{Text: "ship it", SessionID: "session-1", SessionFile: file, CWD: "/repo", Timestamp: baseTime + 2_000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v want %#v", got, want)
	}
}

func TestIndexSessionsSkipsInjectedEmptyMalformed(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	writeSessionFile(t, sessionsDir, "session.jsonl", []string{
		sessionLine("session-1", "/workspace", baseTime),
		"{malformed",
		userLine([]string{"[SYSTEM DIRECTIVE: hidden]"}, baseTime+1_000),
		userLine([]string{"[system:agentika:user.input]\nsecret"}, baseTime+2_000),
		userLine([]string{"[SYSTEM hidden]"}, baseTime+3_000),
		userLine([]string{"   \n\t"}, baseTime+4_000),
		userLine([]string{"visible"}, baseTime+5_000),
	})
	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if texts := textsOf(got); !reflect.DeepEqual(texts, []string{"visible"}) {
		t.Fatalf("got %v", texts)
	}
}

func TestIndexSessionsConcatSortDedupe(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	writeSessionFile(t, sessionsDir, "older.jsonl", []string{
		sessionLine("older", "/workspace", baseTime),
		userLine([]string{"multi", "part"}, baseTime+1_000),
		userLine([]string{"duplicate"}, baseTime+2_000),
	})
	writeSessionFile(t, sessionsDir, "newer.jsonl", []string{
		sessionLine("newer", "/workspace", baseTime),
		userLine([]string{"duplicate"}, baseTime+4_000),
		userLine([]string{"latest"}, baseTime+5_000),
	})
	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	texts := textsOf(got)
	want := []string{"latest", "duplicate", "multi\npart"}
	if !reflect.DeepEqual(texts, want) {
		t.Fatalf("got %v want %v", texts, want)
	}
	for _, e := range got {
		if e.Text == "duplicate" && e.SessionID != "newer" {
			t.Fatalf("dedupe should keep newest sessionId, got %q", e.SessionID)
		}
	}
}

func TestIndexSessionsCapsAt10000(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	lines := []string{sessionLine("bulk", "/workspace", baseTime)}
	for i := 0; i < 10_005; i++ {
		lines = append(lines, userLine([]string{prompt(i)}, baseTime+int64(i)))
	}
	writeSessionFile(t, sessionsDir, "bulk.jsonl", lines)
	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 10_000 {
		t.Fatalf("expected 10000 entries, got %d", len(got))
	}
	set := map[string]bool{}
	for _, e := range got {
		set[e.Text] = true
	}
	if !set["prompt 10004"] || set["prompt 0"] {
		t.Fatalf("cap should keep newest prompts, dropped oldest")
	}
}

func TestIndexSessionsLegacyStringContent(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	legacy := `{"type":"message","id":"msg-legacy","parentId":"parent","timestamp":"` +
		isoTime(baseTime+2_000) + `","message":{"role":"user","content":"legacy string prompt"}}`
	writeSessionFile(t, sessionsDir, "legacy.jsonl", []string{
		sessionLine("legacy", "/repo", baseTime),
		legacy,
		userLine([]string{"structured prompt"}, baseTime+3_000),
	})
	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"structured prompt", "legacy string prompt"}
	if texts := textsOf(got); !reflect.DeepEqual(texts, want) {
		t.Fatalf("got %v want %v", texts, want)
	}
}

func TestIndexSessionsTopLevelFiles(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "custom")
	mustMkdir(t, sessionsDir)
	flatFile := filepath.Join(sessionsDir, "20260520_flat-session.jsonl")
	writeFileString(t, flatFile, strings.Join([]string{
		sessionLine("flat-session", "/repo", baseTime),
		userLine([]string{"flat prompt"}, baseTime+1_000),
	}, "\n"))
	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if texts := textsOf(got); !reflect.DeepEqual(texts, []string{"flat prompt"}) {
		t.Fatalf("got %v", texts)
	}
	if got[0].SessionFile != flatFile {
		t.Fatalf("sessionFile = %q want %q", got[0].SessionFile, flatFile)
	}
}

func TestIndexSessionsCrossCwdSubdirs(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	olderDir := filepath.Join(sessionsDir, "aaaaa-old-cwd")
	newerDir := filepath.Join(sessionsDir, "zzzzz-new-cwd")
	mustMkdirAll(t, olderDir)
	mustMkdirAll(t, newerDir)

	olderLines := []string{sessionLine("old-bulk", "/old", baseTime)}
	for i := 0; i < 10_000; i++ {
		olderLines = append(olderLines, userLine([]string{"old prompt " + itoa(i)}, baseTime+int64(i)))
	}
	writeFileString(t, filepath.Join(olderDir, "20260101_old-bulk.jsonl"), strings.Join(olderLines, "\n"))
	writeFileString(t, filepath.Join(newerDir, "20260901_new-recent.jsonl"), strings.Join([]string{
		sessionLine("new-recent", "/new", baseTime+1_000_000),
		userLine([]string{"fresh prompt"}, baseTime+2_000_000),
	}, "\n"))

	got, err := IndexSessions(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if !containsText(got, "fresh prompt") {
		t.Fatalf("newest-filename subdir file must be indexed before the cap, missing 'fresh prompt'")
	}
}

// --- HistorySearchOverlay (ported) ------------------------------------------

// TestHistoryOverlayRendersInputAndFilters ports the overlay "renders an input
// and filters after synthetic keystrokes" contract.
func TestHistoryOverlayRendersInputAndFilters(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	renderRequests := 0
	entries := []HistoryEntry{
		historyEntryFixture("ship release", 3),
		historyEntryFixture("build project", 2),
		historyEntryFixture("write tests", 1),
	}
	ov := NewHistorySearchOverlay(HistorySearchOptions{
		Entries:       entries,
		Theme:         th,
		Keybindings:   km,
		RequestRender: func() { renderRequests++ },
		Done:          func(HistoryEntry, bool) {},
	})
	ov.SetFocused(true)
	ov.HandleInput("b")

	if ov.SearchValue() != "b" {
		t.Fatalf("search value = %q want b", ov.SearchValue())
	}
	if texts := textsOf(ov.FilteredEntries()); !reflect.DeepEqual(texts, []string{"build project"}) {
		t.Fatalf("filtered = %v", texts)
	}
	lines := ov.Render(80)
	joined := stripLines(lines)
	if !anyContains(joined, "> b") {
		t.Fatalf("overlay should show the search input `> b`, lines: %v", joined)
	}
	if !anyContains(joined, "1/3 prompts") {
		t.Fatalf("overlay should show the count `1/3 prompts`, lines: %v", joined)
	}
	if renderRequests != 1 {
		t.Fatalf("renderRequests = %d want 1", renderRequests)
	}
}

// TestHistoryOverlaySelectInsertsText verifies insert-on-select: confirming the
// selected row returns the entry (the caller then inserts its text into the
// editor, mirroring index.ts:53 `if (selected) ctx.ui.setEditorText`).
func TestHistoryOverlaySelectInsertsText(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	var selected HistoryEntry
	var ok bool
	entries := []HistoryEntry{
		historyEntryFixture("first prompt", 3),
		historyEntryFixture("second prompt", 2),
	}
	ov := NewHistorySearchOverlay(HistorySearchOptions{
		Entries:       entries,
		Theme:         th,
		Keybindings:   km,
		RequestRender: func() {},
		Done:          func(e HistoryEntry, sel bool) { selected, ok = e, sel },
	})
	ov.SetFocused(true)
	ov.HandleInput("\r") // tui.select.confirm
	if !ok || selected.Text != "first prompt" {
		t.Fatalf("confirm should select the first row, got ok=%v text=%q", ok, selected.Text)
	}
}

// TestHistoryOverlayEscapeCancels verifies esc closes with no selection.
func TestHistoryOverlayEscapeCancels(t *testing.T) {
	th := testTheme(t)
	km := keybindings.NewManager(nil)
	var ok = true
	ov := NewHistorySearchOverlay(HistorySearchOptions{
		Entries:       []HistoryEntry{historyEntryFixture("x", 1)},
		Theme:         th,
		Keybindings:   km,
		RequestRender: func() {},
		Done:          func(_ HistoryEntry, sel bool) { ok = sel },
	})
	ov.SetFocused(true)
	ov.HandleInput("\x1b") // esc
	if ok {
		t.Fatalf("esc should cancel with no selection")
	}
}

// --- small shared test helpers ----------------------------------------------

func testTheme(t *testing.T) *theme.Theme {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: "grok-night", AgentDir: t.TempDir()})
	if err != nil {
		t.Fatalf("theme load: %v", err)
	}
	return th
}

func textsOf(entries []HistoryEntry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Text
	}
	return out
}

func containsText(entries []HistoryEntry, text string) bool {
	for _, e := range entries {
		if e.Text == text {
			return true
		}
	}
	return false
}

func prompt(i int) string { return "prompt " + itoa(i) }

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeFileString(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeSessionFile mirrors the TS fixture writeSessionFile: writes under an
// `encoded-cwd` subdirectory of sessionsDir (history-search-fixtures.ts:96-106).
func writeSessionFile(t *testing.T, sessionsDir, fileName string, lines []string) string {
	t.Helper()
	dir := filepath.Join(sessionsDir, "encoded-cwd")
	mustMkdirAll(t, dir)
	file := filepath.Join(dir, fileName)
	writeFileString(t, file, strings.Join(lines, "\n")+"\n")
	return file
}

func stripLines(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = stripANSI(l)
	}
	return out
}

func anyContains(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}
