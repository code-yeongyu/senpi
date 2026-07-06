package theme

// Palette holds the neo TUI's exact colors as `#rrggbb` hex strings. Every
// value is transcribed from the grok build CLI captures:
//   - runtime SGR → hex: .omo/research/neo-grok/ansi-colors.md
//   - aggregate + embedded Night/Day tables: .omo/research/neo-grok/FINDINGS.md
//
// NO color here is approximated: each is the truecolor value the real grok TUI
// emitted (24-bit). The golden tests re-derive these same hexes from the
// captures independently (golden_hexes.go) and assert the rendered cells match.
type Palette struct {
	// Surfaces (background layers).
	SurfaceBase      string // #141414 main terminal background
	SurfacePanel     string // #111111 input interior / lower panel
	SurfaceHighlight string // #242424 highlight/menu/input band
	SurfaceAltRow    string // #1c1c1c alt row / selected output bg
	SurfaceSelected  string // #363636 strong selection bg (selected slash/model row)

	// Text tiers (foreground).
	TextPrimary   string // #e1e1e1 primary fg, header/card/menu text
	TextSecondary string // #c8c8c8 secondary fg / body output
	TextMuted     string // #6c6c6c muted separators/labels
	TextDim       string // #585858 prompt glyph / dim details / cwd path
	TextFaint     string // #505058 faint footer + input border accent
	TextLabel     string // #808080 footer model label

	// Accents.
	AccentGreen  string // #9ece6a success / hook-count / tool guide
	AccentRed    string // #f7768e error / red-pink
	AccentBlue   string // #7aa2f7 slash-command prefix / info
	AccentYellow string // #e0af68 warning / orange
	AccentCyan   string // #3a95ab path emphasis / teal

	// Borders.
	BorderInput string // #505058 rounded input/card border
	BorderCard  string // #333333 welcome card border
	BorderModal string // #585858 settings modal border
}

// grokNight is the neo default palette (dark grok build skin). Hexes verbatim
// from ansi-colors.md aggregate + by-capture rows.
var grokNight = Palette{
	SurfaceBase:      "#141414",
	SurfacePanel:     "#111111",
	SurfaceHighlight: "#242424",
	SurfaceAltRow:    "#1c1c1c",
	SurfaceSelected:  "#363636",

	TextPrimary:   "#e1e1e1",
	TextSecondary: "#c8c8c8",
	TextMuted:     "#6c6c6c",
	TextDim:       "#585858",
	TextFaint:     "#505058",
	TextLabel:     "#808080",

	AccentGreen:  "#9ece6a",
	AccentRed:    "#f7768e",
	AccentBlue:   "#7aa2f7",
	AccentYellow: "#e0af68",
	AccentCyan:   "#3a95ab",

	BorderInput: "#505058",
	BorderCard:  "#333333",
	BorderModal: "#585858",
}

// grokDay is the light grok skin. Surfaces/text are inverted; accents are taken
// from the embedded Day (light) block in FINDINGS.md §3 / hex-rgb-string-context.
var grokDay = Palette{
	SurfaceBase:      "#f6f6f6",
	SurfacePanel:     "#e6e6e6",
	SurfaceHighlight: "#e0e0e0",
	SurfaceAltRow:    "#ececec",
	SurfaceSelected:  "#d9d9d9",

	TextPrimary:   "#171717",
	TextSecondary: "#3a3a3a",
	TextMuted:     "#626262",
	TextDim:       "#8e8e8e",
	TextFaint:     "#b0b0b0",
	TextLabel:     "#808080",

	AccentGreen:  "#0C947C", // day green/teal
	AccentRed:    "#CD3048", // day red
	AccentBlue:   "#2F64D2", // day blue
	AccentYellow: "#A27612", // day amber
	AccentCyan:   "#0082AA", // day cyan

	BorderInput: "#5A6880",
	BorderCard:  "#b0b0b0",
	BorderModal: "#626262",
}

// builtinPalettes maps builtin theme names to their palettes.
var builtinPalettes = map[string]Palette{
	"grok-night": grokNight,
	"grok-day":   grokDay,
}

// DefaultThemeName is the neo default: the dark grok skin.
const DefaultThemeName = "grok-night"

// Glyphs are the exact grok TUI marks (FINDINGS.md §4). Kept with the palette so
// a theme carries a complete visual identity.
const (
	// GlyphToolGuide is the vertical guide before tool-call rows: `┃`.
	GlyphToolGuide = "┃"
	// GlyphEventMarker marks session/user/hook/stop/tool events: `◆`.
	GlyphEventMarker = "◆"
	// GlyphPrompt is the input/selected-row prompt glyph: `❯`.
	GlyphPrompt = "❯"
	// GlyphBranch precedes the git branch in the header.
	GlyphBranch = ""
	// GlyphSettingsRow marks settings rows: `▸`.
	GlyphSettingsRow = "▸"
	// GlyphExpandable marks expandable settings rows: `›`.
	GlyphExpandable = "›"
	// GlyphBullet is the help/example bullet: `•`.
	GlyphBullet = "•"
)

// spinnerFrames is the grok braille spinner family. The captures show
// `⠧ ⠹ ⠼ ⠙ ⠦` in session/MCP/waiting states (FINDINGS.md §4); the full
// single-step braille cycle is used so animation is smooth while including
// every observed frame.
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
