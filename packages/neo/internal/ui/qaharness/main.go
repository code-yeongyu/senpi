// Command qaharness is the manual-QA driver for the neo primitive components
// (plan task 8). It renders a chosen grok-styled scene to stdout at a chosen
// width and color profile so a tmux pane can capture it (tmux capture-pane -e)
// and the xterm.js harness can extract the cell grid for assertions.
//
// Scenes (verbatim task-8 QA):
//
//	slash        - the grok slash/autocomplete menu (rule + count marker,
//	               ❯-selected row in accent-blue, scrollbar block).
//	settings     - the grok settings modal body (▸ cursor, aligned values,
//	               expandable › rows).
//	slash-empty  - failure edge: empty filtered list (no crash, no-match line).
//	slash-one    - failure edge: single-item list (no scroll marker).
//
// It is NOT a package test; it is invoked by hand during QA. Navigation is
// scripted via --select N (0-based highlighted row).
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/colorprofile"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

func main() {
	scene := flag.String("scene", "slash", "scene: slash|settings|slash-empty|slash-one")
	width := flag.Int("width", 120, "render width in columns")
	profileName := flag.String("profile", "truecolor", "color profile: truecolor|ansi256|ansi|nocolor")
	sel := flag.Int("select", 0, "0-based highlighted row")
	flag.Parse()

	profile, err := theme.ProfileFromName(*profileName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad profile:", err)
		os.Exit(2)
	}
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		fmt.Fprintln(os.Stderr, "theme.Load:", err)
		os.Exit(2)
	}

	var lines []string
	switch *scene {
	case "slash":
		lines = renderSlash(th, profile, *width, slashItems(), *sel)
	case "slash-empty":
		lines = renderSlash(th, profile, *width, nil, 0)
	case "slash-one":
		lines = renderSlash(th, profile, *width, slashItems()[:1], 0)
	case "settings":
		lines = renderSettings(th, profile, *width, *sel)
	default:
		fmt.Fprintln(os.Stderr, "unknown scene:", *scene)
		os.Exit(2)
	}

	// Emit each frame line on its own row. We use LF only and never a trailing
	// newline after the last line, so a tmux capture-pane records exactly one
	// pane row per frame line with no soft-wrap artifacts. The QA script renders
	// the frame in a pane WIDER than --width, so a full-width line never reaches
	// the auto-wrap column.
	fmt.Print(strings.Join(lines, "\n"))
	fmt.Print("\n")
}

func slashItems() []ui.SelectItem {
	return []ui.SelectItem{
		{Value: "/quit", Label: "/quit", Description: "Quit the application"},
		{Value: "/home", Label: "/home", Description: "Return to the welcome screen"},
		{Value: "/new", Label: "/new", Description: "Start a new session"},
		{Value: "/chat", Label: "/chat", Description: "Start a remote chat session (gateway light-frontend)"},
		{Value: "/fork", Label: "/fork", Description: "Branch the current session into a peer agent"},
		{Value: "/compact", Label: "/compact", Description: "Compact conversation history"},
	}
}

func renderSlash(th *theme.Theme, profile colorprofile.Profile, width int, items []ui.SelectItem, sel int) []string {
	menu := ui.NewSlashMenu(th, items, 6, 47)
	menu.List().SetSelectedIndex(sel)
	return menu.RenderAt(profile, width)
}

func renderSettings(th *theme.Theme, profile colorprofile.Profile, width int, sel int) []string {
	items := []ui.SettingItem{
		{ID: "compact", Label: "Compact mode", CurrentValue: "off", Values: []string{"off", "on"}},
		{ID: "timestamps", Label: "Show timestamps", CurrentValue: "on", Values: []string{"on", "off"}},
		{ID: "vim", Label: "Disable vim input mode", CurrentValue: "on", Values: []string{"on", "off"}},
		{ID: "theme", Label: "Theme", CurrentValue: "Grok Night", Expandable: true},
		{ID: "autodark", Label: "Auto dark theme", CurrentValue: "Grok Night", Expandable: true},
		{ID: "thoughts", Label: "Max thoughts width", CurrentValue: "120", Values: []string{"120", "80"}},
	}
	slt := ui.SettingsListTheme{
		Label: func(s string, selected bool) string {
			if selected {
				return th.TextPrimary().Render(s)
			}
			return th.TextSecondary().Render(s)
		},
		Value:       func(s string, _ bool) string { return th.TextMuted().Render(s) },
		Description: func(s string) string { return th.TextDim().Render(s) },
		Hint:        func(s string) string { return th.Hint().Render(s) },
		Cursor:      th.AccentGreen().Render(theme.GlyphSettingsRow) + " ",
	}
	sl := ui.NewSettingsList(items, len(items), slt)
	sl.SetSelectedIndex(sel)
	raw := sl.Render(width)
	out := make([]string, len(raw))
	for i, l := range raw {
		out[i] = theme.RenderAtRaw(profile, l)
	}
	return out
}
