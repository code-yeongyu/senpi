package keybindings

import "runtime"

// registry.go holds the action-id registry (TUI defaults + the 44 app actions),
// the Manager that resolves keys to actions with user overrides, and the
// contextual scope tables. It ports packages/tui/src/keybindings.ts
// (KeybindingsManager) and packages/coding-agent/src/core/keybindings.ts
// (KEYBINDINGS + platform-aware defaults).

// Definition is one registry entry: the action id's default key ids and a human
// description. Mirrors KeybindingDefinition (keybindings.ts:46-49).
type Definition struct {
	DefaultKeys []string
	Description string
}

// Scope identifies a contextual key-resolution table. The same physical key can
// map to different actions depending on which UI surface is focused, so ctrl+p
// resolves to app.model.cycleForward in the editor but app.models.toggleProvider
// in the models overlay.
type Scope string

// The contextual scopes. ScopeEditor is the default prompt surface; the others
// correspond to the overlays whose sub-tables reuse chords like ctrl+p/ctrl+d
// for different actions (core/keybindings.ts tree/session/models sub-scopes).
const (
	ScopeEditor   Scope = "editor"
	ScopeSelector Scope = "selector"
	ScopeTree     Scope = "tree"
	ScopeSession  Scope = "session"
	ScopeModels   Scope = "models"
)

// Conflict reports a user binding where one key id is claimed by more than one
// action. Mirrors KeybindingConflict (keybindings.ts:136-139).
type Conflict struct {
	Key     string
	Actions []string
}

// definitionOrder is the registry's declaration order: TUI defaults first (in
// keybindings.ts order), then the 44 app actions (in core/keybindings.ts order).
// Order matters for migration ordering and for stable conflict/scope output.
var definitionOrder = buildDefinitionOrder()

// definitions is the id -> Definition map built from the ordered entries.
var definitions = buildDefinitions()

// Definitions returns a copy of the full action-id registry (TUI + app actions).
func Definitions() map[string]Definition {
	out := make(map[string]Definition, len(definitions))
	for id, def := range definitions {
		keys := make([]string, len(def.DefaultKeys))
		copy(keys, def.DefaultKeys)
		out[id] = Definition{DefaultKeys: keys, Description: def.Description}
	}
	return out
}

// suspendDefault mirrors core/keybindings.ts:71-74: ctrl+z everywhere except
// Windows, where the default is empty.
func suspendDefault() []string {
	if runtime.GOOS == "windows" {
		return []string{}
	}
	return []string{"ctrl+z"}
}

// pasteImageDefault mirrors core/keybindings.ts:111-114: alt+v on Windows,
// ctrl+v elsewhere.
func pasteImageDefault() []string {
	if runtime.GOOS == "windows" {
		return []string{"alt+v"}
	}
	return []string{"ctrl+v"}
}

// Manager is the neo keybinding manager. It holds the resolved key list per
// action (defaults overlaid by user bindings) and reports user-binding
// conflicts, mirroring KeybindingsManager (keybindings.ts:155-231).
type Manager struct {
	userBindings map[string][]string
	keysByID     map[string][]string
	conflicts    []Conflict
}

// NewManager builds a Manager from the built-in definitions plus user overrides
// (already migrated + shape-normalized). A nil or empty override map yields pure
// defaults.
func NewManager(userBindings map[string][]string) *Manager {
	m := &Manager{userBindings: userBindings}
	m.rebuild()
	return m
}

// rebuild mirrors KeybindingsManager.rebuild: resolve each action's keys
// (user override wins, else default) and collect conflicts among user bindings.
func (m *Manager) rebuild() {
	m.keysByID = make(map[string][]string, len(definitions))
	m.conflicts = nil

	userClaims := map[string][]string{}
	claimSeen := map[string]map[string]bool{}
	for _, id := range definitionOrder {
		keys, ok := m.userBindings[id]
		if !ok {
			continue
		}
		for _, key := range normalizeKeys(keys) {
			if claimSeen[key] == nil {
				claimSeen[key] = map[string]bool{}
			}
			if !claimSeen[key][id] {
				claimSeen[key][id] = true
				userClaims[key] = append(userClaims[key], id)
			}
		}
	}
	for _, key := range orderedKeys(userClaims) {
		if len(userClaims[key]) > 1 {
			m.conflicts = append(m.conflicts, Conflict{Key: key, Actions: append([]string(nil), userClaims[key]...)})
		}
	}

	for _, id := range definitionOrder {
		def := definitions[id]
		if userKeys, ok := m.userBindings[id]; ok {
			m.keysByID[id] = normalizeKeys(userKeys)
		} else {
			m.keysByID[id] = normalizeKeys(def.DefaultKeys)
		}
	}
}

// Keys returns the effective key ids bound to an action after overrides. The
// result is always a non-nil slice (empty for an unbound action), mirroring
// getKeys returning a fresh array in keybindings.ts.
func (m *Manager) Keys(action string) []string {
	keys := m.keysByID[action]
	out := make([]string, len(keys))
	copy(out, keys)
	return out
}

// Matches reports whether raw terminal data triggers action.
func (m *Manager) Matches(data, action string) bool {
	for _, key := range m.keysByID[action] {
		if MatchesKey(data, key) {
			return true
		}
	}
	return false
}

// Conflicts returns user-binding conflicts.
func (m *Manager) Conflicts() []Conflict {
	out := make([]Conflict, len(m.conflicts))
	for i, c := range m.conflicts {
		out[i] = Conflict{Key: c.Key, Actions: append([]string(nil), c.Actions...)}
	}
	return out
}

// SetUserBindings replaces the override set and rebuilds, mirroring
// KeybindingsManager.setUserBindings (used by keybindings.json reload).
func (m *Manager) SetUserBindings(userBindings map[string][]string) {
	m.userBindings = userBindings
	m.rebuild()
}

// normalizeKeys mirrors keybindings.ts normalizeKeys: dedupe while preserving
// order; nil input yields an empty (non-nil) slice.
func normalizeKeys(keys []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, k := range keys {
		if !seen[k] {
			seen[k] = true
			result = append(result, k)
		}
	}
	return result
}
