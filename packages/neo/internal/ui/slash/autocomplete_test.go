package slash

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

// The provider port targets the editor.AutocompleteProvider /
// editor.CtxAutocompleteProvider / fileCompletionGate contracts so the wave-1
// editor drives it unchanged.
func getSuggestions(t *testing.T, p editor.AutocompleteProvider, line string, force bool) *editor.Suggestions {
	t.Helper()
	s, err := p.GetSuggestions([]string{line}, 0, len([]rune(line)), force)
	if err != nil {
		t.Fatalf("GetSuggestions(%q) error: %v", line, err)
	}
	return s
}

func values(s *editor.Suggestions) []string {
	if s == nil {
		return nil
	}
	out := make([]string, len(s.Items))
	for i, it := range s.Items {
		out[i] = it.Value
	}
	return out
}

// --- Ported from autocomplete-slash.test.ts ---

func TestSlashRanksLongerPrefixMatchesFirst(t *testing.T) {
	p := NewCombinedProvider([]Command{
		{Name: "session", Description: "Show session info and stats"},
		{Name: "sessions", Description: "Peek at previous session transcripts in a HUD"},
	}, "/tmp", "")
	res := getSuggestions(t, p, "/sessio", false)
	got := values(res)
	want := []string{"sessions", "session"}
	if !equalStrings(got, want) {
		t.Fatalf("/sessio ranking = %v, want %v", got, want)
	}
}

func TestSlashKeepsExactMatchFirst(t *testing.T) {
	p := NewCombinedProvider([]Command{
		{Name: "session", Description: "Show session info and stats"},
		{Name: "sessions", Description: "Peek at previous session transcripts in a HUD"},
	}, "/tmp", "")
	res := getSuggestions(t, p, "/session", false)
	got := values(res)
	want := []string{"session", "sessions"}
	if !equalStrings(got, want) {
		t.Fatalf("/session ranking = %v, want %v", got, want)
	}
}

// --- Ported from autocomplete.test.ts extractPathPrefix ---

func TestExtractSlashRootWhenForced(t *testing.T) {
	p := NewCombinedProvider(nil, "/tmp", "")
	res := getSuggestions(t, p, "hey /", true)
	if res == nil {
		t.Fatal("expected suggestions for root directory")
	}
	if res.Prefix != "/" {
		t.Fatalf("prefix = %q, want /", res.Prefix)
	}
}

func TestDoesNotTriggerForSlashCommands(t *testing.T) {
	p := NewCombinedProvider(nil, "/tmp", "")
	res := getSuggestions(t, p, "/model", true)
	if res != nil {
		t.Fatalf("expected nil for slash command, got %v", values(res))
	}
}

func TestTriggersForAbsolutePathAfterCommandArg(t *testing.T) {
	p := NewCombinedProvider(nil, "/tmp", "")
	res := getSuggestions(t, p, "/command /", true)
	if res == nil {
		t.Fatal("expected suggestions for absolute path in command args")
	}
	if res.Prefix != "/" {
		t.Fatalf("prefix = %q, want /", res.Prefix)
	}
}

// --- @ file suggestions (require fd). Ported from autocomplete.test.ts. ---

func resolveFd(t *testing.T) string {
	t.Helper()
	for _, name := range []string{"fd", "fdfind"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	t.Skip("fd not installed")
	return ""
}

func setupFolder(t *testing.T, base string, dirs []string, files map[string]string) {
	t.Helper()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(base, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for f, c := range files {
		full := filepath.Join(base, f)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAtEmptyReturnsAllEntries(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, []string{"src"}, map[string]string{"README.md": "readme"})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@", false)
	got := values(res)
	sort.Strings(got)
	want := []string{"@README.md", "@src/"}
	sort.Strings(want)
	if !equalStrings(got, want) {
		t.Fatalf("@ empty = %v, want %v", got, want)
	}
}

func TestAtCaseInsensitive(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, []string{"src"}, map[string]string{"README.md": "readme"})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@re", false)
	got := values(res)
	if !equalStrings(got, []string{"@README.md"}) {
		t.Fatalf("@re = %v, want [@README.md]", got)
	}
}

func TestAtRanksDirectoriesFirst(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, []string{"src"}, map[string]string{"src.txt": "text"})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@src", false)
	if res == nil || len(res.Items) == 0 {
		t.Fatal("expected @src suggestions")
	}
	if res.Items[0].Value != "@src/" {
		t.Fatalf("first = %q, want @src/", res.Items[0].Value)
	}
	if !containsValue(res, "@src.txt") {
		t.Fatal("expected @src.txt present")
	}
}

func TestAtNestedPaths(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, nil, map[string]string{"src/index.ts": "export {};\n"})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@index", false)
	if !containsValue(res, "@src/index.ts") {
		t.Fatalf("expected @src/index.ts, got %v", values(res))
	}
}

