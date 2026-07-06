package transcript

import (
	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown"
)

// StyleFunc wraps text in styling SGR (or leaves it plain). Aliased to the
// markdown package's StyleFunc so RenderTheme style functions drop directly into
// markdown.DefaultTextStyle / markdown.Theme without conversion.
type StyleFunc = markdown.StyleFunc

// RenderTheme is the styling surface the transcript renderers consume. It maps
// the interactive-mode `theme.fg("<token>", …)` / `theme.bg(...)` calls onto
// concrete lipgloss styles from the resolved neo theme, plus the markdown Theme
// used by message bodies. Every field routes through internal/theme so no color
// is approximated.
type RenderTheme struct {
	// Foreground token styles (mirror interactive-mode theme.fg tokens).
	ToolTitle       StyleFunc
	ToolOutput      StyleFunc
	ToolDiffAdded   StyleFunc
	ToolDiffRemoved StyleFunc
	ToolDiffContext StyleFunc
	Inverse         StyleFunc
	ThinkingText    StyleFunc
	Error           StyleFunc
	Dim             StyleFunc
	Muted           StyleFunc

	CustomLabel StyleFunc
	CustomText  StyleFunc

	// Glyph styles.
	ToolGuide StyleFunc // `┃` accent-green guide
	ToolMark  StyleFunc // `◆` marker

	// Background wrappers for message/tool surfaces.
	UserBg        StyleFunc
	CustomBg      StyleFunc
	ToolPendingBg StyleFunc
	ToolSuccessBg StyleFunc
	ToolErrorBg   StyleFunc

	// Glyphs.
	GuideGlyph  string
	MarkerGlyph string
	Spinner     []string

	// Markdown carries the markdown block theme for message bodies.
	Markdown markdown.Theme
}

// fgOf renders a foreground color on the theme's base surface.
func fgOf(hex, base string) StyleFunc {
	st := lipgloss.NewStyle().Foreground(lipgloss.Color(hex)).Background(lipgloss.Color(base))
	return func(s string) string { return st.Render(s) }
}

// bgOf renders a background wrapper only.
func bgOf(hex string) StyleFunc {
	st := lipgloss.NewStyle().Background(lipgloss.Color(hex))
	return func(s string) string { return st.Render(s) }
}

// NewRenderTheme builds a RenderTheme from a resolved neo theme. The token→color
// mapping mirrors the grok interactive theme (tool titles use the primary text,
// diffs use green/red accents, errors use the red accent, thinking uses muted,
// custom messages use the blue accent label with a distinct surface).
func NewRenderTheme(t *theme.Theme) RenderTheme {
	p := t.Palette()
	base := p.SurfaceBase
	inverse := func(s string) string {
		return lipgloss.NewStyle().Reverse(true).Render(s)
	}
	return RenderTheme{
		ToolTitle:       fgOf(p.TextPrimary, base),
		ToolOutput:      fgOf(p.TextSecondary, base),
		ToolDiffAdded:   fgOf(p.AccentGreen, base),
		ToolDiffRemoved: fgOf(p.AccentRed, base),
		ToolDiffContext: fgOf(p.TextMuted, base),
		Inverse:         inverse,
		ThinkingText:    fgOf(p.TextMuted, base),
		Error:           fgOf(p.AccentRed, base),
		Dim:             fgOf(p.TextDim, base),
		Muted:           fgOf(p.TextMuted, base),

		CustomLabel: fgOf(p.AccentBlue, p.SurfaceHighlight),
		CustomText:  fgOf(p.TextPrimary, p.SurfaceHighlight),

		ToolGuide: fgOf(p.AccentGreen, base),
		ToolMark:  fgOf(p.AccentGreen, base),

		UserBg:        bgOf(p.SurfacePanel),
		CustomBg:      bgOf(p.SurfaceHighlight),
		ToolPendingBg: bgOf(p.SurfacePanel),
		ToolSuccessBg: bgOf(p.SurfaceAltRow),
		ToolErrorBg:   bgOf(p.SurfaceAltRow),

		GuideGlyph:  theme.GlyphToolGuide,
		MarkerGlyph: theme.GlyphEventMarker,
		Spinner:     t.SpinnerFrames(),

		Markdown: markdown.GrokTheme(t),
	}
}

// DefaultRenderTheme builds a RenderTheme from the neo default (grok-night). Used
// by tests and as the fallback when no theme override is supplied.
func DefaultRenderTheme() RenderTheme {
	t, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	return NewRenderTheme(t)
}

// SpinnerFramesForTest exposes the default spinner frames for abort-state tests.
func SpinnerFramesForTest() []string {
	return DefaultRenderTheme().Spinner
}
