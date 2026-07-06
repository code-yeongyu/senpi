package transcript

import (
	"regexp"
	"strings"
)

// DiffStyles carries the style functions applied to diff spans. Removed/Added/
// Context style whole lines; Inverse highlights the changed token within a
// single-line modification. Mirrors the theme.fg tokens used by diff.ts.
type DiffStyles struct {
	Removed StyleFunc
	Added   StyleFunc
	Context StyleFunc
	Inverse StyleFunc
}

var diffLineRe = regexp.MustCompile(`^([+\-\s])(\s*\d*)\s(.*)$`)

type parsedDiffLine struct {
	prefix  string
	lineNum string
	content string
}

func parseDiffLine(line string) (parsedDiffLine, bool) {
	m := diffLineRe.FindStringSubmatch(line)
	if m == nil {
		return parsedDiffLine{}, false
	}
	return parsedDiffLine{prefix: m[1], lineNum: m[2], content: m[3]}, true
}

func replaceTabs(text string) string {
	return strings.ReplaceAll(text, "\t", "   ")
}

type intraLineDiff struct {
	removedLine string
	addedLine   string
}

// RenderDiff renders a diff string with per-line coloring and intra-line change
// highlighting. Context lines are dimmed; removed lines are red with inverse on
// changed tokens; added lines are green with inverse on changed tokens. Faithful
// port of diff.ts renderDiff.
func RenderDiff(diffText string, styles DiffStyles) string {
	lines := strings.Split(diffText, "\n")
	var result []string

	i := 0
	for i < len(lines) {
		parsed, ok := parseDiffLine(lines[i])
		if !ok {
			result = append(result, styles.Context(lines[i]))
			i++
			continue
		}

		switch parsed.prefix {
		case "-":
			var removedLines []parsedDiffLine
			for i < len(lines) {
				p, ok := parseDiffLine(lines[i])
				if !ok || p.prefix != "-" {
					break
				}
				removedLines = append(removedLines, p)
				i++
			}
			var addedLines []parsedDiffLine
			for i < len(lines) {
				p, ok := parseDiffLine(lines[i])
				if !ok || p.prefix != "+" {
					break
				}
				addedLines = append(addedLines, p)
				i++
			}

			if len(removedLines) == 1 && len(addedLines) == 1 {
				removed := removedLines[0]
				added := addedLines[0]
				intra := renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content), styles)
				result = append(result, styles.Removed("-"+removed.lineNum+" "+intra.removedLine))
				result = append(result, styles.Added("+"+added.lineNum+" "+intra.addedLine))
			} else {
				for _, removed := range removedLines {
					result = append(result, styles.Removed("-"+removed.lineNum+" "+replaceTabs(removed.content)))
				}
				for _, added := range addedLines {
					result = append(result, styles.Added("+"+added.lineNum+" "+replaceTabs(added.content)))
				}
			}
		case "+":
			result = append(result, styles.Added("+"+parsed.lineNum+" "+replaceTabs(parsed.content)))
			i++
		default:
			result = append(result, styles.Context(" "+parsed.lineNum+" "+replaceTabs(parsed.content)))
			i++
		}
	}
	return strings.Join(result, "\n")
}

// renderIntraLineDiff highlights the changed span within a single-line edit.
// Port of diff.ts renderIntraLineDiff: try the single-span fast path first, then
// fall back to a word-level diff.
func renderIntraLineDiff(oldContent, newContent string, styles DiffStyles) intraLineDiff {
	if d, ok := renderIntraLineDiffFastPath(oldContent, newContent, styles); ok {
		return d
	}
	return renderIntraLineDiffWithWords(oldContent, newContent, styles)
}

func renderIntraLineDiffFastPath(oldContent, newContent string, styles DiffStyles) (intraLineDiff, bool) {
	if oldContent == newContent {
		return intraLineDiff{removedLine: oldContent, addedLine: newContent}, true
	}
	span, ok := findSingleDiffWordsReplacement(oldContent, newContent)
	if !ok {
		return intraLineDiff{}, false
	}
	return intraLineDiff{
		removedLine: span.prefix + styles.Inverse(span.removed) + span.suffix,
		addedLine:   span.prefix + styles.Inverse(span.added) + span.suffix,
	}, true
}

type replacementSpan struct {
	prefix  string
	removed string
	added   string
	suffix  string
}

