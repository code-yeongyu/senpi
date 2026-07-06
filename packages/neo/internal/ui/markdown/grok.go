package markdown

import (
	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// GrokTheme builds a markdown Theme wired to grok styling from internal/theme.
// Every color comes from the resolved theme's exact palette tokens (no
// approximation): headings + links + list bullets use the blue accent, inline +
// block code use yellow/green accents, quotes + borders use muted/dim tiers.
// Attribute styles (bold/italic/underline/strikethrough) are palette-independent
// SGR toggles. Truecolor SGR is emitted by default; downstream RenderAt handles
// 256-color / NO_COLOR downgrade at the frame seam.
func GrokTheme(t *theme.Theme) Theme {
	p := t.Palette()

	fg := func(hex string) StyleFunc {
		st := lipgloss.NewStyle().Foreground(lipgloss.Color(hex))
		return func(s string) string { return st.Render(s) }
	}
	attr := func(mk func(lipgloss.Style) lipgloss.Style) StyleFunc {
		st := mk(lipgloss.NewStyle())
		return func(s string) string { return st.Render(s) }
	}

	return Theme{
		Heading:         fg(p.AccentBlue),
		Link:            fg(p.AccentBlue),
		LinkURL:         fg(p.TextDim),
		Code:            fg(p.AccentYellow),
		CodeBlock:       fg(p.AccentGreen),
		CodeBlockBorder: fg(p.TextMuted),
		Quote:           fg(p.TextMuted),
		QuoteBorder:     fg(p.TextDim),
		HR:              fg(p.TextMuted),
		ListBullet:      fg(p.AccentBlue),
		Bold:            attr(func(s lipgloss.Style) lipgloss.Style { return s.Bold(true) }),
		Italic:          attr(func(s lipgloss.Style) lipgloss.Style { return s.Italic(true) }),
		Strikethrough:   attr(func(s lipgloss.Style) lipgloss.Style { return s.Strikethrough(true) }),
		Underline:       attr(func(s lipgloss.Style) lipgloss.Style { return s.Underline(true) }),
		HighlightCode:   chromaHighlighter(p),
	}
}
