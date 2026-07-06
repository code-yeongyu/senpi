package store_test

import (
	"path/filepath"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
)

// TestKeybindingsStringAndArray mirrors toKeybindingsConfig
// (keybindings.ts:288-301): a binding value is either a single string or an
// array of strings; other shapes are dropped.
func TestKeybindingsStringAndArray(t *testing.T) {
	agentDir := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "keybindings.json"), `{
		"app.interrupt": "esc",
		"app.model.cycleForward": ["ctrl+p", "alt+p"],
		"app.bogus": 42,
		"app.bogus2": ["ok", 7]
	}`)

	kb, err := store.LoadKeybindings(agentDir)
	if err != nil {
		t.Fatalf("LoadKeybindings: %v", err)
	}

	if got := kb.Bindings["app.interrupt"]; len(got) != 1 || got[0] != "esc" {
		t.Errorf("app.interrupt = %v, want [esc]", got)
	}
	if got := kb.Bindings["app.model.cycleForward"]; len(got) != 2 || got[0] != "ctrl+p" || got[1] != "alt+p" {
		t.Errorf("app.model.cycleForward = %v, want [ctrl+p alt+p]", got)
	}
	if _, ok := kb.Bindings["app.bogus"]; ok {
		t.Errorf("non-string/array binding app.bogus should be dropped")
	}
	if _, ok := kb.Bindings["app.bogus2"]; ok {
		t.Errorf("mixed-type array binding app.bogus2 should be dropped")
	}
}

// TestKeybindingsMissingFile mirrors loadRawConfig (keybindings.ts:344-352): a
// missing file yields empty bindings, no error.
func TestKeybindingsMissingFile(t *testing.T) {
	agentDir := t.TempDir()
	kb, err := store.LoadKeybindings(agentDir)
	if err != nil {
		t.Fatalf("LoadKeybindings on missing file: %v", err)
	}
	if len(kb.Bindings) != 0 {
		t.Errorf("expected empty bindings, got %v", kb.Bindings)
	}
}

// TestKeybindingsCorruptFile mirrors loadRawConfig catch: malformed JSON yields
// empty bindings, no error (matches classic warn+defaults behavior).
func TestKeybindingsCorruptFile(t *testing.T) {
	agentDir := t.TempDir()
	writeFile(t, filepath.Join(agentDir, "keybindings.json"), `{ this is not json `)
	kb, err := store.LoadKeybindings(agentDir)
	if err != nil {
		t.Fatalf("LoadKeybindings on corrupt file returned error: %v", err)
	}
	if len(kb.Bindings) != 0 {
		t.Errorf("expected empty bindings on corrupt file, got %v", kb.Bindings)
	}
}
