package keybindings

// keys_tables.go holds the constant lookup tables ported verbatim from
// packages/tui/src/keys.ts: modifier bitmasks, codepoint constants, the Kitty
// keypad functional-key equivalents, and the legacy escape-sequence maps. Kept
// separate from the matching logic so the byte-for-byte transcription is easy to
// audit against the source.

// modifier bitmask values (keys.ts MODIFIERS).
const (
	modShift = 1
	modAlt   = 2
	modCtrl  = 4
	modSuper = 8
)

// lockMask is Caps Lock + Num Lock (keys.ts LOCK_MASK).
const lockMask = 64 + 128

// codepoint constants (keys.ts CODEPOINTS).
const (
	cpEscape    = 27
	cpTab       = 9
	cpEnter     = 13
	cpSpace     = 32
	cpBackspace = 127
	cpKpEnter   = 57414
)

// arrow codepoints (keys.ts ARROW_CODEPOINTS): negative sentinels.
const (
	cpUp    = -1
	cpDown  = -2
	cpRight = -3
	cpLeft  = -4
)

// functional codepoints (keys.ts FUNCTIONAL_CODEPOINTS): negative sentinels.
const (
	cpDelete   = -10
	cpInsert   = -11
	cpPageUp   = -12
	cpPageDown = -13
	cpHome     = -14
	cpEnd      = -15
)

// symbolKeys mirrors keys.ts SYMBOL_KEYS.
var symbolKeys = map[rune]bool{
	'`': true, '-': true, '=': true, '[': true, ']': true, '\\': true,
	';': true, '\'': true, ',': true, '.': true, '/': true, '!': true,
	'@': true, '#': true, '$': true, '%': true, '^': true, '&': true,
	'*': true, '(': true, ')': true, '_': true, '+': true, '|': true,
	'~': true, '{': true, '}': true, ':': true, '<': true, '>': true, '?': true,
}

// kittyFunctionalKeyEquivalents mirrors keys.ts KITTY_FUNCTIONAL_KEY_EQUIVALENTS:
// keypad codepoints normalize to their logical digit/symbol/navigation code.
var kittyFunctionalKeyEquivalents = map[int]int{
	57399: 48, 57400: 49, 57401: 50, 57402: 51, 57403: 52, 57404: 53,
	57405: 54, 57406: 55, 57407: 56, 57408: 57, 57409: 46, 57410: 47,
	57411: 42, 57412: 45, 57413: 43, 57415: 61, 57416: 44,
	57417: cpLeft, 57418: cpRight, 57419: cpUp, 57420: cpDown,
	57421: cpPageUp, 57422: cpPageDown, 57423: cpHome, 57424: cpEnd,
	57425: cpInsert, 57426: cpDelete,
}

// legacyKeySequences mirrors keys.ts LEGACY_KEY_SEQUENCES.
var legacyKeySequences = map[string][]string{
	"up":       {"\x1b[A", "\x1bOA"},
	"down":     {"\x1b[B", "\x1bOB"},
	"right":    {"\x1b[C", "\x1bOC"},
	"left":     {"\x1b[D", "\x1bOD"},
	"home":     {"\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"},
	"end":      {"\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"},
	"insert":   {"\x1b[2~"},
	"delete":   {"\x1b[3~"},
	"pageUp":   {"\x1b[5~", "\x1b[[5~"},
	"pageDown": {"\x1b[6~", "\x1b[[6~"},
	"clear":    {"\x1b[E", "\x1bOE"},
	"f1":       {"\x1bOP", "\x1b[11~", "\x1b[[A"},
	"f2":       {"\x1bOQ", "\x1b[12~", "\x1b[[B"},
	"f3":       {"\x1bOR", "\x1b[13~", "\x1b[[C"},
	"f4":       {"\x1bOS", "\x1b[14~", "\x1b[[D"},
	"f5":       {"\x1b[15~", "\x1b[[E"},
	"f6":       {"\x1b[17~"},
	"f7":       {"\x1b[18~"},
	"f8":       {"\x1b[19~"},
	"f9":       {"\x1b[20~"},
	"f10":      {"\x1b[21~"},
	"f11":      {"\x1b[23~"},
	"f12":      {"\x1b[24~"},
}

