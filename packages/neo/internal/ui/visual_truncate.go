package ui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// VisualTruncateResult is the return of TruncateToVisualLines, mirroring the TS
// VisualTruncateResult (visual-truncate.ts).
type VisualTruncateResult struct {
	// VisualLines are the (width-padded) lines to display.
	VisualLines []string
	// SkippedCount is how many leading visual lines were hidden.
	SkippedCount int
}

// TruncateToVisualLines truncates text to at most maxVisualLines visual lines
// FROM THE END, accounting for width-based line wrapping. Port of
// packages/coding-agent/src/modes/interactive/components/visual-truncate.ts:42
// truncateToVisualLines(text, maxVisualLines, width, paddingX). It renders text
// through the same layout a Text component would (paddingX left/right margins,
// each line padded to the full render width), then keeps the last N visual lines.
//
// paddingX is the Text horizontal padding: 0 when the result lands in a Box (the
// Box adds its own padding), 1 for a plain container.
func TruncateToVisualLines(text string, maxVisualLines, width, paddingX int) VisualTruncateResult {
	if text == "" {
		return VisualTruncateResult{VisualLines: []string{}, SkippedCount: 0}
	}

	allVisualLines := renderTextLines(text, width, paddingX)

	if len(allVisualLines) <= maxVisualLines {
		return VisualTruncateResult{VisualLines: allVisualLines, SkippedCount: 0}
	}

	if maxVisualLines < 0 {
		maxVisualLines = 0
	}
	start := len(allVisualLines) - maxVisualLines
	truncated := append([]string(nil), allVisualLines[start:]...)
	return VisualTruncateResult{VisualLines: truncated, SkippedCount: start}
}

// renderTextLines reproduces the pi-tui Text.render(width) layout for the
// paddingY=0 case that truncateToVisualLines relies on: tabs become three
// spaces, empty/whitespace-only text renders nothing, the content wraps at
// width-paddingX*2 (word wrap with long-word breaking, wide-char aware, matching
// wrapTextWithAnsi/wrapSingleLine), each wrapped line gets paddingX-space left
// and right margins, and every line is padded to exactly the render width.
func renderTextLines(text string, width, paddingX int) []string {
	if strings.TrimSpace(text) == "" {
		return []string{}
	}
	if width < 0 {
		width = 0
	}
	if paddingX < 0 {
		paddingX = 0
	}

	normalized := strings.ReplaceAll(text, "\t", "   ")

	contentWidth := width - paddingX*2
	if contentWidth < 1 {
		contentWidth = 1
	}

	margin := spaces(paddingX)
	wrapped := wrapVisualLines(normalized, contentWidth)

	out := make([]string, 0, len(wrapped))
	for _, line := range wrapped {
		withMargins := margin + line + margin
		out = append(out, PadToWidth(withMargins, width))
	}
	return out
}

// wrapVisualLines wraps normalized text (which may contain explicit newlines)
// into visual lines at the given content width, preserving each explicit line
// break and word-wrapping (breaking over-long words) within it. Wide characters
// count as two cells. Mirrors wrapTextWithAnsi splitting on "\n" then wrapping
// each segment.
func wrapVisualLines(text string, contentWidth int) []string {
	var result []string
	for _, seg := range strings.Split(text, "\n") {
		if seg == "" {
			result = append(result, "")
			continue
		}
		wrapped := ansi.WrapWc(seg, contentWidth, "")
		result = append(result, strings.Split(wrapped, "\n")...)
	}
	if len(result) == 0 {
		return []string{""}
	}
	return result
}
