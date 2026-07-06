package theme

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// mustMarshal JSON-encodes v or fails the test.
func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// This file bridges the Go theme goldens to the xterm.js evidence harness. Per
// the plan's EVIDENCE FORMAT RULE, EVERY visual assertion executes against the
// PARSED CELL GRID produced by qa/xterm-render.mjs, never against raw escape
// strings. The Go tests render a themed line, pipe its .ans through the harness
// to obtain a cell grid, then assert exact fg/bg hex + glyph per cell.

// cell mirrors one cell of the harness grid JSON.
type cell struct {
	X     int    `json:"x"`
	Y     int    `json:"y"`
	Glyph string `json:"glyph"`
	Width int    `json:"width"`
	FG    struct {
		Mode  string  `json:"mode"`
		Hex   *string `json:"hex"`
		Index *int    `json:"index"`
	} `json:"fg"`
	BG struct {
		Mode  string  `json:"mode"`
		Hex   *string `json:"hex"`
		Index *int    `json:"index"`
	} `json:"bg"`
	Attrs struct {
		Bold          bool `json:"bold"`
		Dim           bool `json:"dim"`
		Italic        bool `json:"italic"`
		Underline     bool `json:"underline"`
		Inverse       bool `json:"inverse"`
		Invisible     bool `json:"invisible"`
		Strikethrough bool `json:"strikethrough"`
	} `json:"attrs"`
}

// grid mirrors the harness grid JSON envelope.
type grid struct {
	Cols  int      `json:"cols"`
	Rows  int      `json:"rows"`
	Cells [][]cell `json:"cells"`
}

// harnessPath resolves qa/xterm-render.mjs relative to this test file.
func harnessPath(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd() // .../packages/neo/internal/theme
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	p := filepath.Join(wd, "..", "..", "qa", "xterm-render.mjs")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("harness not found at %s: %v", p, err)
	}
	return p
}

// nodeAvailable reports whether a `node` binary is on PATH.
func nodeAvailable() bool {
	_, err := exec.LookPath("node")
	return err == nil
}

// renderThroughHarness writes ansText to a temp .ans, invokes the harness in
// render mode, and returns the parsed cell grid.
func renderThroughHarness(t *testing.T, ansText string, cols, rows int) grid {
	t.Helper()
	if !nodeAvailable() {
		t.Skip("node not on PATH; harness-backed grid assertions require node + @xterm/headless")
	}
	dir := t.TempDir()
	ansFile := filepath.Join(dir, "frame.ans")
	if err := os.WriteFile(ansFile, []byte(ansText), 0o600); err != nil {
		t.Fatalf("write ans: %v", err)
	}
	jsonFile := filepath.Join(dir, "frame.json")
	cmd := exec.Command("node", harnessPath(t), "render", ansFile,
		"--cols", itoa(cols), "--rows", itoa(rows), "--out-json", jsonFile)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("harness render failed: %v\nstderr: %s", err, stderr.String())
	}
	raw, err := os.ReadFile(jsonFile)
	if err != nil {
		t.Fatalf("read grid json: %v", err)
	}
	var g grid
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("unmarshal grid: %v", err)
	}
	return g
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// assertCellFG fails unless the grid cell at (x,y) has the exact truecolor fg hex.
func assertCellFG(t *testing.T, g grid, x, y int, wantHex string) {
	t.Helper()
	c := g.Cells[y][x]
	if c.FG.Mode != "rgb" || c.FG.Hex == nil {
		t.Fatalf("cell (%d,%d): want truecolor fg %s, got mode=%q hex=%v", x, y, wantHex, c.FG.Mode, c.FG.Hex)
	}
	if !strings.EqualFold(*c.FG.Hex, wantHex) {
		t.Fatalf("cell (%d,%d) fg: want %s, got %s", x, y, wantHex, *c.FG.Hex)
	}
}

// assertCellBG fails unless the grid cell at (x,y) has the exact truecolor bg hex.
func assertCellBG(t *testing.T, g grid, x, y int, wantHex string) {
	t.Helper()
	c := g.Cells[y][x]
	if c.BG.Mode != "rgb" || c.BG.Hex == nil {
		t.Fatalf("cell (%d,%d): want truecolor bg %s, got mode=%q hex=%v", x, y, wantHex, c.BG.Mode, c.BG.Hex)
	}
	if !strings.EqualFold(*c.BG.Hex, wantHex) {
		t.Fatalf("cell (%d,%d) bg: want %s, got %s", x, y, wantHex, *c.BG.Hex)
	}
}

// assertCellGlyph fails unless the grid cell at (x,y) shows the exact glyph.
func assertCellGlyph(t *testing.T, g grid, x, y int, wantGlyph string) {
	t.Helper()
	c := g.Cells[y][x]
	if c.Glyph != wantGlyph {
		t.Fatalf("cell (%d,%d) glyph: want %q, got %q", x, y, wantGlyph, c.Glyph)
	}
}

// assertNoTruecolor fails if ANY cell in the grid carries a truecolor fg/bg.
// Used by the 256-color / NO_COLOR fallback goldens.
func assertNoTruecolor(t *testing.T, g grid) {
	t.Helper()
	for y := range g.Cells {
		for x := range g.Cells[y] {
			c := g.Cells[y][x]
			if c.FG.Mode == "rgb" || c.BG.Mode == "rgb" {
				t.Fatalf("cell (%d,%d) unexpectedly truecolor: fg=%q bg=%q", x, y, c.FG.Mode, c.BG.Mode)
			}
		}
	}
}
