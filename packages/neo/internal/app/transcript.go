package app

import (
	"encoding/json"
	"log"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/transcript"
)

// Transcript-owned keybinding action ids, resolved through the Manager (no raw
// key string is ever compared here).
const (
	actionToolsExpand    = "app.tools.expand"
	actionThinkingToggle = "app.thinking.toggle"
)

// maxTrackedUnknownEvents bounds the once-per-type unknown-event log set so a
// misbehaving stream cannot grow it without limit.
const maxTrackedUnknownEvents = 64

// EventDisposition reports what the translator did with one EventMsg, so the
// update loop (todo 9) knows whether the frame changed and tests can prove no
// event type is dropped silently.
type EventDisposition int

const (
	// EventApplied: the event mutated transcript state (Feed.Apply and/or
	// translator bookkeeping).
	EventApplied EventDisposition = iota
	// EventIgnored: the event type is in the explicit ignore-list — it renders on
	// a non-transcript surface (status line, footer, overlays) owned by another
	// todo, and produces no feed entry by design.
	EventIgnored
	// EventDeferred: the event is owned by a later todo and handed off there
	// (queue_update → todo 4's queue/pending area).
	EventDeferred
	// EventUnknown: the type is not in the bridge event mirror; it is logged once
	// per type and otherwise skipped.
	EventUnknown
)

// transcriptIgnoredEvents is the EXPLICIT ignore-list for the transcript
// translator: every bridge.KnownEventTypes() key that intentionally produces no
// feed entry, with the surface that owns it instead. The exhaustiveness test
// asserts handled ∪ ignored ∪ deferred covers the whole mirror.
var transcriptIgnoredEvents = map[string]string{
	"turn_start":             "turn boundaries render nothing; content arrives via message_* events",
	"turn_end":               "turn boundaries render nothing; tool results arrive via tool_execution_end",
	"compaction_start":       "status-indicator surface (shell status line, todo 7)",
	"compaction_progress":    "status-indicator surface (shell status line, todo 7)",
	"entry_appended":         "custom entry renderers are extension-owned (todo 6); classic renders nothing without one",
	"session_info_changed":   "terminal title + footer surface (todo 7/9)",
	"system_prompt_change":   "status-line surface (shell status line, todo 7)",
	"thinking_level_changed": "footer surface (todo 7)",
	"auto_retry_start":       "retry status-indicator surface (shell status line, todo 7)",
	"auto_retry_end":         "retry status-indicator surface (shell status line, todo 7)",
	"auth_login_url":         "auth login overlay (todo 13)",
	"auth_login_end":         "auth login overlay (todo 13)",
	"extension_error":        "delivered as ExtensionErrorMsg by the session adapter demux, never as an EventMsg",
}

// Transcript translates the session adapter's EventMsg stream into transcript
// Feed.Apply calls: streaming message deltas, tool-execution lifecycle, hook
// counts, compaction/branch summaries, and abort fan-out. It owns NO rendering
// (the Feed does) and never touches the wire codec beyond decoding the typed
// payload views it maps.
type Transcript struct {
	feed *transcript.Feed
	keys *keybindings.Manager

	// hookCounts tracks active tool hooks per tool-call id (phase start/end),
	// rendered as the feed's `[hooks: N]` badge. Entries are removed at zero and
	// the map is reset at turn boundaries, so it stays bounded.
	hookCounts map[string]int

	// Presentation toggles (classic toolOutputExpanded / hideThinkingBlock).
	toolsExpanded bool
	hideThinking  bool

	// unknownLogged holds the event types already logged once (bounded); logf is
	// the injectable sink (default: standard log, which todo 9 routes to the
	// bubbletea log file — never the raw terminal).
	unknownLogged map[string]bool
	suppressedLog bool
	logf          func(format string, args ...any)
}

// NewTranscript wires a translator onto a Feed. Expand/collapse and thinking
// toggles resolve through the keybinding Manager's app.tools.expand /
// app.thinking.toggle actions.
func NewTranscript(feed *transcript.Feed, keys *keybindings.Manager) *Transcript {
	return &Transcript{
		feed:          feed,
		keys:          keys,
		hookCounts:    map[string]int{},
		unknownLogged: map[string]bool{},
		logf:          log.Printf,
	}
}

