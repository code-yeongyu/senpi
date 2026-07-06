package ui

import "strings"

// select-list layout constants (verbatim from
// packages/tui/src/components/select-list.ts).
const (
	defaultPrimaryColumnWidth = 32
	primaryColumnGap          = 2
	minDescriptionWidth       = 10
)

// SelectItem is one selectable row.
type SelectItem struct {
	Value       string
	Label       string
	Description string
}

// SelectListTheme wraps the styling fns the list uses. Each takes plain text and
// returns styled text; an identity theme (used by the contract tests) leaves
// visible width unchanged.
type SelectListTheme struct {
	SelectedPrefix func(string) string
	SelectedText   func(string) string
	Description    func(string) string
	ScrollInfo     func(string) string
	NoMatch        func(string) string
}

// SelectTruncateContext is passed to a caller's TruncatePrimary override.
type SelectTruncateContext struct {
	Text        string
	MaxWidth    int
	ColumnWidth int
	Item        SelectItem
	IsSelected  bool
}

// SelectListLayout tunes the primary-column bounds and primary truncation.
type SelectListLayout struct {
	MinPrimaryColumnWidth int
	MaxPrimaryColumnWidth int
	TruncatePrimary       func(SelectTruncateContext) string
}

// SelectList is a filtered, scrollable single-column list with an aligned
// secondary description column. Faithful port of the pi-tui SelectList render
// algorithm (column-width bounds, description alignment, per-row truncation,
// centered scroll window). Visual styling (grok highlight / prompt glyph) is
// injected via the theme fns; the higher-level SlashMenu wraps this with the
// grok rule lines + scrollbar + count marker.
type SelectList struct {
	items         []SelectItem
	filteredItems []SelectItem
	selectedIndex int
	maxVisible    int
	theme         SelectListTheme
	layout        SelectListLayout
}

// NewSelectList builds a SelectList over items (all initially unfiltered).
func NewSelectList(items []SelectItem, maxVisible int, th SelectListTheme, layout SelectListLayout) *SelectList {
	if maxVisible < 1 {
		maxVisible = 1
	}
	return &SelectList{
		items:         items,
		filteredItems: items,
		maxVisible:    maxVisible,
		theme:         th,
		layout:        layout,
	}
}

// SetFilter narrows the list to items whose value has the given prefix
// (case-insensitive), resetting the selection — matches SelectList.setFilter.
func (s *SelectList) SetFilter(filter string) {
	lower := strings.ToLower(filter)
	out := s.items[:0:0]
	for _, item := range s.items {
		if strings.HasPrefix(strings.ToLower(item.Value), lower) {
			out = append(out, item)
		}
	}
	s.filteredItems = out
	s.selectedIndex = 0
}

// SetSelectedIndex clamps and sets the selected row.
func (s *SelectList) SetSelectedIndex(index int) {
	if index < 0 {
		index = 0
	}
	if max := len(s.filteredItems) - 1; index > max {
		index = max
	}
	if index < 0 {
		index = 0
	}
	s.selectedIndex = index
}

// SelectedIndex returns the current selection index.
func (s *SelectList) SelectedIndex() int { return s.selectedIndex }

// MoveUp moves the selection up, wrapping to the bottom (SelectList.up).
func (s *SelectList) MoveUp() {
	n := len(s.filteredItems)
	if n == 0 {
		return
	}
	if s.selectedIndex == 0 {
		s.selectedIndex = n - 1
	} else {
		s.selectedIndex--
	}
}

// MoveDown moves the selection down, wrapping to the top (SelectList.down).
func (s *SelectList) MoveDown() {
	n := len(s.filteredItems)
	if n == 0 {
		return
	}
	if s.selectedIndex == n-1 {
		s.selectedIndex = 0
	} else {
		s.selectedIndex++
	}
}

// SelectedItem returns the currently selected item, or false when the list is
// empty.
func (s *SelectList) SelectedItem() (SelectItem, bool) {
	if s.selectedIndex < 0 || s.selectedIndex >= len(s.filteredItems) {
		return SelectItem{}, false
	}
	return s.filteredItems[s.selectedIndex], true
}

// VisibleRange returns the [start,end) window of filtered indices currently
// rendered, given the centered-scroll rule. Exposed so the SlashMenu can align
// its scrollbar marker with the same window.
func (s *SelectList) VisibleRange() (int, int) {
	n := len(s.filteredItems)
	start := s.selectedIndex - s.maxVisible/2
	if hi := n - s.maxVisible; start > hi {
		start = hi
	}
	if start < 0 {
		start = 0
	}
	end := start + s.maxVisible
	if end > n {
		end = n
	}
	return start, end
}

