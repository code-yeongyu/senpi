// allow: SIZE_OK - the goldmark-AST → pi-token walker is one cohesive unit;
// each block/inline case mirrors a marked token shape the renderer depends on.
package markdown

import (
	"regexp"
	"strings"

	gast "github.com/yuin/goldmark/ast"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
)

// walkBlocks converts a goldmark document's top-level children into pi-shaped
// block tokens. src is the original source (for raw/segment extraction).
func walkBlocks(doc gast.Node, src []byte, opts Options) []block {
	var out []block
	for c := doc.FirstChild(); c != nil; c = c.NextSibling() {
		if b, ok := convertBlock(c, src, opts); ok {
			out = append(out, b)
		}
	}
	return out
}

// insertSpaceTokens inserts a tokSpace before every top-level block (except the
// first) that goldmark marked as preceded by a blank line, matching marked's
// `space` tokens. blocks must be in the same order as doc's top-level children.
func insertSpaceTokens(doc gast.Node, blocks []block) []block {
	// Collect blankPrev flags for each top-level child, skipping nodes we dropped.
	var flags []bool
	for c := doc.FirstChild(); c != nil; c = c.NextSibling() {
		if !isConvertibleBlock(c) {
			continue
		}
		blank := false
		if bb, ok := c.(interface{ HasBlankPreviousLines() bool }); ok {
			blank = bb.HasBlankPreviousLines()
		}
		flags = append(flags, blank)
	}
	if len(flags) != len(blocks) {
		// Defensive: if counts diverge, skip space synthesis (spacing falls back
		// to the renderer's nextToken heuristic).
		return blocks
	}
	var out []block
	for i, b := range blocks {
		if i > 0 && flags[i] {
			out = append(out, block{typ: tokSpace})
		}
		out = append(out, b)
	}
	return out
}

func isConvertibleBlock(n gast.Node) bool {
	switch n.Kind() {
	case gast.KindHeading, gast.KindParagraph, gast.KindTextBlock,
		gast.KindFencedCodeBlock, gast.KindCodeBlock, gast.KindList,
		gast.KindBlockquote, gast.KindThematicBreak, gast.KindHTMLBlock,
		extast.KindTable:
		return true
	}
	return false
}

func convertBlock(n gast.Node, src []byte, opts Options) (block, bool) {
	switch node := n.(type) {
	case *gast.Heading:
		return block{
			typ:    tokHeading,
			depth:  node.Level,
			inline: collectInline(node, src, opts),
		}, true

	case *gast.Paragraph:
		return block{typ: tokParagraph, inline: collectInline(node, src, opts)}, true

	case *gast.TextBlock:
		// A TextBlock is paragraph-like content inside list items / loose lists.
		return block{typ: tokParagraph, inline: collectInline(node, src, opts)}, true

	case *gast.FencedCodeBlock:
		// goldmark's Lines() append a trailing newline after the last content
		// line; marked's token.text has no trailing newline. Strip exactly one so
		// partial-fence trimming (which slices from the end) matches pi.
		codeText := linesText(node.Lines(), src)
		codeText = strings.TrimSuffix(codeText, "\n")
		return block{
			typ:      tokCode,
			codeText: codeText,
			codeLang: string(node.Language(src)),
			raw:      fencedRaw(node, src),
		}, true

	case *gast.CodeBlock:
		return block{
			typ:      tokCode,
			codeText: strings.TrimRight(linesText(node.Lines(), src), "\n"),
			raw:      linesText(node.Lines(), src),
		}, true

	case *gast.List:
		return convertList(node, src, opts), true

	case *gast.Blockquote:
		var children []block
		for c := node.FirstChild(); c != nil; c = c.NextSibling() {
			if b, ok := convertBlock(c, src, opts); ok {
				children = append(children, b)
			}
		}
		children = insertSpaceTokensForChildren(node, children, src, opts)
		return block{typ: tokBlockquote, children: children}, true

	case *gast.ThematicBreak:
		return block{typ: tokHR}, true

	case *gast.HTMLBlock:
		return block{typ: tokHTML, raw: strings.TrimRight(htmlBlockText(node, src), "\n")}, true

	case *extast.Table:
		return convertTable(node, src, opts), true
	}
	return block{}, false
}

// insertSpaceTokensForChildren applies the same blank-line space synthesis to a
// parent's block children (used for blockquotes so inner spacing matches).
func insertSpaceTokensForChildren(parent gast.Node, blocks []block, src []byte, opts Options) []block {
	var flags []bool
	for c := parent.FirstChild(); c != nil; c = c.NextSibling() {
		if !isConvertibleBlock(c) {
			continue
		}
		blank := false
		if bb, ok := c.(interface{ HasBlankPreviousLines() bool }); ok {
			blank = bb.HasBlankPreviousLines()
		}
		flags = append(flags, blank)
	}
	if len(flags) != len(blocks) {
		return blocks
	}
	var out []block
	for i, b := range blocks {
		if i > 0 && flags[i] {
			out = append(out, block{typ: tokSpace})
		}
		out = append(out, b)
	}
	return out
}

var (
	orderedMarkerRe   = regexp.MustCompile(`^(?: {0,3})(\d{1,9}[.)])[ \t]+`)
	unorderedMarkerRe = regexp.MustCompile(`^(?: {0,3})([-+*])(?:[ \t]+|$|\r?\n)`)
)

