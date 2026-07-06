package theme

import (
	"testing"

	"github.com/charmbracelet/colorprofile"
)

// These are the TDD goldens for the neo grok-night theme. They assert EXACT
// truecolor SGR by rendering the theme's styles, piping the bytes through the
// xterm.js harness, and comparing the parsed grid cell's fg/bg hex + glyph to
// the capture hexes recorded in golden_hexes.go. The goldens derive from the
// captures, never from the theme's own output.

// renderCellLine renders a single glyph styled with the given style at
// truecolor, on the base surface bg, and returns the harness grid. The bg is
// applied explicitly so the harness sees the surface layer the grok UI uses.
func renderStyledGlyph(t *testing.T, th *Theme, styleName string, glyph string) grid {
	t.Helper()
	ans := th.renderForTest(styleName, glyph)
	return renderThroughHarness(t, ans, 8, 1)
}

func TestGrokNightIsDefault(t *testing.T) {
	th, err := Load(Options{})
	if err != nil {
		t.Fatalf("Load default: %v", err)
	}
	if th.Name() != "grok-night" {
		t.Fatalf("neo default theme: want grok-night, got %q", th.Name())
	}
}

func TestSurfaceBackgroundHexesMatchCaptures(t *testing.T) {
	th := mustLoadNight(t)
	cases := []struct {
		name string
		want captureHex
	}{
		{"surface-base", goldSurfaceBase},
		{"surface-panel", goldSurfacePanel},
		{"surface-highlight", goldSurfaceHighlight},
		{"surface-alt-row", goldSurfaceAltRow},
		{"surface-selected", goldSurfaceSelected},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := renderThroughHarness(t, th.renderSurfaceForTest(tc.name), 8, 1)
			assertCellBG(t, g, 0, 0, tc.want.hex)
		})
	}
}

func TestTextTierForegroundHexesMatchCaptures(t *testing.T) {
	th := mustLoadNight(t)
	cases := []struct {
		style string
		want  captureHex
	}{
		{"text-primary", goldTextPrimary},
		{"text-secondary", goldTextSecondary},
		{"text-muted", goldTextMuted},
		{"text-dim", goldTextDim},
		{"text-faint", goldTextFaint},
		{"text-label", goldTextLabel},
	}
	for _, tc := range cases {
		t.Run(tc.style, func(t *testing.T) {
			g := renderStyledGlyph(t, th, tc.style, "X")
			assertCellFG(t, g, 0, 0, tc.want.hex)
			assertCellGlyph(t, g, 0, 0, "X")
		})
	}
}

func TestAccentForegroundHexesMatchCaptures(t *testing.T) {
	th := mustLoadNight(t)
	cases := []struct {
		style string
		want  captureHex
	}{
		{"accent-green", goldAccentGreen},
		{"accent-red", goldAccentRed},
		{"accent-blue", goldAccentBlue},
		{"accent-yellow", goldAccentYellow},
		{"accent-cyan", goldAccentCyan},
	}
	for _, tc := range cases {
		t.Run(tc.style, func(t *testing.T) {
			g := renderStyledGlyph(t, th, tc.style, "X")
			assertCellFG(t, g, 0, 0, tc.want.hex)
		})
	}
}

func TestBorderHexesMatchCaptures(t *testing.T) {
	th := mustLoadNight(t)
	cases := []struct {
		style string
		want  captureHex
	}{
		{"border-input", goldBorderInput},
		{"border-card", goldBorderCard},
		{"border-modal", goldBorderModal},
	}
	for _, tc := range cases {
		t.Run(tc.style, func(t *testing.T) {
			g := renderStyledGlyph(t, th, tc.style, "X")
			assertCellFG(t, g, 0, 0, tc.want.hex)
		})
	}
}

// TestToolRowGlyphsAndColors asserts the grok tool-row visuals: the vertical
// guide `┃` and event marker `◆` rendered in the green accent on the surface.
func TestToolRowGlyphsAndColors(t *testing.T) {
	th := mustLoadNight(t)
	// The theme exposes the exact glyphs from FINDINGS.md §4.
	if th.ToolGuide() != "┃" {
		t.Fatalf("tool guide glyph: want ┃, got %q", th.ToolGuide())
	}
	if th.EventMarker() != "◆" {
		t.Fatalf("event marker glyph: want ◆, got %q", th.EventMarker())
	}
	// Rendered as an accent-green guide on the base surface.
	g := renderThroughHarness(t, th.renderToolRowForTest(), 8, 1)
	assertCellGlyph(t, g, 0, 0, "┃")
	assertCellFG(t, g, 0, 0, goldAccentGreen.hex)
	assertCellBG(t, g, 0, 0, goldSurfaceBase.hex)
}

// TestSpinnerFramesAreBraille asserts the spinner frame set is the grok braille
// family including the observed `⠹`.
func TestSpinnerFramesAreBraille(t *testing.T) {
	th := mustLoadNight(t)
	frames := th.SpinnerFrames()
	if len(frames) == 0 {
		t.Fatal("spinner frames empty")
	}
	found := false
	for _, f := range frames {
		if f == "⠹" {
			found = true
		}
		// Every frame must be a single braille-pattern rune (U+2800..U+28FF).
		runes := []rune(f)
		if len(runes) != 1 || runes[0] < 0x2800 || runes[0] > 0x28FF {
			t.Fatalf("spinner frame %q is not a single braille rune", f)
		}
	}
	if !found {
		t.Fatalf("spinner frames %v missing observed frame ⠹", frames)
	}
}

