package theme

import (
	"charm.land/lipgloss/v2"
)

// Theme is a fully-resolved neo skin: a name, the exact palette, ready-to-use
// lipgloss styles for every surface/text-tier/accent/border, and the grok
// glyph + spinner inventory. Styles render truecolor SGR by default; callers
// downgrade for NO_COLOR / 256-color terminals via Downgrade / RenderAt (see
// render.go), so the palette hexes stay exact on truecolor terminals.
type Theme struct {
	name    string
	palette Palette

	// Surface styles carry a background layer.
	surfaceBase      lipgloss.Style
	surfacePanel     lipgloss.Style
	surfaceHighlight lipgloss.Style
	surfaceAltRow    lipgloss.Style
	surfaceSelected  lipgloss.Style

	// Text-tier styles carry a foreground on the base surface.
	textPrimary   lipgloss.Style
	textSecondary lipgloss.Style
	textMuted     lipgloss.Style
	textDim       lipgloss.Style
	textFaint     lipgloss.Style
	textLabel     lipgloss.Style

	// Accent styles.
	accentGreen  lipgloss.Style
	accentRed    lipgloss.Style
	accentBlue   lipgloss.Style
	accentYellow lipgloss.Style
	accentCyan   lipgloss.Style

	// Border styles (foreground = border line color).
	borderInput lipgloss.Style
	borderCard  lipgloss.Style
	borderModal lipgloss.Style

	// footerLabel is the model label in the input footer.
	footerLabel lipgloss.Style
	// hint is the shortcut/hint footer text style.
	hint lipgloss.Style
	// toolGuide styles the `┃` guide + `◆` marker on tool rows (accent green).
	toolGuide lipgloss.Style
}

// newTheme builds a Theme from a name + palette, wiring every lipgloss style.
func newTheme(name string, p Palette) *Theme {
	base := lipgloss.Color(p.SurfaceBase)
	fg := func(hex string) lipgloss.Style {
		return lipgloss.NewStyle().Foreground(lipgloss.Color(hex)).Background(base)
	}
	bg := func(hex string) lipgloss.Style {
		return lipgloss.NewStyle().Background(lipgloss.Color(hex))
	}
	return &Theme{
		name:    name,
		palette: p,

		surfaceBase:      bg(p.SurfaceBase),
		surfacePanel:     bg(p.SurfacePanel),
		surfaceHighlight: bg(p.SurfaceHighlight),
		surfaceAltRow:    bg(p.SurfaceAltRow),
		surfaceSelected:  bg(p.SurfaceSelected),

		textPrimary:   fg(p.TextPrimary),
		textSecondary: fg(p.TextSecondary),
		textMuted:     fg(p.TextMuted),
		textDim:       fg(p.TextDim),
		textFaint:     fg(p.TextFaint),
		textLabel:     fg(p.TextLabel),

		accentGreen:  fg(p.AccentGreen),
		accentRed:    fg(p.AccentRed),
		accentBlue:   fg(p.AccentBlue),
		accentYellow: fg(p.AccentYellow),
		accentCyan:   fg(p.AccentCyan),

		borderInput: fg(p.BorderInput),
		borderCard:  fg(p.BorderCard),
		borderModal: fg(p.BorderModal),

		footerLabel: fg(p.TextLabel),
		hint:        fg(p.TextMuted),
		toolGuide:   fg(p.AccentGreen),
	}
}

// Name returns the resolved theme name (e.g. "grok-night").
func (t *Theme) Name() string { return t.name }

// Palette returns a copy of the theme's exact palette.
func (t *Theme) Palette() Palette { return t.palette }

// --- style accessors --------------------------------------------------------

func (t *Theme) SurfaceBase() lipgloss.Style      { return t.surfaceBase }
func (t *Theme) SurfacePanel() lipgloss.Style     { return t.surfacePanel }
func (t *Theme) SurfaceHighlight() lipgloss.Style { return t.surfaceHighlight }
func (t *Theme) SurfaceAltRow() lipgloss.Style    { return t.surfaceAltRow }
func (t *Theme) SurfaceSelected() lipgloss.Style  { return t.surfaceSelected }

func (t *Theme) TextPrimary() lipgloss.Style   { return t.textPrimary }
func (t *Theme) TextSecondary() lipgloss.Style { return t.textSecondary }
func (t *Theme) TextMuted() lipgloss.Style     { return t.textMuted }
func (t *Theme) TextDim() lipgloss.Style       { return t.textDim }
func (t *Theme) TextFaint() lipgloss.Style     { return t.textFaint }
func (t *Theme) TextLabel() lipgloss.Style     { return t.textLabel }

func (t *Theme) AccentGreen() lipgloss.Style  { return t.accentGreen }
func (t *Theme) AccentRed() lipgloss.Style    { return t.accentRed }
func (t *Theme) AccentBlue() lipgloss.Style   { return t.accentBlue }
func (t *Theme) AccentYellow() lipgloss.Style { return t.accentYellow }
func (t *Theme) AccentCyan() lipgloss.Style   { return t.accentCyan }

func (t *Theme) BorderInput() lipgloss.Style { return t.borderInput }
func (t *Theme) BorderCard() lipgloss.Style  { return t.borderCard }
func (t *Theme) BorderModal() lipgloss.Style { return t.borderModal }

func (t *Theme) FooterLabel() lipgloss.Style    { return t.footerLabel }
func (t *Theme) Hint() lipgloss.Style           { return t.hint }
func (t *Theme) ToolGuideStyle() lipgloss.Style { return t.toolGuide }

// --- glyphs -----------------------------------------------------------------

// ToolGuide returns the vertical tool-row guide glyph `┃`.
func (t *Theme) ToolGuide() string { return GlyphToolGuide }

// EventMarker returns the event marker glyph `◆`.
func (t *Theme) EventMarker() string { return GlyphEventMarker }

// PromptGlyph returns the input/selected-row prompt glyph `❯`.
func (t *Theme) PromptGlyph() string { return GlyphPrompt }

// SpinnerFrames returns the braille spinner frame cycle (includes `⠹`).
func (t *Theme) SpinnerFrames() []string {
	out := make([]string, len(spinnerFrames))
	copy(out, spinnerFrames)
	return out
}

// --- hex accessors (for custom-theme merge tests + downstream consumers) -----

func (t *Theme) SurfaceBaseHex() string { return t.palette.SurfaceBase }
func (t *Theme) TextPrimaryHex() string { return t.palette.TextPrimary }
func (t *Theme) TextMutedHex() string   { return t.palette.TextMuted }
func (t *Theme) AccentGreenHex() string { return t.palette.AccentGreen }
func (t *Theme) AccentBlueHex() string  { return t.palette.AccentBlue }
