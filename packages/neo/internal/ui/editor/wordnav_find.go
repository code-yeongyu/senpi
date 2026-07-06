package editor

import "regexp"

// punctuationRegex mirrors PUNCTUATION_REGEX in packages/tui/src/utils.ts. It
// bounds word-backward/forward inside a word-like segment so ASCII punctuation
// (e.g. "foo.bar") preserves editor cursor stops.
var punctuationRegex = regexp.MustCompile(`[(){}\[\]<>.,;:'"!?+\-=*/\\|&%^$#@~` + "`" + `]`)

// findWordBackward returns the rune position after moving one word backward from
// cursor in text. Ported from packages/tui/src/word-navigation.ts.
func findWordBackward(text string, cursor int, isAtomic func(string) bool) int {
	if cursor <= 0 {
		return 0
	}
	before := runeSlice(text, 0, cursor)
	segs := segmentWords(before, isAtomic)
	newCursor := cursor

	// Skip trailing whitespace.
	for len(segs) > 0 {
		last := segs[len(segs)-1]
		if isAtomicSeg(isAtomic, last.text) || !isWhitespaceChar(last.text) {
			break
		}
		newCursor -= runeLen(last.text)
		segs = segs[:len(segs)-1]
	}
	if len(segs) == 0 {
		return newCursor
	}

	last := segs[len(segs)-1]
	switch {
	case isAtomicSeg(isAtomic, last.text):
		newCursor -= runeLen(last.text)
	case last.isWord:
		matches := punctuationRegex.FindAllStringIndex(last.text, -1)
		if len(matches) == 0 {
			newCursor -= runeLen(last.text)
		} else {
			lastMatch := matches[len(matches)-1]
			// byte end of last punctuation match -> rune tail length after it.
			tail := runeLen(last.text[lastMatch[1]:])
			newCursor -= tail
		}
	default:
		// Skip a non-word non-whitespace run (punctuation).
		for len(segs) > 0 {
			s := segs[len(segs)-1]
			if isAtomicSeg(isAtomic, s.text) || s.isWord || isWhitespaceChar(s.text) {
				break
			}
			newCursor -= runeLen(s.text)
			segs = segs[:len(segs)-1]
		}
	}
	return newCursor
}

// findWordForward returns the rune position after moving one word forward from
// cursor. Ported from packages/tui/src/word-navigation.ts.
func findWordForward(text string, cursor int, isAtomic func(string) bool) int {
	total := runeLen(text)
	if cursor >= total {
		return total
	}
	after := runeSlice(text, cursor, total)
	segs := segmentWords(after, isAtomic)
	newCursor := cursor
	i := 0

	// Skip leading whitespace.
	for i < len(segs) {
		s := segs[i]
		if isAtomicSeg(isAtomic, s.text) || !isWhitespaceChar(s.text) {
			break
		}
		newCursor += runeLen(s.text)
		i++
	}
	if i >= len(segs) {
		return newCursor
	}

	cur := segs[i]
	switch {
	case isAtomicSeg(isAtomic, cur.text):
		newCursor += runeLen(cur.text)
	case cur.isWord:
		if loc := punctuationRegex.FindStringIndex(cur.text); loc != nil {
			newCursor += runeLen(cur.text[:loc[0]])
		} else {
			newCursor += runeLen(cur.text)
		}
	default:
		for i < len(segs) {
			s := segs[i]
			if isAtomicSeg(isAtomic, s.text) || s.isWord || isWhitespaceChar(s.text) {
				break
			}
			newCursor += runeLen(s.text)
			i++
		}
	}
	return newCursor
}

func isAtomicSeg(isAtomic func(string) bool, s string) bool {
	return isAtomic != nil && isAtomic(s)
}
