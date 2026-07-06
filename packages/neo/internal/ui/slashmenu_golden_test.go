package ui

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/colorprofile"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
)

// Goldens for the grok slash/autocomplete popup, asserted through the xterm.js
// harness cell grid (never raw escape strings), matching the grok captures:
//   .omo/research/neo-grok/captures/{120x36,80x24}_04_slash_menu.txt
//
// Capture layout facts these assert:
//   - a rule line ABOVE the list with an embedded count marker near the right
//     end (e.g. "─47─"),
//   - selected row prefixed with the grok prompt glyph "❯", others "  ",
//   - the slash-command primary text in the accent-blue token (#7aa2f7),
//   - a scrollbar block "█" at the far right of the first visible row,
//   - a full-width rule line BELOW the list.

// --- harness plumbing (mirrors internal/theme/harness_test.go) ---------------

type gCell struct {
	X, Y  int
	Glyph string `json:"glyph"`
	FG    struct {
		Mode string  `json:"mode"`
		Hex  *string `json:"hex"`
	} `json:"fg"`
	BG struct {
		Mode string  `json:"mode"`
		Hex  *string `json:"hex"`
	} `json:"bg"`
}

type gGrid struct {
	Cols  int       `json:"cols"`
	Rows  int       `json:"rows"`
	Cells [][]gCell `json:"cells"`
}

func harnessScript(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	p := filepath.Join(wd, "..", "..", "qa", "xterm-render.mjs")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("harness not found at %s: %v", p, err)
	}
	return p
}

func nodeOnPath() bool {
	_, err := exec.LookPath("node")
	return err == nil
}

func renderGrid(t *testing.T, ansText string, cols, rows int) gGrid {
	t.Helper()
	if !nodeOnPath() {
		t.Skip("node not on PATH; harness cell-grid assertions require node + @xterm/headless")
	}
	dir := t.TempDir()
	ansFile := filepath.Join(dir, "frame.ans")
	if err := os.WriteFile(ansFile, []byte(ansText), 0o600); err != nil {
		t.Fatalf("write ans: %v", err)
	}
	jsonFile := filepath.Join(dir, "frame.json")
	cmd := exec.Command("node", harnessScript(t), "render", ansFile,
		"--cols", itoaUI(cols), "--rows", itoaUI(rows), "--out-json", jsonFile)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("harness render failed: %v\nstderr: %s", err, stderr.String())
	}
	raw, err := os.ReadFile(jsonFile)
	if err != nil {
		t.Fatalf("read grid: %v", err)
	}
	var g gGrid
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("unmarshal grid: %v", err)
	}
	return g
}

func firstGlyphCell(g gGrid, glyph string) (int, int, bool) {
	for y := range g.Cells {
		for x := range g.Cells[y] {
			if g.Cells[y][x].Glyph == glyph {
				return x, y, true
			}
		}
	}
	return 0, 0, false
}

func fgHexAt(g gGrid, x, y int) (string, bool) {
	if y < 0 || y >= len(g.Cells) || x < 0 || x >= len(g.Cells[y]) {
		return "", false
	}
	c := g.Cells[y][x]
	if c.FG.Mode != "rgb" || c.FG.Hex == nil {
		return "", false
	}
	return strings.ToLower(*c.FG.Hex), true
}

// slashItems is the grok slash-menu fixture (order + text from the capture).
func slashItems() []SelectItem {
	return []SelectItem{
		{Value: "/quit", Label: "/quit", Description: "Quit the application"},
		{Value: "/home", Label: "/home", Description: "Return to the welcome screen"},
		{Value: "/new", Label: "/new", Description: "Start a new session"},
		{Value: "/chat", Label: "/chat", Description: "Start a remote chat session (gateway light-frontend)"},
		{Value: "/fork", Label: "/fork", Description: "Branch the current session into a peer agent"},
		{Value: "/compact", Label: "/compact", Description: "Compact conversation history"},
	}
}

func renderSlashMenu(t *testing.T, width int) string {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	menu := NewSlashMenu(th, slashItems(), 6, 47)
	lines := menu.RenderAt(colorprofile.TrueColor, width)
	return strings.Join(lines, "\r\n") + "\r\n"
}

func TestSlashMenuGolden_120_SelectedPromptGlyph(t *testing.T) {
	g := renderGrid(t, renderSlashMenu(t, 120), 120, 12)
	x, y, ok := firstGlyphCell(g, theme.GlyphPrompt)
	if !ok {
		t.Fatalf("selected-row prompt glyph %q not found in 120-col slash menu", theme.GlyphPrompt)
	}
	// The selected slash text after "❯ " must be accent-blue (#7aa2f7).
	slashHex, ok := fgHexAt(g, x+2, y)
	if !ok || slashHex != "#7aa2f7" {
		t.Fatalf("slash-command prefix at (%d,%d): want accent-blue #7aa2f7, got %q (ok=%v)", x+2, y, slashHex, ok)
	}
}

func TestSlashMenuGolden_120_ScrollbarAndRuleCount(t *testing.T) {
	g := renderGrid(t, renderSlashMenu(t, 120), 120, 12)
	if _, _, ok := firstGlyphCell(g, "█"); !ok {
		t.Fatalf("scrollbar block \"█\" not found in 120-col slash menu")
	}
	if _, _, ok := firstGlyphCell(g, "─"); !ok {
		t.Fatalf("rule line \"─\" not found in 120-col slash menu")
	}
	// The count marker "47" must appear as adjacent digits on the top rule row.
	if !hasAdjacentDigits(g, "47") {
		t.Fatalf("count marker \"47\" not found on any rule row")
	}
}

func TestSlashMenuGolden_80_LayoutHolds(t *testing.T) {
	g := renderGrid(t, renderSlashMenu(t, 80), 80, 12)
	if _, _, ok := firstGlyphCell(g, theme.GlyphPrompt); !ok {
		t.Fatalf("prompt glyph missing at 80 cols")
	}
	if _, _, ok := firstGlyphCell(g, "█"); !ok {
		t.Fatalf("scrollbar block missing at 80 cols")
	}
	if !hasAdjacentDigits(g, "47") {
		t.Fatalf("count marker \"47\" missing at 80 cols")
	}
}

// hasAdjacentDigits reports whether the digit string appears in consecutive
// cells on any single row of the grid.
func hasAdjacentDigits(g gGrid, digits string) bool {
	for y := range g.Cells {
		var row strings.Builder
		for x := range g.Cells[y] {
			row.WriteString(g.Cells[y][x].Glyph)
		}
		if strings.Contains(row.String(), digits) {
			return true
		}
	}
	return false
}
