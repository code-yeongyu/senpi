package transcript

import (
	"bytes"
	"encoding/json"
)

// entry is one rendered item in the transcript feed.
type entry interface {
	Render(width int) []string
}

// Feed assembles the transcript from the decoded AgentEvent stream. It maps
// message_end / tool_execution_* events onto the message + tool renderers, keeps
// pending tool blocks addressable by tool-call id so results and aborts update
// the right block, and renders the whole feed top-to-bottom.
//
// The event → entry mapping mirrors interactive-mode's session-event handling;
// the exhaustiveness of the underlying event union is owned + tested by
// internal/bridge (task 3). The Feed only renders the variants that produce
// transcript entries.
type Feed struct {
	theme   RenderTheme
	entries []entry
	tools   map[string]*ToolExecution
	// expandHint is the resolved app.tools.expand key text (from the keybinding
	// manager at the app layer). Empty falls back to a neutral label.
	expandHint string
}

// NewFeed builds an empty transcript feed.
func NewFeed(t RenderTheme) *Feed {
	return &Feed{theme: t, tools: map[string]*ToolExecution{}, expandHint: "ctrl+o"}
}

// SetExpandHint sets the resolved expand-key text shown in collapse hints. The
// caller resolves it through the keybinding manager (app.tools.expand); the Feed
// never checks keys directly.
func (f *Feed) SetExpandHint(hint string) { f.expandHint = hint }

// Apply folds one decoded event into the feed.
func (f *Feed) Apply(ev FeedEvent) {
	switch ev.Type {
	case "message_end":
		f.applyMessage(ev.Message)
	case "tool_execution_start":
		f.applyToolStart(ev)
	case "tool_execution_end":
		f.applyToolEnd(ev)
	case "tool_hook_status":
		if te, ok := f.tools[ev.ToolCallID]; ok {
			te.SetHookCount(ev.HookCount)
		}
	}
}

func (f *Feed) applyMessage(m *FeedMessage) {
	if m == nil {
		return
	}
	switch m.Role {
	case "user":
		f.entries = append(f.entries, NewUserMessage(messageText(m.Content), f.theme))
	case "assistant":
		content := make([]MessageContent, len(m.Content))
		copy(content, m.Content)
		f.entries = append(f.entries, NewAssistantMessage(AssistantMessage{
			Content:      content,
			StopReason:   m.StopReason,
			ErrorMessage: m.ErrorMessage,
		}, AssistantOptions{}, f.theme))
	}
}

func (f *Feed) applyToolStart(ev FeedEvent) {
	if ev.ToolCallID == "" {
		return
	}
	te := NewToolExecution(ToolCall{
		ID:   ev.ToolCallID,
		Name: ev.ToolName,
		Args: ev.ToolArgs,
	}, f.theme)
	te.MarkPending()
	if ev.HookCount > 0 {
		te.SetHookCount(ev.HookCount)
	}
	f.tools[ev.ToolCallID] = te
	f.entries = append(f.entries, te)
}

func (f *Feed) applyToolEnd(ev FeedEvent) {
	te, ok := f.tools[ev.ToolCallID]
	if !ok {
		// A result for a tool we never saw start: create one so nothing is lost.
		te = NewToolExecution(ToolCall{ID: ev.ToolCallID, Name: ev.ToolName, Args: ev.ToolArgs}, f.theme)
		f.tools[ev.ToolCallID] = te
		f.entries = append(f.entries, te)
	}
	if ev.Result == nil {
		return
	}
	if ev.Result.Aborted {
		te.Abort()
		return
	}
	te.SetResult(ToolResult{Content: ev.Result.Content, IsError: ev.Result.IsError})
}

// AbortPending marks every still-pending tool block as aborted, so a user abort
// mid-stream leaves no orphan spinner. Mirrors the interactive-mode abort path.
func (f *Feed) AbortPending() {
	for _, te := range f.tools {
		if te.pending {
			te.Abort()
		}
	}
}

// Render lays out the full transcript at width.
func (f *Feed) Render(width int) []string {
	var out []string
	for _, e := range f.entries {
		out = append(out, e.Render(width)...)
	}
	return out
}

// ParseFeedEvents decodes a JSONL byte slice (one event per line) into
// FeedEvents. Blank and non-object lines are skipped. Mirrors the JSONL codec
// tolerance in internal/bridge.
func ParseFeedEvents(data []byte) ([]FeedEvent, error) {
	var events []FeedEvent
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev FeedEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			// Skip malformed lines (rpc-client parity: ignore junk).
			continue
		}
		if ev.Type == "" {
			continue
		}
		events = append(events, ev)
	}
	return events, nil
}

func messageText(content []MessageContent) string {
	var parts []string
	for _, c := range content {
		if c.Type == "text" && c.Text != "" {
			parts = append(parts, c.Text)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += "\n" + p
	}
	return out
}
