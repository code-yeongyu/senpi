package transcript

// Streaming feed contract (todo 3): message_start opens a live assistant entry,
// message_update mutates it in place (finalized entries never reflow),
// message_end finalizes, and tool_execution_update streams args/partial output
// into the pending tool block. Custom/summary message roles render their
// dedicated components, and the expand/thinking toggles fan out to entries.
//
// RED first: the streaming Apply cases and the FeedMessage fields they need do
// not exist until GREEN.

import (
	"strings"
	"testing"
)

func renderJoined(f *Feed, width int) string {
	return strings.Join(f.Render(width), "\n")
}

func TestFeedStreaming_MessageStartUpdateEndInPlace(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())

	feed.Apply(FeedEvent{Type: "message_start", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: ""}},
	}})
	feed.Apply(FeedEvent{Type: "message_update", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "alpha"}},
	}})
	feed.Apply(FeedEvent{Type: "message_update", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "alpha beta"}},
	}})

	joined := renderJoined(feed, 80)
	if !strings.Contains(joined, "alpha beta") {
		t.Fatalf("live update not rendered: %q", joined)
	}
	if got := strings.Count(joined, "alpha"); got != 1 {
		t.Fatalf("message_update duplicated the live entry: %d occurrences of %q in %q", got, "alpha", joined)
	}

	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "alpha beta gamma"}},
	}})
	joined = renderJoined(feed, 80)
	if !strings.Contains(joined, "alpha beta gamma") {
		t.Fatalf("message_end did not finalize content: %q", joined)
	}
	if got := strings.Count(joined, "alpha"); got != 1 {
		t.Fatalf("message_end appended instead of finalizing in place: %d occurrences in %q", got, joined)
	}
}

func TestFeedStreaming_UserMessageStartThenEndNotDuplicated(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	user := &FeedMessage{Role: "user", Content: []MessageContent{{Type: "text", Text: "run the tests"}}}
	feed.Apply(FeedEvent{Type: "message_start", Message: user})
	feed.Apply(FeedEvent{Type: "message_end", Message: user})

	joined := renderJoined(feed, 80)
	if got := strings.Count(joined, "run the tests"); got != 1 {
		t.Fatalf("user message duplicated across start/end: %d occurrences in %q", got, joined)
	}
}

func TestFeedStreaming_UpdateWithoutStartIsDropped(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(FeedEvent{Type: "message_update", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "stray"}},
	}})
	if joined := renderJoined(feed, 80); strings.Contains(joined, "stray") {
		t.Fatalf("message_update without message_start must be dropped (classic parity): %q", joined)
	}
}

func TestFeedStreaming_ToolCallBlocksStreamFromMessageUpdate(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(FeedEvent{Type: "message_start", Message: &FeedMessage{Role: "assistant"}})
	feed.Apply(FeedEvent{Type: "message_update", Message: &FeedMessage{
		Role: "assistant",
		Content: []MessageContent{
			{Type: "toolCall", ID: "t1", Name: "bash", Args: map[string]any{"command": "echo streamed"}},
		},
	}})

	joined := renderJoined(feed, 80)
	if !strings.Contains(joined, "◆") || !strings.Contains(joined, "echo streamed") {
		t.Fatalf("streamed toolCall block not rendered as pending tool row: %q", joined)
	}

	// tool_execution_start for the same id must reuse the streamed block, not
	// append a duplicate (classic pendingTools reuse).
	feed.Apply(FeedEvent{Type: "tool_execution_start", ToolCallID: "t1", ToolName: "bash",
		ToolArgs: map[string]any{"command": "echo streamed"}})
	joined = renderJoined(feed, 80)
	if got := strings.Count(joined, "◆"); got != 1 {
		t.Fatalf("tool_execution_start duplicated the streamed tool block: %d markers in %q", got, joined)
	}
}

func TestFeedStreaming_ToolExecutionUpdateStreamsPartialAndArgs(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(FeedEvent{Type: "tool_execution_start", ToolCallID: "c1", ToolName: "bash",
		ToolArgs: map[string]any{"command": "sleep 5"}})

	feed.Apply(FeedEvent{Type: "tool_execution_update", ToolCallID: "c1", ToolName: "bash",
		ToolArgs: map[string]any{"command": "sleep 5 && echo done"},
		Partial:  &FeedToolResult{Content: []ContentBlock{{Type: "text", Text: "partial-line-1"}}}})

	joined := renderJoined(feed, 80)
	if !strings.Contains(joined, "partial-line-1") {
		t.Fatalf("partial result not rendered while pending: %q", joined)
	}
	if !strings.Contains(joined, "echo done") {
		t.Fatalf("streamed args not updated on the pending block: %q", joined)
	}

	feed.Apply(FeedEvent{Type: "tool_execution_end", ToolCallID: "c1",
		Result: &FeedToolResult{Content: []ContentBlock{{Type: "text", Text: "final-output"}}}})
	joined = renderJoined(feed, 80)
	if !strings.Contains(joined, "final-output") {
		t.Fatalf("final result missing: %q", joined)
	}
	if strings.Contains(joined, "partial-line-1") {
		t.Fatalf("partial output must be replaced by the final result: %q", joined)
	}
}

