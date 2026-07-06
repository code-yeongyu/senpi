package editor

import "unicode"

// The editor addresses text by rune index (Go's natural unit), unlike the tui
// TypeScript source which uses UTF-16 code units. For the ported contract this
// is equivalent: every cursor-column assertion in editor.test.ts uses BMP
// characters (ASCII, CJK, fullwidth punctuation) that are one code unit and one
// rune each, and emoji cases assert text content only. These helpers centralize
// rune-index slicing so the port never mixes byte and rune offsets.

// runeLen returns the number of runes in s.
func runeLen(s string) int { return len([]rune(s)) }

// runeSlice returns s[start:end] measured in runes, clamped to [0,len].
func runeSlice(s string, start, end int) string {
	r := []rune(s)
	if start < 0 {
		start = 0
	}
	if end > len(r) {
		end = len(r)
	}
	if start > end {
		return ""
	}
	return string(r[start:end])
}

// isWhitespaceChar reports whether s is entirely Unicode whitespace. A paste
// marker is never whitespace; callers gate on that separately.
func isWhitespaceChar(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.IsSpace(r) {
			return false
		}
	}
	return true
}
