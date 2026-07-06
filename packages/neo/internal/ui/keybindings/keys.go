// Package keybindings is the neo TUI's keybinding manager. It ports the classic
// TUI's raw-sequence matcher (packages/tui/src/keys.ts) and keybinding registry
// (packages/tui/src/keybindings.ts + packages/coding-agent/src/core/keybindings.ts)
// so that EVERY key in the neo UI resolves through an action-id registry and
// user overrides, never a hardcoded byte comparison.
//
// Two layers live here:
//
//   - The raw matcher (MatchesKey / ParseKey), a faithful Go port of keys.ts.
//     It answers "does this raw terminal byte string represent <key-id>?" and
//     "what canonical key-id is this byte string?" across legacy escape
//     sequences, xterm modifyOtherKeys, and the Kitty keyboard protocol
//     (including alternate/base-layout keys and event types).
//   - The registry (Manager, registry.go), which maps action ids (both TUI-level
//     defaults and the 44 app actions) to key ids, applies user overrides from
//     keybindings.json with legacy-name migration, and resolves keys to the
//     action(s) they trigger within a scope.
package keybindings

import "strings"

// kittyProtocolActive mirrors keys.ts _kittyProtocolActive. It is process-global
// to match the classic module-level flag set by the terminal after detecting
// Kitty keyboard-protocol support.
var kittyProtocolActive bool

// SetKittyProtocolActive mirrors keys.ts setKittyProtocolActive.
func SetKittyProtocolActive(active bool) { kittyProtocolActive = active }

// IsKittyProtocolActive mirrors keys.ts isKittyProtocolActive.
func IsKittyProtocolActive() bool { return kittyProtocolActive }

// parsedKeyID is a decomposed key identifier such as "shift+ctrl+p".
type parsedKeyID struct {
	key                     string
	ctrl, shift, alt, super bool
}

// parseKeyID mirrors keys.ts parseKeyId: lowercase, split on '+', last token is
// the base key, the rest are modifier flags.
func parseKeyID(keyID string) (parsedKeyID, bool) {
	parts := strings.Split(strings.ToLower(keyID), "+")
	key := parts[len(parts)-1]
	if key == "" {
		return parsedKeyID{}, false
	}
	p := parsedKeyID{key: key}
	for _, part := range parts {
		switch part {
		case "ctrl":
			p.ctrl = true
		case "shift":
			p.shift = true
		case "alt":
			p.alt = true
		case "super":
			p.super = true
		}
	}
	return p, true
}

// MatchesKey reports whether raw terminal input data represents keyID. It is a
// faithful port of keys.ts matchesKey; see that file for the rationale behind
// each branch (legacy ambiguities, Kitty protocol interactions, etc.).
func MatchesKey(data, keyID string) bool {
	p, ok := parseKeyID(keyID)
	if !ok {
		return false
	}
	modifier := 0
	if p.shift {
		modifier |= modShift
	}
	if p.alt {
		modifier |= modAlt
	}
	if p.ctrl {
		modifier |= modCtrl
	}
	if p.super {
		modifier |= modSuper
	}

	switch p.key {
	case "escape", "esc":
		if modifier != 0 {
			return false
		}
		return data == "\x1b" ||
			matchesKittySequence(data, cpEscape, 0) ||
			matchesModifyOtherKeys(data, cpEscape, 0)
	case "space":
		return matchSpace(data, modifier)
	case "tab":
		return matchTab(data, modifier)
	case "enter", "return":
		return matchEnter(data, modifier)
	case "backspace":
		return matchBackspace(data, modifier)
	case "insert", "delete", "clear", "home", "end", "pageup", "pagedown":
		return matchFunctional(data, p.key, modifier)
	case "up", "down", "left", "right":
		return matchArrow(data, p.key, modifier)
	case "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12":
		if modifier != 0 {
			return false
		}
		return matchesLegacySequence(data, legacyKeySequences[p.key])
	}

	return matchPrintable(data, p.key, modifier)
}

// matchPrintable mirrors the single letter/digit/symbol tail of matchesKey.
func matchPrintable(data, key string, modifier int) bool {
	if len(key) != 1 {
		return false
	}
	c := key[0]
	if !((key >= "a" && key <= "z") || isDigitKey(key) || symbolKeys[rune(c)]) {
		return false
	}
	codepoint := int(c)
	rawCtrl, hasRawCtrl := rawCtrlChar(key)
	isLetter := key >= "a" && key <= "z"
	isDigit := isDigitKey(key)

	if modifier == modCtrl+modAlt && !kittyProtocolActive && hasRawCtrl {
		if data == "\x1b"+rawCtrl {
			return true
		}
	}
	if modifier == modAlt && !kittyProtocolActive && (isLetter || isDigit) {
		if data == "\x1b"+key {
			return true
		}
	}
	if modifier == modCtrl {
		if hasRawCtrl && data == rawCtrl {
			return true
		}
		return matchesKittySequence(data, codepoint, modCtrl) ||
			matchesPrintableModifyOtherKeys(data, codepoint, modCtrl)
	}
	if modifier == modShift+modCtrl {
		return matchesKittySequence(data, codepoint, modShift+modCtrl) ||
			matchesPrintableModifyOtherKeys(data, codepoint, modShift+modCtrl)
	}
	if modifier == modShift {
		if isLetter && data == strings.ToUpper(key) {
			return true
		}
		return matchesKittySequence(data, codepoint, modShift) ||
			matchesPrintableModifyOtherKeys(data, codepoint, modShift)
	}
	if modifier != 0 {
		return matchesKittySequence(data, codepoint, modifier) ||
			matchesPrintableModifyOtherKeys(data, codepoint, modifier)
	}
	return data == key || matchesKittySequence(data, codepoint, 0)
}
