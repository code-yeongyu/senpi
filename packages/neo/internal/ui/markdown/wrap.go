// allow: SIZE_OK - byte-faithful port of the ANSI-aware wrap engine in
// packages/tui/src/utils.ts; splitting it would fragment the wrapping contract.
package markdown

import (
	"strings"
	"unicode"

	"github.com/rivo/uniseg"
)

// This file ports the word-wrapping engine from packages/tui/src/utils.ts
// (wrapTextWithAnsi, wrapSingleLine, splitIntoTokensWithAnsi, breakLongWord,
// applyBackgroundToLine). It preserves ANSI styling + OSC 8 links across breaks
// and breaks CJK graphemes individually, matching the classic TUI byte-for-byte.

// cjkBreakRanges mirror utils.ts cjkBreakRegex (Han/Hiragana/Katakana/Hangul/
// Bopomofo). Go regexp lacks Script_Extensions; the Script tables below cover the
// same practical break behavior for wrapping.
func isCJKBreak(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r) ||
		unicode.Is(unicode.Bopomofo, r)
}

func firstRuneIsCJKBreak(seg string) bool {
	for _, r := range seg {
		return isCJKBreak(r)
	}
	return false
}

// wrapTextWithAnsi wraps text to width visible columns, preserving ANSI state
// across literal newlines and wrapped lines. Port of utils.ts wrapTextWithAnsi.
func wrapTextWithAnsi(text string, width int) []string {
	if text == "" {
		return []string{""}
	}
	inputLines := strings.Split(text, "\n")
	var result []string
	tracker := &ansiCodeTracker{}
	for _, inputLine := range inputLines {
		prefix := ""
		if len(result) > 0 {
			prefix = tracker.getActiveCodes()
		}
		wrapped := wrapSingleLine(prefix+inputLine, width)
		result = append(result, wrapped...)
		updateTrackerFromText(inputLine, tracker)
	}
	if len(result) == 0 {
		return []string{""}
	}
	return result
}

func wrapSingleLine(line string, width int) []string {
	if line == "" {
		return []string{""}
	}
	if visibleWidth(line) <= width {
		return []string{line}
	}

	var wrapped []string
	tracker := &ansiCodeTracker{}
	tokens := splitIntoTokensWithAnsi(line)

	var currentLine strings.Builder
	currentVisibleLength := 0

	for _, token := range tokens {
		tokenVisibleLength := visibleWidth(token)
		isWhitespace := strings.TrimSpace(token) == ""

		// Token itself too long — break char by char.
		if tokenVisibleLength > width && !isWhitespace {
			if currentLine.Len() > 0 {
				if reset := tracker.getLineEndReset(); reset != "" {
					currentLine.WriteString(reset)
				}
				wrapped = append(wrapped, currentLine.String())
				currentLine.Reset()
				currentVisibleLength = 0
			}
			broken := breakLongWord(token, width, tracker)
			for i := 0; i < len(broken)-1; i++ {
				wrapped = append(wrapped, broken[i])
			}
			last := broken[len(broken)-1]
			currentLine.Reset()
			currentLine.WriteString(last)
			currentVisibleLength = visibleWidth(last)
			continue
		}

		totalNeeded := currentVisibleLength + tokenVisibleLength
		if totalNeeded > width && currentVisibleLength > 0 {
			lineToWrap := strings.TrimRight(currentLine.String(), " \t")
			if reset := tracker.getLineEndReset(); reset != "" {
				lineToWrap += reset
			}
			wrapped = append(wrapped, lineToWrap)
			currentLine.Reset()
			if isWhitespace {
				currentLine.WriteString(tracker.getActiveCodes())
				currentVisibleLength = 0
			} else {
				currentLine.WriteString(tracker.getActiveCodes())
				currentLine.WriteString(token)
				currentVisibleLength = tokenVisibleLength
			}
		} else {
			currentLine.WriteString(token)
			currentVisibleLength += tokenVisibleLength
		}
		updateTrackerFromText(token, tracker)
	}

	if currentLine.Len() > 0 {
		wrapped = append(wrapped, currentLine.String())
	}

	if len(wrapped) == 0 {
		return []string{""}
	}
	for i := range wrapped {
		wrapped[i] = strings.TrimRight(wrapped[i], " \t")
	}
	return wrapped
}

