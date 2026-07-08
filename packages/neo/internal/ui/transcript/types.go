// Package transcript renders the neo chat feed: the AgentEvent stream as a
// scrollable transcript of user, assistant, custom, branch-summary,
// compaction-summary, and skill-invocation messages, plus grok-style
// tool-execution blocks (pending row → result body, collapse/expand, bounded
// per-tool render caching), a diff renderer, and thinking-block toggling.
//
// It ports the interactive-mode message/tool components from
// packages/coding-agent/src/modes/interactive/components/ onto the wave-0/1
// foundations (internal/theme, internal/ui/markdown, internal/ui/keybindings).
// Every color routes through the resolved theme (RenderTheme); no key is checked
// directly (expand hints resolve through the keybinding manager at the app
// layer, passed in as text).
package transcript

import (
	"bytes"
	"encoding/json"
)

// MessageContent is one block of a message's content array. It mirrors the
// pi-ai content union sufficiently for rendering: text / thinking / toolCall /
// providerNative / image.
type MessageContent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Thinking string `json:"thinking,omitempty"`

	// toolCall fields.
	ID   string         `json:"id,omitempty"`
	Name string         `json:"name,omitempty"`
	Args map[string]any `json:"arguments,omitempty"`

	// image fields.
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

// AssistantMessage is a decoded assistant message for rendering. Mirrors the
// pi-ai AssistantMessage fields the renderer reads.
type AssistantMessage struct {
	Content      []MessageContent `json:"content"`
	StopReason   string           `json:"stopReason,omitempty"`
	ErrorMessage string           `json:"errorMessage,omitempty"`
}

// ToolCall is a requested tool invocation.
type ToolCall struct {
	ID   string
	Name string
	Args map[string]any
}

// ContentBlock is a tool-result content block (text or image).
type ContentBlock struct {
	Type     string
	Text     string
	Data     string
	MimeType string
}

// ToolResult is the finalized result of a tool call.
type ToolResult struct {
	Content []ContentBlock
	Details any
	IsError bool
}

// CustomMessage is an extension-authored transcript entry.
type CustomMessage struct {
	CustomType string
	// Content is either a string or a slice of MessageContent (text blocks).
	Content any
}

// CompactionSummary carries a context-compaction summary entry.
type CompactionSummary struct {
	TokensBefore int
	Summary      string
	Details      any
}

// SkillBlock is a parsed skill-invocation block.
type SkillBlock struct {
	Name    string
	Content string
}

// FeedMessage is a role-tagged message applied to the Feed via message_start /
// message_update / message_end. Beyond user/assistant it carries the fields the
// custom / branchSummary / compactionSummary roles render (messages.ts shapes).
type FeedMessage struct {
	Role         string           `json:"role"`
	Content      []MessageContent `json:"content"`
	StopReason   string           `json:"stopReason,omitempty"`
	ErrorMessage string           `json:"errorMessage,omitempty"`

	// custom role (CustomMessage): extension-authored entries render only when
	// Display is true, labeled by CustomType.
	CustomType string `json:"customType,omitempty"`
	Display    bool   `json:"display,omitempty"`

	// branchSummary / compactionSummary roles.
	Summary      string `json:"summary,omitempty"`
	TokensBefore int    `json:"tokensBefore,omitempty"`
}

// UnmarshalJSON decodes the message content union: custom messages may carry a
// plain string (`content: string | blocks`, messages.ts CustomMessage) which is
// normalized into a single text block so every renderer sees []MessageContent.
func (m *FeedMessage) UnmarshalJSON(data []byte) error {
	type alias FeedMessage
	var aux struct {
		alias
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*m = FeedMessage(aux.alias)
	m.Content = nil
	raw := bytes.TrimSpace(aux.Content)
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return err
		}
		m.Content = []MessageContent{{Type: "text", Text: text}}
		return nil
	}
	return json.Unmarshal(raw, &m.Content)
}

// FeedEvent is a decoded stream event the Feed consumes. It carries only the
// fields the transcript renders; the full event union is owned + exhaustiveness-
// tested by internal/bridge. Type mirrors the AgentSessionEvent discriminant.
type FeedEvent struct {
	Type string `json:"type"`

	// message_start / message_end.
	Message *FeedMessage `json:"message,omitempty"`

	// tool_execution_* .
	ToolCallID string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
	ToolArgs   map[string]any  `json:"toolArgs,omitempty"`
	Result     *FeedToolResult `json:"result,omitempty"`
	HookCount  int             `json:"hookCount,omitempty"`

	// tool_execution_update: the streamed partial result shown while the tool is
	// still pending (replaced by Result on tool_execution_end).
	Partial *FeedToolResult `json:"partialResult,omitempty"`
}

// FeedToolResult is a tool result carried on a tool_execution_end event.
type FeedToolResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError"`
	Aborted bool           `json:"aborted,omitempty"`
}
