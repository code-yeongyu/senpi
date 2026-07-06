package markdown

import (
	"strconv"
	"strings"

	"github.com/rivo/uniseg"
)

// This file is a faithful Go port of the ANSI-aware width/escape helpers in
// packages/tui/src/utils.ts (visibleWidth, extractAnsiCode) so wrapping matches
// the classic TUI byte-for-byte.

// extractAnsiCode returns the escape sequence starting at pos in s, or ok=false
// if s[pos] does not begin a recognized sequence. Mirrors utils.ts extractAnsiCode:
// CSI (ESC [ ... m/G/K/H/J), OSC (ESC ] ... BEL | ST), APC (ESC _ ... ST), and
// two-byte ESC sequences.
func extractAnsiCode(s string, pos int) (code string, length int, ok bool) {
	if pos >= len(s) || s[pos] != 0x1b {
		return "", 0, false
	}
	if pos+1 >= len(s) {
		return "", 0, false
	}
	next := s[pos+1]

	switch next {
	case '[': // CSI: ESC [ ... final in mGKHJ
		j := pos + 2
		for j < len(s) && !isCSIFinal(s[j]) {
			j++
		}
		if j < len(s) {
			return s[pos : j+1], j + 1 - pos, true
		}
		return "", 0, false
	case ']': // OSC: ESC ] ... BEL or ST (ESC \)
		j := pos + 2
		for j < len(s) {
			if s[j] == 0x07 { // BEL
				return s[pos : j+1], j + 1 - pos, true
			}
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' { // ST
				return s[pos : j+2], j + 2 - pos, true
			}
			j++
		}
		return "", 0, false
	case '_': // APC: ESC _ ... ST
		j := pos + 2
		for j < len(s) {
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
				return s[pos : j+2], j + 2 - pos, true
			}
			j++
		}
		return "", 0, false
	default:
		// Two-byte escape (e.g. ESC M). Consume ESC + next.
		return s[pos : pos+2], 2, true
	}
}

func isCSIFinal(b byte) bool {
	switch b {
	case 'm', 'G', 'K', 'H', 'J':
		return true
	}
	return false
}

// stripEscapes removes all recognized escape sequences from s.
func stripEscapes(s string) string {
	if !strings.ContainsRune(s, 0x1b) {
		return s
	}
	var b strings.Builder
	i := 0
	for i < len(s) {
		if _, n, ok := extractAnsiCode(s, i); ok {
			i += n
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// visibleWidth returns the terminal column width of s, ignoring escape sequences
// and using grapheme-cluster segmentation (CJK/emoji/combining aware). Port of
// utils.ts visibleWidth. Tabs are expanded to 3 spaces first, matching utils.ts.
func visibleWidth(s string) int {
	if s == "" {
		return 0
	}
	clean := s
	if strings.IndexByte(clean, '\t') >= 0 {
		clean = strings.ReplaceAll(clean, "\t", "   ")
	}
	if strings.IndexByte(clean, 0x1b) >= 0 {
		clean = stripEscapes(clean)
	}
	return graphemeWidth(clean)
}

// graphemeWidth sums the display width of every grapheme cluster in s.
func graphemeWidth(s string) int {
	width := 0
	g := uniseg.NewGraphemes(s)
	for g.Next() {
		width += g.Width()
	}
	return width
}

// sgrLeavesDefaultBackground reports whether an SGR parameter string leaves the
// background at its default. Port of utils.ts sgrLeavesDefaultBackground.
func sgrLeavesDefaultBackground(params string) bool {
	if params == "" {
		return true
	}
	parts := strings.Split(params, ";")
	backgroundIsDefault := false
	i := 0
	for i < len(parts) {
		part := parts[i]
		var code int
		if part == "" {
			code = 0
		} else {
			c, err := strconv.Atoi(part)
			if err != nil {
				i++
				continue
			}
			code = c
		}
		if code == 0 || code == 49 {
			backgroundIsDefault = true
			i++
			continue
		}
		if (code == 38 || code == 48) && i+2 < len(parts) && parts[i+1] == "5" {
			if code == 48 {
				backgroundIsDefault = false
			}
			i += 3
			continue
		}
		if (code == 38 || code == 48) && i+4 < len(parts) && parts[i+1] == "2" {
			if code == 48 {
				backgroundIsDefault = false
			}
			i += 5
			continue
		}
		if (code >= 40 && code <= 47) || (code >= 100 && code <= 107) {
			backgroundIsDefault = false
		}
		i++
	}
	return backgroundIsDefault
}
