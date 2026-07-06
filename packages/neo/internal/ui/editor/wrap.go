package editor

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// TextChunk is a word-wrap layout unit: the (possibly trimmed) display Text plus
// the rune StartIndex/EndIndex it spans in the original line. Ported from the
// TextChunk interface in packages/tui/src/components/editor.ts.
type TextChunk struct {
	Text       string
	StartIndex int
	EndIndex   int
}

// WordWrapLine splits line into word-wrapped chunks at maxWidth using the shared
// grapheme segmenter (no paste-marker awareness). Ported from wordWrapLine().
func WordWrapLine(line string, maxWidth int) []TextChunk {
	return WordWrapLinePreseg(line, maxWidth, nil)
}

// WordWrapLinePreseg is WordWrapLine with an optional pre-segmented unit list
// (e.g. paste-marker-aware graphemes). When preseg is nil the default grapheme
// segmenter is used.
func WordWrapLinePreseg(line string, maxWidth int, preseg []Segment) []TextChunk {
	if line == "" || maxWidth <= 0 {
		return []TextChunk{{Text: "", StartIndex: 0, EndIndex: 0}}
	}
	runes := []rune(line)
	total := len(runes)

	if preseg == nil && !strings.ContainsAny(line, " \t\n") && !strings.Contains(line, "[paste #") && isPrintableASCII(line) {
		return wordWrapASCIILine(line, maxWidth)
	}

	if textwidth.Visible(line) <= maxWidth {
		return []TextChunk{{Text: line, StartIndex: 0, EndIndex: total}}
	}

	segments := preseg
	if segments == nil {
		segments = segmentGraphemes(line, nil)
	}

	var chunks []TextChunk
	currentWidth := 0
	chunkStart := 0
	wrapOppIndex := -1
	wrapOppWidth := 0

	sliceRunes := func(a, b int) string { return string(runes[a:b]) }

	for i := 0; i < len(segments); i++ {
		seg := segments[i]
		grapheme := seg.Text
		gWidth := textwidth.Visible(grapheme)
		charIndex := seg.Index
		isWs := !isPasteMarkerText(grapheme) && isWhitespaceChar(grapheme)

		if currentWidth+gWidth > maxWidth {
			if wrapOppIndex >= 0 && currentWidth-wrapOppWidth+gWidth <= maxWidth {
				chunks = append(chunks, TextChunk{Text: sliceRunes(chunkStart, wrapOppIndex), StartIndex: chunkStart, EndIndex: wrapOppIndex})
				chunkStart = wrapOppIndex
				currentWidth -= wrapOppWidth
			} else if chunkStart < charIndex {
				chunks = append(chunks, TextChunk{Text: sliceRunes(chunkStart, charIndex), StartIndex: chunkStart, EndIndex: charIndex})
				chunkStart = charIndex
				currentWidth = 0
			}
			wrapOppIndex = -1
		}

		if gWidth > maxWidth {
			// Atomic segment wider than maxWidth: re-wrap at grapheme granularity.
			// It stays logically atomic for editing; the split is visual only.
			subChunks := WordWrapLine(grapheme, maxWidth)
			for j := 0; j < len(subChunks)-1; j++ {
				sc := subChunks[j]
				chunks = append(chunks, TextChunk{Text: sc.Text, StartIndex: charIndex + sc.StartIndex, EndIndex: charIndex + sc.EndIndex})
			}
			last := subChunks[len(subChunks)-1]
			chunkStart = charIndex + last.StartIndex
			currentWidth = textwidth.Visible(last.Text)
			wrapOppIndex = -1
			continue
		}

		currentWidth += gWidth

		// Record a wrap opportunity.
		var next *Segment
		if i+1 < len(segments) {
			next = &segments[i+1]
		}
		if isWs && next != nil && (isPasteMarkerText(next.Text) || !isWhitespaceChar(next.Text)) {
			wrapOppIndex = next.Index
			wrapOppWidth = currentWidth
		} else if !isWs && next != nil && !isWhitespaceChar(next.Text) {
			isCjk := !isPasteMarkerText(grapheme) && containsCJK(grapheme)
			nextIsCjk := !isPasteMarkerText(next.Text) && containsCJK(next.Text)
			if isCjk || nextIsCjk {
				wrapOppIndex = next.Index
				wrapOppWidth = currentWidth
			}
		}
	}

	chunks = append(chunks, TextChunk{Text: sliceRunes(chunkStart, total), StartIndex: chunkStart, EndIndex: total})
	return chunks
}

// wordWrapASCIILine is the fast path for printable-ASCII lines with no markers.
// Ported from wordWrapAsciiLine().
func wordWrapASCIILine(line string, maxWidth int) []TextChunk {
	runes := []rune(line)
	n := len(runes)
	if n <= maxWidth {
		return []TextChunk{{Text: line, StartIndex: 0, EndIndex: n}}
	}
	var chunks []TextChunk
	chunkStart := 0
	for chunkStart < n {
		chunkEnd := chunkStart + maxWidth
		if chunkEnd > n {
			chunkEnd = n
		}
		if chunkEnd < n {
			breakAt := -1
			for i := chunkEnd; i > chunkStart; i-- {
				c := runes[i-1]
				if c == ' ' || c == '\t' {
					breakAt = i - 1
					break
				}
			}
			if breakAt > chunkStart {
				chunkEnd = breakAt
			}
		}
		raw := string(runes[chunkStart:chunkEnd])
		text := strings.TrimRight(raw, " \t")
		if text != "" || len(chunks) == 0 {
			chunks = append(chunks, TextChunk{Text: text, StartIndex: chunkStart, EndIndex: chunkStart + len([]rune(raw))})
		}
		chunkStart = chunkEnd
		for chunkStart < n {
			c := runes[chunkStart]
			if c != ' ' && c != '\t' {
				break
			}
			chunkStart++
		}
	}
	if len(chunks) == 0 {
		return []TextChunk{{Text: "", StartIndex: 0, EndIndex: 0}}
	}
	return chunks
}

func isPrintableASCII(s string) bool {
	for _, r := range s {
		if r < 0x20 || r > 0x7e {
			return false
		}
	}
	return true
}

func containsCJK(s string) bool {
	for _, r := range s {
		if isCJK(r) {
			return true
		}
	}
	return false
}
