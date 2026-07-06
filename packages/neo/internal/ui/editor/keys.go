package editor

import (
	"regexp"
	"strconv"
	"strings"
)

// Key-sequence decoding, ported from packages/tui/src/keys.ts. The editor
// receives raw terminal byte sequences (matching the tui test suite) and must
// turn printable Kitty CSI-u / xterm modifyOtherKeys sequences into text, while
// routing control/navigation sequences through the Keymap.

const (
	modShift = 1
	modAlt   = 2
	modCtrl  = 4
	modSuper = 8
	lockMask = 64 + 128 // Caps Lock + Num Lock
)

// kittyCSIuRe matches "\x1b[<cp>[:<shifted>][:<base>][;<mod>][:<event>]u".
var kittyCSIuRe = regexp.MustCompile(`^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$`)

// modifyOtherKeysRe matches "\x1b[27;<mod>;<cp>~".
var modifyOtherKeysRe = regexp.MustCompile(`^\x1b\[27;(\d+);(\d+)~$`)

// kittyFunctionalEquivalents maps Kitty functional codepoints (keypad) to ASCII.
var kittyFunctionalEquivalents = map[int]int{
	57399: 48, 57400: 49, 57401: 50, 57402: 51, 57403: 52, 57404: 53,
	57405: 54, 57406: 55, 57407: 56, 57408: 57, 57409: 46, 57410: 47,
	57411: 42, 57412: 45, 57413: 43, 57415: 61, 57416: 44,
}

// decodePrintableKey decodes a printable Kitty CSI-u or modifyOtherKeys sequence
// to its character, or returns ("", false) when the sequence is not printable
// text (control chars, unsupported modifiers, navigation keys).
func decodePrintableKey(data string) (string, bool) {
	if s, ok := decodeKittyPrintable(data); ok {
		return s, true
	}
	return decodeModifyOtherKeysPrintable(data)
}

func decodeKittyPrintable(data string) (string, bool) {
	m := kittyCSIuRe.FindStringSubmatch(data)
	if m == nil {
		return "", false
	}
	codepoint, err := strconv.Atoi(m[1])
	if err != nil {
		return "", false
	}
	var shiftedKey int
	hasShifted := m[2] != ""
	if hasShifted {
		shiftedKey, _ = strconv.Atoi(m[2])
	}
	modValue := 1
	if m[4] != "" {
		modValue, _ = strconv.Atoi(m[4])
	}
	modifier := modValue - 1

	allowed := modShift | lockMask
	if modifier&^allowed != 0 {
		return "", false
	}
	if modifier&(modAlt|modCtrl) != 0 {
		return "", false
	}
	effective := codepoint
	if modifier&modShift != 0 && hasShifted {
		effective = shiftedKey
	}
	if eq, ok := kittyFunctionalEquivalents[effective]; ok {
		effective = eq
	}
	if effective < 32 {
		return "", false
	}
	return string(rune(effective)), true
}

func decodeModifyOtherKeysPrintable(data string) (string, bool) {
	m := modifyOtherKeysRe.FindStringSubmatch(data)
	if m == nil {
		return "", false
	}
	modValue, _ := strconv.Atoi(m[1])
	codepoint, _ := strconv.Atoi(m[2])
	modifier := (modValue - 1) &^ lockMask
	if modifier&^modShift != 0 {
		return "", false
	}
	if codepoint < 32 {
		return "", false
	}
	return string(rune(codepoint)), true
}

// decodePasteCSIu decodes CSI-u Ctrl+<letter> sequences re-encoded inside a
// bracketed paste (tmux popups with extended-keys-format=csi-u) back to their
// control byte, mirroring the decode step in handlePaste(). Only Ctrl+letter
// (";5u") forms are converted; other sequences are left intact.
var pasteCSIuRe = regexp.MustCompile(`\x1b\[(\d+);5u`)

func decodePasteCSIu(text string) string {
	return pasteCSIuRe.ReplaceAllStringFunc(text, func(match string) string {
		sub := pasteCSIuRe.FindStringSubmatch(match)
		cp, _ := strconv.Atoi(sub[1])
		switch {
		case cp >= 97 && cp <= 122:
			return string(rune(cp - 96))
		case cp >= 65 && cp <= 90:
			return string(rune(cp - 64))
		default:
			return match
		}
	})
}

// joinLines joins document lines with "\n".
func joinLines(lines []string) string { return strings.Join(lines, "\n") }

// trimSpace trims leading/trailing whitespace (matches String.prototype.trim).
func trimSpace(s string) string { return strings.TrimSpace(s) }
