package keybindings

// keys_match.go ports the per-special-key match branches of keys.ts matchesKey.
// Each function corresponds to one `case` in the TS switch and preserves its
// exact ordering of legacy / Kitty / modifyOtherKeys checks.

func matchSpace(data string, modifier int) bool {
	if !kittyProtocolActive {
		if modifier == modCtrl && data == "\x00" {
			return true
		}
		if modifier == modAlt && data == "\x1b " {
			return true
		}
	}
	if modifier == 0 {
		return data == " " ||
			matchesKittySequence(data, cpSpace, 0) ||
			matchesModifyOtherKeys(data, cpSpace, 0)
	}
	return matchesKittySequence(data, cpSpace, modifier) ||
		matchesModifyOtherKeys(data, cpSpace, modifier)
}

func matchTab(data string, modifier int) bool {
	if modifier == modShift {
		return data == "\x1b[Z" ||
			matchesKittySequence(data, cpTab, modShift) ||
			matchesModifyOtherKeys(data, cpTab, modShift)
	}
	if modifier == 0 {
		return data == "\t" || matchesKittySequence(data, cpTab, 0)
	}
	return matchesKittySequence(data, cpTab, modifier) ||
		matchesModifyOtherKeys(data, cpTab, modifier)
}

func matchEnter(data string, modifier int) bool {
	switch modifier {
	case modShift:
		if matchesKittySequence(data, cpEnter, modShift) ||
			matchesKittySequence(data, cpKpEnter, modShift) {
			return true
		}
		if matchesModifyOtherKeys(data, cpEnter, modShift) {
			return true
		}
		if kittyProtocolActive {
			return data == "\x1b\r" || data == "\n"
		}
		return false
	case modAlt:
		if matchesKittySequence(data, cpEnter, modAlt) ||
			matchesKittySequence(data, cpKpEnter, modAlt) {
			return true
		}
		if matchesModifyOtherKeys(data, cpEnter, modAlt) {
			return true
		}
		if !kittyProtocolActive {
			return data == "\x1b\r"
		}
		return false
	case 0:
		return data == "\r" ||
			(!kittyProtocolActive && data == "\n") ||
			data == "\x1bOM" ||
			matchesKittySequence(data, cpEnter, 0) ||
			matchesKittySequence(data, cpKpEnter, 0)
	default:
		return matchesKittySequence(data, cpEnter, modifier) ||
			matchesKittySequence(data, cpKpEnter, modifier) ||
			matchesModifyOtherKeys(data, cpEnter, modifier)
	}
}

func matchBackspace(data string, modifier int) bool {
	switch modifier {
	case modAlt:
		if data == "\x1b\x7f" || data == "\x1b\b" {
			return true
		}
		return matchesKittySequence(data, cpBackspace, modAlt) ||
			matchesModifyOtherKeys(data, cpBackspace, modAlt)
	case modCtrl:
		if matchesRawBackspace(data, modCtrl) {
			return true
		}
		return matchesKittySequence(data, cpBackspace, modCtrl) ||
			matchesModifyOtherKeys(data, cpBackspace, modCtrl)
	case 0:
		return matchesRawBackspace(data, 0) ||
			matchesKittySequence(data, cpBackspace, 0) ||
			matchesModifyOtherKeys(data, cpBackspace, 0)
	default:
		return matchesKittySequence(data, cpBackspace, modifier) ||
			matchesModifyOtherKeys(data, cpBackspace, modifier)
	}
}

// functionalCodepoint maps a functional key name to its sentinel codepoint and
// legacy-sequence table key.
func functionalCodepoint(key string) (cp int, legacyKey string) {
	switch key {
	case "insert":
		return cpInsert, "insert"
	case "delete":
		return cpDelete, "delete"
	case "home":
		return cpHome, "home"
	case "end":
		return cpEnd, "end"
	case "pageup":
		return cpPageUp, "pageUp"
	case "pagedown":
		return cpPageDown, "pageDown"
	}
	return 0, ""
}

func matchFunctional(data, key string, modifier int) bool {
	if key == "clear" {
		if modifier == 0 {
			return matchesLegacySequence(data, legacyKeySequences["clear"])
		}
		return matchesLegacyModifierSequence(data, "clear", modifier)
	}
	cp, legacyKey := functionalCodepoint(key)
	if modifier == 0 {
		return matchesLegacySequence(data, legacyKeySequences[legacyKey]) ||
			matchesKittySequence(data, cp, 0)
	}
	if matchesLegacyModifierSequence(data, legacyKey, modifier) {
		return true
	}
	return matchesKittySequence(data, cp, modifier)
}

func matchArrow(data, key string, modifier int) bool {
	cp := map[string]int{"up": cpUp, "down": cpDown, "left": cpLeft, "right": cpRight}[key]
	legacyKey := key

	switch key {
	case "up":
		if modifier == modAlt {
			return data == "\x1bp" || matchesKittySequence(data, cpUp, modAlt)
		}
	case "down":
		if modifier == modAlt {
			return data == "\x1bn" || matchesKittySequence(data, cpDown, modAlt)
		}
	case "left":
		if modifier == modAlt {
			return data == "\x1b[1;3D" ||
				(!kittyProtocolActive && data == "\x1bB") ||
				data == "\x1bb" ||
				matchesKittySequence(data, cpLeft, modAlt)
		}
		if modifier == modCtrl {
			return data == "\x1b[1;5D" ||
				matchesLegacyModifierSequence(data, "left", modCtrl) ||
				matchesKittySequence(data, cpLeft, modCtrl)
		}
	case "right":
		if modifier == modAlt {
			return data == "\x1b[1;3C" ||
				(!kittyProtocolActive && data == "\x1bF") ||
				data == "\x1bf" ||
				matchesKittySequence(data, cpRight, modAlt)
		}
		if modifier == modCtrl {
			return data == "\x1b[1;5C" ||
				matchesLegacyModifierSequence(data, "right", modCtrl) ||
				matchesKittySequence(data, cpRight, modCtrl)
		}
	}

	if modifier == 0 {
		return matchesLegacySequence(data, legacyKeySequences[legacyKey]) ||
			matchesKittySequence(data, cp, 0)
	}
	if matchesLegacyModifierSequence(data, legacyKey, modifier) {
		return true
	}
	return matchesKittySequence(data, cp, modifier)
}
