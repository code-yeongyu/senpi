package editor

import (
	"regexp"
	"strconv"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// Paste-marker regexes mirror packages/tui/src/components/editor.ts. A large
// paste is replaced by an atomic marker "[paste #N +K lines]" or "[paste #N K
// chars]" whose numeric id must be a live paste for the marker to be treated as
// a single unit (cursor/delete/word-nav atomicity).
var pasteMarkerGlobalRe = regexp.MustCompile(`\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]`)
var pasteMarkerSingleRe = regexp.MustCompile(`^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$`)

// isPasteMarkerText reports whether s is exactly a paste-marker string.
func isPasteMarkerText(s string) bool {
	return runeLen(s) >= 10 && pasteMarkerSingleRe.MatchString(s)
}

// markerSpan is a rune-indexed marker occurrence.
type markerSpan struct {
	start int
	end   int
}

// findMarkerSpans returns rune-indexed spans of all marker substrings for which
// isValid(marker-text) is true.
func findMarkerSpans(text string, isValid func(string) bool) []markerSpan {
	locs := pasteMarkerGlobalRe.FindAllStringIndex(text, -1)
	if len(locs) == 0 {
		return nil
	}
	var out []markerSpan
	for _, loc := range locs {
		mt := text[loc[0]:loc[1]]
		if isValid != nil && !isValid(mt) {
			continue
		}
		startRune := runeLen(text[:loc[0]])
		endRune := startRune + runeLen(mt)
		out = append(out, markerSpan{start: startRune, end: endRune})
	}
	return out
}

// Segment is a rune-indexed grapheme (or atomic marker) unit used by the
// word-wrap layout. It mirrors Intl.SegmentData: Text plus a rune Index.
type Segment struct {
	Text  string
	Index int
}

// segmentGraphemes splits text into grapheme clusters, merging any marker spans
// whose id is valid into single atomic segments. Mirrors segmentWithMarkers +
// the grapheme segmenter in editor.ts.
func segmentGraphemes(text string, validMarker func(string) bool) []Segment {
	base := textwidth.Graphemes(text)
	if validMarker == nil {
		return graphemesToSegments(base)
	}
	markers := findMarkerSpans(text, validMarker)
	if len(markers) == 0 {
		return graphemesToSegments(base)
	}
	var out []Segment
	mi := 0
	for _, g := range base {
		for mi < len(markers) && markers[mi].end <= g.Index {
			mi++
		}
		var m *markerSpan
		if mi < len(markers) {
			m = &markers[mi]
		}
		if m != nil && g.Index >= m.start && g.Index < m.end {
			if g.Index == m.start {
				out = append(out, Segment{Text: runeSlice(text, m.start, m.end), Index: m.start})
			}
			continue
		}
		out = append(out, Segment{Text: g.Text, Index: g.Index})
	}
	return out
}

func graphemesToSegments(gs []textwidth.Grapheme) []Segment {
	out := make([]Segment, len(gs))
	for i, g := range gs {
		out[i] = Segment{Text: g.Text, Index: g.Index}
	}
	return out
}

// parseMarkerID extracts the numeric id from a marker string, or -1.
func parseMarkerID(marker string) int {
	m := pasteMarkerSingleRe.FindStringSubmatch(marker)
	if m == nil {
		return -1
	}
	id, err := strconv.Atoi(m[1])
	if err != nil {
		return -1
	}
	return id
}
