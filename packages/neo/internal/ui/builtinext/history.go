package builtinext

import (
	"math"
	"path/filepath"
	"sort"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// HistoryEntry is one cross-session prompt-history row. Mirror of
// history-search/types.ts:1-7.
type HistoryEntry struct {
	Text        string
	SessionID   string
	SessionFile string
	CWD         string
	Timestamp   int64 // ms since epoch
}

const (
	maxHistoryEntries = 10_000
	recencyWeight     = 0.01
	dayMS             = 86_400_000.0
)

// ResolveSearchRoot mirrors history-search/index.ts:10-22: when the current
// session dir is empty, equals the default sessions root, or is a descendant of
// it (the cwd-subdir layout), the default root is searched so history spans
// every cwd; a session dir outside the default root is searched in isolation.
func ResolveSearchRoot(currentSessionDir, defaultSessionsRoot string) string {
	defaultRoot := resolveClean(defaultSessionsRoot)
	if currentSessionDir == "" {
		return defaultRoot
	}
	current := resolveClean(currentSessionDir)
	if current == defaultRoot {
		return defaultRoot
	}
	rel, err := filepath.Rel(defaultRoot, current)
	if err == nil && rel != "" && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
		return defaultRoot
	}
	return current
}

// resolveClean mirrors path.resolve for absolute-ish inputs used by the search
// root logic; it cleans separators without touching the process cwd for the
// absolute paths the resolver receives.
func resolveClean(p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return abs
}

// FilterHistory mirrors history-search/filter.ts: empty query returns a copy in
// input order; otherwise fuzzy-matches each entry, adds a small recency weight
// (older entries score slightly worse), and sorts ascending by score with a
// newest-first tiebreak. A LOWER score is a BETTER match (fuzzy.ts semantics).
func FilterHistory(entries []HistoryEntry, query string) []HistoryEntry {
	normalized := strings.TrimSpace(query)
	if normalized == "" {
		out := make([]HistoryEntry, len(entries))
		copy(out, entries)
		return out
	}

	var newest int64
	for _, e := range entries {
		if e.Timestamp > newest {
			newest = e.Timestamp
		}
	}

	type scored struct {
		entry HistoryEntry
		score float64
	}
	var matched []scored
	for _, e := range entries {
		m := ui.FuzzyMatch(normalized, e.Text)
		if !m.Matches {
			continue
		}
		ageDays := math.Max(0, float64(newest-e.Timestamp)) / dayMS
		matched = append(matched, scored{entry: e, score: m.Score + ageDays*recencyWeight})
	}

	sort.SliceStable(matched, func(i, j int) bool {
		if matched[i].score != matched[j].score {
			return matched[i].score < matched[j].score
		}
		return matched[i].entry.Timestamp > matched[j].entry.Timestamp
	})

	out := make([]HistoryEntry, len(matched))
	for i, s := range matched {
		out[i] = s.entry
	}
	return out
}

// The session-file discovery + prompt extraction (IndexSessions and helpers)
// live in history_indexer.go.
