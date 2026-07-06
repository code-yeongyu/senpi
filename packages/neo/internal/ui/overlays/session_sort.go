package overlays

import (
	"regexp"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// session_sort.go ports
// packages/coding-agent/src/modes/interactive/components/session-selector-search.ts
// (filterAndSortSessions + query parsing) so the session picker's Modified-sort,
// relevance ranking, name filter, and regex/phrase/fuzzy query modes match the
// classic TUI exactly. The Modified field it sorts on is computed by the store
// scanner, whose activity-time fallback now decodes the entry-level timestamp
// (the wave-0 gate-23 carry-forward fix) — TestModifiedSortUsesEntryTimestamp
// proves the picker sort consumes it.

// SortByModifiedDesc returns the sessions ordered by SessionInfo.Modified
// descending (most-recently-active first) — the picker's default "recent" scope
// ordering when no search query is active. Modified is the store's last-activity
// time, which decodes the entry-level timestamp as the fallback
// (getMessageActivityTime, session-manager.ts:664), so this ranking is correct
// even for sessions whose messages omit a numeric message.timestamp. The sort is
// stable so equal-Modified sessions keep their input order.
func SortByModifiedDesc(sessions []store.SessionInfo) []store.SessionInfo {
	out := make([]store.SessionInfo, len(sessions))
	copy(out, sessions)
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Modified.After(out[j].Modified)
	})
	return out
}

// SortMode mirrors the TS SortMode union.
type SortMode string

const (
	SortThreaded  SortMode = "threaded"
	SortRecent    SortMode = "recent"
	SortRelevance SortMode = "relevance"
)

// NameFilter mirrors the TS NameFilter union.
type NameFilter string

const (
	NameFilterAll   NameFilter = "all"
	NameFilterNamed NameFilter = "named"
)

// SessionSearchText is the searchable text for a session, mirroring
// getSessionSearchText: "id name allMessagesText cwd". allMessagesText is passed
// separately because the store's SessionInfo keeps only firstMessage; the picker
// supplies the joined text when available.
func SessionSearchText(s store.SessionInfo, allMessagesText string) string {
	return s.ID + " " + s.Name + " " + allMessagesText + " " + s.CWD
}

// HasSessionName mirrors hasSessionName: a non-blank trimmed name.
func HasSessionName(s store.SessionInfo) bool {
	return strings.TrimSpace(s.Name) != ""
}

type parsedToken struct {
	kind  string // "fuzzy" | "phrase"
	value string
}

type parsedQuery struct {
	mode   string // "tokens" | "regex"
	tokens []parsedToken
	regex  *regexp.Regexp
	err    bool
}

var wsRun = regexp.MustCompile(`\s+`)

func normalizeWhitespaceLower(text string) string {
	return strings.TrimSpace(wsRun.ReplaceAllString(strings.ToLower(text), " "))
}

func matchesNameFilter(s store.SessionInfo, filter NameFilter) bool {
	if filter == NameFilterAll {
		return true
	}
	return HasSessionName(s)
}

// parseSearchQuery mirrors parseSearchQuery: re:<pattern> regex mode, quoted
// phrases, whitespace-tokenized fuzzy terms, with the unclosed-quote fallback.
func parseSearchQuery(query string) parsedQuery {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return parsedQuery{mode: "tokens"}
	}

	if strings.HasPrefix(trimmed, "re:") {
		pattern := strings.TrimSpace(trimmed[3:])
		if pattern == "" {
			return parsedQuery{mode: "regex", err: true}
		}
		// (?i) case-insensitive, mirroring new RegExp(pattern, "i").
		re, err := regexp.Compile("(?i)" + pattern)
		if err != nil {
			return parsedQuery{mode: "regex", err: true}
		}
		return parsedQuery{mode: "regex", regex: re}
	}

	var tokens []parsedToken
	var buf strings.Builder
	inQuote := false
	hadUnclosedQuote := false
	flush := func(kind string) {
		v := strings.TrimSpace(buf.String())
		buf.Reset()
		if v == "" {
			return
		}
		tokens = append(tokens, parsedToken{kind: kind, value: v})
	}
	for _, ch := range trimmed {
		if ch == '"' {
			if inQuote {
				flush("phrase")
				inQuote = false
			} else {
				flush("fuzzy")
				inQuote = true
			}
			continue
		}
		if !inQuote && (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
			flush("fuzzy")
			continue
		}
		buf.WriteRune(ch)
	}
	if inQuote {
		hadUnclosedQuote = true
	}
	if hadUnclosedQuote {
		var fb []parsedToken
		for _, t := range wsRun.Split(strings.TrimSpace(trimmed), -1) {
			t = strings.TrimSpace(t)
			if t != "" {
				fb = append(fb, parsedToken{kind: "fuzzy", value: t})
			}
		}
		return parsedQuery{mode: "tokens", tokens: fb}
	}
	if inQuote {
		flush("phrase")
	} else {
		flush("fuzzy")
	}
	return parsedQuery{mode: "tokens", tokens: tokens}
}

