// Package textwidth provides grapheme-cluster segmentation and terminal
// column-width measurement for the neo editor. It mirrors the width contract of
// packages/tui/src/utils.ts (CJK/fullwidth = 2 cols, emoji = 2 cols, Thai/Lao
// AM vowels segment with their base, ANSI/OSC/APC escapes are zero-width) using
// rivo/uniseg for Unicode-correct grapheme boundaries and display widths.
//
// All offsets in the editor are rune indices; these helpers operate on runes
// and grapheme clusters, never UTF-16 code units.
package textwidth

import (
	"strings"

	"github.com/rivo/uniseg"
)

// Grapheme is one grapheme cluster with its start rune index in the source
// string and its terminal column width.
type Grapheme struct {
	Text  string
	Index int // rune offset of the cluster start
	Width int
}

// Graphemes segments s into grapheme clusters with rune indices and widths.
func Graphemes(s string) []Grapheme {
	if s == "" {
		return nil
	}
	var out []Grapheme
	idx := 0
	rest := s
	state := -1
	var cluster string
	for len(rest) > 0 {
		cluster, rest, _, state = uniseg.FirstGraphemeClusterInString(rest, state)
		out = append(out, Grapheme{Text: cluster, Index: idx, Width: clusterWidth(cluster)})
		idx += len([]rune(cluster))
	}
	return out
}

// clusterWidth returns the terminal column width of a single grapheme cluster.
// Tabs are treated as width 3 to match the tui editor's tab expansion contract
// (though the editor normalizes tabs to spaces before storage).
func clusterWidth(cluster string) int {
	if cluster == "\t" {
		return 3
	}
	return uniseg.StringWidth(cluster)
}

// Visible returns the terminal column width of s, ignoring ANSI CSI (SGR/cursor)
// sequences, OSC hyperlinks/titles, and APC application commands (e.g. the
// hardware-cursor marker). Tabs expand to 3 columns.
func Visible(s string) int {
	if s == "" {
		return 0
	}
	clean := StripANSI(s)
	if clean == "" {
		return 0
	}
	width := 0
	rest := clean
	state := -1
	var cluster string
	for len(rest) > 0 {
		cluster, rest, _, state = uniseg.FirstGraphemeClusterInString(rest, state)
		width += clusterWidth(cluster)
	}
	return width
}

// FirstGraphemeWidth returns the rune length and column width of the first
// grapheme cluster in s. Returns (0,0) for the empty string.
func FirstGrapheme(s string) (runeLen, width int) {
	if s == "" {
		return 0, 0
	}
	cluster, _, _, _ := uniseg.FirstGraphemeClusterInString(s, -1)
	return len([]rune(cluster)), clusterWidth(cluster)
}

// StripANSI removes CSI, OSC, and APC escape sequences, leaving only visible
// text. It mirrors extractAnsiCode() in utils.ts: CSI ends at a final byte in
// [@-~] for the styling forms used here (m/G/K/H/J and cursor letters); OSC/APC
// end at BEL or ST (ESC \).
func StripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	var b strings.Builder
	runes := []rune(s)
	i := 0
	for i < len(runes) {
		if runes[i] == 0x1b && i+1 < len(runes) {
			next := runes[i+1]
			switch next {
			case '[': // CSI ... final byte 0x40-0x7e
				j := i + 2
				for j < len(runes) && (runes[j] < 0x40 || runes[j] > 0x7e) {
					j++
				}
				if j < len(runes) {
					i = j + 1
					continue
				}
				i = len(runes)
				continue
			case ']', '_', 'P': // OSC / APC / DCS ... ST (BEL or ESC \)
				j := i + 2
				for j < len(runes) {
					if runes[j] == 0x07 {
						j++
						break
					}
					if runes[j] == 0x1b && j+1 < len(runes) && runes[j+1] == '\\' {
						j += 2
						break
					}
					j++
				}
				i = j
				continue
			}
		}
		b.WriteRune(runes[i])
		i++
	}
	return b.String()
}
