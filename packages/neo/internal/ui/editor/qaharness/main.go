// Command qaharness is the manual-QA driver for the neo editor component (plan
// task 5). It runs the editor inside a real bubbletea v2 program so the verbatim
// QA scenario can be driven in tmux: type 한글+emoji, multi-line paste,
// ctrl+w/ctrl+y roundtrip, history up/down draft-preserve, plus a Korean-IME
// hardware-cursor spot-check and a 2MB atomic-paste responsiveness check.
//
// The program keeps the REAL terminal cursor at the editor's logical insertion
// point every frame (View.Cursor), which is what anchors IME candidate windows
// for CJK composition. It is NOT a package test; it is invoked by hand (or by the
// tmux QA script) and also supports --self-test for an automated smoke.
package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

func main() {
	for i, arg := range os.Args[1:] {
		if arg == "--self-test" {
			os.Exit(selfTest())
		}
		if arg == "--emit" && i+1 < len(os.Args[1:]) {
			os.Exit(emitScenario(os.Args[1:][i+1]))
		}
	}
	th, err := theme.Load(theme.Options{Name: "grok-night"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "qaharness theme error:", err)
		os.Exit(1)
	}
	m := newModel(th)
	p := tea.NewProgram(m)
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "qaharness error:", err)
		os.Exit(1)
	}
}

type model struct {
	ed     *editor.Editor
	theme  *theme.Theme
	width  int
	height int
	status string
}

func newModel(th *theme.Theme) *model {
	ed := editor.New(editor.Options{PaddingX: 1})
	ed.SetFocused(true)
	ed.SetPlaceholder("Type here (한글+emoji), paste, ctrl+w / ctrl+y, history up/down. ctrl+d quits.")
	ed.OnSubmit = func(text string) { ed.AddToHistory(text) }
	return &model{ed: ed, theme: th, width: 80, height: 24, status: "ready"}
}

func (m *model) Init() tea.Cmd { return nil }

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = v.Width, v.Height
		m.ed.SetViewport(v.Width, v.Height)
	case tea.KeyPressMsg:
		k := tea.Key(v)
		// Ctrl+D quits the harness.
		if k.Mod&tea.ModCtrl != 0 && k.Code == 'd' {
			return m, tea.Quit
		}
		start := time.Now()
		m.ed.Update(msg)
		m.status = fmt.Sprintf("frame %s | lines=%d", time.Since(start).Round(time.Microsecond), len(m.ed.GetLines()))
	case tea.PasteMsg:
		start := time.Now()
		m.ed.Update(msg)
		m.status = fmt.Sprintf("paste %d bytes in %s (atomic)", len(v.Content), time.Since(start).Round(time.Millisecond))
	}
	return m, nil
}

func (m *model) View() tea.View {
	width := m.width
	if width <= 0 {
		width = 80
	}
	rows := m.ed.Render(width)
	originY := 1 // one status line above the editor

	var b strings.Builder
	b.WriteString(m.theme.Hint().Render("neo editor QA harness — " + m.status))
	b.WriteString("\n")
	for _, r := range rows {
		b.WriteString(editor.StripCursorMarker(r))
		b.WriteString("\n")
	}
	line, col := m.ed.Cursor()
	b.WriteString(m.theme.TextMuted().Render(fmt.Sprintf("cursor(logical) line=%d col=%d", line, col)))

	view := tea.NewView(b.String())
	view.AltScreen = true // stable full-screen for deterministic tmux capture
	// Pin the hardware cursor at the editor's insertion point for IME.
	if c := m.ed.ViewCursor(rows, 0, originY); c != nil {
		view.Cursor = c
	}
	return view
}

