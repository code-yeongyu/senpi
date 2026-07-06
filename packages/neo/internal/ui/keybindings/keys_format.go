package keybindings

import "strings"

// keys_format.go ports keys.ts formatParsedKey / parseKey / decodeKittyPrintable
// / decodePrintableKey: turning a raw sequence into a canonical key-id string and
// extracting printable characters from CSI-u / modifyOtherKeys sequences.

// formatKeyNameWithModifiers mirrors keys.ts formatKeyNameWithModifiers.
func formatKeyNameWithModifiers(keyName string, modifier int) (string, bool) {
	eff := modifier &^ lockMask
	supported := modShift | modCtrl | modAlt | modSuper
	if (eff &^ supported) != 0 {
		return "", false
	}
	var mods []string
	if eff&modShift != 0 {
		mods = append(mods, "shift")
	}
	if eff&modCtrl != 0 {
		mods = append(mods, "ctrl")
	}
	if eff&modAlt != 0 {
		mods = append(mods, "alt")
	}
	if eff&modSuper != 0 {
		mods = append(mods, "super")
	}
	if len(mods) == 0 {
		return keyName, true
	}
	return strings.Join(mods, "+") + "+" + keyName, true
}

// runeIfSymbol returns the symbol name for a codepoint that is a known symbol.
func symbolName(cp int) (string, bool) {
	if cp >= 0 && cp <= 0x10FFFF && symbolKeys[rune(cp)] {
		return string(rune(cp)), true
	}
	return "", false
}

// formatParsedKey mirrors keys.ts formatParsedKey.
func formatParsedKey(codepoint, modifier int, baseLayoutKey int, hasBase bool) (string, bool) {
	normCp := normalizeKittyFunctionalCodepoint(codepoint)
	identity := normalizeShiftedLetterIdentityCodepoint(normCp, modifier)

	isLatinLetter := identity >= 97 && identity <= 122
	isDigit := identity >= 48 && identity <= 57
	_, isKnownSymbol := symbolName(identity)

	effective := identity
	if !(isLatinLetter || isDigit || isKnownSymbol) && hasBase {
		effective = baseLayoutKey
	}

	var keyName string
	switch {
	case effective == cpEscape:
		keyName = "escape"
	case effective == cpTab:
		keyName = "tab"
	case effective == cpEnter || effective == cpKpEnter:
		keyName = "enter"
	case effective == cpSpace:
		keyName = "space"
	case effective == cpBackspace:
		keyName = "backspace"
	case effective == cpDelete:
		keyName = "delete"
	case effective == cpInsert:
		keyName = "insert"
	case effective == cpHome:
		keyName = "home"
	case effective == cpEnd:
		keyName = "end"
	case effective == cpPageUp:
		keyName = "pageUp"
	case effective == cpPageDown:
		keyName = "pageDown"
	case effective == cpUp:
		keyName = "up"
	case effective == cpDown:
		keyName = "down"
	case effective == cpLeft:
		keyName = "left"
	case effective == cpRight:
		keyName = "right"
	case effective >= 48 && effective <= 57:
		keyName = string(rune(effective))
	case effective >= 97 && effective <= 122:
		keyName = string(rune(effective))
	default:
		if s, ok := symbolName(effective); ok {
			keyName = s
		}
	}
	if keyName == "" {
		return "", false
	}
	return formatKeyNameWithModifiers(keyName, modifier)
}

// ParseKey returns the canonical key id for raw terminal input data, or ("",
// false) if unrecognized. Faithful port of keys.ts parseKey.
func ParseKey(data string) (string, bool) {
	if kitty, ok := parseKittySequence(data); ok {
		return formatParsedKey(kitty.codepoint, kitty.modifier, kitty.baseLayout, kitty.hasBaseLayer)
	}
	if mok, ok := parseModifyOtherKeysSequence(data); ok {
		return formatParsedKey(mok.codepoint, mok.modifier, 0, false)
	}

	if kittyProtocolActive {
		if data == "\x1b\r" || data == "\n" {
			return "shift+enter", true
		}
	}

	if id, ok := legacySequenceKeyIDs[data]; ok {
		return id, true
	}

	switch data {
	case "\x1b":
		return "escape", true
	case "\x1c":
		return "ctrl+\\", true
	case "\x1d":
		return "ctrl+]", true
	case "\x1f":
		return "ctrl+-", true
	case "\x1b\x1b":
		return "ctrl+alt+[", true
	case "\x1b\x1c":
		return "ctrl+alt+\\", true
	case "\x1b\x1d":
		return "ctrl+alt+]", true
	case "\x1b\x1f":
		return "ctrl+alt+-", true
	case "\t":
		return "tab", true
	case "\x00":
		return "ctrl+space", true
	case " ":
		return "space", true
	case "\x7f":
		return "backspace", true
	case "\x1b[Z":
		return "shift+tab", true
	case "\x1b\x7f", "\x1b\b":
		return "alt+backspace", true
	}
	if data == "\r" || (!kittyProtocolActive && data == "\n") || data == "\x1bOM" {
		return "enter", true
	}
	if data == "\x08" {
		if isWindowsTerminalSession() {
			return "ctrl+backspace", true
		}
		return "backspace", true
	}
	if !kittyProtocolActive && data == "\x1b\r" {
		return "alt+enter", true
	}
	if !kittyProtocolActive && data == "\x1b " {
		return "alt+space", true
	}
	if !kittyProtocolActive && data == "\x1bB" {
		return "alt+left", true
	}
	if !kittyProtocolActive && data == "\x1bF" {
		return "alt+right", true
	}
	if !kittyProtocolActive && len(data) == 2 && data[0] == '\x1b' {
		code := int(data[1])
		if code >= 1 && code <= 26 {
			return "ctrl+alt+" + string(rune(code+96)), true
		}
		if (code >= 97 && code <= 122) || (code >= 48 && code <= 57) {
			return "alt+" + string(rune(code)), true
		}
	}
	switch data {
	case "\x1b[A":
		return "up", true
	case "\x1b[B":
		return "down", true
	case "\x1b[C":
		return "right", true
	case "\x1b[D":
		return "left", true
	case "\x1b[H", "\x1bOH":
		return "home", true
	case "\x1b[F", "\x1bOF":
		return "end", true
	case "\x1b[3~":
		return "delete", true
	case "\x1b[5~":
		return "pageUp", true
	case "\x1b[6~":
		return "pageDown", true
	}
	if len(data) == 1 {
		code := int(data[0])
		if code >= 1 && code <= 26 {
			return "ctrl+" + string(rune(code+96)), true
		}
		if code >= 32 && code <= 126 {
			return data, true
		}
	}
	return "", false
}
