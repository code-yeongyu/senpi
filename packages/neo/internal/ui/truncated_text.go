package ui

import "strings"

// TruncatedText is the Go port of packages/tui/src/components/truncated-text.ts:
// a single-line text primitive that renders the FIRST line only (stopping at a
// newline), truncates with a "..." ellipsis to fit, applies symmetric horizontal
// padding, and pads every output line to EXACTLY the render width in visible
// cells. Optional vertical padding emits blank full-width lines above and below.
type TruncatedText struct {
	text     string
	paddingX int
	paddingY int
}

// NewTruncatedText builds a TruncatedText with the given horizontal/vertical
// padding (in cells / lines).
func NewTruncatedText(text string, paddingX, paddingY int) *TruncatedText {
	return &TruncatedText{text: text, paddingX: paddingX, paddingY: paddingY}
}

// Render returns the padded lines for the given render width.
func (t *TruncatedText) Render(width int) []string {
	if width < 0 {
		width = 0
	}
	result := make([]string, 0, 1+2*t.paddingY)
	emptyLine := spaces(width)

	for i := 0; i < t.paddingY; i++ {
		result = append(result, emptyLine)
	}

	availableWidth := width - t.paddingX*2
	if availableWidth < 1 {
		availableWidth = 1
	}

	// First line only.
	singleLine := t.text
	if idx := strings.IndexByte(t.text, '\n'); idx != -1 {
		singleLine = t.text[:idx]
	}

	displayText := TruncateToWidth(singleLine, availableWidth, "...")

	pad := spaces(t.paddingX)
	line := pad + displayText + pad
	line = PadToWidth(line, width)
	result = append(result, line)

	for i := 0; i < t.paddingY; i++ {
		result = append(result, emptyLine)
	}
	return result
}
