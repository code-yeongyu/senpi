package theme

// This file is NOT production code that other packages import for behavior; it
// is the single, hand-transcribed source of truth for the golden test suite.
//
// Every hex here is copied verbatim from the grok captures as recorded in
//   .omo/research/neo-grok/ansi-colors.md  (runtime SGR → hex, per-capture)
//   .omo/research/neo-grok/FINDINGS.md     (aggregate palette + Night/Day tables)
// with the exact truecolor SGR that produced it noted alongside. Goldens are
// derived from these capture hexes, NEVER from the theme implementation's own
// output — so a regression in the theme cannot silently "fix" the golden.
//
// The corresponding SGR byte in each capture is `\x1b[38;2;R;G;Bm` (fg) or
// `\x1b[48;2;R;G;Bm` (bg); the RGB triples are shown in the comments.

// captureHex is a golden hex string with the RGB triple observed in captures.
type captureHex struct {
	hex string // "#rrggbb"
	r   int
	g   int
	b   int
	// role documents where the color is observed in the grok UI.
	role string
}

// Surfaces (background layers). Source: ansi-colors.md aggregate + by-capture.
var (
	goldSurfaceBase      = captureHex{"#141414", 20, 20, 20, "main terminal background (\\x1b[48;2;20;20;20m, 713x)"}
	goldSurfacePanel     = captureHex{"#111111", 17, 17, 17, "input interior / lower panel (\\x1b[48;2;17;17;17m, 194x)"}
	goldSurfaceHighlight = captureHex{"#242424", 36, 36, 36, "highlight/menu/input band (\\x1b[48;2;36;36;36m, 82x)"}
	goldSurfaceAltRow    = captureHex{"#1c1c1c", 28, 28, 28, "alt row / selected output bg (\\x1b[48;2;28;28;28m, 38x)"}
	goldSurfaceSelected  = captureHex{"#363636", 54, 54, 54, "strong selection bg, selected slash/model row (\\x1b[48;2;54;54;54m)"}
)

// Text tiers (foreground). Source: ansi-colors.md aggregate + by-capture.
var (
	goldTextPrimary   = captureHex{"#e1e1e1", 225, 225, 225, "primary fg, header/card/menu text (\\x1b[38;2;225;225;225m, 307x)"}
	goldTextSecondary = captureHex{"#c8c8c8", 200, 200, 200, "secondary fg / body output (\\x1b[38;2;200;200;200m, 230x)"}
	goldTextMuted     = captureHex{"#6c6c6c", 108, 108, 108, "muted separators/labels (\\x1b[38;2;108;108;108m, 447x)"}
	goldTextDim       = captureHex{"#585858", 88, 88, 88, "prompt glyph / dim details, cwd path (\\x1b[38;2;88;88;88m, 268x)"}
	goldTextFaint     = captureHex{"#505058", 80, 80, 88, "faint footer/status + input border accent (\\x1b[38;2;80;80;88m, 186x)"}
	goldTextLabel     = captureHex{"#808080", 128, 128, 128, "footer model label 'Composer 2.5' (\\x1b[38;2;128;128;128m)"}
)

// Accents. Source: ansi-colors.md by-capture + FINDINGS.md palette table.
var (
	goldAccentGreen  = captureHex{"#9ece6a", 158, 206, 106, "green success/hook-count/tool guide (\\x1b[38;2;158;206;106m, 30x)"}
	goldAccentRed    = captureHex{"#f7768e", 247, 118, 142, "red/pink error accent (\\x1b[38;2;247;118;142m, 27x)"}
	goldAccentBlue   = captureHex{"#7aa2f7", 122, 162, 247, "blue accent, slash command prefix (\\x1b[38;2;122;162;247m, 4x)"}
	goldAccentYellow = captureHex{"#e0af68", 224, 175, 104, "yellow/orange accent (\\x1b[38;2;224;175;104m, 6x)"}
	goldAccentCyan   = captureHex{"#3a95ab", 58, 149, 171, "cyan/teal accent, path emphasis (\\x1b[38;2;58;149;171m, 29x)"}
)

// Borders. Source: ansi-colors.md by-capture (input card + modal borders).
var (
	goldBorderInput = captureHex{"#505058", 80, 80, 88, "rounded input/card border (\\x1b[38;2;80;80;88m ╭─╮)"}
	goldBorderCard  = captureHex{"#333333", 51, 51, 51, "welcome card border (\\x1b[38;2;51;51;51m ╭─╮)"}
	goldBorderModal = captureHex{"#585858", 88, 88, 88, "settings modal border (\\x1b[38;2;88;88;88m │ ┌─┐)"}
)

// Embedded Grok Night/Day theme tables. Source: FINDINGS.md §3 + hex-rgb-string-context.txt.
var (
	// Grok Night (dark) bundled theme block.
	goldNightMagenta = captureHex{"#bb9af7", 187, 154, 247, "night magenta/purple (FINDINGS §3 dark block)"}
	goldNightBlue    = captureHex{"#7aa2f7", 122, 162, 247, "night blue (FINDINGS §3 dark block)"}
	goldNightCyan    = captureHex{"#73daca", 115, 218, 202, "night cyan/teal (FINDINGS §3 dark block)"}
	goldNightFg      = captureHex{"#c0caf5", 192, 202, 245, "night default fg (FINDINGS §3 dark block)"}
	goldNightGreen   = captureHex{"#9ece6a", 158, 206, 106, "night green (FINDINGS §3 dark block)"}
	goldNightRed     = captureHex{"#f7768e", 247, 118, 142, "night red (FINDINGS §3 dark block)"}

	// Grok Day (light) bundled theme block.
	goldDayBlue  = captureHex{"#2F64D2", 47, 100, 210, "day blue (FINDINGS §3 light block)"}
	goldDayRed   = captureHex{"#CD3048", 205, 48, 72, "day red (FINDINGS §3 light block)"}
	goldDayGreen = captureHex{"#0C947C", 12, 148, 124, "day green/teal (FINDINGS §3 light block)"}
)
