package editor

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// cursorMarker is the zero-width APC hardware-cursor marker, matching
// CURSOR_MARKER in packages/tui/src/tui.ts. When focused, Render emits it at the
// insertion point so a host can position the real terminal cursor for IME.
const cursorMarker = "\x1b_pi:c\x07"

// layoutLine is one rendered row before cursor decoration.
type layoutLine struct {
	text      string
	hasCursor bool
	cursorPos int // rune offset of the cursor within text
}

// BorderColor optionally wraps the horizontal border rune. Defaults to identity.
var _ = 0

// Render lays out and renders the editor at the given width, returning styled
// rows (top border, content rows, bottom border, optional autocomplete popup).
// Ported from render().
func (e *Editor) Render(width int) []string {
	maxPadding := max0((width - 1) / 2)
	paddingX := e.paddingX
	if paddingX > maxPadding {
		paddingX = maxPadding
	}
	contentWidth := width - paddingX*2
	if contentWidth < 1 {
		contentWidth = 1
	}
	layoutWidth := contentWidth
	if paddingX == 0 {
		layoutWidth = contentWidth - 1
	}
	if layoutWidth < 1 {
		layoutWidth = 1
	}
	e.lastWidth = layoutWidth

	horizontal := "─"
	layoutLines := e.layoutText(layoutWidth)

	maxVisible := e.maxVisibleLines()

	cursorLineIndex := 0
	for i, l := range layoutLines {
		if l.hasCursor {
			cursorLineIndex = i
			break
		}
	}

	if cursorLineIndex < e.scrollOff {
		e.scrollOff = cursorLineIndex
	} else if cursorLineIndex >= e.scrollOff+maxVisible {
		e.scrollOff = cursorLineIndex - maxVisible + 1
	}
	maxScroll := max0(len(layoutLines) - maxVisible)
	if e.scrollOff > maxScroll {
		e.scrollOff = maxScroll
	}
	if e.scrollOff < 0 {
		e.scrollOff = 0
	}

	end := e.scrollOff + maxVisible
	if end > len(layoutLines) {
		end = len(layoutLines)
	}
	visible := layoutLines[e.scrollOff:end]

	var result []string
	leftPad := strings.Repeat(" ", paddingX)
	rightPad := leftPad

	// Top border.
	if e.scrollOff > 0 {
		indicator := "─── ↑ " + itoa(e.scrollOff) + " more "
		remaining := width - textwidth.Visible(indicator)
		if remaining >= 0 {
			result = append(result, indicator+strings.Repeat("─", remaining))
		} else {
			result = append(result, truncateToWidth(indicator, width))
		}
	} else {
		result = append(result, strings.Repeat(horizontal, width))
	}

	emitMarker := e.focused
	for _, ll := range visible {
		displayText := ll.text
		lineVisibleWidth := textwidth.Visible(ll.text)
		cursorInPadding := false

		if ll.hasCursor {
			before := runeSlice(displayText, 0, ll.cursorPos)
			after := runeSlice(displayText, ll.cursorPos, runeLen(displayText))
			marker := ""
			if emitMarker {
				marker = cursorMarker
			}
			if after != "" {
				gLen := firstGraphemeLen(after, e.validMarker())
				first := runeSlice(after, 0, gLen)
				rest := runeSlice(after, gLen, runeLen(after))
				cursor := "\x1b[7m" + first + "\x1b[0m"
				displayText = before + marker + cursor + rest
			} else {
				cursor := "\x1b[7m \x1b[0m"
				displayText = before + marker + cursor
				lineVisibleWidth++
				if lineVisibleWidth > contentWidth && paddingX > 0 {
					cursorInPadding = true
				}
			}
		}

		pad := strings.Repeat(" ", max0(contentWidth-lineVisibleWidth))
		lineRightPad := rightPad
		if cursorInPadding && len(rightPad) > 0 {
			lineRightPad = rightPad[1:]
		}
		result = append(result, leftPad+displayText+pad+lineRightPad)
	}

	// Bottom border.
	linesBelow := len(layoutLines) - (e.scrollOff + len(visible))
	if linesBelow > 0 {
		indicator := "─── ↓ " + itoa(linesBelow) + " more "
		remaining := width - textwidth.Visible(indicator)
		result = append(result, indicator+strings.Repeat("─", max0(remaining)))
	} else {
		result = append(result, strings.Repeat(horizontal, width))
	}

	// Autocomplete popup.
	if e.acState != acNone && e.acList != nil {
		for _, line := range e.acList.render(contentWidth) {
			lineWidth := textwidth.Visible(line)
			linePad := strings.Repeat(" ", max0(contentWidth-lineWidth))
			result = append(result, leftPad+line+linePad+rightPad)
		}
	}

	return result
}

// layoutText builds the per-visual-line layout, marking the row with the cursor.
// Ported from layoutText().
func (e *Editor) layoutText(contentWidth int) []layoutLine {
	var out []layoutLine
	if len(e.state.lines) == 0 || (len(e.state.lines) == 1 && e.state.lines[0] == "") {
		return []layoutLine{{text: "", hasCursor: true, cursorPos: 0}}
	}
	for i, line := range e.state.lines {
		isCurrent := i == e.state.cursorLine
		wl := e.getWrappedLine(i, contentWidth)
		if wl.width <= contentWidth {
			out = append(out, layoutLine{text: line, hasCursor: isCurrent, cursorPos: e.state.cursorCol})
			continue
		}
		chunks := wl.chunks
		for ci, chunk := range chunks {
			cursorPos := e.state.cursorCol
			isLast := ci == len(chunks)-1
			hasCursorInChunk := false
			adjusted := 0
			if isCurrent {
				if isLast {
					hasCursorInChunk = cursorPos >= chunk.StartIndex
					adjusted = cursorPos - chunk.StartIndex
				} else if cursorPos >= chunk.StartIndex && cursorPos < chunk.EndIndex {
					hasCursorInChunk = true
					adjusted = cursorPos - chunk.StartIndex
					if adjusted > runeLen(chunk.Text) {
						adjusted = runeLen(chunk.Text)
					}
				}
			}
			out = append(out, layoutLine{text: chunk.Text, hasCursor: hasCursorInChunk, cursorPos: adjusted})
		}
	}
	return out
}

// truncateToWidth clips text to maxWidth visible columns (grapheme-aware).
func truncateToWidth(text string, maxWidth int) string {
	if maxWidth <= 0 {
		return ""
	}
	var b strings.Builder
	width := 0
	for _, g := range textwidth.Graphemes(text) {
		if width+g.Width > maxWidth {
			break
		}
		b.WriteString(g.Text)
		width += g.Width
	}
	return b.String()
}
