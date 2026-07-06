package keybindings

import (
	"reflect"
	"testing"
)

// migrate_test.go ports packages/coding-agent/test/keybindings-migration.test.ts
// (legacy-name migration contract) as Go table tests. Written RED first.

func TestMigrate_RewritesOldNamesToNamespacedIDs(t *testing.T) {
	config, migrated := MigrateConfig(map[string][]string{
		"cursorUp":    {"up", "ctrl+p"},
		"expandTools": {"ctrl+x"},
	})
	if !migrated {
		t.Errorf("migrated = false, want true")
	}
	want := map[string][]string{
		"tui.editor.cursorUp": {"up", "ctrl+p"},
		"app.tools.expand":    {"ctrl+x"},
	}
	if !reflect.DeepEqual(config, want) {
		t.Errorf("MigrateConfig = %v, want %v", config, want)
	}
}

func TestMigrate_NamespacedValueWinsWhenBothExist(t *testing.T) {
	config, migrated := MigrateConfig(map[string][]string{
		"expandTools":      {"ctrl+x"},
		"app.tools.expand": {"ctrl+y"},
	})
	if !migrated {
		t.Errorf("migrated = false, want true")
	}
	want := map[string][]string{"app.tools.expand": {"ctrl+y"}}
	if !reflect.DeepEqual(config, want) {
		t.Errorf("MigrateConfig = %v, want %v", config, want)
	}
}

// The "loads old key names in memory before the file is rewritten" TS case maps
// to: NewManager applied to a legacy config resolves the migrated ids.
func TestMigrate_ManagerLoadsLegacyNamesInMemory(t *testing.T) {
	legacy, _ := MigrateConfig(map[string][]string{
		"selectConfirm": {"enter"},
		"interrupt":     {"ctrl+x"},
	})
	m := NewManager(legacy)
	if got := m.Keys("tui.select.confirm"); !reflect.DeepEqual(got, []string{"enter"}) {
		t.Errorf("Keys(tui.select.confirm) = %v, want [enter]", got)
	}
	if got := m.Keys("app.interrupt"); !reflect.DeepEqual(got, []string{"ctrl+x"}) {
		t.Errorf("Keys(app.interrupt) = %v, want [ctrl+x]", got)
	}
}
