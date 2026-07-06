package editor

import (
	"regexp"
	"strconv"
	"strings"
)

// insertLineAt inserts value at index i in lines and returns the new slice.
func insertLineAt(lines []string, i int, value string) []string {
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:i]...)
	out = append(out, value)
	out = append(out, lines[i:]...)
	return out
}

// removeLineAt removes the line at index i.
func removeLineAt(lines []string, i int) []string {
	out := make([]string, 0, len(lines)-1)
	out = append(out, lines[:i]...)
	out = append(out, lines[i+1:]...)
	return out
}

// spliceLines replaces `count` lines starting at start with a single value.
func spliceLines(lines []string, start, count int, value string) []string {
	out := make([]string, 0, len(lines)-count+1)
	out = append(out, lines[:start]...)
	out = append(out, value)
	out = append(out, lines[start+count:]...)
	return out
}

// splitLines splits on "\n" (never returns an empty slice for "").
func splitLines(s string) []string { return strings.Split(s, "\n") }

func itoa(n int) string { return strconv.Itoa(n) }

// markerRegexForID builds a regex matching the paste-marker for a given id.
func markerRegexForID(id int) *regexp.Regexp {
	return regexp.MustCompile(`\[paste #` + strconv.Itoa(id) + `( (\+\d+ lines|\d+ chars))?\]`)
}

// replaceLiteral escapes "$" in replacement content so regexp.ReplaceAllString
// treats it literally (Go uses $1 etc. for group refs).
func replaceLiteral(s string) string {
	return strings.ReplaceAll(s, "$", "$$")
}