func convertList(node *gast.List, src []byte, opts Options) block {
	b := block{
		typ:        tokList,
		ordered:    node.IsOrdered(),
		start:      node.Start,
		loose:      !node.IsTight,
		listMarker: node.Marker,
	}
	if !node.IsOrdered() {
		b.start = 1
	}
	for item := node.FirstChild(); item != nil; item = item.NextSibling() {
		li, ok := item.(*gast.ListItem)
		if !ok {
			continue
		}
		it := listItem{}
		it.srcMarker = itemSourceMarker(li, src, node.IsOrdered())
		for c := li.FirstChild(); c != nil; c = c.NextSibling() {
			// Detect task checkbox inside the first text block.
			if tb, ok := c.(*gast.TextBlock); ok {
				if cb := findTaskCheckbox(tb); cb != nil {
					it.task = true
					it.checked = cb.IsChecked
				}
			}
			if para, ok := c.(*gast.Paragraph); ok {
				if cb := findTaskCheckbox(para); cb != nil {
					it.task = true
					it.checked = cb.IsChecked
				}
			}
			if cb, ok := convertBlock(c, src, opts); ok {
				it.tokens = append(it.tokens, cb)
			}
		}
		it.tokens = insertSpaceTokensForChildren(li, it.tokens, src, opts)
		b.items = append(b.items, it)
	}
	return b
}

func findTaskCheckbox(n gast.Node) *extast.TaskCheckBox {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		if cb, ok := c.(*extast.TaskCheckBox); ok {
			return cb
		}
	}
	return nil
}

// itemSourceMarker extracts the item's exact source marker (e.g. "4.", "10)",
// "-") using the item's first source line.
func itemSourceMarker(li *gast.ListItem, src []byte, ordered bool) string {
	line := firstSourceLine(li, src)
	if ordered {
		if m := orderedMarkerRe.FindStringSubmatch(line); m != nil {
			return m[1]
		}
	} else {
		if m := unorderedMarkerRe.FindStringSubmatch(line); m != nil {
			return m[1]
		}
	}
	return ""
}

func firstSourceLine(n gast.Node, src []byte) string {
	// Walk to the first descendant with Lines and read its first segment's line,
	// then back up to the line start in src.
	seg, ok := firstSegment(n)
	if !ok {
		return ""
	}
	start := seg.Start
	// back up to the beginning of the physical line
	ls := start
	for ls > 0 && src[ls-1] != '\n' {
		ls--
	}
	le := start
	for le < len(src) && src[le] != '\n' {
		le++
	}
	return string(src[ls:le])
}

func firstSegment(n gast.Node) (text.Segment, bool) {
	// Inline Text nodes carry their own source segment; block nodes carry Lines.
	// Calling Lines() on an inline node panics, so dispatch on node Type.
	if t, ok := n.(*gast.Text); ok {
		return t.Segment, true
	}
	if n.Type() == gast.TypeBlock {
		if lb, ok := n.(interface{ Lines() *text.Segments }); ok {
			if segs := lb.Lines(); segs != nil && segs.Len() > 0 {
				return segs.At(0), true
			}
		}
	}
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		if seg, ok := firstSegment(c); ok {
			return seg, true
		}
	}
	return text.Segment{}, false
}

func linesText(segs *text.Segments, src []byte) string {
	if segs == nil {
		return ""
	}
	var b strings.Builder
	for i := 0; i < segs.Len(); i++ {
		s := segs.At(i)
		b.Write(s.Value(src))
	}
	return b.String()
}

// fencedRaw reconstructs the fenced code block's raw source including fence
// markers, so trimPartialClosingFences can inspect the closing fence.
func fencedRaw(node *gast.FencedCodeBlock, src []byte) string {
	seg, ok := firstSegment(node)
	if !ok {
		return linesText(node.Lines(), src)
	}
	// back up to opening fence line start
	start := seg.Start
	for start > 0 && src[start-1] != '\n' {
		start--
	}
	// opening fence is on the line before the first content line
	for start > 0 {
		lineStart := start - 1
		for lineStart > 0 && src[lineStart-1] != '\n' {
			lineStart--
		}
		line := string(src[lineStart : start-1])
		if fenceMarkerRe.MatchString(strings.TrimSpace(line)) {
			start = lineStart
			break
		}
		break
	}
	// stop at end of last content line + following fence line if present
	end := start
	if l := node.Lines(); l != nil && l.Len() > 0 {
		last := l.At(l.Len() - 1)
		end = last.Stop
	} else {
		end = seg.Start
	}
	// include trailing fence line
	for end < len(src) && src[end] != '\n' {
		end++
	}
	if end < len(src) && src[end] == '\n' {
		// possibly a closing fence line follows
		fs := end + 1
		fe := fs
		for fe < len(src) && src[fe] != '\n' {
			fe++
		}
		if fenceMarkerRe.MatchString(strings.TrimSpace(string(src[fs:fe]))) {
			end = fe
		}
	}
	return string(src[start:end])
}

var fenceMarkerRe = regexp.MustCompile("^(`{3,}|~{3,})")

func htmlBlockText(node *gast.HTMLBlock, src []byte) string {
	txt := linesText(node.Lines(), src)
	if node.HasClosure() {
		cl := node.ClosureLine
		txt += string(cl.Value(src))
	}
	return txt
}
