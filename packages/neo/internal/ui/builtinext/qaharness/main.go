// Command qaharness is the manual-QA driver for the five native builtin
// ctx.ui.custom extension ports (plan task 14). It renders each feature's overlay
// to stdout as a frame (\r\n line endings) so a tmux capture can produce the
// xterm.js triplet, and drives the two verbatim QA scenarios:
//
//	history  - ctrl+r history search finding seeded prompts across two fixture
//	           sessions (the happy scenario). --query filters live.
//	observer - the session HUD viewer tailing an actively-growing session file
//	           (the failure scenario): it appends to the file, reloads via the
//	           tail, and prints the entry counts + a final frame with no crash.
//	files    - the files browser picker (R/W/E glyphs).
//	diff     - the diff picker (status column).
//	redraws  - the /tui redraw-stat notice string.
//	notice   - the third-party ctx.ui.custom fallback dialog.
//
// It is NOT a package test; it prints machine-checkable frames a human/verifier
// captures during QA. Frames printed here are qaharness --emit frames, never a
// tmux capture — the manifest triplets are produced by capturing THIS program in
// tmux via qa/xterm-render.mjs.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

func main() {
	mode := "history"
	width := 80
	query := ""
	for i := 1; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--mode":
			if i+1 < len(os.Args) {
				mode = os.Args[i+1]
				i++
			}
		case "--width":
			if i+1 < len(os.Args) {
				_, _ = fmt.Sscanf(os.Args[i+1], "%d", &width)
				i++
			}
		case "--query":
			if i+1 < len(os.Args) {
				query = os.Args[i+1]
				i++
			}
		}
	}

	th, err := theme.Load(theme.Options{Name: "grok-night"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "qaharness: theme load failed:", err)
		os.Exit(1)
	}
	km := keybindings.NewManager(nil)

	switch mode {
	case "history":
		runHistory(th, km, width, query)
	case "observer":
		runObserver(th, km, width)
	case "files":
		runFiles(th, km, width)
	case "diff":
		runDiff(th, km, width)
	case "redraws":
		runRedraws()
	case "notice":
		runNotice(th, km, width)
	default:
		fmt.Fprintf(os.Stderr, "qaharness: unknown mode %q\n", mode)
		os.Exit(2)
	}
}

func emit(lines []string) {
	fmt.Print(strings.Join(lines, "\r\n"))
	fmt.Print("\r\n")
}
