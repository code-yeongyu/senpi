package markdown

import (
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// chromaHighlighter returns a HighlightCode func that tokenizes fenced code with
// chroma and colors each token from the grok palette (no approximated colors:
// keyword→blue, string→green, comment→muted, number→yellow, name/func→cyan,
// everything else→primary text). Output is a slice of styled lines (one per
// source line), matching pi's highlightCode(code, lang) []string contract.
func chromaHighlighter(p theme.Palette) func(code, lang string) []string {
	styleFor := func(hex string) lipgloss.Style { return lipgloss.NewStyle().Foreground(lipgloss.Color(hex)) }
	keyword := styleFor(p.AccentBlue)
	str := styleFor(p.AccentGreen)
	comment := styleFor(p.TextMuted)
	number := styleFor(p.AccentYellow)
	name := styleFor(p.AccentCyan)
	base := styleFor(p.TextSecondary)

	styleForToken := func(tt chroma.TokenType) lipgloss.Style {
		switch tt.Category() {
		case chroma.Keyword:
			return keyword
		case chroma.LiteralString:
			return str
		case chroma.Comment:
			return comment
		case chroma.LiteralNumber, chroma.Literal:
			return number
		case chroma.Name:
			return name
		default:
			return base
		}
	}

	return func(code, lang string) []string {
		lexer := lexers.Get(lang)
		if lexer == nil {
			lexer = lexers.Analyse(code)
		}
		if lexer == nil {
			lexer = lexers.Fallback
		}
		lexer = chroma.Coalesce(lexer)
		it, err := lexer.Tokenise(nil, code)
		if err != nil {
			return plainCodeLines(code, base)
		}

		// Build styled output token by token, then split into physical lines.
		var b strings.Builder
		for tok := it(); tok != chroma.EOF; tok = it() {
			st := styleForToken(tok.Type)
			// Style each physical line segment of the token separately so newlines
			// stay unstyled (avoids background/style bleed across the wrap seam).
			parts := strings.Split(tok.Value, "\n")
			for i, part := range parts {
				if part != "" {
					b.WriteString(st.Render(part))
				}
				if i < len(parts)-1 {
					b.WriteByte('\n')
				}
			}
		}
		out := strings.Split(b.String(), "\n")
		// chroma appends a trailing newline for the final line; drop the empty tail.
		if len(out) > 0 && out[len(out)-1] == "" {
			out = out[:len(out)-1]
		}
		if len(out) == 0 {
			return []string{""}
		}
		return out
	}
}

func plainCodeLines(code string, base lipgloss.Style) []string {
	lines := strings.Split(code, "\n")
	for i, l := range lines {
		lines[i] = base.Render(l)
	}
	return lines
}
