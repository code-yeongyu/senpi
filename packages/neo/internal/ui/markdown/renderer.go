// allow: SIZE_OK - renderToken/renderInlineTokens are a byte-faithful port of the
// markdown.ts render switch; the style-prefix reapplication logic must stay together.
package markdown

import (
	"strings"
)

// inlineStyleContext mirrors pi's InlineStyleContext: how to style plain text
// runs and the ANSI prefix to re-open after nested resets.
type inlineStyleContext struct {
	applyText   StyleFunc
	stylePrefix string
}

const sentinel = "\x00"

// getStylePrefix extracts the ANSI prefix a style function emits before content.
func getStylePrefix(styleFn StyleFunc) string {
	styled := styleFn(sentinel)
	idx := strings.Index(styled, sentinel)
	if idx >= 0 {
		return styled[:idx]
	}
	return ""
}

func (m *Markdown) applyDefaultStyle(text string) string {
	if m.defaultTextStyle == nil {
		return text
	}
	styled := text
	if m.defaultTextStyle.Color != nil {
		styled = m.defaultTextStyle.Color(styled)
	}
	if m.defaultTextStyle.Bold {
		styled = m.theme.Bold(styled)
	}
	if m.defaultTextStyle.Italic {
		styled = m.theme.Italic(styled)
	}
	if m.defaultTextStyle.Strikethrough {
		styled = m.theme.Strikethrough(styled)
	}
	if m.defaultTextStyle.Underline {
		styled = m.theme.Underline(styled)
	}
	return styled
}

func (m *Markdown) getDefaultStylePrefix() string {
	if m.defaultTextStyle == nil {
		return ""
	}
	if m.defaultStylePrefixSet {
		return m.defaultStylePrefix
	}
	styled := sentinel
	if m.defaultTextStyle.Color != nil {
		styled = m.defaultTextStyle.Color(styled)
	}
	if m.defaultTextStyle.Bold {
		styled = m.theme.Bold(styled)
	}
	if m.defaultTextStyle.Italic {
		styled = m.theme.Italic(styled)
	}
	if m.defaultTextStyle.Strikethrough {
		styled = m.theme.Strikethrough(styled)
	}
	if m.defaultTextStyle.Underline {
		styled = m.theme.Underline(styled)
	}
	idx := strings.Index(styled, sentinel)
	if idx >= 0 {
		m.defaultStylePrefix = styled[:idx]
	} else {
		m.defaultStylePrefix = ""
	}
	m.defaultStylePrefixSet = true
	return m.defaultStylePrefix
}

func (m *Markdown) defaultInlineStyleContext() inlineStyleContext {
	return inlineStyleContext{
		applyText:   func(t string) string { return m.applyDefaultStyle(t) },
		stylePrefix: m.getDefaultStylePrefix(),
	}
}

// renderToken renders one block token to styled lines. Faithful port of
// markdown.ts renderToken. nextType is -1 when there is no following token.
func (m *Markdown) renderToken(tok *block, width int, nextType tokenType, sc *inlineStyleContext) []string {
	var lines []string

	switch tok.typ {
	case tokHeading:
		level := tok.depth
		prefix := strings.Repeat("#", level) + " "
		var headingStyleFn StyleFunc
		if level == 1 {
			headingStyleFn = func(t string) string { return m.theme.Heading(m.theme.Bold(m.theme.Underline(t))) }
		} else {
			headingStyleFn = func(t string) string { return m.theme.Heading(m.theme.Bold(t)) }
		}
		hsc := inlineStyleContext{applyText: headingStyleFn, stylePrefix: getStylePrefix(headingStyleFn)}
		headingText := m.renderInlineTokens(tok.inline, &hsc)
		var styledHeading string
		if level >= 3 {
			styledHeading = headingStyleFn(prefix) + headingText
		} else {
			styledHeading = headingText
		}
		lines = append(lines, styledHeading)
		if nextType != -1 && nextType != tokSpace {
			lines = append(lines, "")
		}

	case tokParagraph:
		para := m.renderInlineTokens(tok.inline, sc)
		lines = append(lines, para)
		if nextType != -1 && nextType != tokList && nextType != tokSpace {
			lines = append(lines, "")
		}

	case tokText:
		lines = append(lines, m.renderInlineTokens(tok.inline, sc))

	case tokCode:
		indent := m.codeBlockIndent()
		m.renderCodeBlock(&lines, tok.codeText, tok.codeLang, indent)
		if nextType != -1 && nextType != tokSpace {
			lines = append(lines, "")
		}

	case tokList:
		lines = append(lines, m.renderList(tok, 0, width, sc)...)

	case tokTable:
		lines = append(lines, m.renderTable(tok.table, width, nextType, sc)...)

	case tokBlockquote:
		quoteStyle := func(t string) string { return m.theme.Quote(m.theme.Italic(t)) }
		quoteStylePrefix := getStylePrefix(quoteStyle)
		applyQuoteStyle := func(line string) string {
			if quoteStylePrefix == "" {
				return quoteStyle(line)
			}
			reapplied := strings.ReplaceAll(line, "\x1b[0m", "\x1b[0m"+quoteStylePrefix)
			return quoteStyle(reapplied)
		}
		quoteContentWidth := width - 2
		if quoteContentWidth < 1 {
			quoteContentWidth = 1
		}
		quoteSC := inlineStyleContext{applyText: func(t string) string { return t }, stylePrefix: quoteStylePrefix}
		var renderedQuoteLines []string
		for i := range tok.children {
			var nt tokenType = -1
			if i+1 < len(tok.children) {
				nt = tok.children[i+1].typ
			}
			renderedQuoteLines = append(renderedQuoteLines, m.renderToken(&tok.children[i], quoteContentWidth, nt, &quoteSC)...)
		}
		for len(renderedQuoteLines) > 0 && renderedQuoteLines[len(renderedQuoteLines)-1] == "" {
			renderedQuoteLines = renderedQuoteLines[:len(renderedQuoteLines)-1]
		}
		for _, quoteLine := range renderedQuoteLines {
			styled := applyQuoteStyle(quoteLine)
			for _, wl := range wrapTextWithAnsi(styled, quoteContentWidth) {
				lines = append(lines, m.theme.QuoteBorder("│ ")+wl)
			}
		}
		if nextType != -1 && nextType != tokSpace {
			lines = append(lines, "")
		}

	case tokHR:
		w := width
		if w > 80 {
			w = 80
		}
		lines = append(lines, m.theme.HR(strings.Repeat("─", w)))
		if nextType != -1 && nextType != tokSpace {
			lines = append(lines, "")
		}

	case tokHTML:
		lines = append(lines, m.applyDefaultStyle(strings.TrimSpace(tok.raw)))

	case tokSpace:
		lines = append(lines, "")
	}

	return lines
}

