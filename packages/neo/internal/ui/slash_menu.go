package ui

import (
	"strings"

	"github.com/charmbracelet/colorprofile"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// scrollbarBlock is the grok scrollbar marker glyph (captures show a solid block
// at the far right of the first visible row).
const scrollbarBlock = "█"

// SlashMenu is the grok slash/autocomplete popup: an inline SelectList framed by
// a top rule line carrying a right-aligned count marker, a bottom rule line, and
// a scrollbar block at the right edge of the first visible row. Layout matches
// .omo/research/neo-grok/captures/{120x36,80x24}_04_slash_menu.
//
// The command primary text renders in the accent-blue token (#7aa2f7, the grok
// slash-command color), the selected row prefix uses the grok prompt glyph ❯ in
// accent-blue, descriptions in muted text, and the rules/scrollbar in the muted
// separator color.
type SlashMenu struct {
	th    *theme.Theme
	list  *SelectList
	total int // total item count shown in the top-rule count marker
}

// NewSlashMenu builds a SlashMenu over items. maxVisible bounds the inline
// window; total is the count rendered in the rule marker (usually the full
// command count, matching the grok capture's "47").
func NewSlashMenu(th *theme.Theme, items []SelectItem, maxVisible, total int) *SlashMenu {
	slt := SelectListTheme{
		SelectedPrefix: func(s string) string { return th.AccentBlue().Render(s) },
		SelectedText:   func(s string) string { return s },
		Description:    func(s string) string { return th.TextMuted().Render(s) },
		ScrollInfo:     func(s string) string { return th.TextMuted().Render(s) },
		NoMatch:        func(s string) string { return th.TextMuted().Render(s) },
	}
	list := NewSelectList(items, maxVisible, slt, SelectListLayout{
		MinPrimaryColumnWidth: 16,
		MaxPrimaryColumnWidth: 16,
	})
	return &SlashMenu{th: th, list: list, total: total}
}

// List exposes the underlying SelectList for navigation (MoveUp/MoveDown/etc).
func (m *SlashMenu) List() *SelectList { return m.list }

// Render returns the grok-styled menu at truecolor for the given width.
func (m *SlashMenu) Render(width int) []string {
	return m.RenderAt(colorprofile.TrueColor, width)
}

// RenderAt renders the menu and downgrades every styled line to the given color
// profile (truecolor keeps exact hexes; 256/NO_COLOR fall back safely).
func (m *SlashMenu) RenderAt(profile colorprofile.Profile, width int) []string {
	if width < 4 {
		width = 4
	}
	var lines []string

	lines = append(lines, m.topRule(width))

	rows := m.styledRows(width)
	// Scrollbar block at the right edge of the first visible row.
	if len(rows) > 0 {
		rows[0] = m.appendScrollbar(rows[0], width)
	}
	lines = append(lines, rows...)

	lines = append(lines, m.bottomRule(width))

	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = theme.RenderAtRaw(profile, l)
	}
	return out
}

// styledRows renders each visible command row with the accent-blue command
// token + muted description, replacing the SelectList's raw prefix styling with
// the grok colors. The SelectList owns the column math; SlashMenu owns color.
func (m *SlashMenu) styledRows(width int) []string {
	raw := m.list.Render(width)
	styled := make([]string, 0, len(raw))
	selIdx := m.list.SelectedIndex()
	start, _ := m.list.VisibleRange()
	for i, line := range raw {
		absolute := start + i
		// The scroll-info line (if any) is appended after the item rows; leave it
		// muted as the SelectList already styled it.
		if absolute >= len(m.itemsForColoring()) {
			styled = append(styled, line)
			continue
		}
		styled = append(styled, m.colorizeRow(line, absolute == selIdx))
	}
	return styled
}

// colorizeRow paints the prefix + slash-command token in accent-blue. The row
// text is "<prefix><command><spacing><description>"; we recolor the "/command"
// span (up to the first run of >=2 spaces) blue, leaving the rest as-is (the
// SelectList already muted the description).
func (m *SlashMenu) colorizeRow(line string, selected bool) string {
	blue := m.th.AccentBlue()
	// Split off the 2-cell prefix.
	prefixWidth := 2
	prefix := prefixVisible(line, prefixWidth)
	rest := line[len(prefix):]

	// The command token runs until the first double-space gap.
	cmdEnd := strings.Index(rest, "  ")
	if cmdEnd < 0 {
		cmdEnd = len(rest)
	}
	cmd := rest[:cmdEnd]
	tail := rest[cmdEnd:]

	styledPrefix := blue.Render(prefix)
	styledCmd := blue.Render(cmd)
	return styledPrefix + styledCmd + tail
}

// itemsForColoring returns the currently visible filtered items count basis. We
// only need the count of item rows (excludes the trailing scroll-info line).
func (m *SlashMenu) itemsForColoring() []SelectItem {
	start, end := m.list.VisibleRange()
	if start > end {
		return nil
	}
	return make([]SelectItem, end-start)
}

// appendScrollbar right-aligns the scrollbar block on a row, padding the row to
// width-1 then adding the block. The block is muted (grok capture).
func (m *SlashMenu) appendScrollbar(row string, width int) string {
	padded := PadToWidth(row, width-1)
	// Hard-clip if the row already exceeds width-1.
	if VisibleWidth(padded) > width-1 {
		padded = TruncateToWidth(padded, width-1, "")
	}
	return padded + m.th.TextMuted().Render(scrollbarBlock)
}

// topRule renders the upper divider with a right-aligned count marker
// "─<total>─" (grok "47" marker). The rule is muted.
func (m *SlashMenu) topRule(width int) string {
	marker := "─" + itoaUI(m.total) + "─"
	markerWidth := VisibleWidth(marker)
	fillWidth := width - markerWidth
	if fillWidth < 0 {
		fillWidth = 0
	}
	rule := strings.Repeat(borderRune, fillWidth) + marker
	// Ensure exact width.
	rule = TruncateToWidth(PadToWidth(rule, width), width, "")
	return m.th.TextMuted().Render(rule)
}

// bottomRule renders the full-width lower divider (muted).
func (m *SlashMenu) bottomRule(width int) string {
	return m.th.TextMuted().Render(strings.Repeat(borderRune, width))
}

// prefixVisible returns the leading substring of line spanning exactly n visible
// cells (used to peel the "❯ "/"  " prefix regardless of glyph byte length).
func prefixVisible(line string, n int) string {
	if n <= 0 {
		return ""
	}
	var b strings.Builder
	width := 0
	for _, r := range line {
		rw := VisibleWidth(string(r))
		if width+rw > n {
			break
		}
		b.WriteRune(r)
		width += rw
		if width >= n {
			break
		}
	}
	return b.String()
}
