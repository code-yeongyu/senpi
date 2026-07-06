package overlays

import (
	"sort"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// model_selector.go ports model-selector.ts: a fuzzy-searchable model list with a
// favorite marker (* / space), a per-provider auth-status indicator, the current
// model marked ✓, ctrl+f favorite toggling, and enter → set_model (persisting the
// default). It embeds a grapheme-safe search input so CJK/IME composition anchors
// the hardware cursor at the insertion point (task-5 contract).

// AuthStatus classifies a provider's credential state for the auth indicator.
type AuthStatus int

const (
	// AuthConfigured means the provider has usable credentials.
	AuthConfigured AuthStatus = iota
	// AuthMissing means no credentials; the row shows a login hint.
	AuthMissing
)

// ModelItem is one selectable model with the fields the selector renders.
type ModelItem struct {
	Provider   string
	ID         string
	Name       string
	AuthStatus AuthStatus
}

// FullID returns provider/id, the favorite/current key.
func (m ModelItem) FullID() string { return m.Provider + "/" + m.ID }

// ModelSelectorOptions configures the overlay.
type ModelSelectorOptions struct {
	Models       []ModelItem
	CurrentModel string // provider/id
	Favorites    FavoriteModelIDs
}

// ModelSelector is the model-picker overlay.
type ModelSelector struct {
	all           []ModelItem
	filtered      []ModelItem
	current       string
	favorites     FavoriteModelIDs
	selectedIndex int
	input         *textInput
	th            *theme.Theme
}

// NewModelSelector builds the overlay, sorting models (current first, favorites,
// then provider/id) and preselecting the current model.
func NewModelSelector(opts ModelSelectorOptions) *ModelSelector {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	o := &ModelSelector{
		current:   opts.CurrentModel,
		favorites: opts.Favorites,
		input:     newTextInput(),
		th:        th,
	}
	o.all = o.sortModels(opts.Models)
	o.filtered = o.all
	o.selectedIndex = o.indexOfCurrent()
	return o
}

func (o *ModelSelector) indexOfCurrent() int {
	for i, m := range o.filtered {
		if m.FullID() == o.current {
			return i
		}
	}
	return 0
}

// sortModels mirrors ModelSelectorComponent.sortModels: current first, favorites
// next, then provider then id.
func (o *ModelSelector) sortModels(models []ModelItem) []ModelItem {
	out := make([]ModelItem, len(models))
	copy(out, models)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		aCur, bCur := a.FullID() == o.current, b.FullID() == o.current
		if aCur != bCur {
			return aCur
		}
		aFav, bFav := o.favorites.IsFavoriteModel(a.FullID()), o.favorites.IsFavoriteModel(b.FullID())
		if aFav != bFav {
			return aFav
		}
		if a.Provider != b.Provider {
			return a.Provider < b.Provider
		}
		return a.ID < b.ID
	})
	return out
}

// searchText mirrors getModelSelectorSearchText (id + provider + name).
func searchText(m ModelItem) string {
	return m.ID + " " + m.Provider + " " + m.Name
}

// filter re-applies the fuzzy query to the sorted list.
func (o *ModelSelector) filter() {
	q := o.input.Value()
	if strings.TrimSpace(q) == "" {
		o.filtered = o.all
	} else {
		o.filtered = ui.FuzzyFilter(o.all, q, searchText)
	}
	if o.selectedIndex > len(o.filtered)-1 {
		o.selectedIndex = maxInt0(len(o.filtered) - 1)
	}
}

func maxInt0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// VisibleModelIDs returns the currently filtered model full-ids (test seam).
func (o *ModelSelector) VisibleModelIDs() []string {
	out := make([]string, len(o.filtered))
	for i, m := range o.filtered {
		out[i] = m.FullID()
	}
	return out
}

// CurrentFavorites returns the live favorite set (updated by ctrl+f).
func (o *ModelSelector) CurrentFavorites() FavoriteModelIDs { return o.favorites }

// CursorCol exposes the search input's insertion column for hardware-cursor
// placement (task-5 IME contract).
func (o *ModelSelector) CursorCol() int { return o.input.CursorCol() }

// HandleKey routes navigation, favorite toggle, confirm, cancel, and otherwise
// feeds the search input.
func (o *ModelSelector) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	switch {
	case matchesInScope(kb, data, "app.models.toggleFavorite", keybindings.ScopeModels):
		o.toggleFavorite()
		return none()
	case matches(kb, data, "tui.select.up"):
		o.moveUp()
		return none()
	case matches(kb, data, "tui.select.down"):
		o.moveDown()
		return none()
	case matches(kb, data, "tui.select.confirm"):
		if m, ok := o.selected(); ok {
			return selectCmd("set_model", map[string]any{"provider": m.Provider, "modelId": m.ID})
		}
		return none()
	case matches(kb, data, "tui.select.cancel"):
		return cancel(savedText)
	}
	if o.input.handleKey(data, kb) {
		o.filter()
	}
	return none()
}