func findSingleDiffWordsReplacement(oldContent, newContent string) (replacementSpan, bool) {
	start := 0
	for start < len(oldContent) && start < len(newContent) && oldContent[start] == newContent[start] {
		start++
	}
	oldEnd := len(oldContent)
	newEnd := len(newContent)
	for oldEnd > start && newEnd > start && oldContent[oldEnd-1] == newContent[newEnd-1] {
		oldEnd--
		newEnd--
	}
	for start > 0 && (isASCIIWordCode(oldContent[start-1]) || isASCIIWordCode(newContent[start-1])) {
		start--
	}
	for oldEnd < len(oldContent) && newEnd < len(newContent) &&
		(isASCIIWordCode(oldContent[oldEnd]) || isASCIIWordCode(newContent[newEnd])) {
		oldEnd++
		newEnd++
	}
	prefix := oldContent[:start]
	removed := oldContent[start:oldEnd]
	added := newContent[start:newEnd]
	oldSuffix := oldContent[oldEnd:]
	newSuffix := newContent[newEnd:]
	if oldSuffix != newSuffix {
		return replacementSpan{}, false
	}
	if !isSingleDiffWordsReplacement(removed, added) {
		return replacementSpan{}, false
	}
	return replacementSpan{prefix: prefix, removed: removed, added: added, suffix: oldSuffix}, true
}

func isSingleDiffWordsReplacement(removed, added string) bool {
	return len(removed) > 0 && len(added) > 0 && isSimpleDiffToken(removed) && isSimpleDiffToken(added)
}

func isSimpleDiffToken(value string) bool {
	for i := 0; i < len(value); i++ {
		if !isASCIIWordCode(value[i]) {
			return false
		}
	}
	return true
}

func isASCIIWordCode(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || c == '_' || (c >= 'a' && c <= 'z')
}

// renderIntraLineDiffWithWords is the word-level fallback: split on word
// boundaries and inverse-highlight the differing runs. A simplified port of the
// diffWords path (grouping whitespace with adjacent words) sufficient for the
// multi-token edits the fast path rejects.
func renderIntraLineDiffWithWords(oldContent, newContent string, styles DiffStyles) intraLineDiff {
	oldTokens := splitWords(oldContent)
	newTokens := splitWords(newContent)
	changes := diffTokens(oldTokens, newTokens)

	var removedLine, addedLine strings.Builder
	firstRemoved, firstAdded := true, true
	for _, ch := range changes {
		switch ch.kind {
		case tokRemoved:
			value := ch.value
			if firstRemoved {
				lead := leadingWhitespace(value)
				value = value[len(lead):]
				removedLine.WriteString(lead)
				firstRemoved = false
			}
			if value != "" {
				removedLine.WriteString(styles.Inverse(value))
			}
		case tokAdded:
			value := ch.value
			if firstAdded {
				lead := leadingWhitespace(value)
				value = value[len(lead):]
				addedLine.WriteString(lead)
				firstAdded = false
			}
			if value != "" {
				addedLine.WriteString(styles.Inverse(value))
			}
		default:
			removedLine.WriteString(ch.value)
			addedLine.WriteString(ch.value)
		}
	}
	return intraLineDiff{removedLine: removedLine.String(), addedLine: addedLine.String()}
}

func leadingWhitespace(s string) string {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return s[:i]
}

var wordSplitRe = regexp.MustCompile(`\s+|\S+`)

func splitWords(s string) []string {
	return wordSplitRe.FindAllString(s, -1)
}

type tokKind int

const (
	tokEqual tokKind = iota
	tokRemoved
	tokAdded
)

type tokChange struct {
	kind  tokKind
	value string
}

// diffTokens is a minimal LCS-based token diff producing equal/removed/added
// runs in old-then-new order for changed regions.
func diffTokens(oldTokens, newTokens []string) []tokChange {
	m, n := len(oldTokens), len(newTokens)
	lcs := make([][]int, m+1)
	for i := range lcs {
		lcs[i] = make([]int, n+1)
	}
	for i := m - 1; i >= 0; i-- {
		for j := n - 1; j >= 0; j-- {
			if oldTokens[i] == newTokens[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var out []tokChange
	i, j := 0, 0
	for i < m && j < n {
		if oldTokens[i] == newTokens[j] {
			out = append(out, tokChange{tokEqual, oldTokens[i]})
			i++
			j++
		} else if lcs[i+1][j] >= lcs[i][j+1] {
			out = append(out, tokChange{tokRemoved, oldTokens[i]})
			i++
		} else {
			out = append(out, tokChange{tokAdded, newTokens[j]})
			j++
		}
	}
	for ; i < m; i++ {
		out = append(out, tokChange{tokRemoved, oldTokens[i]})
	}
	for ; j < n; j++ {
		out = append(out, tokChange{tokAdded, newTokens[j]})
	}
	return out
}