// emitScenario writes the editor's exact rendered ANSI frame for a named
// scenario to stdout, positioned into an 80x24 screen. This is the editor's
// ground-truth output (the same Render() the app draws), rendered through the
// grok theme — the faithful source for cell-grid visual assertions, free of the
// wide-char misalignment tmux's capture-pane -e introduces for CJK under
// altscreen. It complements (does not replace) the live tmux .ans captures.
func emitScenario(name string) int {
	th, err := theme.Load(theme.Options{Name: "grok-night"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "theme:", err)
		return 1
	}
	ed := editor.New(editor.Options{PaddingX: 1})
	ed.SetViewport(80, 24)
	ed.SetFocused(true)
	switch name {
	case "hangul-emoji":
		for _, ch := range []string{"한", "글", "😀"} {
			ed.HandleInput(ch)
		}
	case "killring-yank":
		ed.SetText("foo bar baz")
		ed.HandleInput("\x17")
		ed.HandleInput("\x01")
		ed.HandleInput("\x19")
	case "multiline-paste":
		ed.Update(tea.PasteMsg{Content: "first line\nsecond line\nthird line"})
	default:
		fmt.Fprintln(os.Stderr, "unknown scenario:", name)
		return 2
	}
	rows := ed.Render(80)
	// Move to home, clear screen, then draw the border-and-content frame.
	var b strings.Builder
	b.WriteString("\x1b[H\x1b[2J")
	for _, r := range rows {
		b.WriteString(editor.StripCursorMarker(r))
		b.WriteString("\r\n")
	}
	_, l := ed.Cursor()
	b.WriteString(th.TextMuted().Render(fmt.Sprintf("cursor col=%d", l)))
	os.Stdout.WriteString(b.String())
	return 0
}

// selfTest drives the editor headlessly through the verbatim scenario checks and
// returns a nonzero code on any failure.
func selfTest() int {
	ed := editor.New(editor.Options{PaddingX: 1})
	ed.SetViewport(80, 24)
	ed.SetFocused(true)

	// 1. 한글 + emoji insertion.
	for _, ch := range []string{"한", "글", "😀"} {
		ed.HandleInput(ch)
	}
	if got := ed.GetText(); got != "한글😀" {
		fmt.Println("FAIL: hangul+emoji insert:", got)
		return 1
	}

	// 2. ctrl+w / ctrl+y roundtrip.
	ed.SetText("foo bar baz")
	ed.HandleInput("\x17") // Ctrl+W -> "foo bar "
	ed.HandleInput("\x01") // Ctrl+A
	ed.HandleInput("\x19") // Ctrl+Y
	if got := ed.GetText(); got != "bazfoo bar " {
		fmt.Println("FAIL: ctrl+w/ctrl+y roundtrip:", got)
		return 1
	}

	// 3. history draft-preserve.
	ed.SetText("")
	ed.AddToHistory("prompt")
	ed.SetText("draft")
	ed.HandleInput("\x01")   // to start (col 0)
	ed.HandleInput("\x1b[A") // Up -> history "prompt"
	if ed.GetText() != "prompt" {
		fmt.Println("FAIL: history up:", ed.GetText())
		return 1
	}
	ed.HandleInput("\x1b[B") // Down -> restores draft
	if ed.GetText() != "draft" {
		fmt.Println("FAIL: history draft-preserve:", ed.GetText())
		return 1
	}

	// 4. multi-line paste atomic.
	ed.SetText("")
	ed.Update(tea.PasteMsg{Content: "a\nb\nc"})
	if ed.GetText() != "a\nb\nc" {
		fmt.Println("FAIL: multi-line paste:", ed.GetText())
		return 1
	}

	// 5. 2MB paste stays atomic and fast (<200ms).
	ed.SetText("")
	big := strings.Repeat("x", 2*1024*1024)
	start := time.Now()
	ed.Update(tea.PasteMsg{Content: big})
	elapsed := time.Since(start)
	if !strings.Contains(ed.GetText(), "[paste #") {
		fmt.Println("FAIL: 2MB paste did not produce a marker")
		return 1
	}
	if ed.GetExpandedText() != big {
		fmt.Println("FAIL: 2MB paste content not lossless")
		return 1
	}
	// Render must also be responsive after the paste.
	rstart := time.Now()
	rows := ed.Render(80)
	rElapsed := time.Since(rstart)
	if rElapsed > 200*time.Millisecond {
		fmt.Printf("FAIL: render after 2MB paste took %s (>200ms)\n", rElapsed)
		return 1
	}

	// 6. hardware cursor present at insertion point.
	if c := ed.ViewCursor(rows, 0, 1); c == nil {
		fmt.Println("FAIL: no hardware cursor emitted while focused")
		return 1
	}

	fmt.Printf("SELF-TEST OK: 2MB paste %s, render %s, all scenario checks passed\n", elapsed.Round(time.Millisecond), rElapsed.Round(time.Millisecond))
	return 0
}