// Render returns the list's lines for the given render width. Empty filtered
// list → a single no-match line. Matches SelectList.render.
func (s *SelectList) Render(width int) []string {
	if len(s.filteredItems) == 0 {
		return []string{s.theme.NoMatch("  No matching commands")}
	}

	primaryColumnWidth := s.primaryColumnWidth()
	start, end := s.VisibleRange()

	lines := make([]string, 0, s.maxVisible+1)
	for i := start; i < end; i++ {
		item := s.filteredItems[i]
		isSelected := i == s.selectedIndex
		desc := ""
		if item.Description != "" {
			desc = normalizeToSingleLine(item.Description)
		}
		lines = append(lines, s.renderItem(item, isSelected, width, desc, primaryColumnWidth))
	}

	if start > 0 || end < len(s.filteredItems) {
		scrollText := "  (" + itoaUI(s.selectedIndex+1) + "/" + itoaUI(len(s.filteredItems)) + ")"
		lines = append(lines, s.theme.ScrollInfo(TruncateToWidth(scrollText, width-2, "")))
	}
	return lines
}

// renderItem renders a single row with aligned description (port of
// SelectList.renderItem).
func (s *SelectList) renderItem(item SelectItem, isSelected bool, width int, desc string, primaryColumnWidth int) string {
	prefix := "  "
	if isSelected {
		prefix = "❯ "
	}
	prefixWidth := VisibleWidth(prefix)

	if desc != "" && width > 40 {
		effectivePrimary := clampInt(primaryColumnWidth, 1, width-prefixWidth-4)
		maxPrimaryWidth := maxInt(1, effectivePrimary-primaryColumnGap)
		truncatedValue := s.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimary)
		truncatedValueWidth := VisibleWidth(truncatedValue)
		spacingWidth := maxInt(1, effectivePrimary-truncatedValueWidth)
		spacing := spaces(spacingWidth)
		descriptionStart := prefixWidth + truncatedValueWidth + spacingWidth
		remainingWidth := width - descriptionStart - 2

		if remainingWidth > minDescriptionWidth {
			truncatedDesc := TruncateToWidth(desc, remainingWidth, "")
			if isSelected {
				return s.theme.SelectedText(prefix + truncatedValue + spacing + truncatedDesc)
			}
			descText := s.theme.Description(spacing + truncatedDesc)
			return prefix + truncatedValue + descText
		}
	}

	maxWidth := width - prefixWidth - 2
	truncatedValue := s.truncatePrimary(item, isSelected, maxWidth, maxWidth)
	if isSelected {
		return s.theme.SelectedText(prefix + truncatedValue)
	}
	return prefix + truncatedValue
}

// primaryColumnWidth computes the clamped primary column width (port of
// getPrimaryColumnWidth).
func (s *SelectList) primaryColumnWidth() int {
	lo, hi := s.primaryColumnBounds()
	widest := 0
	for _, item := range s.filteredItems {
		w := VisibleWidth(s.displayValue(item)) + primaryColumnGap
		if w > widest {
			widest = w
		}
	}
	return clampInt(widest, lo, hi)
}

// primaryColumnBounds resolves the min/max column width (port of
// getPrimaryColumnBounds).
func (s *SelectList) primaryColumnBounds() (lo, hi int) {
	rawMin := firstNonZero(s.layout.MinPrimaryColumnWidth, s.layout.MaxPrimaryColumnWidth, defaultPrimaryColumnWidth)
	rawMax := firstNonZero(s.layout.MaxPrimaryColumnWidth, s.layout.MinPrimaryColumnWidth, defaultPrimaryColumnWidth)
	lo = maxInt(1, minInt(rawMin, rawMax))
	hi = maxInt(1, maxInt(rawMin, rawMax))
	return lo, hi
}

// truncatePrimary applies the caller's override then a final hard clip (port of
// truncatePrimary — the double truncate is intentional so overrides can't exceed
// maxWidth).
func (s *SelectList) truncatePrimary(item SelectItem, isSelected bool, maxWidth, columnWidth int) string {
	display := s.displayValue(item)
	var truncated string
	if s.layout.TruncatePrimary != nil {
		truncated = s.layout.TruncatePrimary(SelectTruncateContext{
			Text:        display,
			MaxWidth:    maxWidth,
			ColumnWidth: columnWidth,
			Item:        item,
			IsSelected:  isSelected,
		})
	} else {
		truncated = TruncateToWidth(display, maxWidth, "")
	}
	return TruncateToWidth(truncated, maxWidth, "")
}

func (s *SelectList) displayValue(item SelectItem) string {
	if item.Label != "" {
		return item.Label
	}
	return item.Value
}

// normalizeToSingleLine collapses newlines to single spaces (select-list.ts
// normalizeToSingleLine), matching the /[\r\n]+/ → " " replacement.
func normalizeToSingleLine(text string) string {
	replacer := strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ")
	collapsed := replacer.Replace(text)
	for strings.Contains(collapsed, "  ") {
		collapsed = strings.ReplaceAll(collapsed, "  ", " ")
	}
	return strings.TrimSpace(collapsed)
}
