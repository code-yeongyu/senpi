package keybindings

import "github.com/code-yeongyu/senpi/packages/neo/internal/store"

// loader.go wires the native store reader to the keybinding manager: it reads
// ~/.senpi/agent/keybindings.json (via internal/store), applies legacy-name
// migration, and returns a ready Manager. This mirrors KeybindingsManager.create
// (core/keybindings.ts:362-366): a missing/malformed file yields defaults, and
// old key names are migrated to namespaced ids in memory before resolution.

// Load reads the keybindings overrides from the given agent dir and returns a
// Manager with those overrides applied (after legacy-name migration). A missing
// or malformed keybindings.json yields a defaults-only Manager and a nil error,
// matching the classic warn-and-fall-back behavior.
func Load(agentDir string) (*Manager, error) {
	kb, err := store.LoadKeybindings(agentDir)
	if err != nil {
		// A read error (not "missing", which the store already tolerates) still
		// yields defaults so the UI never crashes on a bad file.
		return NewManager(nil), err
	}
	migrated, _ := MigrateConfig(kb.Bindings)
	return NewManager(migrated), nil
}

// LoadDefault reads overrides from the default senpi agent dir.
func LoadDefault() (*Manager, error) {
	return Load(store.DefaultConfig().AgentDir())
}
