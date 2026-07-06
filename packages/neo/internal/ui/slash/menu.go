package slash

import (
	"strconv"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
)

// itoa is the local integer formatter (avoids importing strconv at every call
// site in filewalk).
func itoa(n int) string { return strconv.Itoa(n) }

// NewSlashMenu builds the grok-styled slash/autocomplete popup over the current
// editor suggestions, reusing the wave-1 ui.SlashMenu primitive. maxVisible
// bounds the inline window; total is the full command count shown in the top
// rule marker.
//
// This is the render bridge between the editor's autocomplete suggestion set and
// the shared popup primitive: each suggestion becomes a SelectItem (primary =
// the label, secondary = the description carrying the source tag).
func NewSlashMenu(th *theme.Theme, items []editor.Item, maxVisible, total int) *ui.SlashMenu {
	selItems := make([]ui.SelectItem, len(items))
	for i, it := range items {
		primary := it.Label
		if primary == "" {
			primary = it.Value
		}
		selItems[i] = ui.SelectItem{Label: "/" + primary, Value: it.Value, Description: it.Description}
	}
	return ui.NewSlashMenu(th, selItems, maxVisible, total)
}
