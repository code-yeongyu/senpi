package markdown

import (
	"strconv"
	"strings"
)

// Highlight caps: beyond these, syntax highlighting is skipped so pathological
// large / streaming code blocks stay responsive. Values mirror markdown.ts
// (MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES).
const (
	maxHighlightBytes = 200_000
	maxHighlightLines = 2000
)

// renderCodeBlock renders a fenced code block with triple-backtick borders,
// normalizing any source fence marker to ```. Port of markdown.ts renderCodeBlock.
func (m *Markdown) renderCodeBlock(lines *[]string, code, lang, indent string) {
	*lines = append(*lines, m.theme.CodeBlockBorder("```"+lang))
	if hl := m.highlightCodeBlock(code, lang); hl != nil {
		for _, l := range hl {
			*lines = append(*lines, indent+l)
		}
	} else {
		if m.theme.HighlightCode != nil && exceedsHighlightCap(code) {
			*lines = append(*lines, indent+m.theme.CodeBlock("[syntax highlighting skipped: code block too large]"))
		}
		for _, codeLine := range strings.Split(code, "\n") {
			*lines = append(*lines, indent+m.theme.CodeBlock(codeLine))
		}
	}
	*lines = append(*lines, m.theme.CodeBlockBorder("```"))
}

func (m *Markdown) highlightCodeBlock(code, lang string) []string {
	if m.theme.HighlightCode == nil {
		return nil
	}
	if exceedsHighlightCap(code) {
		return nil
	}
	return m.theme.HighlightCode(code, lang)
}

// exceedsHighlightCap reports whether code is too large to syntax-highlight
// responsively. Port of markdown.ts exceedsHighlightCap.
func exceedsHighlightCap(code string) bool {
	newlineCount := 0
	for i := 0; i < len(code); i++ {
		if code[i] == '\n' {
			newlineCount++
			if newlineCount+1 > maxHighlightLines {
				return true
			}
		}
	}
	return len(code) > maxHighlightBytes
}

// renderList renders a list with nesting. Port of markdown.ts renderList.
func (m *Markdown) renderList(tok *block, depth, width int, sc *inlineStyleContext) []string {
	var lines []string
	indent := strings.Repeat("    ", depth)
	startNumber := tok.start
	if startNumber == 0 {
		startNumber = 1
	}

	for i := range tok.items {
		item := &tok.items[i]
		isLast := i == len(tok.items)-1

		var bullet string
		if tok.ordered {
			if m.options.PreserveOrderedListMarkers && item.srcMarker != "" {
				bullet = item.srcMarker + " "
			} else {
				bullet = strconv.Itoa(startNumber+i) + ". "
			}
		} else {
			if m.options.PreserveOrderedListMarkers {
				srcMarker := item.srcMarker
				if srcMarker == "" && tok.listMarker != 0 {
					// Empty item (e.g. a bare "+" at EOF) has no source text to scan;
					// fall back to the list's marker byte.
					srcMarker = string(tok.listMarker)
				}
				if srcMarker != "" {
					bullet = srcMarker + " "
				} else {
					bullet = "- "
				}
			} else {
				bullet = "- "
			}
		}

		taskMarker := ""
		if item.task {
			if item.checked {
				taskMarker = "[x] "
			} else {
				taskMarker = "[ ] "
			}
		}
		marker := bullet + taskMarker
		firstPrefix := indent + m.theme.ListBullet(marker)
		continuationPrefix := indent + strings.Repeat(" ", visibleWidth(marker))
		itemWidth := width - visibleWidth(firstPrefix)
		if itemWidth < 1 {
			itemWidth = 1
		}
		renderedAny := false

		for j := range item.tokens {
			itemToken := &item.tokens[j]
			if itemToken.typ == tokList {
				lines = append(lines, m.renderList(itemToken, depth+1, width, sc)...)
				renderedAny = true
				continue
			}
			// Task-marked paragraphs already carry the "[ ] " text token from the
			// checkbox; skip re-adding via taskMarker by stripping a duplicate.
			itemLines := m.renderToken(itemToken, itemWidth, -1, sc)
			for _, line := range itemLines {
				for _, wl := range wrapTextWithAnsi(line, itemWidth) {
					var linePrefix string
					if renderedAny {
						linePrefix = continuationPrefix
					} else {
						linePrefix = firstPrefix
					}
					lines = append(lines, linePrefix+wl)
					renderedAny = true
				}
			}
		}

		if !renderedAny {
			lines = append(lines, firstPrefix)
		}

		if tok.loose && !isLast {
			lines = append(lines, "")
		}
	}

	return lines
}
