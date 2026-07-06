// Command qaharness is the manual-QA driver for the neo slash system (plan task
// 11): slash menu, @file mentions, bash mode, and the unknown-command error. It
// renders a chosen scene to stdout at a chosen width and color profile so a tmux
// pane can capture it (tmux capture-pane -e) and the xterm.js harness can extract
// the cell grid for assertions.
//
// Scenes (verbatim task-11 QA):
//
//	slash-mo     - the slash menu after typing "/mo" (grok popup; /model + /more
//	               style filter; the ⇥/tab completion target).
//	slash-model  - the slash menu with just "/model" typed (exact-match first).
//	at-file      - the @file-mention popup after typing "@<query>": drives the
//	               REAL fd walker (--at-base / --at-query) and renders the ranked
//	               file entries in the grok popup (@token in accent-blue).
//	bash-run     - a `!ls` bash block mid-stream (green $ prompt, streaming body).
//	bash-done    - the same block completed (exit 0, no status suffix).
//	bash-err     - a failed bash block ((exit 2) in the error color).
//	bash-excl    - a `!!` excluded block (dim prompt/border).
//	unknown      - the grok-style inline error for `/xyzcmd`.
//
// It is NOT a package test; it is invoked by hand during QA.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/charmbracelet/colorprofile"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/slash"
)

func main() {
	scene := flag.String("scene", "slash-mo", "scene: slash-mo|slash-model|at-file|bash-run|bash-done|bash-err|bash-excl|unknown")
	width := flag.Int("width", 120, "render width in columns")
	profileName := flag.String("profile", "truecolor", "color profile: truecolor|ansi256|ansi|nocolor")
	atBase := flag.String("at-base", ".", "base directory the @file scene walks with fd")
	atQuery := flag.String("at-query", "", "the @ query typed after '@' for the at-file scene (empty = list all)")
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
	case "slash-mo":
		lines = renderSlashMenu(th, profile, *width, "mo")
	case "slash-model":
		lines = renderSlashMenu(th, profile, *width, "model")
	case "at-file":
		lines = renderAtMenu(th, profile, *width, *atBase, *atQuery)
	case "bash-run":
		b := slash.NewBashBlock("ls", false, th)
		b.AppendOutput("README.md\ninternal\npackage.json")
		lines = renderAt(profile, b.Render(*width))
	case "bash-done":
		b := slash.NewBashBlock("ls", false, th)
		b.AppendOutput("README.md\ninternal\npackage.json")
		b.SetComplete(0, false)
		lines = renderAt(profile, b.Render(*width))
	case "bash-err":
		b := slash.NewBashBlock("false", false, th)
		b.AppendOutput("command failed")
		b.SetComplete(2, false)
		lines = renderAt(profile, b.Render(*width))
	case "bash-excl":
		b := slash.NewBashBlock("echo secret", true, th)
		b.AppendOutput("secret")
		b.SetComplete(0, false)
		lines = renderAt(profile, b.Render(*width))
	case "unknown":
		msg := slash.UnknownCommandError("xyzcmd")
		lines = renderAt(profile, []string{th.AccentRed().Render(msg)})
	default:
		fmt.Fprintln(os.Stderr, "unknown scene:", *scene)
		os.Exit(2)
	}

	fmt.Print(strings.Join(lines, "\n"))
	fmt.Print("\n")
}

// renderSlashMenu builds the merged command set (builtins only for QA; dynamic
// commands come from get_commands live), runs the CombinedProvider's slash
// filter for the typed prefix, and renders the grok popup.
func renderSlashMenu(th *theme.Theme, profile colorprofile.Profile, width int, prefix string) []string {
	merged := slash.MergeCommands(nil) // builtins only for the offline harness
	provider := slash.NewCombinedProvider(slash.AsCommands(merged), ".", "")
	line := "/" + prefix
	sugg, _ := provider.GetSuggestions([]string{line}, 0, len([]rune(line)), false)
	var items []editor.Item
	if sugg != nil {
		items = sugg.Items
	}
	menu := slash.NewSlashMenu(th, items, 6, len(merged))
	return menu.RenderAt(profile, width)
}

// renderAtMenu drives the REAL @file completion path: it constructs a
// CombinedProvider rooted at atBase with the resolved fd binary, asks it for the
// suggestions for the line "@<query>" (which shells out to fd and fuzzy-ranks the
// results), then renders those entries through the grok popup primitive. The @
// mention token renders in the accent-blue command color exactly like the slash
// token (the popup colorizes the leading token up to the first double-space gap),
// so a cell-grid assertion can bind the "@" glyph + accent-blue fg.
//
// If fd is absent the scene errors out (exit 3) rather than rendering a fake menu
// — the QA claim requires the real walker.
func renderAtMenu(th *theme.Theme, profile colorprofile.Profile, width int, atBase, atQuery string) []string {
	fdPath := resolveFd()
	if fdPath == "" {
		fmt.Fprintln(os.Stderr, "at-file scene requires fd on PATH")
		os.Exit(3)
	}
	provider := slash.NewCombinedProvider(nil, atBase, fdPath)
	line := "@" + atQuery
	sugg, err := provider.GetSuggestionsCtx(context.Background(), []string{line}, 0, len([]rune(line)), false)
	if err != nil {
		fmt.Fprintln(os.Stderr, "@ completion error:", err)
		os.Exit(3)
	}
	if sugg == nil || len(sugg.Items) == 0 {
		fmt.Fprintln(os.Stderr, "@ completion returned no entries for base", atBase)
		os.Exit(3)
	}
	// Build grok popup items: the @mention token is the item Value (already
	// "@name" / "@dir/"); the description carries the display path. This mirrors
	// the live editor @ popup — the token is the attachment string the user gets.
	selItems := make([]ui.SelectItem, len(sugg.Items))
	for i, it := range sugg.Items {
		selItems[i] = ui.SelectItem{Label: it.Value, Value: it.Value, Description: it.Description}
	}
	menu := ui.NewSlashMenu(th, selItems, 6, len(sugg.Items))
	return menu.RenderAt(profile, width)
}

// resolveFd finds the fd binary (fd or fdfind), matching the test helper's
// lookup order.
func resolveFd() string {
	for _, name := range []string{"fd", "fdfind"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func renderAt(profile colorprofile.Profile, raw []string) []string {
	out := make([]string, len(raw))
	for i, l := range raw {
		out[i] = theme.RenderAtRaw(profile, l)
	}
	return out
}