func (o *ModelSelector) selected() (ModelItem, bool) {
	if o.selectedIndex < 0 || o.selectedIndex >= len(o.filtered) {
		return ModelItem{}, false
	}
	return o.filtered[o.selectedIndex], true
}

func (o *ModelSelector) moveUp() {
	if len(o.filtered) == 0 {
		return
	}
	if o.selectedIndex == 0 {
		o.selectedIndex = len(o.filtered) - 1
	} else {
		o.selectedIndex--
	}
}

func (o *ModelSelector) moveDown() {
	if len(o.filtered) == 0 {
		return
	}
	if o.selectedIndex == len(o.filtered)-1 {
		o.selectedIndex = 0
	} else {
		o.selectedIndex++
	}
}

// toggleFavorite mirrors handleToggleFavorite: flip the selected model, re-sort,
// re-filter, and keep it selected.
func (o *ModelSelector) toggleFavorite() {
	m, ok := o.selected()
	if !ok {
		return
	}
	allIDs := make([]string, len(o.all))
	for i, x := range o.all {
		allIDs[i] = x.FullID()
	}
	o.favorites = o.favorites.ToggleFavoriteModel(allIDs, m.FullID())
	o.all = o.sortModels(o.all)
	o.filter()
	for i, x := range o.filtered {
		if x.FullID() == m.FullID() {
			o.selectedIndex = i
			break
		}
	}
}

// authIndicator returns the per-provider auth-status marker text.
func authIndicator(status AuthStatus) string {
	if status == AuthMissing {
		return " (no auth — /login)"
	}
	return ""
}

// RenderPlain renders the overlay without color for content assertions.
func (o *ModelSelector) RenderPlain(width int) []string { return o.render(width, false) }

// RenderStyled renders the overlay with grok styling for the QA harness.
func (o *ModelSelector) RenderStyled(width int) []string { return o.render(width, true) }

func (o *ModelSelector) render(width int, styled bool) []string {
	style := func(fn func() lipgloss.Style, s string) string {
		if !styled {
			return s
		}
		return fn().Render(s)
	}
	border := ui.NewDynamicBorder(o.th).Render(width)
	if !styled {
		for i, l := range border {
			border[i] = ui.StripANSI(l)
		}
	}
	lines := append([]string(nil), border...)
	// Search input row.
	lines = append(lines, "search: "+o.input.Value())
	lines = append(lines, "")

	if len(o.filtered) == 0 {
		if len(o.all) == 0 {
			lines = append(lines, style(o.th.TextMuted, "  No models available"))
		} else {
			lines = append(lines, style(o.th.TextMuted, "  No matching models"))
		}
		lines = append(lines, border...)
		return lines
	}

	maxVisible := 10
	start := clampStart(o.selectedIndex, maxVisible, len(o.filtered))
	end := start + maxVisible
	if end > len(o.filtered) {
		end = len(o.filtered)
	}
	for i := start; i < end; i++ {
		m := o.filtered[i]
		isSelected := i == o.selectedIndex
		isCurrent := m.FullID() == o.current
		favMarker := "  "
		if o.favorites.IsFavoriteModel(m.FullID()) {
			favMarker = style(o.th.AccentGreen, "* ")
		}
		check := ""
		if isCurrent {
			check = style(o.th.AccentGreen, " ✓")
		}
		provider := style(o.th.TextMuted, "["+m.Provider+"]")
		auth := style(o.th.AccentRed, authIndicator(m.AuthStatus))
		prefix := "  "
		id := m.ID
		if isSelected {
			prefix = style(o.th.AccentBlue, "→ ")
			id = style(o.th.AccentBlue, m.ID)
		}
		lines = append(lines, prefix+favMarker+id+" "+provider+check+auth)
	}
	if start > 0 || end < len(o.filtered) {
		lines = append(lines, style(o.th.TextMuted, "  ("+strconv.Itoa(o.selectedIndex+1)+"/"+strconv.Itoa(len(o.filtered))+")"))
	}
	lines = append(lines, border...)
	return lines
}

func clampStart(selected, maxVisible, n int) int {
	start := selected - maxVisible/2
	if start > n-maxVisible {
		start = n - maxVisible
	}
	if start < 0 {
		start = 0
	}
	return start
}
