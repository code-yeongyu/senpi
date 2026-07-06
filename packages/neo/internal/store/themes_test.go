package store_test

import (
	"path/filepath"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestListCustomThemes mirrors getCustomThemeInfos (theme.ts:483-506): read every
// *.json in the themes dir, parse it, and use the inner "name" field; invalid
// or non-json files are skipped.
func TestListCustomThemes(t *testing.T) {
	agentDir := t.TempDir()
	themesDir := filepath.Join(agentDir, "themes")
	writeFile(t, filepath.Join(themesDir, "mine.json"), `{"name":"My Custom","colors":{}}`)
	writeFile(t, filepath.Join(themesDir, "other.json"), `{"name":"Other Skin"}`)
	writeFile(t, filepath.Join(themesDir, "broken.json"), `{ not json`)
	writeFile(t, filepath.Join(themesDir, "notes.txt"), `ignored`)
	writeFile(t, filepath.Join(themesDir, "noname.json"), `{"colors":{}}`) // no name -> skipped

	themes, err := store.ListCustomThemes(agentDir)
	if err != nil {
		t.Fatalf("ListCustomThemes: %v", err)
	}

	names := map[string]string{}
	for _, th := range themes {
		names[th.Name] = th.Path
	}
	if len(themes) != 2 {
		t.Fatalf("got %d themes, want 2 (%v)", len(themes), names)
	}
	if names["My Custom"] != filepath.Join(themesDir, "mine.json") {
		t.Errorf("My Custom path = %q", names["My Custom"])
	}
	if _, ok := names["Other Skin"]; !ok {
		t.Errorf("Other Skin missing")
	}
}

// TestListCustomThemesMissingDir yields empty list, no error.
func TestListCustomThemesMissingDir(t *testing.T) {
	agentDir := t.TempDir()
	themes, err := store.ListCustomThemes(agentDir)
	if err != nil {
		t.Fatalf("ListCustomThemes on missing dir: %v", err)
	}
	if len(themes) != 0 {
		t.Errorf("expected 0 themes, got %d", len(themes))
	}
}
