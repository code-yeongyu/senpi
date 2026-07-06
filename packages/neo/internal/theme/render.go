package theme

import (
	"bytes"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
)

// RenderAt renders a lipgloss style + text and downgrades the SGR to the given
// color profile. At TrueColor the exact palette hexes survive unchanged; at
// ANSI256/ANSI the truecolor SGR is converted to palette indices; at ASCII/NoTTY
// all color SGR is stripped (the NO_COLOR path) while the text/glyphs remain.
//
// This is the single seam neo uses so a 256-color or NO_COLOR terminal never
// receives truecolor escapes, and a truecolor terminal always gets the exact
// grok hexes.
func RenderAt(profile colorprofile.Profile, style lipgloss.Style, text string) string {
	full := style.Render(text)
	return downgrade(profile, full)
}

// downgrade converts a truecolor SGR string to the target profile using a
// colorprofile.Writer.
func downgrade(profile colorprofile.Profile, s string) string {
	var buf bytes.Buffer
	w := &colorprofile.Writer{Forward: &buf, Profile: profile}
	_, _ = w.Write([]byte(s))
	return buf.String()
}

// --- test-support render helpers --------------------------------------------
//
// These render exactly ONE styled glyph/surface as an .ans byte string so the
// golden tests can pipe them through the xterm.js harness and assert the parsed
// cell. They are not part of the public consumer API; downstream UI code renders
// full components. Kept in production (not _test.go) because the golden tests in
// this package reference them via the exported *Theme methods below.

// styleByName maps a golden test's style name to the theme's lipgloss style.
func (t *Theme) styleByName(name string) lipgloss.Style {
	switch name {
	case "text-primary":
		return t.textPrimary
	case "text-secondary":
		return t.textSecondary
	case "text-muted":
		return t.textMuted
	case "text-dim":
		return t.textDim
	case "text-faint":
		return t.textFaint
	case "text-label", "footer-label":
		return t.footerLabel
	case "accent-green":
		return t.accentGreen
	case "accent-red":
		return t.accentRed
	case "accent-blue":
		return t.accentBlue
	case "accent-yellow":
		return t.accentYellow
	case "accent-cyan":
		return t.accentCyan
	case "border-input":
		return t.borderInput
	case "border-card":
		return t.borderCard
	case "border-modal":
		return t.borderModal
	default:
		return t.textPrimary
	}
}

// surfaceByName maps a golden test's surface name to the theme's surface style.
func (t *Theme) surfaceByName(name string) lipgloss.Style {
	switch name {
	case "surface-base":
		return t.surfaceBase
	case "surface-panel":
		return t.surfacePanel
	case "surface-highlight":
		return t.surfaceHighlight
	case "surface-alt-row":
		return t.surfaceAltRow
	case "surface-selected":
		return t.surfaceSelected
	default:
		return t.surfaceBase
	}
}

// renderForTest renders one styled glyph at truecolor (neo's default path).
func (t *Theme) renderForTest(styleName, glyph string) string {
	return t.styleByName(styleName).Render(glyph)
}

// renderSurfaceForTest renders a single space carrying the named surface bg.
func (t *Theme) renderSurfaceForTest(name string) string {
	return t.surfaceByName(name).Render(" ")
}

// renderToolRowForTest renders the `┃` guide in accent-green on the base surface.
func (t *Theme) renderToolRowForTest() string {
	style := lipgloss.NewStyle().
		Foreground(lipgloss.Color(t.palette.AccentGreen)).
		Background(lipgloss.Color(t.palette.SurfaceBase))
	return style.Render(GlyphToolGuide)
}

// renderAtProfileForTest renders one styled glyph downgraded to a profile.
func (t *Theme) renderAtProfileForTest(profile colorprofile.Profile, styleName, glyph string) string {
	return RenderAt(profile, t.styleByName(styleName), glyph)
}
