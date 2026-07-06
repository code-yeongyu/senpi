package builtinext

import (
	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// roleStyler resolves the classic theme.fg(role, text) semantic roles used by
// the five extensions to the neo palette's exact hexes. This is the single seam
// mapping the TS role names to internal/theme, so every extension colors through
// the theme package and never approximates a color.
//
// Role -> palette mapping (transcribed from the grok theme the extensions use):
//
//	accent   -> AccentBlue    (#7aa2f7)  selected prefix, titles, cursor, tool ▸
//	success  -> AccentGreen   (#9ece6a)  W glyph, ✓ markers, added status
//	error    -> AccentRed     (#f7768e)  ✗ markers, D status
//	warning  -> AccentYellow  (#e0af68)  E glyph, M status, no-match
//	muted    -> TextMuted     (#6c6c6c)  labels, descriptions
//	dim      -> TextDim       (#585858)  hints, counts, previews
type roleStyler struct {
	accent  lipgloss.Style
	success lipgloss.Style
	errorS  lipgloss.Style
	warning lipgloss.Style
	muted   lipgloss.Style
	dim     lipgloss.Style
	bold    lipgloss.Style
}

func newRoleStyler(t *theme.Theme) roleStyler {
	p := t.Palette()
	fg := func(hex string) lipgloss.Style { return lipgloss.NewStyle().Foreground(lipgloss.Color(hex)) }
	return roleStyler{
		accent:  fg(p.AccentBlue),
		success: fg(p.AccentGreen),
		errorS:  fg(p.AccentRed),
		warning: fg(p.AccentYellow),
		muted:   fg(p.TextMuted),
		dim:     fg(p.TextDim),
		bold:    lipgloss.NewStyle().Bold(true),
	}
}

// fg renders text in the given semantic role (matching theme.fg(role, text)).
func (r roleStyler) fg(role, text string) string {
	switch role {
	case "accent":
		return r.accent.Render(text)
	case "success":
		return r.success.Render(text)
	case "error":
		return r.errorS.Render(text)
	case "warning":
		return r.warning.Render(text)
	case "muted":
		return r.muted.Render(text)
	case "dim":
		return r.dim.Render(text)
	default:
		return text
	}
}

// boldText renders text bold (matching theme.bold(text)).
func (r roleStyler) boldText(text string) string { return r.bold.Render(text) }
