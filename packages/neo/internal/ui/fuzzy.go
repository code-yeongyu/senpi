package ui

import (
	"sort"
	"strings"
)

// Fuzzy matching, a faithful port of packages/tui/src/fuzzy.ts. Matches when all
// query characters appear in order (not necessarily consecutive); LOWER score is
// a BETTER match. The exact scoring weights (consecutive bonus, gap penalty,
// word-boundary bonus, positional penalty, exact-match bonus, alphanumeric-swap
// penalty) are reproduced verbatim so neo's ranking is byte-for-byte the classic
// TUI's ranking — the select-list and settings-list filters depend on it.

const alphanumericSwapPenalty = 5.0

// FuzzyResult is the outcome of a single fuzzy match.
type FuzzyResult struct {
	Matches bool
	Score   float64
}

func isASCIILetter(c byte) bool { return c >= 'a' && c <= 'z' }
func isASCIIDigit(c byte) bool  { return c >= '0' && c <= '9' }

// isWordBoundaryPrefix mirrors fuzzy.ts isWordBoundaryPrefix.
func isWordBoundaryPrefix(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '-', '_', '.', '/', ':':
		return true
	default:
		return false
	}
}

// scoreMatch mirrors fuzzy.ts scoreMatch. Both inputs are already lowercased.
// It operates on runes so multi-byte characters are treated as single units,
// matching JS string iteration for the ASCII-dominant queries this handles.
func scoreMatch(queryLower, textLower string) FuzzyResult {
	q := []rune(queryLower)
	tx := []rune(textLower)

	if len(q) == 0 {
		return FuzzyResult{Matches: true, Score: 0}
	}
	if len(q) > len(tx) {
		return FuzzyResult{Matches: false, Score: 0}
	}

	queryIndex := 0
	score := 0.0
	lastMatchIndex := -1
	consecutiveMatches := 0

	for i := 0; i < len(tx) && queryIndex < len(q); i++ {
		if tx[i] != q[queryIndex] {
			continue
		}
		isWordBoundary := i == 0 || isWordBoundaryPrefix(byteOf(tx[i-1]))

		// Reward consecutive matches.
		if lastMatchIndex == i-1 {
			consecutiveMatches++
			score -= float64(consecutiveMatches) * 5
		} else {
			consecutiveMatches = 0
			if lastMatchIndex >= 0 {
				score += float64(i-lastMatchIndex-1) * 2
			}
		}

		if isWordBoundary {
			score -= 10
		}

		// Slight penalty for later matches.
		score += float64(i) * 0.1

		lastMatchIndex = i
		queryIndex++
	}

	if queryIndex < len(q) {
		return FuzzyResult{Matches: false, Score: 0}
	}

	if queryLower == textLower {
		score -= 100
	}

	return FuzzyResult{Matches: true, Score: score}
}

// byteOf returns the low byte of a rune for the ASCII boundary check (fuzzy.ts
// compares char codes; only ASCII boundary chars matter here).
func byteOf(r rune) byte {
	if r < 256 {
		return byte(r)
	}
	return 0
}

// addWholeTokenSwap mirrors fuzzy.ts addWholeTokenSwap.
func addWholeTokenSwap(variants map[string]struct{}, queryLower string) {
	q := queryLower
	// letters-then-digits → digits+letters
	splitIndex := 0
	for splitIndex < len(q) && isASCIILetter(q[splitIndex]) {
		splitIndex++
	}
	if splitIndex > 0 && splitIndex < len(q) {
		digitEnd := splitIndex
		for digitEnd < len(q) && isASCIIDigit(q[digitEnd]) {
			digitEnd++
		}
		if digitEnd == len(q) {
			variants[q[splitIndex:]+q[:splitIndex]] = struct{}{}
		}
	}

	// digits-then-letters → letters+digits
	splitIndex = 0
	for splitIndex < len(q) && isASCIIDigit(q[splitIndex]) {
		splitIndex++
	}
	if splitIndex > 0 && splitIndex < len(q) {
		letterEnd := splitIndex
		for letterEnd < len(q) && isASCIILetter(q[letterEnd]) {
			letterEnd++
		}
		if letterEnd == len(q) {
			variants[q[splitIndex:]+q[:splitIndex]] = struct{}{}
		}
	}
}

// buildAlphanumericSwapQueries mirrors fuzzy.ts buildAlphanumericSwapQueries.
func buildAlphanumericSwapQueries(queryLower string) []string {
	variants := map[string]struct{}{}
	addWholeTokenSwap(variants, queryLower)

	for i := 0; i+1 < len(queryLower); i++ {
		cur := queryLower[i]
		next := queryLower[i+1]
		isSwap := (isASCIILetter(cur) && isASCIIDigit(next)) || (isASCIIDigit(cur) && isASCIILetter(next))
		if !isSwap {
			continue
		}
		variants[queryLower[:i]+string(next)+string(cur)+queryLower[i+2:]] = struct{}{}
	}

	out := make([]string, 0, len(variants))
	for v := range variants {
		out = append(out, v)
	}
	return out
}

// FuzzyMatch scores query against text. Mirrors fuzzy.ts fuzzyMatch: a direct
// match wins; otherwise the best alphanumeric-swap variant (plus a fixed swap
// penalty) is returned; else the direct (non-matching) result.
func FuzzyMatch(query, text string) FuzzyResult {
	queryLower := strings.ToLower(query)
	textLower := strings.ToLower(text)

	direct := scoreMatch(queryLower, textLower)
	if direct.Matches {
		return direct
	}

	var bestSwap *FuzzyResult
	for _, variant := range buildAlphanumericSwapQueries(queryLower) {
		match := scoreMatch(variant, textLower)
		if !match.Matches {
			continue
		}
		score := match.Score + alphanumericSwapPenalty
		if bestSwap == nil || score < bestSwap.Score {
			bestSwap = &FuzzyResult{Matches: true, Score: score}
		}
	}
	if bestSwap != nil {
		return *bestSwap
	}
	return direct
}

// FuzzyFilter filters and sorts items by fuzzy match quality (best first).
// Whitespace- and slash-separated tokens must ALL match. Mirrors fuzzy.ts
// fuzzyFilter, including its stable sort by ascending total score.
func FuzzyFilter[T any](items []T, query string, getText func(T) string) []T {
	if strings.TrimSpace(query) == "" {
		return items
	}
	tokens := splitTokens(query)
	if len(tokens) == 0 {
		return items
	}

	type scored struct {
		item  T
		total float64
		order int
	}
	results := make([]scored, 0, len(items))
	for idx, item := range items {
		text := getText(item)
		total := 0.0
		allMatch := true
		for _, token := range tokens {
			m := FuzzyMatch(token, text)
			if m.Matches {
				total += m.Score
			} else {
				allMatch = false
				break
			}
		}
		if allMatch {
			results = append(results, scored{item: item, total: total, order: idx})
		}
	}

	// Stable ascending sort by total score (Array.prototype.sort in the TS is a
	// stable sort in modern V8; preserve input order for equal scores).
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].total != results[j].total {
			return results[i].total < results[j].total
		}
		return results[i].order < results[j].order
	})

	out := make([]T, len(results))
	for i, r := range results {
		out[i] = r.item
	}
	return out
}

// splitTokens splits on whitespace and slashes, dropping empties (fuzzy.ts:
// query.trim().split(/[\s/]+/)).
func splitTokens(query string) []string {
	fields := strings.FieldsFunc(strings.TrimSpace(query), func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '/'
	})
	return fields
}
