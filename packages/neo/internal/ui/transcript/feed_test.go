package transcript

// Fixture-driven feed contract. The Feed consumes the decoded AgentEvent stream
// (bridge.Event payloads) recorded from a mock-loop session and renders the chat
// transcript. The golden fixture testdata/session_tool_error_abort.jsonl is a
// recorded mock-loop turn containing a tool call, a tool error, and a user
// abort mid-stream (acceptance: "matches goldens; no orphan spinner on abort").
//
// RED first: Feed does not exist until GREEN.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadFeedFixture(t *testing.T, name string) []FeedEvent {
	t.Helper()
	path := filepath.Join("testdata", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	events, err := ParseFeedEvents(data)
	if err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
	return events
}

func TestFeed_ToolCallErrorAbortGolden(t *testing.T) {
	events := loadFeedFixture(t, "session_tool_error_abort.jsonl")
	feed := NewFeed(DefaultRenderTheme())
	for _, ev := range events {
		feed.Apply(ev)
	}
	lines := feed.Render(80)
	joined := strings.Join(lines, "\n")

	// The tool call row renders with grok glyphs.
	if !strings.Contains(joined, "◆") {
		t.Fatalf("feed missing tool marker: %q", joined)
	}
	// The tool error output surfaces.
	if !strings.Contains(joined, "boom: command failed") {
		t.Fatalf("feed missing tool error output: %q", joined)
	}
	// The aborted assistant turn shows the abort notice, not a spinner.
	if !strings.Contains(joined, "Operation aborted") {
		t.Fatalf("feed missing abort notice: %q", joined)
	}
	for _, frame := range SpinnerFramesForTest() {
		if strings.Contains(joined, frame) {
			t.Fatalf("orphan spinner frame %q in aborted feed", frame)
		}
	}
}

func TestFeed_UserThenAssistant(t *testing.T) {
	feed := NewFeed(DefaultRenderTheme())
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:    "user",
		Content: []MessageContent{{Type: "text", Text: "run the build"}},
	}})
	feed.Apply(FeedEvent{Type: "message_end", Message: &FeedMessage{
		Role:    "assistant",
		Content: []MessageContent{{Type: "text", Text: "Done."}},
	}})
	joined := strings.Join(feed.Render(80), "\n")
	if !strings.Contains(joined, "run the build") || !strings.Contains(joined, "Done.") {
		t.Fatalf("feed did not render user+assistant: %q", joined)
	}
}
