package keybindings

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// loader_test.go covers the end-to-end store -> migrate -> manager path,
// including the QA failure scenario: a malformed keybindings.json must fall back
// to defaults (matching classic warn-and-default behavior), never crash.

func writeKeybindings(t *testing.T, contents string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "keybindings.json"), []byte(contents), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return dir
}

func TestLoad_OverrideFixtureFlipsBinding(t *testing.T) {
	// A namespaced override flips app.tools.expand from ctrl+o to ctrl+x.
	dir := writeKeybindings(t, `{"app.tools.expand":"ctrl+x"}`)
	m, err := Load(dir)
	if err != nil {
		t.Fatalf("Load err = %v", err)
	}
	if got := m.Keys("app.tools.expand"); !reflect.DeepEqual(got, []string{"ctrl+x"}) {
		t.Errorf("Keys(app.tools.expand) = %v, want [ctrl+x]", got)
	}
}

func TestLoad_LegacyNameMigratedOnLoad(t *testing.T) {
	// A legacy flat name must resolve to its namespaced action id in memory.
	dir := writeKeybindings(t, `{"expandTools":"ctrl+x","selectConfirm":"enter"}`)
	m, err := Load(dir)
	if err != nil {
		t.Fatalf("Load err = %v", err)
	}
	if got := m.Keys("app.tools.expand"); !reflect.DeepEqual(got, []string{"ctrl+x"}) {
		t.Errorf("Keys(app.tools.expand) = %v, want [ctrl+x]", got)
	}
	if got := m.Keys("tui.select.confirm"); !reflect.DeepEqual(got, []string{"enter"}) {
		t.Errorf("Keys(tui.select.confirm) = %v, want [enter]", got)
	}
}

// The QA failure scenario: malformed keybindings.json -> defaults, no crash.
func TestLoad_MalformedFileFallsBackToDefaults(t *testing.T) {
	dir := writeKeybindings(t, `{ this is not valid json `)
	m, err := Load(dir)
	if err != nil {
		t.Fatalf("Load err = %v, want nil (warn-and-default)", err)
	}
	if got := m.Keys("app.tools.expand"); !reflect.DeepEqual(got, []string{"ctrl+o"}) {
		t.Errorf("Keys(app.tools.expand) = %v, want default [ctrl+o]", got)
	}
	if got := m.Keys("app.thinking.cycle"); !reflect.DeepEqual(got, []string{"shift+tab"}) {
		t.Errorf("Keys(app.thinking.cycle) = %v, want default [shift+tab]", got)
	}
}

func TestLoad_MissingFileYieldsDefaults(t *testing.T) {
	m, err := Load(t.TempDir()) // no keybindings.json in this dir
	if err != nil {
		t.Fatalf("Load err = %v", err)
	}
	if got := m.Keys("app.interrupt"); !reflect.DeepEqual(got, []string{"escape"}) {
		t.Errorf("Keys(app.interrupt) = %v, want default [escape]", got)
	}
}
