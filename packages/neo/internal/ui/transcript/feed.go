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
// message_start / message_update / message_end / tool_execution_* events onto
// the message + tool renderers, keeps pending tool blocks addressable by
// tool-call id so results and aborts update the right block, tracks the live
// streaming message so updates mutate one entry in place (finalized entries
// never reflow — their render inputs never change, so re-renders reuse the
// shared markdown cache), and renders the whole feed top-to-bottom.
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

	// Live streaming state (message_start → message_update → message_end).
	// liveAssistant is set only for assistant streams; other roles are appended
	// once at message_start and liveRole dedupes their message_end.
	liveRole      string
	liveAssistant *AssistantMessageComponent

	// Presentation toggles, applied to existing entries on change and inherited
	// by entries created afterwards (classic toolOutputExpanded /
	// hideThinkingBlock semantics).
	toolsExpanded bool
	hideThinking  bool
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
	case "message_start":
		f.applyMessageStart(ev.Message)
	case "message_update":
		f.applyMessageUpdate(ev.Message)
	case "message_end":
		f.applyMessage(ev.Message)
	case "tool_execution_start":
		f.applyToolStart(ev)
	case "tool_execution_update":
		f.applyToolUpdate(ev)
	case "tool_execution_end":
		f.applyToolEnd(ev)
	case "tool_hook_status":
		if te, ok := f.tools[ev.ToolCallID]; ok {
			te.SetHookCount(ev.HookCount)
		}
	}
}

// applyMessageStart opens a stream: assistant messages get a live component
// that message_update mutates in place; every other role renders fully at
// start (classic addMessageToChat on message_start) and liveRole dedupes the
// matching message_end.
func (f *Feed) applyMessageStart(m *FeedMessage) {
	if m == nil {
		return
	}
	if m.Role == "assistant" {
		comp := NewAssistantMessage(f.assistantMessage(m), AssistantOptions{
			HideThinking: f.hideThinking,
			Expanded:     f.toolsExpanded,
		}, f.theme)
		f.entries = append(f.entries, comp)
		f.liveRole, f.liveAssistant = "assistant", comp
		f.syncToolCalls(m.Content)
		return
	}
	f.appendMessageEntry(m)
	f.liveRole, f.liveAssistant = m.Role, nil
}

// applyMessageUpdate replaces the live assistant entry's content in place. The
// component re-renders through the shared markdown cache, so the unchanged
// finalized entries above it never reflow. An update with no live stream is
// dropped (classic parity: streamingComponent guards message_update).
func (f *Feed) applyMessageUpdate(m *FeedMessage) {
	if m == nil || m.Role != "assistant" || f.liveAssistant == nil {
		return
	}
	// Same-package in-place mutation: the component owns no content setter and
	// its render path is stateless, so replacing msg is the update seam.
	f.liveAssistant.msg = f.assistantMessage(m)
	f.syncToolCalls(m.Content)
}

// applyMessage finalizes on message_end: a live stream of the same role is
// finalized in place (assistant gets its terminal content; other roles were
// already rendered at message_start); with no matching live stream the message
// is appended directly (recorded fixtures and non-streamed messages).
func (f *Feed) applyMessage(m *FeedMessage) {
	if m == nil {
		return
	}
	if f.liveRole != "" && f.liveRole == m.Role {
		if m.Role == "assistant" && f.liveAssistant != nil {
			f.liveAssistant.msg = f.assistantMessage(m)
			f.syncToolCalls(m.Content)
		}
		f.clearLive()
		return
	}
	f.appendMessageEntry(m)
}

// appendMessageEntry renders one complete message as a new feed entry.
func (f *Feed) appendMessageEntry(m *FeedMessage) {
	switch m.Role {
	case "user":
		f.entries = append(f.entries, NewUserMessage(messageText(m.Content), f.theme))
	case "assistant":
		comp := NewAssistantMessage(f.assistantMessage(m), AssistantOptions{
			HideThinking: f.hideThinking,
			Expanded:     f.toolsExpanded,
		}, f.theme)
		f.entries = append(f.entries, comp)
	case "custom":
		if !m.Display {
			return
		}
		f.entries = append(f.entries, NewCustomMessage(CustomMessage{
			CustomType: m.CustomType,
			Content:    m.Content,
		}, f.theme))
	case "branchSummary":
		comp := NewBranchSummaryMessage(m.Summary, f.expandHint, f.theme)
		comp.SetExpanded(f.toolsExpanded)
		f.entries = append(f.entries, comp)
	case "compactionSummary":
		comp := NewCompactionSummaryMessage(CompactionSummary{
			TokensBefore: m.TokensBefore,
			Summary:      m.Summary,
		}, f.expandHint, f.theme)
		comp.SetExpanded(f.toolsExpanded)
		f.entries = append(f.entries, comp)
	}
}

