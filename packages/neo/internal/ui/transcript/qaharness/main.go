// Command qaharness is the manual-QA driver for the transcript + tool renderers
// (plan task 9). It renders the recorded mock-loop session fixture through the
// transcript.Feed and prints the frame so tmux can capture the xterm.js triplet;
// all visual assertions run against the extracted cell grid.
//
// Modes:
//
//	happy    - render the tool-call → result → final-assistant-message feed from
//	           the recorded fixture (the "pending tool row → result → final
//	           message" scenario) so the grok tool row (`┃ ◆`) + result body +
//	           final markdown reply can be asserted against captures.
//	failure  - render the tool-error + user-abort feed so the aborted assistant
//	           notice is visible and the frame can be asserted to carry NO spinner
//	           frame glyph (the no-orphan-spinner acceptance criterion).
//	toolexpand - render an expanded long tool result (collapse/expand visual).
//
// It is NOT a package test; it is invoked by hand during QA and prints a
// machine-checkable frame to stdout (CRLF-terminated lines for tmux capture).
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

func main() {
	mode := "happy"
	width := 80
	fixture := "internal/ui/transcript/testdata/session_tool_error_abort.jsonl"
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
		case "--fixture":
			if i+1 < len(os.Args) {
				fixture = os.Args[i+1]
				i++
			}
		}
	}

	th, err := theme.Load(theme.Options{})
	if err != nil {
		fmt.Fprintln(os.Stderr, "qaharness: theme load failed:", err)
		os.Exit(1)
	}
	rt := transcript.NewRenderTheme(th)

	data, err := os.ReadFile(fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, "qaharness: read fixture failed:", err)
		os.Exit(1)
	}
	events, err := transcript.ParseFeedEvents(data)
	if err != nil {
		fmt.Fprintln(os.Stderr, "qaharness: parse fixture failed:", err)
		os.Exit(1)
	}

	switch mode {
	case "happy":
		runFeed(rt, width, events, false)
	case "failure":
		runFeed(rt, width, events, true)
	case "toolexpand":
		runToolExpand(rt, width)
	default:
		fmt.Fprintf(os.Stderr, "qaharness: unknown mode %q (want happy|failure|toolexpand)\n", mode)
		os.Exit(2)
	}
}

// runFeed renders the recorded session. When abortPending is set, any tool block
// still pending at the end of the stream is marked aborted, exercising the
// no-orphan-spinner path even though the recorded fixture completes its tool.
func runFeed(rt transcript.RenderTheme, width int, events []transcript.FeedEvent, abortPending bool) {
	feed := transcript.NewFeed(rt)
	for _, ev := range events {
		feed.Apply(ev)
	}
	if abortPending {
		feed.AbortPending()
	}
	printLines(feed.Render(width))
}

// runToolExpand renders a single tool block with a long result, expanded, to
// exercise the collapse/expand visual (app.tools.expand).
func runToolExpand(rt transcript.RenderTheme, width int) {
	te := transcript.NewToolExecution(transcript.ToolCall{
		ID: "call-x", Name: "bash", Args: map[string]any{"command": "seq 20"},
	}, rt)
	te.SetHookCount(2)
	var b strings.Builder
	for i := 1; i <= 20; i++ {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	te.SetResult(transcript.ToolResult{Content: []transcript.ContentBlock{{Type: "text", Text: b.String()}}})
	te.SetExpanded(true)
	printLines(te.Render(width))
}

func printLines(lines []string) {
	fmt.Print(strings.Join(lines, "\r\n"))
	fmt.Print("\r\n")
}