// renderInlineTokens renders inline tokens to a single styled string. Faithful
// port of markdown.ts renderInlineTokens.
func (m *Markdown) renderInlineTokens(tokens []inline, sc *inlineStyleContext) string {
	var resolved inlineStyleContext
	if sc != nil {
		resolved = *sc
	} else {
		resolved = m.defaultInlineStyleContext()
	}
	applyText := resolved.applyText
	stylePrefix := resolved.stylePrefix

	applyTextWithNewlines := func(text string) string {
		segs := strings.Split(text, "\n")
		for i, s := range segs {
			segs[i] = applyText(s)
		}
		return strings.Join(segs, "\n")
	}

	var b strings.Builder
	for _, tok := range tokens {
		switch tok.typ {
		case tokEscape:
			if m.options.PreserveBackslashEscapes {
				b.WriteString(applyTextWithNewlines(tok.text)) // raw carried in text
			} else {
				b.WriteString(applyTextWithNewlines(tok.text))
			}

		case tokInlineText:
			if len(tok.children) > 0 {
				b.WriteString(m.renderInlineTokens(tok.children, &resolved))
			} else {
				b.WriteString(applyTextWithNewlines(m.normalizeEscapes(tok.text)))
			}

		case tokStrong:
			content := m.renderInlineTokens(tok.children, &resolved)
			b.WriteString(m.theme.Bold(content) + stylePrefix)

		case tokEm:
			content := m.renderInlineTokens(tok.children, &resolved)
			b.WriteString(m.theme.Italic(content) + stylePrefix)

		case tokCodespan:
			b.WriteString(m.theme.Code(tok.text) + stylePrefix)

		case tokLink:
			linkText := m.renderInlineTokens(tok.children, &resolved)
			styledLink := m.theme.Link(m.theme.Underline(linkText))
			if GetCapabilities().Hyperlinks {
				b.WriteString(hyperlink(styledLink, tok.href) + stylePrefix)
			} else {
				plainText := inlinePlainText(tok.children)
				hrefForComparison := tok.href
				if strings.HasPrefix(hrefForComparison, "mailto:") {
					hrefForComparison = hrefForComparison[7:]
				}
				if plainText == tok.href || plainText == hrefForComparison {
					b.WriteString(styledLink + stylePrefix)
				} else {
					b.WriteString(styledLink + m.theme.LinkURL(" ("+tok.href+")") + stylePrefix)
				}
			}

		case tokBr:
			b.WriteString("\n")

		case tokDel:
			content := m.renderInlineTokens(tok.children, &resolved)
			b.WriteString(m.theme.Strikethrough(content) + stylePrefix)

		case tokInlineHTML:
			b.WriteString(applyTextWithNewlines(tok.text))

		default:
			if tok.text != "" {
				b.WriteString(applyTextWithNewlines(tok.text))
			}
		}
	}

	result := b.String()
	for stylePrefix != "" && strings.HasSuffix(result, stylePrefix) {
		result = result[:len(result)-len(stylePrefix)]
	}
	return result
}

// inlinePlainText returns the concatenated plain text of inline children (for
// link href comparison — matches marked's token.text).
func inlinePlainText(tokens []inline) string {
	var b strings.Builder
	for _, t := range tokens {
		switch t.typ {
		case tokInlineText, tokCodespan, tokEscape, tokInlineHTML:
			b.WriteString(t.text)
		default:
			b.WriteString(inlinePlainText(t.children))
		}
	}
	return b.String()
}
