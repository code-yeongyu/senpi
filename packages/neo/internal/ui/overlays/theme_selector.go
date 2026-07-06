package overlays

import "github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"

// theme_selector.go ports theme-selector.ts. It lists the available theme names
// (the current one marked "(current)"), fires a live preview on every selection
// change, and — critically — persists the choice under the neo.theme settings
// key, NEVER the classic `theme` key (writing classic theme would change
// classic-TUI behavior, violating the additive-only guardrail).

// NeoThemeSettingsKey is the settings key neo writes its skin under.
const NeoThemeSettingsKey = "neo.theme"

// ThemeSelector is the theme-choice overlay.
type ThemeSelector struct {
	*listOverlay
	current string
}

// NewThemeSelector builds the overlay from available theme names, preselecting
// current and marking it "(current)".
func NewThemeSelector(current string, themeNames []string) *ThemeSelector {
	items := make([]listItem, len(themeNames))
	for i, name := range themeNames {
		desc := ""
		if name == current {
			desc = "(current)"
		}
		items[i] = listItem{value: name, label: name, description: desc}
	}
	maxVisible := 10
	return &ThemeSelector{listOverlay: newListOverlay(items, current, maxVisible), current: current}
}

// SelectedValue returns the highlighted theme name.
func (o *ThemeSelector) SelectedValue() string { return o.selectedValue() }

// PreviewValue returns the theme name to preview (updated on every move).
func (o *ThemeSelector) PreviewValue() string { return o.previewValue() }

// RenderPlain renders the overlay without color for content assertions.
func (o *ThemeSelector) RenderPlain(width int) []string { return o.renderPlain(width) }

// RenderStyled renders the overlay with grok styling for the QA harness.
func (o *ThemeSelector) RenderStyled(width int) []string { return o.renderStyled(width) }

// HandleKey navigates (updating the preview) and, on confirm, emits a settings
// write to NeoThemeSettingsKey — never the classic key.
func (o *ThemeSelector) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	confirmed, cancelled := o.handleNav(data, kb)
	if cancelled {
		return cancel(savedText)
	}
	if confirmed {
		return selectFileOp("write_settings", map[string]any{
			"key":   NeoThemeSettingsKey,
			"value": o.selectedValue(),
		})
	}
	return none()
}
