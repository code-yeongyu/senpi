package editor

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// wrappedLine is the word-wrap layout for one logical line.
type wrappedLine struct {
	chunks []TextChunk
	width  int
}

// getWrappedLine wraps logical line lineIndex to contentWidth. Marker-bearing
// lines are re-segmented with paste-marker awareness so oversized markers split
// visually while staying atomic for editing. Ported from getWrappedLine().
func (e *Editor) getWrappedLine(lineIndex, contentWidth int) wrappedLine {
	line := ""
	if lineIndex >= 0 && lineIndex < len(e.state.lines) {
		line = e.state.lines[lineIndex]
	}
	width := runeLen(line)
	if !isPrintableASCII(line) {
		width = textwidth.Visible(line)
	}

	if strings.Contains(line, "[paste #") {
		var chunks []TextChunk
		if width <= contentWidth {
			chunks = []TextChunk{{Text: line, StartIndex: 0, EndIndex: runeLen(line)}}
		} else {
			chunks = WordWrapLinePreseg(line, contentWidth, segmentGraphemes(line, e.validMarker()))
		}
		return wrappedLine{chunks: chunks, width: width}
	}

	var chunks []TextChunk
	if width <= contentWidth {
		chunks = []TextChunk{{Text: line, StartIndex: 0, EndIndex: runeLen(line)}}
	} else {
		chunks = WordWrapLine(line, contentWidth)
	}
	return wrappedLine{chunks: chunks, width: width}
}
