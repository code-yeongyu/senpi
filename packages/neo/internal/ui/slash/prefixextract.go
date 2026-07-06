package slash

import "strings"

// This file holds the prefix-extraction helpers (path/@-mention/quoted-token
// parsing) ported from the autocomplete.ts helper functions, split from
// autocomplete.go to keep each file under the 250-LOC ceiling.

// --- prefix extraction (autocomplete.ts helpers) ---

var pathDelimiters = map[rune]bool{' ': true, '\t': true, '"': true, '\'': true, '=': true}

func findLastDelimiter(text string) int {
	r := []rune(text)
	for i := len(r) - 1; i >= 0; i-- {
		if pathDelimiters[r[i]] {
			return i
		}
	}
	return -1
}

func isTokenStart(text string, index int) bool {
	r := []rune(text)
	if index == 0 {
		return true
	}
	if index-1 < 0 || index-1 >= len(r) {
		return false
	}
	return pathDelimiters[r[index-1]]
}

// findUnclosedQuoteStart ports findUnclosedQuoteStart (autocomplete.ts:54-68).
func findUnclosedQuoteStart(text string) int {
	r := []rune(text)
	inQuotes := false
	quoteStart := -1
	for i := 0; i < len(r); i++ {
		if r[i] == '"' {
			inQuotes = !inQuotes
			if inQuotes {
				quoteStart = i
			}
		}
	}
	if inQuotes {
		return quoteStart
	}
	return -1
}

// extractQuotedPrefix ports extractQuotedPrefix (autocomplete.ts:74-92).
func extractQuotedPrefix(text string) string {
	quoteStart := findUnclosedQuoteStart(text)
	if quoteStart < 0 {
		return ""
	}
	r := []rune(text)
	if quoteStart > 0 && r[quoteStart-1] == '@' {
		if !isTokenStart(text, quoteStart-1) {
			return ""
		}
		return string(r[quoteStart-1:])
	}
	if !isTokenStart(text, quoteStart) {
		return ""
	}
	return string(r[quoteStart:])
}

// extractAtPrefix ports extractAtPrefix (autocomplete.ts:447-461).
func (p *CombinedProvider) extractAtPrefix(text string) string {
	if q := extractQuotedPrefix(text); strings.HasPrefix(q, `@"`) {
		return q
	}
	last := findLastDelimiter(text)
	tokenStart := 0
	if last >= 0 {
		tokenStart = last + 1
	}
	r := []rune(text)
	if tokenStart < len(r) && r[tokenStart] == '@' {
		return string(r[tokenStart:])
	}
	return ""
}

// extractPathPrefix ports extractPathPrefix (autocomplete.ts:464-491). The bool
// is false when no path context is present (the classic returns null).
func (p *CombinedProvider) extractPathPrefix(text string, force bool) (string, bool) {
	if q := extractQuotedPrefix(text); q != "" {
		return q, true
	}
	last := findLastDelimiter(text)
	pathPrefix := text
	if last >= 0 {
		pathPrefix = string([]rune(text)[last+1:])
	}
	if force {
		return pathPrefix, true
	}
	if strings.Contains(pathPrefix, "/") || strings.HasPrefix(pathPrefix, ".") || strings.HasPrefix(pathPrefix, "~/") {
		return pathPrefix, true
	}
	if pathPrefix == "" && strings.HasSuffix(text, " ") {
		return pathPrefix, true
	}
	return "", false
}

// parsePathPrefix ports parsePathPrefix (autocomplete.ts:94-105).
func parsePathPrefix(prefix string) (raw string, isAt bool, isQuoted bool) {
	switch {
	case strings.HasPrefix(prefix, `@"`):
		return prefix[2:], true, true
	case strings.HasPrefix(prefix, `"`):
		return prefix[1:], false, true
	case strings.HasPrefix(prefix, "@"):
		return prefix[1:], true, false
	default:
		return prefix, false, false
	}
}

// buildCompletionValue ports buildCompletionValue (autocomplete.ts:107-121).
func buildCompletionValue(path string, isAt, isQuoted bool) string {
	needsQuotes := isQuoted || strings.Contains(path, " ")
	prefix := ""
	if isAt {
		prefix = "@"
	}
	if !needsQuotes {
		return prefix + path
	}
	return prefix + `"` + path + `"`
}

// runeSlice returns text[start:end] on rune boundaries, clamped.
func runeSlice(text string, start, end int) string {
	r := []rune(text)
	if start < 0 {
		start = 0
	}
	if end > len(r) {
		end = len(r)
	}
	if start >= end {
		return ""
	}
	return string(r[start:end])
}

// runeSliceFrom returns text[start:] on rune boundaries, clamped.
func runeSliceFrom(text string, start int) string {
	r := []rune(text)
	if start < 0 {
		start = 0
	}
	if start >= len(r) {
		return ""
	}
	return string(r[start:])
}
