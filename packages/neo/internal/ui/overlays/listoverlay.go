package overlays

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// listoverlay.go provides the bordered-select-list scaffolding shared by the
// thinking selector, theme selector, and hotkeys view — the overlays that are
// (per the TS sources) thin wrappers over SelectList + a DynamicBorder. It
// centralizes navigation (tui.select.up/down wrap, confirm, cancel), the
// preselect-current logic, and the selection-change preview hook so each concrete
// overlay only supplies its items and its confirm mapping.

// listItem is one row (value + label + description) for the shared list overlay.
type listItem struct {
	value       string
	label       string
	description string
}

// listOverlay is the shared bordered list. It owns a SelectList and tracks the
// preview value (fired on every selection change, mirroring
// SelectList.onSelectionChange → onPreview in theme-selector.ts).
type listOverlay struct {
	list    *ui.SelectList
	items   []listItem
	preview string
	th      *theme.Theme
}

func newListOverlay(items []listItem, current string, maxVisible int) *listOverlay {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	selItems := make([]ui.SelectItem, len(items))
	for i, it := range items {
		selItems[i] = ui.SelectItem{Value: it.value, Label: it.label, Description: it.description}
	}
	list := ui.NewSelectList(selItems, maxVisible, listSelectTheme(th), ui.SelectListLayout{
		MinPrimaryColumnWidth: 12,
		MaxPrimaryColumnWidth: 32,
	})
	o := &listOverlay{list: list, items: items, th: th, preview: current}
	// Preselect the current value (findIndex(value === current)).
	for i, it := range items {
		if it.value == current {
			list.SetSelectedIndex(i)
			o.preview = it.value
			break
		}
	}
	return o
}

// listSelectTheme builds the SelectList theme fns from the neo theme: the
// selected row is accent-blue, descriptions muted (mirrors getSelectListTheme).
func listSelectTheme(th *theme.Theme) ui.SelectListTheme {
	return ui.SelectListTheme{
		SelectedText: func(s string) string { return th.AccentBlue().Render(s) },
		Description:  func(s string) string { return th.TextMuted().Render(s) },
		ScrollInfo:   func(s string) string { return th.TextMuted().Render(s) },
		NoMatch:      func(s string) string { return th.TextMuted().Render(s) },
	}
}

// selectedValue returns the highlighted row's value.
func (o *listOverlay) selectedValue() string {
	if it, ok := o.list.SelectedItem(); ok {
		return it.Value
	}
	return ""
}

// previewValue returns the last previewed value (updated on every move).
func (o *listOverlay) previewValue() string { return o.preview }

// handleNav processes navigation/confirm/cancel keys shared by every list
// overlay. It returns (confirmed, cancelled) so the concrete overlay can build
// its own Outcome (thinking → RPC, theme → settings write) on confirm.
func (o *listOverlay) handleNav(data string, kb *keybindings.Manager) (confirmed, cancelled bool) {
	switch {
	case matches(kb, data, "tui.select.up"):
		o.list.MoveUp()
		o.preview = o.selectedValue()
		return false, false
	case matches(kb, data, "tui.select.down"):
		o.list.MoveDown()
		o.preview = o.selectedValue()
		return false, false
	case matches(kb, data, "tui.select.confirm"):
		return true, false
	case matches(kb, data, "tui.select.cancel"):
		return false, true
	}
	return false, false
}

// renderPlain renders the bordered list without color for content assertions.
func (o *listOverlay) renderPlain(width int) []string {
	return o.renderList(width, false)
}

// renderStyled renders the bordered list with grok styling for the QA harness.
func (o *listOverlay) renderStyled(width int) []string {
	return o.renderList(width, true)
}

func (o *listOverlay) renderList(width int, styled bool) []string {
	body := o.list.Render(width)
	if !styled {
		for i, l := range body {
			body[i] = ui.StripANSI(l)
		}
	}
	border := ui.NewDynamicBorder(o.th).Render(width)
	if !styled {
		for i, l := range border {
			border[i] = ui.StripANSI(l)
		}
	}
	out := make([]string, 0, len(body)+len(border)*2)
	out = append(out, border...)
	out = append(out, body...)
	out = append(out, border...)
	return out
}