// splitIntoTokensWithAnsi splits text into word/space tokens with ANSI codes
// attached to the following visible content. Port of utils.ts.
func splitIntoTokensWithAnsi(text string) []string {
	var tokens []string
	var current strings.Builder
	pendingAnsi := ""
	currentKind := "" // "space" | "word" | ""

	flush := func() {
		if current.Len() == 0 {
			return
		}
		tokens = append(tokens, current.String())
		current.Reset()
		currentKind = ""
	}

	i := 0
	for i < len(text) {
		if code, n, ok := extractAnsiCode(text, i); ok {
			pendingAnsi += code
			i += n
			continue
		}
		// find next ANSI code or end
		end := i
		for end < len(text) {
			if _, _, ok := extractAnsiCode(text, end); ok {
				break
			}
			end++
		}
		portion := text[i:end]
		g := uniseg.NewGraphemes(portion)
		for g.Next() {
			segment := g.Str()
			segmentIsSpace := segment == " "
			if !segmentIsSpace && firstRuneIsCJKBreak(segment) {
				flush()
				token := pendingAnsi + segment
				pendingAnsi = ""
				tokens = append(tokens, token)
				continue
			}
			segmentKind := "word"
			if segmentIsSpace {
				segmentKind = "space"
			}
			if current.Len() > 0 && currentKind != segmentKind {
				flush()
			}
			if pendingAnsi != "" {
				current.WriteString(pendingAnsi)
				pendingAnsi = ""
			}
			currentKind = segmentKind
			current.WriteString(segment)
		}
		i = end
	}

	if pendingAnsi != "" {
		if current.Len() > 0 {
			current.WriteString(pendingAnsi)
		} else if len(tokens) > 0 {
			tokens[len(tokens)-1] += pendingAnsi
		} else {
			current.WriteString(pendingAnsi)
		}
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

// breakLongWord breaks a word wider than width into grapheme-safe pieces,
// preserving ANSI state. Port of utils.ts breakLongWord.
func breakLongWord(word string, width int, tracker *ansiCodeTracker) []string {
	var lines []string
	var currentLine strings.Builder
	currentLine.WriteString(tracker.getActiveCodes())
	currentWidth := 0

	type seg struct {
		ansi  bool
		value string
	}
	var segments []seg
	i := 0
	for i < len(word) {
		if code, n, ok := extractAnsiCode(word, i); ok {
			segments = append(segments, seg{ansi: true, value: code})
			i += n
			continue
		}
		end := i
		for end < len(word) {
			if _, _, ok := extractAnsiCode(word, end); ok {
				break
			}
			end++
		}
		g := uniseg.NewGraphemes(word[i:end])
		for g.Next() {
			segments = append(segments, seg{ansi: false, value: g.Str()})
		}
		i = end
	}

	for _, s := range segments {
		if s.ansi {
			currentLine.WriteString(s.value)
			tracker.process(s.value)
			continue
		}
		grapheme := s.value
		if grapheme == "" {
			continue
		}
		gw := visibleWidth(grapheme)
		if currentWidth+gw > width {
			if reset := tracker.getLineEndReset(); reset != "" {
				currentLine.WriteString(reset)
			}
			lines = append(lines, currentLine.String())
			currentLine.Reset()
			currentLine.WriteString(tracker.getActiveCodes())
			currentWidth = 0
		}
		currentLine.WriteString(grapheme)
		currentWidth += gw
	}

	if currentLine.Len() > 0 {
		lines = append(lines, currentLine.String())
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

// applyBackgroundToLine applies a background color to a line, padding to width.
// Port of utils.ts applyBackgroundToLine.
func applyBackgroundToLine(line string, width int, bgFn StyleFunc) string {
	visibleLen := visibleWidth(line)
	paddingNeeded := width - visibleLen
	if paddingNeeded < 0 {
		paddingNeeded = 0
	}
	padding := strings.Repeat(" ", paddingNeeded)
	withPadding := line + padding
	marker := "\x1fpi-bg-marker\x1f"
	wrappedMarker := bgFn(marker)
	markerIndex := strings.Index(wrappedMarker, marker)
	if markerIndex == -1 {
		return bgFn(withPadding)
	}
	bgStart := wrappedMarker[:markerIndex]
	bgEnd := wrappedMarker[markerIndex+len(marker):]

	restoredLine := replaceSGR(line, func(sequence, params string) string {
		if sgrLeavesDefaultBackground(params) {
			return sequence + bgStart
		}
		return sequence
	})
	tracker := &ansiCodeTracker{}
	updateTrackerFromText(line, tracker)
	var restored string
	if paddingNeeded > 0 && tracker.hasActiveCodes() {
		restored = restoredLine + "\x1b[0m" + tracker.getLineEndReset() + bgStart + padding
	} else {
		restored = restoredLine + padding
	}
	return bgStart + restored + bgEnd
}

// replaceSGR replaces each CSI SGR sequence in s using f(sequence, params).
func replaceSGR(s string, f func(sequence, params string) string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && s[j] != 'm' {
				if s[j] != ';' && (s[j] < '0' || s[j] > '9') {
					break
				}
				j++
			}
			if j < len(s) && s[j] == 'm' {
				sequence := s[i : j+1]
				params := s[i+2 : j]
				b.WriteString(f(sequence, params))
				i = j + 1
				continue
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}
