package keybindings

import (
	"strings"

	tea "charm.land/bubbletea/v2"
)

// normalize.go bridges bubbletea v2's parsed key events into the neo key-id
// vocabulary. bubbletea (with kitty enhancements enabled) parses raw terminal
// bytes itself into a structured Key; the classic key-ids the registry uses have
// a slightly different spelling (escape/pageUp/pageDown vs bubbletea's
// esc/pgup/pgdown) and a fixed modifier order (shift+ctrl+alt+super, matching how
// core/keybindings.ts writes defaults like "shift+ctrl+p"). NormalizeKeyMsg maps
// one to the other so the Manager can resolve a KeyPressMsg through the SAME
// registry path as a raw sequence — no hardcoded key comparison anywhere.

// specialKeyNames maps bubbletea special key codes to neo key-id names.
var specialKeyNames = map[rune]string{
	tea.KeyEscape:    "escape",
	tea.KeyEnter:     "enter",
	tea.KeyKpEnter:   "enter",
	tea.KeyTab:       "tab",
	tea.KeyBackspace: "backspace",
	tea.KeySpace:     "space",
	tea.KeyDelete:    "delete",
	tea.KeyKpDelete:  "delete",
	tea.KeyInsert:    "insert",
	tea.KeyKpInsert:  "insert",
	tea.KeyHome:      "home",
	tea.KeyKpHome:    "home",
	tea.KeyEnd:       "end",
	tea.KeyKpEnd:     "end",
	tea.KeyPgUp:      "pageUp",
	tea.KeyKpPgUp:    "pageUp",
	tea.KeyPgDown:    "pageDown",
	tea.KeyKpPgDown:  "pageDown",
	tea.KeyUp:        "up",
	tea.KeyKpUp:      "up",
	tea.KeyDown:      "down",
	tea.KeyKpDown:    "down",
	tea.KeyLeft:      "left",
	tea.KeyKpLeft:    "left",
	tea.KeyRight:     "right",
	tea.KeyKpRight:   "right",
	tea.KeyF1:        "f1", tea.KeyF2: "f2", tea.KeyF3: "f3", tea.KeyF4: "f4",
	tea.KeyF5: "f5", tea.KeyF6: "f6", tea.KeyF7: "f7", tea.KeyF8: "f8",
	tea.KeyF9: "f9", tea.KeyF10: "f10", tea.KeyF11: "f11", tea.KeyF12: "f12",
}

// baseKeyName returns the un-modified key name for a bubbletea Key, or "" if the
// code is not one neo binds. Base-layout keys (BaseCode) win for non-Latin
// layouts, matching keys.ts's base-layout preference.
func baseKeyName(k tea.Key) string {
	if name, ok := specialKeyNames[k.Code]; ok {
		return name
	}
	code := k.Code
	if k.BaseCode != 0 {
		isLatinLetter := code >= 'a' && code <= 'z'
		isDigit := code >= '0' && code <= '9'
		isSymbol := code >= 0 && code <= 0x10FFFF && symbolKeys[code]
		if !(isLatinLetter || isDigit || isSymbol) {
			code = k.BaseCode
		}
	}
	// Fold a shifted uppercase letter to its lowercase key name (ctrl+C == ctrl+c).
	if code >= 'A' && code <= 'Z' && (k.Mod&tea.ModShift != 0) {
		code += 32
	}
	if code >= 'a' && code <= 'z' {
		return string(code)
	}
	if code >= '0' && code <= '9' {
		return string(code)
	}
	if code >= 0 && code <= 0x10FFFF && symbolKeys[code] {
		return string(code)
	}
	// Printable text (e.g. a shifted symbol) with no special code.
	if k.Text != "" {
		return k.Text
	}
	return ""
}

// NormalizeKeyMsg converts a bubbletea v2 KeyPressMsg into its neo key-id string
// (e.g. "shift+ctrl+p", "escape", "alt+up"). Modifier order is fixed as
// shift+ctrl+alt+super to match the default-binding spelling in the registry.
func NormalizeKeyMsg(msg tea.KeyPressMsg) string {
	k := tea.Key(msg)
	name := baseKeyName(k)
	if name == "" {
		return ""
	}
	var mods []string
	if k.Mod&tea.ModShift != 0 {
		mods = append(mods, "shift")
	}
	if k.Mod&tea.ModCtrl != 0 {
		mods = append(mods, "ctrl")
	}
	if k.Mod&tea.ModAlt != 0 {
		mods = append(mods, "alt")
	}
	if k.Mod&tea.ModSuper != 0 {
		mods = append(mods, "super")
	}
	if len(mods) == 0 {
		return name
	}
	return strings.Join(mods, "+") + "+" + name
}

// MatchesKeyMsg reports whether a bubbletea KeyPressMsg triggers action, routing
// through the normalized key-id and the registry — the neo update loop's single
// key-resolution entry point (no hardcoded comparisons).
func (m *Manager) MatchesKeyMsg(msg tea.KeyPressMsg, action string) bool {
	id := NormalizeKeyMsg(msg)
	if id == "" {
		return false
	}
	for _, key := range m.keysByID[action] {
		if keyIDEqual(key, id) {
			return true
		}
	}
	return false
}

// ResolveKeyMsgScoped returns the action ids a KeyPressMsg triggers within scope,
// in scope-priority order. Deterministic, mirroring ResolveScoped.
func (m *Manager) ResolveKeyMsgScoped(msg tea.KeyPressMsg, scope Scope) []string {
	id := NormalizeKeyMsg(msg)
	if id == "" {
		return nil
	}
	actions, ok := scopeActions[scope]
	if !ok {
		return nil
	}
	var out []string
	for _, action := range actions {
		for _, key := range m.keysByID[action] {
			if keyIDEqual(key, id) {
				out = append(out, action)
				break
			}
		}
	}
	return out
}

// keyIDEqual compares two key-ids for semantic equality independent of modifier
// ordering: "shift+ctrl+p" == "ctrl+shift+p". This lets a user's differently
// ordered override still match the normalized event id.
func keyIDEqual(a, b string) bool {
	pa, oka := parseKeyID(a)
	pb, okb := parseKeyID(b)
	if !oka || !okb {
		return a == b
	}
	return pa.key == pb.key && pa.ctrl == pb.ctrl && pa.shift == pb.shift &&
		pa.alt == pb.alt && pa.super == pb.super
}
