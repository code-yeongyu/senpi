package theme

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
)

// SamplePanel renders a small, self-contained grok-styled panel that exercises
// the theme's surfaces, text tiers, accents, borders, spinner and tool-row
// glyphs. It is the QA/evidence surface: rendered to a real terminal (tmux) and
// piped through the xterm.js harness so its cells can be asserted against the
// capture palette. profile selects the color depth so the SAME panel proves the
// truecolor path and the 256/NO_COLOR fallback without any crash.
//
// The panel is deliberately compact and stable (no timestamps, no live data) so
// its cell grid is deterministic across runs.
func (t *Theme) SamplePanel(profile colorprofile.Profile) string {
	var b strings.Builder

	// Header row: branch glyph + name in primary, cwd in dim — grok header.
	header := t.textPrimary.Render(GlyphBranch+" main") +
		t.textDim.Render("  ~/senpi")
	b.WriteString(RenderAtRaw(profile, header))
	b.WriteString("\n")

	// Event row: green ◆ marker + muted label (grok hook/event row).
	event := lipgloss.NewStyle().Foreground(lipgloss.Color(t.palette.AccentGreen)).
		Background(lipgloss.Color(t.palette.SurfaceBase)).Render(GlyphEventMarker) +
		t.textMuted.Render(" session_start")
	b.WriteString(RenderAtRaw(profile, event))
	b.WriteString("\n")

	// Tool row: green ┃ guide + ◆ + secondary text (grok tool-call row).
	tool := t.toolGuide.Render(GlyphToolGuide) +
		t.textMuted.Render("  ") +
		t.toolGuide.Render(GlyphEventMarker) +
		t.textSecondary.Render(" Run ls -la")
	b.WriteString(RenderAtRaw(profile, tool))
	b.WriteString("\n")

	// Spinner row: braille spinner in secondary + muted elapsed (grok waiting).
	spinner := t.textSecondary.Render(t.SpinnerFrames()[2]+" Waiting for response…") +
		t.textMuted.Render(" 0.4s")
	b.WriteString(RenderAtRaw(profile, spinner))
	b.WriteString("\n")

	// Accent legend: each accent glyph in its exact color.
	accents := []struct {
		style lipgloss.Style
		label string
	}{
		{t.accentGreen, "ok"},
		{t.accentRed, "err"},
		{t.accentBlue, "/cmd"},
		{t.accentYellow, "warn"},
		{t.accentCyan, "path"},
	}
	parts := make([]string, 0, len(accents))
	for _, a := range accents {
		parts = append(parts, a.style.Render(a.label))
	}
	b.WriteString(RenderAtRaw(profile, strings.Join(parts, t.textMuted.Render(" · "))))
	b.WriteString("\n")

	// Input footer: rounded border color + prompt glyph + model label + mode.
	footer := t.borderInput.Render("╭─"+GlyphPrompt) +
		t.textLabel.Render(" Composer 2.5") +
		t.textMuted.Render(" · always-approve")
	b.WriteString(RenderAtRaw(profile, footer))
	b.WriteString("\n")

	return b.String()
}

// RenderAtRaw downgrades an already-styled string to a profile (no extra style).
func RenderAtRaw(profile colorprofile.Profile, s string) string {
	return downgrade(profile, s)
}

// ProfileFromName maps a CLI/string name to a colorprofile.Profile. Unknown
// names default to TrueColor (neo's default target).
func ProfileFromName(name string) (colorprofile.Profile, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "truecolor", "24bit", "full":
		return colorprofile.TrueColor, nil
	case "ansi256", "256":
		return colorprofile.ANSI256, nil
	case "ansi", "16":
		return colorprofile.ANSI, nil
	case "ascii", "nocolor", "no-color", "none":
		return colorprofile.ASCII, nil
	case "notty":
		return colorprofile.NoTTY, nil
	default:
		return colorprofile.TrueColor, fmt.Errorf("unknown color profile %q", name)
	}
}
