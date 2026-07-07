// Command qaharness is the manual-QA driver for the neo app Model (plan task 1).
// It runs the REAL root Model inside a live bubbletea v2 program — no alternate
// screen — so a tmux pane can capture the composed frame:
//
//	tmux send-keys 'go run ./internal/app/qaharness --scene welcome' Enter
//	tmux capture-pane -e -p > frame.ans
//
// Unlike the shell qaharness (which prints a single scene and exits), this driver
// exercises the assembled Model.View through a running program and stays alive
// until the terminal quits it (app.exit on an empty editor) or it is killed —
// matching the editor qaharness pattern, since the frame under test is the live
// program's own output.
//
// Scenes:
//
//	welcome - the pre-first-turn frame: the composed welcome card (wide bordered
//	          card at >= 100 cols, compact centered layout below).
//
// It is NOT a package test; it is invoked by hand or by the tmux QA script.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
)

const appName = "senpi"

func main() {
	scene := flag.String("scene", "welcome", "scene: welcome")
	flag.Parse()

	if *scene != "welcome" {
		fmt.Fprintln(os.Stderr, "unknown scene:", *scene)
		os.Exit(2)
	}

	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	if err != nil {
		fmt.Fprintln(os.Stderr, "theme.Load:", err)
		os.Exit(1)
	}
	keys := keybindings.NewManager(nil)

	p := app.NewProgram(app.Deps{
		Theme:   th,
		Keys:    keys,
		AppName: appName,
		Welcome: welcomeContent(keys),
	})
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "qaharness error:", err)
		os.Exit(1)
	}
}

// welcomeContent builds the startup card content, resolving every menu key hint
// through the keybinding manager (no literal key strings).
func welcomeContent(keys *keybindings.Manager) shell.WelcomeContent {
	return shell.WelcomeContent{
		Title: appName,
		Menu: []shell.MenuEntry{
			{Label: "Resume session", Key: firstKey(keys, "app.sessions.observe")},
			{Label: "Search history", Key: firstKey(keys, "app.history.search")},
			{Label: "Quit", Key: firstKey(keys, "app.exit")},
		},
	}
}

func firstKey(keys *keybindings.Manager, action string) string {
	if k := keys.Keys(action); len(k) > 0 {
		return k[0]
	}
	return ""
}
