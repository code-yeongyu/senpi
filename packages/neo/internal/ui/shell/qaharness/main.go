// Command qaharness is the manual-QA driver for the neo app-shell components
// (plan task 10). It renders a chosen shell scene to stdout at a chosen width +
// color profile so a tmux pane can capture it (tmux capture-pane -e) and the
// xterm.js harness (qa/xterm-render.mjs) can extract the cell grid for
// assertions.
//
// Scenes (verbatim task-10 QA):
//
//	welcome   - the startup welcome card: bordered text-only card at wide
//	            widths, compact centered text + version bottom-right at narrow.
//	footer    - the input footer HUD (cwd/tokens/context + model:thinking).
//	status    - the working/retry/compaction/branchSummary status stack.
//	queue     - the pending steering/follow-up messages area.
//	degrade   - a tiny (40x10-style) render proving no panic at small sizes.
//
// It is NOT a package test; it is invoked by hand (or by the QA script) during
// QA. The emitted frame is a qaharness --emit frame, NOT a tmux capture — the QA
// script wraps this in a real tmux pane to produce the .ans triplet leg.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/shell"
)

func main() {
	scene := flag.String("scene", "welcome", "scene: welcome|footer|status|queue|degrade")
	width := flag.Int("width", 120, "render width in columns")
	profileName := flag.String("profile", "truecolor", "color profile: truecolor|ansi256|ansi|nocolor")
	statusKind := flag.String("status", "working", "status scene kind: working|retry|compaction|branch")
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
	case "welcome":
		lines = renderWelcome(th, *width)
	case "footer":
		lines = renderFooter(th, *width)
	case "status":
		lines = renderStatus(th, *width, *statusKind)
	case "queue":
		lines = renderQueue(th, *width)
	case "degrade":
		lines = renderDegrade(th, *width)
	default:
		fmt.Fprintln(os.Stderr, "unknown scene:", *scene)
		os.Exit(2)
	}

	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = theme.RenderAtRaw(profile, l)
	}
	// LF-joined, single trailing newline: one pane row per frame line, no wrap
	// artifacts when the pane is wider than --width.
	fmt.Print(strings.Join(out, "\n"))
	fmt.Print("\n")
}

func welcomeContent() shell.WelcomeContent {
	return shell.WelcomeContent{
		Title:   "Grok Build Beta",
		Version: "0.2.82 [stable]",
		Announcement: shell.Announcement{
			Heading: "Composer 2.5 is here!",
			Body:    "Cursor's latest model is now available. Try it out in the /model picker.",
		},
		Menu: []shell.MenuEntry{
			{Label: "New worktree", Key: "ctrl+w"},
			{Label: "Resume session", Key: "ctrl+s"},
			{Label: "Changelog"},
			{Label: "Quit", Key: "ctrl+q"},
		},
	}
}

func renderWelcome(th *theme.Theme, width int) []string {
	w := shell.NewWelcome(th, welcomeContent())
	return w.Render(width)
}

func renderFooter(th *theme.Theme, width int) []string {
	f := shell.NewFooter(th)
	f.SetData(shell.FooterData{
		Cwd:             "/private/tmp/grok-qa",
		Home:            "/private",
		GitBranch:       "master",
		TokensInput:     12345,
		TokensOutput:    678,
		CacheRead:       200,
		CacheWrite:      50,
		Cost:            0.042,
		ContextTokens:   8000,
		ContextWindow:   200000,
		ContextPct:      4.0,
		ContextPctKnown: true,
		AutoCompact:     true,
		ModelID:         "Composer 2.5",
		ModelReasons:    false,
	})
	return f.Render(width)
}

func renderStatus(th *theme.Theme, width int, kind string) []string {
	stack := shell.NewStatusStack(th)
	switch kind {
	case "retry":
		stack.Set(shell.NewRetryStatus(th, 2, 5, 3000, "esc"))
	case "compaction":
		stack.Set(shell.NewCompactionStatus(th, shell.CompactionThreshold, "esc"))
	case "branch":
		stack.Set(shell.NewBranchSummaryStatus(th, "esc"))
	default:
		stack.Set(shell.NewStatusIndicator(th, shell.StatusWorking, "Thinking..."))
	}
	return stack.Render(width)
}

func renderQueue(th *theme.Theme, width int) []string {
	q := shell.NewQueue()
	q.Enqueue("keep refactoring the parser", shell.QueueSteering)
	q.Enqueue("then run the full test suite", shell.QueueFollowUp)
	pm := shell.NewPendingMessages(th, "alt+up")
	pm.SetQueue(q)
	return pm.Render(width)
}

func renderDegrade(th *theme.Theme, width int) []string {
	// Prove the welcome + footer degrade without panic at a tiny width.
	var out []string
	out = append(out, renderWelcome(th, width)...)
	out = append(out, "")
	out = append(out, renderFooter(th, width)...)
	return out
}
