package ui

import "github.com/charmbracelet/x/ansi"

// Width/truncation primitives. These are the Go equivalents of the pi-tui
// utils (packages/tui/src/utils.ts visibleWidth / truncateToWidth / strip): they
// are ANSI-aware, wide-character-aware (East Asian, emoji), and operate on
// grapheme clusters — the same guarantees the TS components rely on. x/ansi
// already implements these semantics, so neo builds on it rather than
// re-deriving grapheme tables.

// VisibleWidth returns the terminal cell width of s, ignoring ANSI escape codes
// and counting wide graphemes as 2 cells. Mirrors utils.ts visibleWidth.
func VisibleWidth(s string) int {
	return ansi.StringWidth(s)
}

// StripANSI removes ANSI/SGR escape codes from s, leaving the visible text.
func StripANSI(s string) string {
	return ansi.Strip(s)
}

// ansiReset is the SGR reset sequence. pi-tui's truncateToWidth
// (finalizeTruncatedResult, utils.ts) emits a reset immediately BEFORE and after
// the ellipsis so the ellipsis always renders unstyled even when the truncated
// prefix left an SGR color open.
const ansiReset = "\x1b[0m"

// TruncateToWidth truncates s to at most maxWidth visible cells, appending
// ellipsis when it overflows. It is ANSI- and grapheme-aware and never splits a
// wide cell across the boundary. Mirrors utils.ts truncateToWidth: a maxWidth
// <= 0 yields the empty string, and text that already fits is returned as-is.
//
// When a non-empty ellipsis is appended after truncation, the ellipsis is framed
// by SGR resets ("<prefix>\x1b[0m<ellipsis>\x1b[0m") so a color opened in the
// kept prefix cannot bleed onto the ellipsis — this is the pi-tui
// finalizeTruncatedResult contract (truncated-text.test.ts "adds reset code
// before ellipsis"). The empty-ellipsis path is left byte-identical to x/ansi so
// the column-math the higher-level lists rely on is unchanged.
func TruncateToWidth(s string, maxWidth int, ellipsis string) string {
	if maxWidth <= 0 {
		return ""
	}
	if VisibleWidth(s) <= maxWidth {
		return s
	}
	if ellipsis == "" {
		return ansi.Truncate(s, maxWidth, "")
	}
	// Truncation with an ellipsis: build the kept prefix WITHOUT the ellipsis
	// (reserving the ellipsis width), then frame the ellipsis with resets.
	ellipsisWidth := VisibleWidth(ellipsis)
	if ellipsisWidth >= maxWidth {
		// No room for any prefix; clip the ellipsis itself and reset after it.
		clipped := ansi.Truncate(ellipsis, maxWidth, "")
		if VisibleWidth(clipped) == 0 {
			return ""
		}
		return ansiReset + clipped + ansiReset
	}
	prefix := ansi.Truncate(s, maxWidth-ellipsisWidth, "")
	return prefix + ansiReset + ellipsis + ansiReset
}

// PadToWidth right-pads s with spaces to exactly width visible cells. If s is
// already at least width wide it is returned unchanged (callers that need a hard
// clip truncate first).
func PadToWidth(s string, width int) string {
	w := VisibleWidth(s)
	if w >= width {
		return s
	}
	return s + spaces(width-w)
}

// itoaUI formats a non-negative-friendly int without importing strconv into the
// hot render path (mirrors the small helper the theme harness test uses).
func itoaUI(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// --- small numeric helpers (shared across the ui primitives) -----------------

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(v, lo, hi int) int { return maxInt(lo, minInt(v, hi)) }

// firstNonZero returns the first non-zero argument, or 0 when all are zero.
func firstNonZero(vs ...int) int {
	for _, v := range vs {
		if v != 0 {
			return v
		}
	}
	return 0
}

// spaces returns n spaces (n<0 → "").
func spaces(n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = ' '
	}
	return string(b)
}
