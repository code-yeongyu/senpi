package shell

import (
	"sort"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
)

// WidgetArea renders keyed line blocks contributed by extensions via the
// setWidget extension-UI method (interactive-mode createExtensionUIContext:
// setWidget keys a block of lines placed above or below the editor). Blocks are
// rendered in key order so the layout is deterministic across renders. An empty
// area renders nothing.
//
// Two instances are used by the shell: one above the editor and one below; each
// is fed only the widgets targeting its position.
type WidgetArea struct {
	th      *theme.Theme
	widgets map[string][]string
}

// NewWidgetArea builds an empty widget area.
func NewWidgetArea(th *theme.Theme) *WidgetArea {
	return &WidgetArea{th: th, widgets: map[string][]string{}}
}

// Set installs (or replaces) the block for key. An empty/nil block removes the
// key (parity with setWidget(key, undefined) clearing a widget).
func (w *WidgetArea) Set(key string, lines []string) {
	if len(lines) == 0 {
		delete(w.widgets, key)
		return
	}
	cp := make([]string, len(lines))
	copy(cp, lines)
	w.widgets[key] = cp
}

// Clear removes the block for key.
func (w *WidgetArea) Clear(key string) { delete(w.widgets, key) }

// Len returns the number of active widget keys.
func (w *WidgetArea) Len() int { return len(w.widgets) }

// Render returns every widget block's lines in key order, each truncated to
// width, or nil when the area is empty.
func (w *WidgetArea) Render(width int) []string {
	if len(w.widgets) == 0 {
		return nil
	}
	keys := make([]string, 0, len(w.widgets))
	for k := range w.widgets {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var out []string
	for _, k := range keys {
		for _, line := range w.widgets[k] {
			out = append(out, ui.TruncateToWidth(line, width, w.th.TextDim().Render("...")))
		}
	}
	return out
}