// SetLogf replaces the unknown-event log sink (tests and the program wiring
// inject theirs; the default is the standard logger).
func (t *Transcript) SetLogf(logf func(format string, args ...any)) {
	if logf != nil {
		t.logf = logf
	}
}

// HandleKey routes transcript-level presentation chords through the Manager:
// app.tools.expand toggles tool/summary expansion and app.thinking.toggle
// toggles thinking-block visibility. Returns true when the key was consumed.
func (t *Transcript) HandleKey(raw string) bool {
	switch {
	case t.keys.Matches(raw, actionToolsExpand):
		t.toolsExpanded = !t.toolsExpanded
		t.feed.SetToolsExpanded(t.toolsExpanded)
		return true
	case t.keys.Matches(raw, actionThinkingToggle):
		t.hideThinking = !t.hideThinking
		t.feed.SetHideThinking(t.hideThinking)
		return true
	}
	return false
}

// HandleEvent maps one demuxed session event onto the Feed. Malformed payloads
// of known types are logged once per type and skipped without panicking; the
// stream keeps flowing.
func (t *Transcript) HandleEvent(msg EventMsg) EventDisposition {
	ev := msg.Event
	switch ev.Type {
	case "agent_start":
		// New turn: per-turn hook bookkeeping resets (classic clearToolHookStatuses).
		t.hookCounts = map[string]int{}
		return EventApplied

	case "agent_end":
		// Turn over: any straggler pending block would spin forever, so abort the
		// leftovers (no-op after a clean turn) and drop stale hook counts.
		t.feed.AbortPending()
		t.hookCounts = map[string]int{}
		return EventApplied

	case "message_start", "message_update", "message_end":
		return t.applyMessageEvent(ev.Type, ev.Payload)

	case "tool_execution_start", "tool_execution_update", "tool_execution_end":
		return t.applyToolEvent(ev.Type, ev.Payload)

	case "tool_hook_status":
		return t.applyToolHookStatus(ev.Payload)

	case "compaction_end":
		return t.applyCompactionEnd(ev.Payload)

	case "queue_update":
		// Hand-off to todo 4: the queue/pending-messages area (shell.Queue) owns
		// steering/follow-up display; the transcript renders nothing for it.
		return EventDeferred
	}

	if _, ok := transcriptIgnoredEvents[ev.Type]; ok {
		return EventIgnored
	}
	t.logUnknown(ev.Type)
	return EventUnknown
}

// applyMessageEvent decodes the wire message envelope and forwards it to the
// Feed; an aborted/errored assistant finalization also aborts pending tool
// blocks (classic message_end stopReason handling).
func (t *Transcript) applyMessageEvent(eventType string, payload []byte) EventDisposition {
	var body struct {
		Message *transcript.FeedMessage `json:"message"`
	}
	if err := json.Unmarshal(payload, &body); err != nil || body.Message == nil {
		t.logMalformed(eventType, err)
		return EventApplied
	}
	t.feed.Apply(transcript.FeedEvent{Type: eventType, Message: body.Message})
	if eventType == "message_end" && body.Message.Role == "assistant" &&
		(body.Message.StopReason == "aborted" || body.Message.StopReason == "error") {
		t.feed.AbortPending()
	}
	return EventApplied
}

// applyToolEvent decodes the tool_execution_* wire shapes (args / partialResult
// / result + top-level isError) into the Feed's tool lifecycle.
func (t *Transcript) applyToolEvent(eventType string, payload []byte) EventDisposition {
	var body struct {
		ToolCallID string          `json:"toolCallId"`
		ToolName   string          `json:"toolName"`
		Args       map[string]any  `json:"args"`
		Partial    json.RawMessage `json:"partialResult"`
		Result     json.RawMessage `json:"result"`
		IsError    bool            `json:"isError"`
	}
	if err := json.Unmarshal(payload, &body); err != nil || body.ToolCallID == "" {
		t.logMalformed(eventType, err)
		return EventApplied
	}
	fev := transcript.FeedEvent{
		Type:       eventType,
		ToolCallID: body.ToolCallID,
		ToolName:   body.ToolName,
		ToolArgs:   body.Args,
	}
	switch eventType {
	case "tool_execution_update":
		fev.Partial = decodeToolResult(body.Partial, false)
	case "tool_execution_end":
		fev.Result = decodeToolResult(body.Result, body.IsError)
		if fev.Result == nil {
			// A result-less end still finalizes the block instead of leaving an
			// eternal spinner.
			fev.Result = &transcript.FeedToolResult{IsError: body.IsError}
		}
	}
	t.feed.Apply(fev)
	return EventApplied
}