// TestHintFooterStyle asserts the footer/hint style renders the model label in
// the exact grok footer label color (#808080) with the muted separator dot.
func TestHintFooterStyle(t *testing.T) {
	th := mustLoadNight(t)
	g := renderStyledGlyph(t, th, "footer-label", "C")
	assertCellFG(t, g, 0, 0, goldTextLabel.hex)
}

// --- fallback paths ---------------------------------------------------------

// TestNoColorProfileEmitsNoTruecolor proves the NO_COLOR path: rendering the
// theme at the ASCII profile strips all SGR color, so the harness grid contains
// no truecolor cells and does not crash.
func TestNoColorProfileEmitsNoTruecolor(t *testing.T) {
	th := mustLoadNight(t)
	ans := th.renderAtProfileForTest(colorprofile.ASCII, "accent-green", "X")
	g := renderThroughHarness(t, ans, 8, 1)
	assertNoTruecolor(t, g)
	// The glyph itself must survive stripping.
	assertCellGlyph(t, g, 0, 0, "X")
}

// TestANSI256ProfileEmitsNoTruecolor proves the 256-color fallback: rendering
// at the ANSI256 profile downgrades truecolor to palette indices, so the grid
// carries NO truecolor cells (TERM=xterm scenario), and does not crash.
func TestANSI256ProfileEmitsNoTruecolor(t *testing.T) {
	th := mustLoadNight(t)
	ans := th.renderAtProfileForTest(colorprofile.ANSI256, "accent-green", "X")
	g := renderThroughHarness(t, ans, 8, 1)
	assertNoTruecolor(t, g)
	// The accent cell must now be a palette color, not truecolor.
	c := g.Cells[0][0]
	if c.FG.Mode == "rgb" {
		t.Fatalf("ANSI256 fallback still emitted truecolor fg: %v", c.FG.Hex)
	}
	assertCellGlyph(t, g, 0, 0, "X")
}

// TestTruecolorProfilePreservesExactHex proves that at the TrueColor profile the
// accent hex is preserved exactly (no downgrade) — the default neo path.
func TestTruecolorProfilePreservesExactHex(t *testing.T) {
	th := mustLoadNight(t)
	ans := th.renderAtProfileForTest(colorprofile.TrueColor, "accent-green", "X")
	g := renderThroughHarness(t, ans, 8, 1)
	assertCellFG(t, g, 0, 0, goldAccentGreen.hex)
}

func mustLoadNight(t *testing.T) *Theme {
	t.Helper()
	th, err := Load(Options{Name: "grok-night"})
	if err != nil {
		t.Fatalf("Load grok-night: %v", err)
	}
	return th
}

// TestEmbeddedGrokTablesTranscribedExactly locks the embedded Grok Night/Day
// theme tables from FINDINGS.md §3 (the task's named hexes: night
// #c0caf5/#bb9af7/#73daca, day #2F64D2/#CD3048/#0C947C). Each golden's hex must
// be the exact `#rrggbb` of its recorded RGB triple, so a transcription typo
// fails here rather than shipping an approximated color.
func TestEmbeddedGrokTablesTranscribedExactly(t *testing.T) {
	all := []captureHex{
		goldNightMagenta, goldNightBlue, goldNightCyan, goldNightFg, goldNightGreen, goldNightRed,
		goldDayBlue, goldDayRed, goldDayGreen,
	}
	for _, c := range all {
		t.Run(c.hex, func(t *testing.T) {
			want := hexFromRGB(c.r, c.g, c.b)
			if !equalFoldHex(c.hex, want) {
				t.Fatalf("golden %q (%s) does not match its RGB triple (%d,%d,%d)=%s",
					c.hex, c.role, c.r, c.g, c.b, want)
			}
		})
	}
	// The day theme must expose the exact day-table hexes on its accents.
	th, err := Load(Options{Name: "grok-day"})
	if err != nil {
		t.Fatalf("Load grok-day: %v", err)
	}
	if th.Palette().AccentBlue != goldDayBlue.hex {
		t.Fatalf("grok-day accent blue: want %s, got %s", goldDayBlue.hex, th.Palette().AccentBlue)
	}
	if th.Palette().AccentRed != goldDayRed.hex {
		t.Fatalf("grok-day accent red: want %s, got %s", goldDayRed.hex, th.Palette().AccentRed)
	}
	if th.Palette().AccentGreen != goldDayGreen.hex {
		t.Fatalf("grok-day accent green: want %s, got %s", goldDayGreen.hex, th.Palette().AccentGreen)
	}
}

// hexFromRGB renders an (r,g,b) triple as a lowercase "#rrggbb" string.
func hexFromRGB(r, g, b int) string {
	const digits = "0123456789abcdef"
	buf := []byte{'#', 0, 0, 0, 0, 0, 0}
	comps := []int{r, g, b}
	for i, v := range comps {
		buf[1+i*2] = digits[(v>>4)&0xf]
		buf[2+i*2] = digits[v&0xf]
	}
	return string(buf)
}

// equalFoldHex compares two "#rrggbb" strings case-insensitively.
func equalFoldHex(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	lower := func(c byte) byte {
		if c >= 'A' && c <= 'F' {
			return c + ('a' - 'A')
		}
		return c
	}
	for i := 0; i < len(a); i++ {
		if lower(a[i]) != lower(b[i]) {
			return false
		}
	}
	return true
}
