package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Keybindings holds the user's keybindings.json overrides as an actionId ->
// list-of-keys map. It mirrors toKeybindingsConfig (keybindings.ts:288-301):
// each value is normalized to a slice whether the file used a single string or
// an array of strings; any other shape is dropped.
type Keybindings struct {
	// Bindings maps an action id (e.g. "app.interrupt") to its bound key ids.
	Bindings map[string][]string
}

// LoadKeybindings reads <agentDir>/keybindings.json, mirroring
// KeybindingsManager.loadFromFile + loadRawConfig (keybindings.ts:344-365): a
// missing or malformed file yields empty bindings with no error (the classic
// path warns and falls back to defaults).
func LoadKeybindings(agentDir string) (Keybindings, error) {
	path := filepath.Join(agentDir, "keybindings.json")
	kb := Keybindings{Bindings: map[string][]string{}}

	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return kb, nil
		}
		return kb, err
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		// Corrupt file: mirror loadRawConfig's catch -> undefined (no error).
		return kb, nil
	}

	for action, rawVal := range raw {
		keys, ok := parseBinding(rawVal)
		if !ok {
			continue
		}
		kb.Bindings[action] = keys
	}
	return kb, nil
}

// parseBinding normalizes one keybindings.json value to a []string, mirroring
// toKeybindingsConfig: a string becomes a single-element slice; an array of
// strings is taken as-is; a mixed or non-string-array value is rejected.
func parseBinding(raw json.RawMessage) ([]string, bool) {
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return []string{single}, true
	}
	var arr []any
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, false
	}
	keys := make([]string, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok {
			// Array contains a non-string: reject the whole binding (mirrors
			// binding.every(entry => typeof entry === "string")).
			return nil, false
		}
		keys = append(keys, s)
	}
	return keys, true
}
