package transcript

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/markdown"
)

// OSC 133 shell-integration zone markers (prompt/output boundaries). Emitted
// around user/assistant messages exactly as the classic components do, so the
// grok terminal-integration behavior is preserved.
const (
	osc133ZoneStart = "\x1b]133;A\x07"
	osc133ZoneEnd   = "\x1b]133;B\x07"
	osc133ZoneFinal = "\x1b]133;C\x07"
)

// UserMessage renders a user turn: the source markdown in a panel surface with
// OSC 133 prompt-zone markers. Port of user-message.ts.
type UserMessage struct {
	text  string
	theme RenderTheme
	pad   int
}

// NewUserMessage builds a user message renderer.
func NewUserMessage(text string, t RenderTheme) *UserMessage {
	return &UserMessage{text: text, theme: t, pad: 1}
}

// Render lays out the user message to width columns.
func (u *UserMessage) Render(width int) []string {
	md := markdown.New(u.text, u.pad, 1, u.theme.Markdown,
		&markdown.DefaultTextStyle{Color: u.theme.CustomText, BgColor: u.theme.UserBg},
		&markdown.Options{PreserveOrderedListMarkers: true, PreserveBackslashEscapes: true})
	lines := md.Render(width)
	return wrapZone(lines)
}

// AssistantOptions toggles thinking display + expansion for AssistantMessage.
type AssistantOptions struct {
	HideThinking        bool
	HiddenThinkingLabel string
	Expanded            bool
	OutputPad           int
}

// AssistantMessageComponent renders an assistant turn: ordered text/thinking
// content blocks plus stop-reason error/abort notices. Port of
// assistant-message.ts (tool-call blocks are rendered separately by the Feed).
type AssistantMessageComponent struct {
	msg   AssistantMessage
	opts  AssistantOptions
	theme RenderTheme
}

// NewAssistantMessage builds an assistant message renderer.
func NewAssistantMessage(msg AssistantMessage, opts AssistantOptions, t RenderTheme) *AssistantMessageComponent {
	if opts.OutputPad == 0 {
		opts.OutputPad = 1
	}
	if opts.HiddenThinkingLabel == "" {
		opts.HiddenThinkingLabel = "Thinking..."
	}
	return &AssistantMessageComponent{msg: msg, opts: opts, theme: t}
}

// SetExpanded toggles provider-native expansion.
func (a *AssistantMessageComponent) SetExpanded(expanded bool) { a.opts.Expanded = expanded }

// SetHideThinking toggles the thinking-block collapse.
func (a *AssistantMessageComponent) SetHideThinking(hide bool) { a.opts.HideThinking = hide }

// Render lays out the assistant message.
func (a *AssistantMessageComponent) Render(width int) []string {
	pad := a.opts.OutputPad
	var out []string

	hasVisible := false
	for _, c := range a.msg.Content {
		if (c.Type == "text" && strings.TrimSpace(c.Text) != "") ||
			(c.Type == "thinking" && strings.TrimSpace(c.Thinking) != "") {
			hasVisible = true
			break
		}
	}
	if hasVisible {
		out = append(out, "")
	}

	for i, c := range a.msg.Content {
		switch {
		case c.Type == "text" && strings.TrimSpace(c.Text) != "":
			md := markdown.New(strings.TrimSpace(c.Text), pad, 0, a.theme.Markdown, nil, nil)
			out = append(out, md.Render(width)...)
		case c.Type == "thinking" && strings.TrimSpace(c.Thinking) != "":
			hasVisibleAfter := a.hasVisibleContentAfter(i)
			if a.opts.HideThinking {
				out = append(out, a.theme.ThinkingText(italic(a.opts.HiddenThinkingLabel)))
				if hasVisibleAfter {
					out = append(out, "")
				}
			} else {
				md := markdown.New(strings.TrimSpace(c.Thinking), pad, 0, a.theme.Markdown,
					&markdown.DefaultTextStyle{Color: a.theme.ThinkingText, Italic: true}, nil)
				out = append(out, md.Render(width)...)
				if hasVisibleAfter {
					out = append(out, "")
				}
			}
		}
	}

	// Stop-reason surfacing. Tool-call messages defer errors to the tool block.
	hasToolCalls := false
	for _, c := range a.msg.Content {
		if c.Type == "toolCall" {
			hasToolCalls = true
			break
		}
	}
	switch {
	case a.msg.StopReason == "length":
		out = append(out, "")
		out = append(out, a.theme.Error("Error: Model stopped because it reached the maximum output token limit. The response may be incomplete."))
	case !hasToolCalls && a.msg.StopReason == "aborted":
		abortMsg := "Operation aborted"
		if a.msg.ErrorMessage != "" && a.msg.ErrorMessage != "Request was aborted" {
			abortMsg = a.msg.ErrorMessage
		}
		out = append(out, "")
		out = append(out, a.theme.Error(abortMsg))
	case !hasToolCalls && a.msg.StopReason == "error":
		errMsg := a.msg.ErrorMessage
		if errMsg == "" {
			errMsg = "Unknown error"
		}
		out = append(out, "")
		out = append(out, a.theme.Error("Error: "+errMsg))
	}

	return wrapZoneIfNoTools(out, hasToolCalls)
}

func (a *AssistantMessageComponent) hasVisibleContentAfter(idx int) bool {
	for _, c := range a.msg.Content[idx+1:] {
		if (c.Type == "text" && strings.TrimSpace(c.Text) != "") ||
			(c.Type == "thinking" && strings.TrimSpace(c.Thinking) != "") {
			return true
		}
	}
	return false
}

// CustomMessageComponent renders an extension-authored transcript entry: a
// bold `[type]` label + markdown body on the custom surface. Port of
// custom-message.ts default rendering.
type CustomMessageComponent struct {
	msg   CustomMessage
	theme RenderTheme
}

// NewCustomMessage builds a custom message renderer.
func NewCustomMessage(msg CustomMessage, t RenderTheme) *CustomMessageComponent {
	return &CustomMessageComponent{msg: msg, theme: t}
}

// Render lays out the custom message.
func (c *CustomMessageComponent) Render(width int) []string {
	var out []string
	out = append(out, "")
	label := c.theme.CustomLabel(bold("[" + c.msg.CustomType + "]"))
	out = append(out, label)
	out = append(out, "")

	text := customContentText(c.msg.Content)
	md := markdown.New(text, 0, 0, c.theme.Markdown,
		&markdown.DefaultTextStyle{Color: c.theme.CustomText, BgColor: c.theme.CustomBg}, nil)
	out = append(out, md.Render(width)...)
	return out
}

func customContentText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []MessageContent:
		var parts []string
		for _, b := range v {
			if b.Type == "text" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}
