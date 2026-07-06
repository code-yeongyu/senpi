package overlays

import (
	"sort"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// hotkeys.go renders the /hotkeys view: every action's effective binding drawn
// live from the keybinding registry (Definitions + the Manager's resolved keys),
// so user overrides are reflected and nothing is hardcoded. This is the neo
// analogue of the classic hotkeys screen, built from the same registry the app
// dispatches through.

// HotkeysView lists action → key bindings from the registry.
type HotkeysView struct {
	mgr *keybindings.Manager
	th  *theme.Theme
}

// NewHotkeysView builds the view over a keybinding manager.
func NewHotkeysView(mgr *keybindings.Manager) *HotkeysView {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	return &HotkeysView{mgr: mgr, th: th}
}

// HandleKey closes the view on cancel; other keys are ignored (read-only view).
func (o *HotkeysView) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	if matches(kb, data, "tui.select.cancel") {
		return cancel(savedText)
	}
	return none()
}

// RenderPlain renders the view without color for content assertions.
func (o *HotkeysView) RenderPlain(width int) []string { return o.render(width, false) }

// RenderStyled renders the view with grok styling for the QA harness.
func (o *HotkeysView) RenderStyled(width int) []string { return o.render(width, true) }

func (o *HotkeysView) render(width int, styled bool) []string {
	style := func(fn func() lipgloss.Style, s string) string {
		if !styled {
			return s
		}
		return fn().Render(s)
	}
	defs := keybindings.Definitions()
	ids := make([]string, 0, len(defs))
	for id := range defs {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	border := ui.NewDynamicBorder(o.th).Render(width)
	if !styled {
		for i, l := range border {
			border[i] = ui.StripANSI(l)
		}
	}
	lines := append([]string(nil), border...)
	lines = append(lines, style(o.th.AccentBlue, "Hotkeys"))
	lines = append(lines, "")
	for _, id := range ids {
		def := defs[id]
		keys := o.mgr.Keys(id) // effective (override-aware) bindings
		if len(keys) == 0 {
			continue
		}
		keyText := strings.Join(keys, ", ")
		label := def.Description
		if label == "" {
			label = id
		}
		lines = append(lines,
			style(o.th.TextLabel, padRight(keyText, 22))+style(o.th.TextSecondary, label))
	}
	lines = append(lines, border...)
	return lines
}

func padRight(s string, w int) string {
	for ui.VisibleWidth(s) < w {
		s += " "
	}
	return s
}
