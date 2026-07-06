package keybindings

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

// keys_parse.go ports the Kitty CSI-u and xterm modifyOtherKeys parsers plus the
// low-level codepoint matchers from keys.ts. Regexes mirror the TS source
// exactly (translated from JS \x1b escapes to Go's \x1b).

var (
	csiURe     = regexp.MustCompile(`^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$`)
	arrowRe    = regexp.MustCompile(`^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$`)
	funcRe     = regexp.MustCompile(`^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$`)
	homeEndRe  = regexp.MustCompile(`^\x1b\[1;(\d+)(?::(\d+))?([HF])$`)
	mokRe      = regexp.MustCompile(`^\x1b\[27;(\d+);(\d+)~$`)
	kittyPrint = regexp.MustCompile(`^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$`)
)

type parsedKitty struct {
	codepoint    int
	shiftedKey   int
	hasShifted   bool
	baseLayout   int
	hasBaseLayer bool
	modifier     int
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// parseKittySequence mirrors keys.ts parseKittySequence.
func parseKittySequence(data string) (parsedKitty, bool) {
	if m := csiURe.FindStringSubmatch(data); m != nil {
		p := parsedKitty{codepoint: atoi(m[1])}
		if m[2] != "" {
			p.shiftedKey, p.hasShifted = atoi(m[2]), true
		}
		if m[3] != "" {
			p.baseLayout, p.hasBaseLayer = atoi(m[3]), true
		}
		modValue := 1
		if m[4] != "" {
			modValue = atoi(m[4])
		}
		p.modifier = modValue - 1
		return p, true
	}
	if m := arrowRe.FindStringSubmatch(data); m != nil {
		modValue := atoi(m[1])
		codes := map[string]int{"A": cpUp, "B": cpDown, "C": cpRight, "D": cpLeft}
		return parsedKitty{codepoint: codes[m[3]], modifier: modValue - 1}, true
	}
	if m := funcRe.FindStringSubmatch(data); m != nil {
		keyNum := atoi(m[1])
		modValue := 1
		if m[2] != "" {
			modValue = atoi(m[2])
		}
		funcCodes := map[int]int{2: cpInsert, 3: cpDelete, 5: cpPageUp, 6: cpPageDown, 7: cpHome, 8: cpEnd}
		if cp, ok := funcCodes[keyNum]; ok {
			return parsedKitty{codepoint: cp, modifier: modValue - 1}, true
		}
	}
	if m := homeEndRe.FindStringSubmatch(data); m != nil {
		modValue := atoi(m[1])
		cp := cpHome
		if m[3] == "F" {
			cp = cpEnd
		}
		return parsedKitty{codepoint: cp, modifier: modValue - 1}, true
	}
	return parsedKitty{}, false
}

// matchesKittySequence mirrors keys.ts matchesKittySequence.
func matchesKittySequence(data string, expectedCodepoint, expectedModifier int) bool {
	p, ok := parseKittySequence(data)
	if !ok {
		return false
	}
	if (p.modifier &^ lockMask) != (expectedModifier &^ lockMask) {
		return false
	}
	normCp := normalizeShiftedLetterIdentityCodepoint(normalizeKittyFunctionalCodepoint(p.codepoint), p.modifier)
	normExp := normalizeShiftedLetterIdentityCodepoint(normalizeKittyFunctionalCodepoint(expectedCodepoint), expectedModifier)
	if normCp == normExp {
		return true
	}
	if p.hasBaseLayer && p.baseLayout == expectedCodepoint {
		cp := normCp
		isLatinLetter := cp >= 97 && cp <= 122
		isKnownSymbol := cp >= 0 && cp <= 0x10FFFF && symbolKeys[rune(cp)]
		if !isLatinLetter && !isKnownSymbol {
			return true
		}
	}
	return false
}

type parsedMOK struct {
	codepoint int
	modifier  int
}

// parseModifyOtherKeysSequence mirrors keys.ts parseModifyOtherKeysSequence.
func parseModifyOtherKeysSequence(data string) (parsedMOK, bool) {
	m := mokRe.FindStringSubmatch(data)
	if m == nil {
		return parsedMOK{}, false
	}
	return parsedMOK{codepoint: atoi(m[2]), modifier: atoi(m[1]) - 1}, true
}

// matchesModifyOtherKeys mirrors keys.ts matchesModifyOtherKeys.
func matchesModifyOtherKeys(data string, expectedKeycode, expectedModifier int) bool {
	p, ok := parseModifyOtherKeysSequence(data)
	if !ok {
		return false
	}
	return p.codepoint == expectedKeycode && p.modifier == expectedModifier
}

// matchesPrintableModifyOtherKeys mirrors keys.ts matchesPrintableModifyOtherKeys.
func matchesPrintableModifyOtherKeys(data string, expectedKeycode, expectedModifier int) bool {
	if expectedModifier == 0 {
		return false
	}
	p, ok := parseModifyOtherKeysSequence(data)
	if !ok || p.modifier != expectedModifier {
		return false
	}
	return normalizeShiftedLetterIdentityCodepoint(p.codepoint, p.modifier) ==
		normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier)
}

// isWindowsTerminalSession mirrors keys.ts isWindowsTerminalSession.
func isWindowsTerminalSession() bool {
	return os.Getenv("WT_SESSION") != "" &&
		os.Getenv("SSH_CONNECTION") == "" &&
		os.Getenv("SSH_CLIENT") == "" &&
		os.Getenv("SSH_TTY") == ""
}

// matchesRawBackspace mirrors keys.ts matchesRawBackspace.
func matchesRawBackspace(data string, expectedModifier int) bool {
	if data == "\x7f" {
		return expectedModifier == 0
	}
	if data != "\x08" {
		return false
	}
	if isWindowsTerminalSession() {
		return expectedModifier == modCtrl
	}
	return expectedModifier == 0
}

// rawCtrlChar mirrors keys.ts rawCtrlChar.
func rawCtrlChar(key string) (string, bool) {
	char := strings.ToLower(key)
	if char == "" {
		return "", false
	}
	code := rune(char[0])
	if (code >= 97 && code <= 122) || char == "[" || char == "\\" || char == "]" || char == "_" {
		return string(rune(int(code) & 0x1f)), true
	}
	if char == "-" {
		return string(rune(31)), true
	}
	return "", false
}

func isDigitKey(key string) bool { return key >= "0" && key <= "9" }
