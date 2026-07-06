package editor

import (
	"unicode"

	"github.com/rivo/uniseg"
)

// wordSegment is one UAX-29 word segment with its rune-start index and whether
// it is "word-like" (letters/digits/marks — Intl.Segmenter's isWordLike).
type wordSegment struct {
	text   string
	index  int
	isWord bool
}

// isCJK reports whether r is a CJK/Kana/Hangul/Bopomofo character. Mirrors
// cjkBreakRegex in packages/tui/src/utils.ts. Intl.Segmenter groups consecutive
// CJK runes into one word segment, so word navigation treats a Han run as a
// single unit; uniseg splits per rune, so we re-merge to match.
func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r) ||
		unicode.Is(unicode.Bopomofo, r)
}

// isWordLikeSegment reports whether a segment is Intl-word-like: it contains at
// least one letter or number and is not pure punctuation/whitespace.
func isWordLikeSegment(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return true
		}
	}
	return false
}

// segmentWords splits text into UAX-29 word segments (rune-indexed), merging
// consecutive single-CJK-rune segments into one to match Intl.Segmenter's word
// granularity. The atomic predicate keeps marker spans (e.g. paste markers) as
// single non-word segments.
func segmentWords(text string, isAtomic func(string) bool) []wordSegment {
	// First, split into atomic vs non-atomic spans so markers stay whole.
	var segs []wordSegment
	rawSpans := splitAtomic(text, isAtomic)
	for _, span := range rawSpans {
		if span.atomic {
			segs = append(segs, wordSegment{text: span.text, index: span.index, isWord: false})
			continue
		}
		segs = append(segs, uax29Words(span.text, span.index)...)
	}
	return mergeCJK(segs)
}

type atomicSpan struct {
	text   string
	index  int
	atomic bool
}

// splitAtomic partitions text into atomic (marker) spans and plain spans using a
// forward scan; atomic spans are matched greedily from each position.
func splitAtomic(text string, isAtomic func(string) bool) []atomicSpan {
	if isAtomic == nil {
		return []atomicSpan{{text: text, index: 0, atomic: false}}
	}
	markers := findMarkerSpans(text, isAtomic)
	if len(markers) == 0 {
		return []atomicSpan{{text: text, index: 0, atomic: false}}
	}
	runes := []rune(text)
	var out []atomicSpan
	pos := 0
	for _, m := range markers {
		if m.start > pos {
			out = append(out, atomicSpan{text: string(runes[pos:m.start]), index: pos, atomic: false})
		}
		out = append(out, atomicSpan{text: string(runes[m.start:m.end]), index: m.start, atomic: true})
		pos = m.end
	}
	if pos < len(runes) {
		out = append(out, atomicSpan{text: string(runes[pos:]), index: pos, atomic: false})
	}
	return out
}

// uax29Words splits plain text into UAX-29 word segments, offsetting each rune
// index by base.
func uax29Words(text string, base int) []wordSegment {
	var out []wordSegment
	idx := base
	rest := text
	state := -1
	var w string
	for len(rest) > 0 {
		w, rest, state = uniseg.FirstWordInString(rest, state)
		out = append(out, wordSegment{text: w, index: idx, isWord: isWordLikeSegment(w)})
		idx += len([]rune(w))
	}
	return out
}

// mergeCJK merges runs of consecutive single-rune CJK word segments into one.
func mergeCJK(segs []wordSegment) []wordSegment {
	var out []wordSegment
	for _, s := range segs {
		if len(out) > 0 && isSingleCJK(s.text) && isCJKRun(out[len(out)-1].text) {
			prev := &out[len(out)-1]
			prev.text += s.text
			prev.isWord = true
			continue
		}
		out = append(out, s)
	}
	return out
}

func isSingleCJK(s string) bool {
	r := []rune(s)
	return len(r) == 1 && isCJK(r[0])
}

func isCJKRun(s string) bool {
	for _, r := range s {
		if !isCJK(r) {
			return false
		}
	}
	return len(s) > 0
}