// assistantMessage copies a FeedMessage into the renderer's AssistantMessage
// (defensive copy so later stream mutations never alias rendered state).
func (f *Feed) assistantMessage(m *FeedMessage) AssistantMessage {
	content := make([]MessageContent, len(m.Content))
	copy(content, m.Content)
	return AssistantMessage{
		Content:      content,
		StopReason:   m.StopReason,
		ErrorMessage: m.ErrorMessage,
	}
}

// syncToolCalls creates/updates pending tool blocks from streamed toolCall
// content blocks, so tool rows appear while arguments are still streaming
// (classic message_update pendingTools handling). tool_execution_start later
// reuses the same block.
func (f *Feed) syncToolCalls(content []MessageContent) {
	for _, c := range content {
		if c.Type != "toolCall" || c.ID == "" {
			continue
		}
		if te, ok := f.tools[c.ID]; ok {
			te.call.Args = c.Args
			te.invalidate()
			continue
		}
		te := NewToolExecution(ToolCall{ID: c.ID, Name: c.Name, Args: c.Args}, f.theme)
		te.SetExpanded(f.toolsExpanded)
		te.MarkPending()
		f.tools[c.ID] = te
		f.entries = append(f.entries, te)
	}
}

func (f *Feed) clearLive() {
	f.liveRole, f.liveAssistant = "", nil
}

func (f *Feed) applyToolStart(ev FeedEvent) {
	if ev.ToolCallID == "" {
		return
	}
	te, ok := f.tools[ev.ToolCallID]
	if !ok {
		te = NewToolExecution(ToolCall{
			ID:   ev.ToolCallID,
			Name: ev.ToolName,
			Args: ev.ToolArgs,
		}, f.theme)
		te.SetExpanded(f.toolsExpanded)
		f.tools[ev.ToolCallID] = te
		f.entries = append(f.entries, te)
	} else if ev.ToolArgs != nil {
		// Execution starts with the now-complete arguments.
		te.call.Args = ev.ToolArgs
	}
	te.MarkPending()
	if ev.HookCount > 0 {
		te.SetHookCount(ev.HookCount)
	}
}

// applyToolUpdate streams args/partial output into the pending tool block. The
// block stays pending (the spinner-eligible state) until tool_execution_end
// replaces the partial with the finalized result. Updates for unknown tool ids
// are ignored (classic parity).
func (f *Feed) applyToolUpdate(ev FeedEvent) {
	te, ok := f.tools[ev.ToolCallID]
	if !ok {
		return
	}
	if ev.ToolArgs != nil {
		te.call.Args = ev.ToolArgs
	}
	if ev.Partial != nil {
		// Direct result assignment (not SetResult) keeps the pending state while
		// the streamed partial body renders under the header row.
		te.result = &ToolResult{Content: ev.Partial.Content}
	}
	te.invalidate()
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

// AbortPending marks every still-pending tool block as aborted and closes the
// live message stream, so a user abort mid-stream leaves no orphan spinner and
// no resurrectable streaming entry. Mirrors the interactive-mode abort path.
func (f *Feed) AbortPending() {
	for _, te := range f.tools {
		if te.pending {
			te.Abort()
		}
	}
	f.clearLive()
}

// SetToolsExpanded toggles collapse/expand across every entry that supports it
// (tool blocks, summaries) and is inherited by entries created afterwards.
// Resolved from the app.tools.expand action at the app layer — the Feed never
// checks keys.
func (f *Feed) SetToolsExpanded(expanded bool) {
	f.toolsExpanded = expanded
	for _, e := range f.entries {
		if x, ok := e.(interface{ SetExpanded(bool) }); ok {
			x.SetExpanded(expanded)
		}
	}
}

// ToolsExpanded reports the current expansion state.
func (f *Feed) ToolsExpanded() bool { return f.toolsExpanded }

// SetHideThinking toggles thinking-block visibility on every assistant entry
// (including the live one) and is inherited by entries created afterwards.
// Resolved from the app.thinking.toggle action at the app layer.
func (f *Feed) SetHideThinking(hide bool) {
	f.hideThinking = hide
	for _, e := range f.entries {
		if a, ok := e.(*AssistantMessageComponent); ok {
			a.SetHideThinking(hide)
		}
	}
}

// HideThinking reports the current thinking-visibility state.
func (f *Feed) HideThinking() bool { return f.hideThinking }

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