func TestFeedStreaming_FinalizedLinesNeverReflow(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(FeedEvent{Type: "message_start", Message: &FeedMessage{Role: "assistant"}})
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "finalized paragraph one"}},
	}})

	before := feed.Render(80)

	// A new streaming turn must not reflow the finalized entry's lines.
	feed.Apply(FeedEvent{Type: "message_start", Message: &FeedMessage{Role: "assistant"}})
	feed.Apply(FeedEvent{Type: "message_update", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "second turn streaming"}},
	}})

	after := feed.Render(80)
	if len(after) < len(before) {
		t.Fatalf("render shrank: before %d lines, after %d", len(before), len(after))
	}
	for i, line := range before {
		if after[i] != line {
			t.Fatalf("finalized line %d reflowed:\n before: %q\n after:  %q", i, line, after[i])
		}
	}
}

func TestFeedStreaming_AbortPendingClearsLiveStream(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(FeedEvent{Type: "message_start", Message: &FeedMessage{Role: "assistant"}})
	feed.Apply(FeedEvent{Type: "tool_execution_start", ToolCallID: "c9", ToolName: "bash",
		ToolArgs: map[string]any{"command": "sleep 99"}})

	feed.AbortPending()

	joined := renderJoined(feed, 80)
	if !strings.Contains(joined, "Operation aborted") {
		t.Fatalf("pending tool not aborted: %q", joined)
	}
	for _, frame := range SpinnerFramesForTest() {
		if strings.Contains(joined, frame) {
			t.Fatalf("orphan spinner frame %q after abort", frame)
		}
	}

	// A straggler update after the abort must not resurrect the dead stream.
	feed.Apply(FeedEvent{Type: "message_update", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "ghost-delta"}},
	}})
	if joined := renderJoined(feed, 80); strings.Contains(joined, "ghost-delta") {
		t.Fatalf("aborted stream resurrected by a straggler update: %q", joined)
	}
}

func TestFeedRoles_CustomAndSummaries(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())

	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:       "custom",
		CustomType: "memo",
		Display:    true,
		Content:    []MessageContent{{Type: "text", Text: "remember the milk"}},
	}})
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:       "custom",
		CustomType: "hidden",
		Display:    false,
		Content:    []MessageContent{{Type: "text", Text: "invisible-note"}},
	}})
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:    "branchSummary",
		Summary: "took the left fork",
	}})
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:         "compactionSummary",
		Summary:      "squeezed the transcript",
		TokensBefore: 12345,
	}})

	joined := renderJoined(feed, 80)
	if !strings.Contains(joined, "[memo]") || !strings.Contains(joined, "remember the milk") {
		t.Fatalf("displayable custom message not rendered: %q", joined)
	}
	if strings.Contains(joined, "invisible-note") {
		t.Fatalf("display=false custom message must not render: %q", joined)
	}
	if !strings.Contains(joined, "[branch]") {
		t.Fatalf("branch summary not rendered: %q", joined)
	}
	if !strings.Contains(joined, "[compaction]") || !strings.Contains(joined, "12,345") {
		t.Fatalf("compaction summary not rendered: %q", joined)
	}
}

func TestFeedRoles_CustomStringContentDecodes(t *testing.T) {
	events, err := ParseFeedEvents([]byte(
		`{"type":"message_end","message":{"role":"custom","customType":"memo","display":true,"content":"plain string body"}}` + "\n"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("want 1 event, got %d", len(events))
	}
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(events[0])
	if joined := renderJoined(feed, 80); !strings.Contains(joined, "plain string body") {
		t.Fatalf("string-content custom message not decoded/rendered: %q", joined)
	}
}

func TestFeedToggles_ExpandAndThinking(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())

	// 15 output lines: collapsed shows only the trailing 10.
	var lines []string
	for i := 0; i < 15; i++ {
		lines = append(lines, "out-line-"+itoaSigned(i))
	}
	feed.Apply(FeedEvent{Type: "tool_execution_start", ToolCallID: "c1", ToolName: "bash",
		ToolArgs: map[string]any{"command": "many"}})
	feed.Apply(FeedEvent{Type: "tool_execution_end", ToolCallID: "c1",
		Result: &FeedToolResult{Content: []ContentBlock{{Type: "text", Text: strings.Join(lines, "\n")}}}})

	joined := renderJoined(feed, 120)
	if strings.Contains(joined, "out-line-2\x1b") || strings.Contains(joined, "out-line-2\n") {
		t.Fatalf("collapsed tool output shows head lines: %q", joined)
	}
	if !strings.Contains(joined, "out-line-14") {
		t.Fatalf("collapsed tool output missing tail: %q", joined)
	}

	feed.SetToolsExpanded(true)
	joined = renderJoined(feed, 120)
	if !strings.Contains(joined, "out-line-0") {
		t.Fatalf("expanded tool output missing head lines: %q", joined)
	}

	// Thinking toggle: hidden thinking collapses to the label.
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "thinking", Thinking: "pondering deeply"}, {Type: "text", Text: "answer"}},
	}})
	joined = renderJoined(feed, 120)
	if !strings.Contains(joined, "pondering deeply") {
		t.Fatalf("thinking visible by default: %q", joined)
	}
	feed.SetHideThinking(true)
	joined = renderJoined(feed, 120)
	if strings.Contains(joined, "pondering deeply") {
		t.Fatalf("hidden thinking body still rendered: %q", joined)
	}
	if !strings.Contains(joined, "Thinking...") {
		t.Fatalf("hidden thinking label missing: %q", joined)
	}
}
