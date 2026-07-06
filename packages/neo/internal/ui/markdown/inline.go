package markdown

import (
	"strings"

	gast "github.com/yuin/goldmark/ast"
	extast "github.com/yuin/goldmark/extension/ast"
)

// collectInline walks the inline children of a block node and produces pi-shaped
// inline tokens (text/strong/em/codespan/link/del/br/html). A task checkbox is
// re-materialized as literal "[ ] "/"[x] " text so list rendering shows it (pi
// keeps the marker in the item text via marked).
func collectInline(n gast.Node, src []byte, opts Options) []inline {
	var out []inline
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		out = append(out, convertInline(c, src, opts)...)
	}
	return mergeAdjacentText(out)
}

func convertInline(n gast.Node, src []byte, opts Options) []inline {
	switch node := n.(type) {
	case *gast.Text:
		txt := string(node.Segment.Value(src))
		// goldmark encodes a hard/soft line break on the Text node.
		if node.HardLineBreak() {
			return []inline{{typ: tokInlineText, text: txt}, {typ: tokBr}}
		}
		if node.SoftLineBreak() {
			// soft breaks become spaces in marked's inline text flow; pi relies on
			// marked joining soft-wrapped lines with a space. Represent as text + " ".
			return []inline{{typ: tokInlineText, text: txt + "\n"}}
		}
		return []inline{{typ: tokInlineText, text: txt}}

	case *gast.String:
		return []inline{{typ: tokInlineText, text: string(node.Value)}}

	case *gast.CodeSpan:
		return []inline{{typ: tokCodespan, text: inlineRawText(node, src)}}

	case *gast.Emphasis:
		kids := collectInline(node, src, opts)
		if node.Level == 2 {
			return []inline{{typ: tokStrong, children: kids}}
		}
		return []inline{{typ: tokEm, children: kids}}

	case *extast.Strikethrough:
		return []inline{{typ: tokDel, children: collectInline(node, src, opts)}}

	case *gast.Link:
		return []inline{{
			typ:      tokLink,
			href:     string(node.Destination),
			children: collectInline(node, src, opts),
		}}

	case *gast.AutoLink:
		url := string(node.URL(src))
		label := string(node.Label(src))
		href := url
		if node.AutoLinkType == gast.AutoLinkEmail && !strings.HasPrefix(href, "mailto:") {
			href = "mailto:" + url
		}
		return []inline{{
			typ:      tokLink,
			href:     href,
			children: []inline{{typ: tokInlineText, text: label}},
		}}

	case *gast.RawHTML:
		return []inline{{typ: tokInlineHTML, text: rawHTMLText(node, src)}}

	case *extast.TaskCheckBox:
		// The checkbox marker is emitted by renderList via item.task/checked, so
		// it must NOT also appear in the item's inline text (that would double it).
		// goldmark leaves a leading space after the checkbox in the following Text
		// node; renderList's taskMarker already includes the trailing space.
		return nil

	default:
		// Fallback: descend into children, else emit raw text if available.
		if n.ChildCount() > 0 {
			return collectInline(n, src, opts)
		}
		return nil
	}
}

func inlineRawText(n gast.Node, src []byte) string {
	var b strings.Builder
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		if t, ok := c.(*gast.Text); ok {
			b.Write(t.Segment.Value(src))
		}
	}
	return b.String()
}

func rawHTMLText(n *gast.RawHTML, src []byte) string {
	var b strings.Builder
	for i := 0; i < n.Segments.Len(); i++ {
		seg := n.Segments.At(i)
		b.Write(seg.Value(src))
	}
	return b.String()
}

// mergeAdjacentText coalesces consecutive plain-text inline tokens so downstream
// backslash/whitespace handling operates on contiguous runs (matches marked's
// single text token per run).
func mergeAdjacentText(in []inline) []inline {
	var out []inline
	for _, t := range in {
		if t.typ == tokInlineText && len(out) > 0 && out[len(out)-1].typ == tokInlineText {
			out[len(out)-1].text += t.text
			continue
		}
		out = append(out, t)
	}
	return out
}
