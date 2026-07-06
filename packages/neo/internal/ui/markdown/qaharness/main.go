// Command qaharness is the manual-QA driver for the grok markdown renderer
// (plan task 7). It runs the verbatim scenarios:
//
//	happy   - render a fixture reply containing a table + fenced code + links
//	          through the grok markdown renderer and print the frame so tmux can
//	          capture the xterm.js triplet; assertions run against the cell grid.
//	stress  - render an unclosed fence followed by a 10k-line body and report the
//	          per-render frame time so the failure scenario can assert the frame
//	          budget and that the renderer stays responsive with no crash.
//
// It is NOT a package test; it is invoked by hand during QA and prints a
// machine-checkable frame + report to stdout.
package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown"
)

// happyFixture is a self-contained reply exercising every grok markdown surface
// the happy scenario asserts: heading, paragraph with bold/inline-code, a link,
// a bulleted list, a width-aware table, and a fenced code block with highlight.
const happyFixture = "# Deploy summary\n" +
	"\n" +
	"The **build** finished. See `packages/neo` and the [runbook](https://example.com/runbook).\n" +
	"\n" +
	"- Compiled 6 targets\n" +
	"- Uploaded artifacts\n" +
	"\n" +
	"| Target | Arch | Size |\n" +
	"| --- | --- | --- |\n" +
	"| darwin | arm64 | 12 MB |\n" +
	"| linux | x64 | 13 MB |\n" +
	"\n" +
	"```go\n" +
	"func main() {\n" +
	"\tfmt.Println(\"shipped\")\n" +
	"}\n" +
	"```\n"

func main() {
	mode := "happy"
	width := 80
	hyperlinks := true
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
		case "--no-hyperlinks":
			// Fallback URL annotation instead of OSC 8, so a tmux capture-pane -e
			// round-trip does not re-serialize OSC 8 into cursor-shifting bytes.
			hyperlinks = false
		}
	}

	th, err := theme.Load(theme.Options{})
	if err != nil {
		fmt.Fprintln(os.Stderr, "qaharness: theme load failed:", err)
		os.Exit(1)
	}
	mdTheme := markdown.GrokTheme(th)

	switch mode {
	case "happy":
		runHappy(mdTheme, width, hyperlinks)
	case "stress":
		runStress(mdTheme, width)
	case "failviz":
		runFailViz(mdTheme, width)
	default:
		fmt.Fprintf(os.Stderr, "qaharness: unknown mode %q (want happy|stress|failviz)\n", mode)
		os.Exit(2)
	}
}

func runHappy(mdTheme markdown.Theme, width int, hyperlinks bool) {
	// With hyperlinks on the link renders as an OSC 8 clickable annotation; with
	// them off it renders as a ` (url)` fallback the cell grid can verify without
	// OSC 8 (used for tmux capture-pane round-trips).
	markdown.SetCapabilities(markdown.Capabilities{Images: "", TrueColor: true, Hyperlinks: hyperlinks})
	m := markdown.New(happyFixture, 0, 0, mdTheme, nil, nil)
	lines := m.Render(width)
	fmt.Print(strings.Join(lines, "\r\n"))
	fmt.Print("\r\n")
}

// runFailViz renders a bounded UNCLOSED fence so a triplet can visually confirm
// the partial-fence stabilization (the block still terminates with a synthetic
// ``` border and never shrinks) — the visible half of the failure scenario.
func runFailViz(mdTheme markdown.Theme, width int) {
	markdown.SetCapabilities(markdown.Capabilities{Images: "", TrueColor: true, Hyperlinks: false})
	// Unclosed fence: no closing ``` in the source.
	src := "Streaming reply:\n\n```go\nfunc handler() {\n\tlog.Println(\"partial\")\n"
	m := markdown.New(src, 0, 0, mdTheme, nil, nil)
	lines := m.Render(width)
	fmt.Print(strings.Join(lines, "\r\n"))
	fmt.Print("\r\n")
}

func runStress(mdTheme markdown.Theme, width int) {
	// Unclosed fence + 10k body lines: the pathological streaming/large-output
	// case the failure scenario guards. Render repeatedly and report frame time.
	var b strings.Builder
	b.WriteString("```go\n")
	for i := 0; i < 10000; i++ {
		fmt.Fprintf(&b, "line %d: fmt.Println(\"x\")\n", i)
	}
	// NOTE: no closing fence — an unclosed fence.
	src := b.String()

	const iterations = 5
	var first []string
	var slowest time.Duration
	var total time.Duration
	for it := 0; it < iterations; it++ {
		// Fresh instance each iteration so we measure a cold render (streaming
		// re-creates Markdown for a growing string); the shared cache still helps
		// identical repeats, so also force a unique cache miss on the first pass.
		m := markdown.New(src, 0, 0, mdTheme, nil, nil)
		start := time.Now()
		lines := m.Render(width)
		elapsed := time.Since(start)
		total += elapsed
		if elapsed > slowest {
			slowest = elapsed
		}
		if it == 0 {
			first = lines
		}
	}

	// A responsive frame budget: even the pathological 10k-line unclosed fence
	// must render well under a human-perceptible frame (250ms) per iteration.
	const frameBudget = 250 * time.Millisecond
	ok := slowest < frameBudget

	fmt.Printf("STRESS lines_in=%d rendered_lines=%d iterations=%d slowest=%s avg=%s budget=%s within_budget=%v crash=false\n",
		10000, len(first), iterations, slowest.Round(time.Microsecond), (total / iterations).Round(time.Microsecond), frameBudget, ok)

	// Print the first + last rendered lines so a human/QA can confirm the
	// synthetic closing fence stabilized the unclosed block (no shrink/crash).
	if len(first) >= 2 {
		fmt.Printf("FIRST_LINE %q\n", stripForReport(first[0]))
		fmt.Printf("LAST_LINE  %q\n", stripForReport(first[len(first)-1]))
	}
	if !ok {
		os.Exit(3)
	}
}

// stripForReport removes escape sequences so the report line is plain-text and
// safe to embed in evidence (no raw SGR).
func stripForReport(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == 0x1b {
			for i < len(s) && s[i] != 'm' && s[i] != '\\' && s[i] != 0x07 {
				i++
			}
			if i < len(s) {
				i++
			}
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return strings.TrimRight(b.String(), " ")
}
