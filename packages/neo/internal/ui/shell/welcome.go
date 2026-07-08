package shell

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// MenuEntry is one welcome-menu row: a label with an optional right-aligned key
// hint (e.g. "New worktree" … "ctrl+w").
type MenuEntry struct {
	Label string
	Key   string
}

// Announcement is the welcome announcement block: a bold heading (accent-yellow
// in the captures) and a muted body line.
type Announcement struct {
	Heading string
	Body    string
}

// WelcomeContent is everything the text-only welcome card renders.
type WelcomeContent struct {
	Title        string
	Version      string
	Announcement Announcement
	Menu         []MenuEntry
}

// welcomeReflowWidth is the width below which the welcome collapses from the
// bordered text card to the compact centered layout. The 120x36 capture draws
// the card; the 80x24 capture uses the compact form.
const welcomeReflowWidth = 100

// Welcome renders the startup welcome. It reflows at wide widths to a bordered
// text-only card (title+version, announcement, menu); at narrow widths it uses a
// compact centered menu + announcement with the version pinned bottom-right.
type Welcome struct {
	th      *theme.Theme
	content WelcomeContent
}

// NewWelcome builds a welcome bound to a theme + content.
func NewWelcome(th *theme.Theme, content WelcomeContent) *Welcome {
	return &Welcome{th: th, content: content}
}

// Render returns the welcome lines for the given width, reflowing at
// welcomeReflowWidth.
func (w *Welcome) Render(width int) []string {
	if width >= welcomeReflowWidth {
		return w.renderWide(width)
	}
	return w.renderCompact(width)
}

// renderWide draws the bordered text card.
func (w *Welcome) renderWide(width int) []string {
	th := w.th
	const leftMargin = 3
	// Card spans width - leftMargin; interior = card - 2 borders.
	cardWidth := width - leftMargin
	if cardWidth < 20 {
		return w.renderCompact(width)
	}
	interior := cardWidth - 2 // inside the │ … │
	marginPad := spacesN(leftMargin)

	border := func(s string) string { return th.BorderCard().Render(s) }
	horiz := strings.Repeat("─", interior)
	top := marginPad + border("╭"+horiz+"╮")
	bottom := marginPad + border("╰"+horiz+"╯")

	rightLines := w.rightColumnLines()
	const horizontalPadding = 2
	contentWidth := interior - horizontalPadding*2
	if contentWidth < 1 {
		contentWidth = 1
	}

	body := make([]string, 0, len(rightLines)+4)
	// top interior padding blank row.
	body = append(body, cardLine(border, "", interior, marginPad))
	for _, right := range rightLines {
		content := spacesN(horizontalPadding) + w.padRight(right, contentWidth) + spacesN(horizontalPadding)
		body = append(body, cardLine(border, content, interior, marginPad))
	}
	// bottom interior padding blank row.
	body = append(body, cardLine(border, "", interior, marginPad))

	out := make([]string, 0, len(body)+2)
	out = append(out, top)
	out = append(out, body...)
	out = append(out, bottom)
	return out
}

// cardLine wraps content between the card's vertical borders, padding the
// interior to exactly `interior` visible cells.
func cardLine(border func(string) string, content string, interior int, marginPad string) string {
	padded := padVisible(content, interior)
	return marginPad + border("│") + padded + border("│")
}

// rightColumnLines builds the wide card's right-column content (already colored)
// aligned to the same rows the logo occupies, then any overflow menu rows below.
func (w *Welcome) rightColumnLines() []string {
	th := w.th
	c := w.content
	title := th.TextPrimary().Bold(true).Render(c.Title)
	version := th.TextMuted().Render(c.Version)

	var lines []string
	// row 0: title + version.
	lines = append(lines, title+"  "+version)
	// row 1: blank.
	lines = append(lines, "")
	// row 2: announcement heading (accent-yellow bold).
	if c.Announcement.Heading != "" {
		lines = append(lines, th.AccentYellow().Bold(true).Render(c.Announcement.Heading))
	} else {
		lines = append(lines, "")
	}
	// row 3: announcement body (muted).
	if c.Announcement.Body != "" {
		lines = append(lines, th.TextMuted().Render(c.Announcement.Body))
	} else {
		lines = append(lines, "")
	}
	// row 4: blank separator.
	lines = append(lines, "")
	// remaining rows: menu entries.
	for _, m := range c.Menu {
		lines = append(lines, w.menuLine(m))
	}
	return lines
}

