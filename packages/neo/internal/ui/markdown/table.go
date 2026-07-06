package markdown

import (
	gast "github.com/yuin/goldmark/ast"
	extast "github.com/yuin/goldmark/extension/ast"
)

func convertTable(node *extast.Table, src []byte, opts Options) block {
	tt := &tableToken{}
	for c := node.FirstChild(); c != nil; c = c.NextSibling() {
		switch row := c.(type) {
		case *extast.TableHeader:
			for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
				if tc, ok := cell.(*extast.TableCell); ok {
					tt.header = append(tt.header, tableCell{inline: collectInline(tc, src, opts)})
				}
			}
		case *extast.TableRow:
			var cells []tableCell
			for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
				if tc, ok := cell.(*extast.TableCell); ok {
					cells = append(cells, tableCell{inline: collectInline(tc, src, opts)})
				}
			}
			tt.rows = append(tt.rows, cells)
		}
	}
	tt.raw = nodeSourceSpan(node, src)
	return block{typ: tokTable, table: tt}
}

// nodeSourceSpan returns the source text covering all descendant segments of n,
// snapped to physical line boundaries. Used for the too-narrow table fallback.
func nodeSourceSpan(n gast.Node, src []byte) string {
	start, stop, ok := segmentBounds(n)
	if !ok {
		return ""
	}
	for start > 0 && src[start-1] != '\n' {
		start--
	}
	for stop < len(src) && src[stop] != '\n' {
		stop++
	}
	if start < 0 {
		start = 0
	}
	if stop > len(src) {
		stop = len(src)
	}
	return string(src[start:stop])
}

// segmentBounds returns the min start and max stop offsets over all descendant
// segments of n.
func segmentBounds(n gast.Node) (minStart, maxStop int, ok bool) {
	minStart = -1
	var visit func(node gast.Node)
	visit = func(node gast.Node) {
		if s, has := firstSegment(node); has {
			if minStart == -1 || s.Start < minStart {
				minStart = s.Start
			}
			if s.Stop > maxStop {
				maxStop = s.Stop
			}
		}
		for c := node.FirstChild(); c != nil; c = c.NextSibling() {
			visit(c)
		}
	}
	visit(n)
	if minStart == -1 {
		return 0, 0, false
	}
	return minStart, maxStop, true
}
