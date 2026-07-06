package transcript

// Ported/derived contract for message renderers. Sources (all under
// packages/coding-agent/src/modes/interactive/components/):
//   assistant-message.ts, user-message.ts, custom-message.ts,
//   branch-summary-message.ts, compaction-summary-message.ts,
//   skill-invocation-message.ts.
// Assertions target the structural rendering (labels, markdown body, error
// surfacing, collapse/expand hint text) with the exact-hex cell checks deferred
// to the xterm.js harness in QA.
//
// RED first: the renderers do not exist until GREEN.

import (
	"strings"
	"testing"
)

func TestUserMessage_RendersMarkdownBody(t *testing.T) {
	m := NewUserMessage("hello **world**", DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "hello") || !strings.Contains(joined, "world") {
		t.Fatalf("user message body missing: %q", joined)
	}
}

func TestAssistantMessage_TextContent(t *testing.T) {
	m := NewAssistantMessage(AssistantMessage{
		Content: []MessageContent{{Type: "text", Text: "The build finished."}},
	}, AssistantOptions{}, DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "The build finished.") {
		t.Fatalf("assistant text missing: %q", joined)
	}
}

func TestAssistantMessage_AbortedShowsError(t *testing.T) {
	// stopReason "aborted" with no tool calls surfaces an abort notice
	// (assistant-message.ts:212-218), NOT an orphan spinner.
	m := NewAssistantMessage(AssistantMessage{
		Content:    []MessageContent{{Type: "text", Text: "partial"}},
		StopReason: "aborted",
	}, AssistantOptions{}, DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "Operation aborted") {
		t.Fatalf("aborted notice missing: %q", joined)
	}
}

func TestAssistantMessage_ErrorStopReason(t *testing.T) {
	m := NewAssistantMessage(AssistantMessage{
		Content:      []MessageContent{{Type: "text", Text: "oops"}},
		StopReason:   "error",
		ErrorMessage: "boom",
	}, AssistantOptions{}, DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "Error: boom") {
		t.Fatalf("error notice missing: %q", joined)
	}
}

func TestAssistantMessage_ThinkingHiddenLabel(t *testing.T) {
	// When hideThinkingBlock is set, thinking content collapses to the static
	// label (assistant-message.ts:153-160).
	m := NewAssistantMessage(AssistantMessage{
		Content: []MessageContent{{Type: "thinking", Thinking: "deep thoughts"}},
	}, AssistantOptions{HideThinking: true, HiddenThinkingLabel: "Thinking..."}, DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "Thinking...") {
		t.Fatalf("hidden thinking label missing: %q", joined)
	}
	if strings.Contains(joined, "deep thoughts") {
		t.Fatalf("thinking body shown while hidden: %q", joined)
	}
}

func TestAssistantMessage_ThinkingShownWhenToggled(t *testing.T) {
	m := NewAssistantMessage(AssistantMessage{
		Content: []MessageContent{{Type: "thinking", Thinking: "deep thoughts"}},
	}, AssistantOptions{HideThinking: false}, DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "deep thoughts") {
		t.Fatalf("thinking body missing when shown: %q", joined)
	}
}

func TestCustomMessage_DefaultLabelAndBody(t *testing.T) {
	m := NewCustomMessage(CustomMessage{
		CustomType: "note",
		Content:    "a custom note",
	}, DefaultRenderTheme())
	joined := strings.Join(m.Render(80), "\n")
	if !strings.Contains(joined, "[note]") {
		t.Fatalf("custom label missing: %q", joined)
	}
	if !strings.Contains(joined, "a custom note") {
		t.Fatalf("custom body missing: %q", joined)
	}
}

func TestBranchSummary_CollapsedAndExpanded(t *testing.T) {
	m := NewBranchSummaryMessage("the summary text", "ctrl+o", DefaultRenderTheme())
	collapsed := strings.Join(m.Render(80), "\n")
	if !strings.Contains(collapsed, "[branch]") || !strings.Contains(collapsed, "Branch summary") {
		t.Fatalf("collapsed branch missing label: %q", collapsed)
	}
	if !strings.Contains(collapsed, "ctrl+o") {
		t.Fatalf("collapsed branch missing expand hint: %q", collapsed)
	}
	if strings.Contains(collapsed, "the summary text") {
		t.Fatalf("collapsed branch leaked body: %q", collapsed)
	}
	m.SetExpanded(true)
	expanded := strings.Join(m.Render(80), "\n")
	if !strings.Contains(expanded, "the summary text") {
		t.Fatalf("expanded branch missing body: %q", expanded)
	}
}

func TestCompactionSummary_CollapsedShowsTokens(t *testing.T) {
	m := NewCompactionSummaryMessage(CompactionSummary{
		TokensBefore: 12000,
		Summary:      "compaction body",
	}, "ctrl+o", DefaultRenderTheme())
	collapsed := strings.Join(m.Render(80), "\n")
	if !strings.Contains(collapsed, "[compaction]") {
		t.Fatalf("compaction label missing: %q", collapsed)
	}
	if !strings.Contains(collapsed, "12,000 tokens") {
		t.Fatalf("compaction token count missing/unlocalized: %q", collapsed)
	}
	m.SetExpanded(true)
	expanded := strings.Join(m.Render(80), "\n")
	if !strings.Contains(expanded, "compaction body") {
		t.Fatalf("expanded compaction body missing: %q", expanded)
	}
}

func TestSkillInvocation_CollapsedAndExpanded(t *testing.T) {
	m := NewSkillInvocationMessage(SkillBlock{
		Name:    "senpi-qa",
		Content: "skill details here",
	}, "ctrl+o", DefaultRenderTheme())
	collapsed := strings.Join(m.Render(80), "\n")
	if !strings.Contains(collapsed, "[skill]") || !strings.Contains(collapsed, "senpi-qa") {
		t.Fatalf("collapsed skill missing label/name: %q", collapsed)
	}
	if strings.Contains(collapsed, "skill details here") {
		t.Fatalf("collapsed skill leaked content: %q", collapsed)
	}
	m.SetExpanded(true)
	expanded := strings.Join(m.Render(80), "\n")
	if !strings.Contains(expanded, "skill details here") {
		t.Fatalf("expanded skill missing content: %q", expanded)
	}
}