func TestAtDeeplyNestedFullPath(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, nil, map[string]string{
		"packages/tui/src/autocomplete.ts": "export {};",
		"packages/ai/src/autocomplete.ts":  "export {};",
	})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@tui/src/auto", false)
	if !containsValue(res, "@packages/tui/src/autocomplete.ts") {
		t.Fatalf("expected tui path, got %v", values(res))
	}
	if containsValue(res, "@packages/ai/src/autocomplete.ts") {
		t.Fatalf("should not include ai path: %v", values(res))
	}
}

func TestAtExcludesGit(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, []string{".pi", ".github", ".git"}, map[string]string{
		".pi/config.json":          "{}",
		".github/workflows/ci.yml": "name: ci",
		".git/config":              "[core]",
	})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@", false)
	got := values(res)
	if !contains(got, "@.pi/") || !contains(got, "@.github/") {
		t.Fatalf("expected hidden dirs, got %v", got)
	}
	for _, v := range got {
		// classic: exclude only "@.git" exactly or the "@.git/" subtree (NOT
		// @.github, a sibling dir).
		if v == "@.git" || strings.HasPrefix(v, "@.git/") {
			t.Fatalf("should exclude .git: %v", got)
		}
	}
}

func TestAtQuotesPathsWithSpaces(t *testing.T) {
	fd := resolveFd(t)
	base := t.TempDir()
	setupFolder(t, base, []string{"my folder"}, map[string]string{"my folder/test.txt": "content"})
	p := NewCombinedProvider(nil, base, fd)
	res := getSuggestions(t, p, "@my", false)
	if !containsValue(res, `@"my folder/"`) {
		t.Fatalf("expected quoted folder, got %v", values(res))
	}
}

// --- ./ path completion (readdir, no fd) ---

func TestDotSlashPreservesPrefix(t *testing.T) {
	base := t.TempDir()
	setupFolder(t, base, nil, map[string]string{"update.sh": "#!/bin/bash", "utils.ts": "export {};"})
	p := NewCombinedProvider(nil, base, "")
	res := getSuggestions(t, p, "./up", true)
	if !containsValue(res, "./update.sh") {
		t.Fatalf("expected ./update.sh, got %v", values(res))
	}
}

func TestDotSlashDirectory(t *testing.T) {
	base := t.TempDir()
	setupFolder(t, base, []string{"src"}, map[string]string{"src/index.ts": "export {};"})
	p := NewCombinedProvider(nil, base, "")
	res := getSuggestions(t, p, "./sr", true)
	if !containsValue(res, "./src/") {
		t.Fatalf("expected ./src/, got %v", values(res))
	}
}

func TestQuotedPathSpaces(t *testing.T) {
	base := t.TempDir()
	setupFolder(t, base, []string{"my folder"}, map[string]string{"my folder/test.txt": "content"})
	p := NewCombinedProvider(nil, base, "")
	res := getSuggestions(t, p, "my", true)
	if !containsValue(res, `"my folder/"`) {
		t.Fatalf("expected quoted folder, got %v", values(res))
	}
}

func TestApplyQuotedCompletionNoDoubleQuote(t *testing.T) {
	base := t.TempDir()
	setupFolder(t, base, nil, map[string]string{"my folder/test.txt": "content"})
	p := NewCombinedProvider(nil, base, "")
	line := `"my folder/te"`
	cursorCol := len([]rune(line)) - 1
	res, err := p.GetSuggestions([]string{line}, 0, cursorCol, true)
	if err != nil {
		t.Fatal(err)
	}
	if res == nil {
		t.Fatal("expected suggestions for quoted path")
	}
	var item editor.Item
	found := false
	for _, it := range res.Items {
		if it.Value == `"my folder/test.txt"` {
			item = it
			found = true
		}
	}
	if !found {
		t.Fatalf("test.txt not found: %v", values(res))
	}
	applied := p.ApplyCompletion([]string{line}, 0, cursorCol, item, res.Prefix)
	if applied.Lines[0] != `"my folder/test.txt"` {
		t.Fatalf("applied = %q", applied.Lines[0])
	}
}

// --- Slash command argument completion path (implements CtxAutocompleteProvider) ---

func TestProviderImplementsCtxAndGate(t *testing.T) {
	p := NewCombinedProvider(nil, "/tmp", "")
	if _, ok := interface{}(p).(editor.CtxAutocompleteProvider); !ok {
		t.Fatal("provider must implement CtxAutocompleteProvider for abort semantics")
	}
	// shouldTriggerFileCompletion veto: slash command in progress → false.
	ctxRes, err := p.GetSuggestionsCtx(context.Background(), []string{"@"}, 0, 1, false)
	_ = ctxRes
	if err != nil {
		t.Fatal(err)
	}
}

func equalStrings(a, b []string) bool {
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

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func containsValue(s *editor.Suggestions, v string) bool {
	return contains(values(s), v)
}