// menuLine renders one menu entry with the label at the left and the key hint
// right-aligned within the right column (padding is applied later by padRight).
func (w *Welcome) menuLine(m MenuEntry) string {
	th := w.th
	label := th.TextPrimary().Bold(true).Render(m.Label)
	if m.Key == "" {
		return label
	}
	// encode a marker the padRight step uses to right-align the key: we store the
	// key colored + a sentinel so padRight can split. Simpler: return label and
	// key joined by a tab-like sentinel handled by padRight.
	return label + menuKeySep + th.TextFaint().Render(m.Key)
}

// menuKeySep separates a menu label from its right-aligned key hint. It is a
// Unicode private-use marker (U+E000) that never appears in real menu labels,
// so padRight can split the label from the key and right-align the key.
const menuKeySep = "KEY"

// padRight pads a right-column line to width. If the line carries a menuKeySep,
// the key portion is right-aligned to the width edge.
func (w *Welcome) padRight(line string, width int) string {
	if idx := strings.Index(line, menuKeySep); idx >= 0 {
		left := line[:idx]
		key := line[idx+len(menuKeySep):]
		lw := ui.VisibleWidth(left)
		kw := ui.VisibleWidth(key)
		pad := width - lw - kw
		if pad < 1 {
			pad = 1
		}
		return left + spacesN(pad) + key
	}
	return w.padRightPlain(line, width)
}

func (w *Welcome) padRightPlain(line string, width int) string {
	vw := ui.VisibleWidth(line)
	if vw >= width {
		return ui.TruncateToWidth(line, width, "")
	}
	return line + spacesN(width-vw)
}

// renderCompact draws the narrow welcome: no bordered card. A left-indented
// menu block, a blank line, then the announcement, then (after spacing) the
// version pinned to the bottom-right. Mirrors the 80x24 capture.
func (w *Welcome) renderCompact(width int) []string {
	th := w.th
	c := w.content
	const indent = 15 // capture indents the compact block ~15 cols
	ind := spacesN(minInt(indent, maxInt(0, width-20)))

	// menu block width (label … key) fits within the remaining width.
	blockWidth := width - ui.VisibleWidth(ind) - 2
	if blockWidth < 10 {
		blockWidth = maxInt(1, width-2)
	}

	var out []string
	for _, m := range c.Menu {
		label := th.TextPrimary().Bold(true).Render(m.Label)
		if m.Key == "" {
			out = append(out, ind+label)
			continue
		}
		lw := ui.VisibleWidth(m.Label)
		kw := ui.VisibleWidth(m.Key)
		pad := blockWidth - lw - kw
		if pad < 1 {
			pad = 1
		}
		out = append(out, ind+label+spacesN(pad)+th.TextFaint().Render(m.Key))
	}
	out = append(out, "")
	if c.Announcement.Heading != "" {
		out = append(out, ind+th.AccentYellow().Bold(true).Render(c.Announcement.Heading))
	}
	if c.Announcement.Body != "" {
		// wrap the body to the block width.
		for _, line := range wrapPlain(c.Announcement.Body, blockWidth) {
			out = append(out, ind+th.TextMuted().Render(line))
		}
	}
	out = append(out, "")

	// version pinned bottom-right: "<Title> <Version>" right-aligned.
	versionText := c.Title + "  " + c.Version
	vw := ui.VisibleWidth(versionText)
	lead := width - vw - 2
	if lead < 0 {
		lead = 0
	}
	versionColored := th.TextPrimary().Bold(true).Render(c.Title) + "  " + th.TextMuted().Render(c.Version)
	out = append(out, spacesN(lead)+versionColored)
	return out
}

// padVisible pads s (which may contain SGR) to exactly width visible cells,
// clipping if it overflows.
func padVisible(s string, width int) string {
	vw := ui.VisibleWidth(s)
	if vw == width {
		return s
	}
	if vw > width {
		return ui.TruncateToWidth(s, width, "")
	}
	return s + spacesN(width-vw)
}

// wrapPlain word-wraps plain text to width, never splitting a word unless it is
// itself longer than width.
func wrapPlain(s string, width int) []string {
	if width < 1 {
		width = 1
	}
	words := strings.Fields(s)
	if len(words) == 0 {
		return []string{""}
	}
	var lines []string
	cur := ""
	for _, word := range words {
		if cur == "" {
			cur = word
			continue
		}
		if ui.VisibleWidth(cur)+1+ui.VisibleWidth(word) <= width {
			cur += " " + word
		} else {
			lines = append(lines, cur)
			cur = word
		}
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	return lines
}