// legacyShiftSequences mirrors keys.ts LEGACY_SHIFT_SEQUENCES.
var legacyShiftSequences = map[string][]string{
	"up": {"\x1b[a"}, "down": {"\x1b[b"}, "right": {"\x1b[c"}, "left": {"\x1b[d"},
	"clear": {"\x1b[e"}, "insert": {"\x1b[2$"}, "delete": {"\x1b[3$"},
	"pageUp": {"\x1b[5$"}, "pageDown": {"\x1b[6$"}, "home": {"\x1b[7$"}, "end": {"\x1b[8$"},
}

// legacyCtrlSequences mirrors keys.ts LEGACY_CTRL_SEQUENCES.
var legacyCtrlSequences = map[string][]string{
	"up": {"\x1bOa"}, "down": {"\x1bOb"}, "right": {"\x1bOc"}, "left": {"\x1bOd"},
	"clear": {"\x1bOe"}, "insert": {"\x1b[2^"}, "delete": {"\x1b[3^"},
	"pageUp": {"\x1b[5^"}, "pageDown": {"\x1b[6^"}, "home": {"\x1b[7^"}, "end": {"\x1b[8^"},
}

// legacySequenceKeyIDs mirrors keys.ts LEGACY_SEQUENCE_KEY_IDS.
var legacySequenceKeyIDs = map[string]string{
	"\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
	"\x1bOH": "home", "\x1bOF": "end", "\x1b[E": "clear", "\x1bOE": "clear",
	"\x1bOe": "ctrl+clear", "\x1b[e": "shift+clear", "\x1b[2~": "insert",
	"\x1b[2$": "shift+insert", "\x1b[2^": "ctrl+insert", "\x1b[3$": "shift+delete",
	"\x1b[3^": "ctrl+delete", "\x1b[[5~": "pageUp", "\x1b[[6~": "pageDown",
	"\x1b[a": "shift+up", "\x1b[b": "shift+down", "\x1b[c": "shift+right", "\x1b[d": "shift+left",
	"\x1bOa": "ctrl+up", "\x1bOb": "ctrl+down", "\x1bOc": "ctrl+right", "\x1bOd": "ctrl+left",
	"\x1b[5$": "shift+pageUp", "\x1b[6$": "shift+pageDown", "\x1b[7$": "shift+home", "\x1b[8$": "shift+end",
	"\x1b[5^": "ctrl+pageUp", "\x1b[6^": "ctrl+pageDown", "\x1b[7^": "ctrl+home", "\x1b[8^": "ctrl+end",
	"\x1bOP": "f1", "\x1bOQ": "f2", "\x1bOR": "f3", "\x1bOS": "f4",
	"\x1b[11~": "f1", "\x1b[12~": "f2", "\x1b[13~": "f3", "\x1b[14~": "f4",
	"\x1b[[A": "f1", "\x1b[[B": "f2", "\x1b[[C": "f3", "\x1b[[D": "f4", "\x1b[[E": "f5",
	"\x1b[15~": "f5", "\x1b[17~": "f6", "\x1b[18~": "f7", "\x1b[19~": "f8",
	"\x1b[20~": "f9", "\x1b[21~": "f10", "\x1b[23~": "f11", "\x1b[24~": "f12",
	"\x1bb": "alt+left", "\x1bf": "alt+right", "\x1bp": "alt+up", "\x1bn": "alt+down",
}

func normalizeKittyFunctionalCodepoint(cp int) int {
	if v, ok := kittyFunctionalKeyEquivalents[cp]; ok {
		return v
	}
	return cp
}

// normalizeShiftedLetterIdentityCodepoint mirrors keys.ts: a shifted A-Z folds
// to its lowercase codepoint for identity comparison.
func normalizeShiftedLetterIdentityCodepoint(cp, modifier int) int {
	eff := modifier &^ lockMask
	if eff&modShift != 0 && cp >= 65 && cp <= 90 {
		return cp + 32
	}
	return cp
}

func matchesLegacySequence(data string, seqs []string) bool {
	for _, s := range seqs {
		if data == s {
			return true
		}
	}
	return false
}

func matchesLegacyModifierSequence(data, key string, modifier int) bool {
	if modifier == modShift {
		return matchesLegacySequence(data, legacyShiftSequences[key])
	}
	if modifier == modCtrl {
		return matchesLegacySequence(data, legacyCtrlSequences[key])
	}
	return false
}
