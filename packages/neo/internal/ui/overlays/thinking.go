package overlays

import "github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"

// thinking.go ports thinking-selector.ts. The overlay lists the available
// thinking levels (each with its token-budget description) with the current
// level preselected; confirming emits a set_thinking_level RPC command.

// thinkingDescriptions mirrors LEVEL_DESCRIPTIONS (thinking-selector.ts:11-19).
var thinkingDescriptions = map[string]string{
	"off":     "No reasoning",
	"minimal": "Very brief reasoning (~1k tokens)",
	"low":     "Light reasoning (~2k tokens)",
	"medium":  "Moderate reasoning (~8k tokens)",
	"high":    "Deep reasoning (~16k tokens)",
	"xhigh":   "Extended reasoning (~32k tokens or native xhigh effort)",
	"max":     "Unbounded reasoning (Anthropic native max effort; Opus 4.7)",
}

// ThinkingSelector is the thinking-level overlay.
type ThinkingSelector struct {
	*listOverlay
}

// NewThinkingSelector builds the overlay from the available levels, preselecting
// current. The list is sized to show every level (thinkingLevels.length).
func NewThinkingSelector(current string, availableLevels []string) *ThinkingSelector {
	items := make([]listItem, len(availableLevels))
	for i, lvl := range availableLevels {
		items[i] = listItem{value: lvl, label: lvl, description: thinkingDescriptions[lvl]}
	}
	maxVisible := len(items)
	if maxVisible < 1 {
		maxVisible = 1
	}
	return &ThinkingSelector{listOverlay: newListOverlay(items, current, maxVisible)}
}

// SelectedValue returns the highlighted level.
func (o *ThinkingSelector) SelectedValue() string { return o.selectedValue() }

// RenderPlain renders the overlay without color for content assertions.
func (o *ThinkingSelector) RenderPlain(width int) []string { return o.renderPlain(width) }

// RenderStyled renders the overlay with grok styling for the QA harness.
func (o *ThinkingSelector) RenderStyled(width int) []string { return o.renderStyled(width) }

// HandleKey navigates and, on confirm, emits set_thinking_level.
func (o *ThinkingSelector) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	confirmed, cancelled := o.handleNav(data, kb)
	if cancelled {
		return cancel(savedText)
	}
	if confirmed {
		return selectCmd("set_thinking_level", map[string]any{"level": o.selectedValue()})
	}
	return none()
}