// decodeToolResult extracts the content blocks from a wire tool result (the
// `result`/`partialResult` objects are open-shaped; only `content` renders).
// Returns nil for an absent or non-object value.
func decodeToolResult(raw json.RawMessage, isError bool) *transcript.FeedToolResult {
	if len(raw) == 0 {
		return nil
	}
	var body struct {
		Content []transcript.ContentBlock `json:"content"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	return &transcript.FeedToolResult{Content: body.Content, IsError: isError}
}

// applyToolHookStatus folds hook lifecycle phases into the per-tool active-hook
// count the feed renders as `[hooks: N]`.
func (t *Transcript) applyToolHookStatus(payload []byte) EventDisposition {
	var body struct {
		ToolCallID string `json:"toolCallId"`
		Phase      string `json:"phase"`
	}
	if err := json.Unmarshal(payload, &body); err != nil || body.ToolCallID == "" {
		t.logMalformed("tool_hook_status", err)
		return EventApplied
	}
	switch body.Phase {
	case "start":
		t.hookCounts[body.ToolCallID]++
	case "end":
		if t.hookCounts[body.ToolCallID] > 0 {
			t.hookCounts[body.ToolCallID]--
		}
		if t.hookCounts[body.ToolCallID] == 0 {
			delete(t.hookCounts, body.ToolCallID)
		}
	}
	t.feed.Apply(transcript.FeedEvent{
		Type:       "tool_hook_status",
		ToolCallID: body.ToolCallID,
		HookCount:  t.hookCounts[body.ToolCallID],
	})
	return EventApplied
}

// applyCompactionEnd renders a successful compaction as a collapsible summary
// entry. Aborted or failed compactions render nothing here (the status-line
// surface owns cancellation notices, todo 7).
func (t *Transcript) applyCompactionEnd(payload []byte) EventDisposition {
	var body struct {
		Aborted bool `json:"aborted"`
		Result  *struct {
			Summary      string `json:"summary"`
			TokensBefore int    `json:"tokensBefore"`
		} `json:"result"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.logMalformed("compaction_end", err)
		return EventApplied
	}
	if body.Aborted || body.Result == nil {
		return EventApplied
	}
	t.feed.Apply(transcript.FeedEvent{Type: "message_end", Message: &transcript.FeedMessage{
		Role:         "compactionSummary",
		Summary:      body.Result.Summary,
		TokensBefore: body.Result.TokensBefore,
	}})
	return EventApplied
}

// logUnknown logs an unmirrored event type exactly once per type, bounded so a
// hostile stream cannot grow the set forever (one final suppression notice).
func (t *Transcript) logUnknown(eventType string) {
	if t.unknownLogged[eventType] {
		return
	}
	if len(t.unknownLogged) >= maxTrackedUnknownEvents {
		if !t.suppressedLog {
			t.suppressedLog = true
			t.logf("neo transcript: further unknown event types suppressed after %d distinct types", maxTrackedUnknownEvents)
		}
		return
	}
	t.unknownLogged[eventType] = true
	t.logf("neo transcript: unknown session event type %q (rendering skipped)", eventType)
}

// logMalformed reports a known event type whose payload failed to decode; keyed
// into the same once-per-type set so it cannot spam.
func (t *Transcript) logMalformed(eventType string, err error) {
	key := "malformed:" + eventType
	if t.unknownLogged[key] || len(t.unknownLogged) >= maxTrackedUnknownEvents {
		return
	}
	t.unknownLogged[key] = true
	t.logf("neo transcript: malformed %s payload skipped (err=%v)", eventType, err)
}