type matchResult struct {
	matches bool
	score   float64
}

// matchSession mirrors matchSession: regex index-based score, or the sum of
// per-token fuzzy/phrase scores.
func matchSession(text string, parsed parsedQuery) matchResult {
	if parsed.mode == "regex" {
		if parsed.regex == nil {
			return matchResult{}
		}
		loc := parsed.regex.FindStringIndex(text)
		if loc == nil {
			return matchResult{}
		}
		return matchResult{matches: true, score: float64(loc[0]) * 0.1}
	}
	if len(parsed.tokens) == 0 {
		return matchResult{matches: true, score: 0}
	}
	total := 0.0
	var normalizedText string
	haveNorm := false
	for _, token := range parsed.tokens {
		if token.kind == "phrase" {
			if !haveNorm {
				normalizedText = normalizeWhitespaceLower(text)
				haveNorm = true
			}
			phrase := normalizeWhitespaceLower(token.value)
			if phrase == "" {
				continue
			}
			idx := strings.Index(normalizedText, phrase)
			if idx < 0 {
				return matchResult{}
			}
			total += float64(idx) * 0.1
			continue
		}
		m := ui.FuzzyMatch(token.value, text)
		if !m.Matches {
			return matchResult{}
		}
		total += m.Score
	}
	return matchResult{matches: true, score: total}
}

// SessionText pairs a session with its full searchable message text (the picker
// supplies allMessagesText; the store keeps only firstMessage).
type SessionText struct {
	Info            store.SessionInfo
	AllMessagesText string
}

// FilterAndSortSessions ports filterAndSortSessions. It applies the name filter,
// then (for a non-empty query) the parsed query, then sorts per mode: recent
// keeps input order, relevance sorts by ascending score tie-broken by Modified
// descending. An invalid regex yields an empty result.
func FilterAndSortSessions(sessions []SessionText, query string, sortMode SortMode, nameFilter NameFilter) []SessionText {
	nameFiltered := sessions
	if nameFilter != NameFilterAll {
		nameFiltered = nil
		for _, s := range sessions {
			if matchesNameFilter(s.Info, nameFilter) {
				nameFiltered = append(nameFiltered, s)
			}
		}
	}
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return nameFiltered
	}
	parsed := parseSearchQuery(query)
	if parsed.err {
		return []SessionText{}
	}

	if sortMode == SortRecent {
		var filtered []SessionText
		for _, s := range nameFiltered {
			if matchSession(SessionSearchText(s.Info, s.AllMessagesText), parsed).matches {
				filtered = append(filtered, s)
			}
		}
		return filtered
	}

	type scored struct {
		s     SessionText
		score float64
		order int
	}
	var scoredList []scored
	for i, s := range nameFiltered {
		res := matchSession(SessionSearchText(s.Info, s.AllMessagesText), parsed)
		if !res.matches {
			continue
		}
		scoredList = append(scoredList, scored{s: s, score: res.score, order: i})
	}
	sort.SliceStable(scoredList, func(i, j int) bool {
		if scoredList[i].score != scoredList[j].score {
			return scoredList[i].score < scoredList[j].score
		}
		// tie-break: modified desc.
		return scoredList[i].s.Info.Modified.After(scoredList[j].s.Info.Modified)
	})
	out := make([]SessionText, len(scoredList))
	for i, r := range scoredList {
		out[i] = r.s
	}
	return out
}
