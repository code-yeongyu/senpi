package keybindings

// keys_decode.go ports keys.ts decodeKittyPrintable / decodeModifyOtherKeysPrintable
// / decodePrintableKey: extracting the printable character from a CSI-u or
// modifyOtherKeys sequence when the neo editor should insert text rather than
// treat the sequence as a binding.

const kittyPrintableAllowedModifiers = modShift | lockMask

// DecodeKittyPrintable extracts a printable character from a Kitty CSI-u
// sequence, or ("", false). Faithful port of keys.ts decodeKittyPrintable.
func DecodeKittyPrintable(data string) (string, bool) {
	m := kittyPrint.FindStringSubmatch(data)
	if m == nil {
		return "", false
	}
	codepoint := atoi(m[1])
	var shiftedKey int
	hasShifted := m[2] != ""
	if hasShifted {
		shiftedKey = atoi(m[2])
	}
	modValue := 1
	if m[4] != "" {
		modValue = atoi(m[4])
	}
	modifier := modValue - 1

	if (modifier &^ kittyPrintableAllowedModifiers) != 0 {
		return "", false
	}
	if modifier&(modAlt|modCtrl) != 0 {
		return "", false
	}

	effective := codepoint
	if modifier&modShift != 0 && hasShifted {
		effective = shiftedKey
	}
	effective = normalizeKittyFunctionalCodepoint(effective)
	if effective < 32 {
		return "", false
	}
	if effective > 0x10FFFF {
		return "", false
	}
	return string(rune(effective)), true
}

// decodeModifyOtherKeysPrintable ports keys.ts decodeModifyOtherKeysPrintable.
func decodeModifyOtherKeysPrintable(data string) (string, bool) {
	p, ok := parseModifyOtherKeysSequence(data)
	if !ok {
		return "", false
	}
	modifier := p.modifier &^ lockMask
	if (modifier &^ modShift) != 0 {
		return "", false
	}
	if p.codepoint < 32 || p.codepoint > 0x10FFFF {
		return "", false
	}
	return string(rune(p.codepoint)), true
}

// DecodePrintableKey extracts a printable character from a Kitty CSI-u or xterm
// modifyOtherKeys sequence, or ("", false). Port of keys.ts decodePrintableKey.
func DecodePrintableKey(data string) (string, bool) {
	if s, ok := DecodeKittyPrintable(data); ok {
		return s, true
	}
	return decodeModifyOtherKeysPrintable(data)
}
