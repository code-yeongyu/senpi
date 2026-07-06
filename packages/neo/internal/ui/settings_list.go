package ui

// SettingItem is one row in a settings list.
type SettingItem struct {
	ID           string
	Label        string
	Description  string
	CurrentValue string
	// Values, when set, are cycled on activate (Enter/Space).
	Values []string
	// Expandable marks a row that opens a submenu (grok shows a trailing ›).
	Expandable bool
}

// SettingsListTheme wraps the styling fns. label/value receive a `selected`
// flag; cursor is the selected-row prefix glyph (grok ▸).
type SettingsListTheme struct {
	Label       func(text string, selected bool) string
	Value       func(text string, selected bool) string
	Description func(string) string
	Hint        func(string) string
	Cursor      string
}

// SettingsList is the grok settings modal body: a label/value list with an
// aligned value column, a ▸ cursor on the selected row, an optional selected-row
// description, and a trailing hint line. Port of
// packages/tui/src/components/settings-list.ts (non-search subset; the neo
// overlay wave adds search on top).
type SettingsList struct {
	items         []SettingItem
	selectedIndex int
	maxVisible    int
	theme         SettingsListTheme

	// OnChange fires when a value is cycled.
	OnChange func(id, newValue string)
	// OnCancel fires on the cancel action.
	OnCancel func()
}

// NewSettingsList builds a SettingsList.
func NewSettingsList(items []SettingItem, maxVisible int, th SettingsListTheme) *SettingsList {
	if maxVisible < 1 {
		maxVisible = 1
	}
	return &SettingsList{items: items, maxVisible: maxVisible, theme: th}
}

// SelectedIndex returns the current selection.
func (s *SettingsList) SelectedIndex() int { return s.selectedIndex }

// SetSelectedIndex clamps and sets the selected row.
func (s *SettingsList) SetSelectedIndex(index int) {
	if index < 0 {
		index = 0
	}
	if max := len(s.items) - 1; index > max {
		index = max
	}
	if index < 0 {
		index = 0
	}
	s.selectedIndex = index
}

// MoveUp / MoveDown wrap the selection (settings-list handleInput).
func (s *SettingsList) MoveUp() {
	n := len(s.items)
	if n == 0 {
		return
	}
	if s.selectedIndex == 0 {
		s.selectedIndex = n - 1
	} else {
		s.selectedIndex--
	}
}

func (s *SettingsList) MoveDown() {
	n := len(s.items)
	if n == 0 {
		return
	}
	if s.selectedIndex == n-1 {
		s.selectedIndex = 0
	} else {
		s.selectedIndex++
	}
}

// Activate cycles the selected row's value (Enter/Space). Port of activateItem
// value-cycling; submenu handling lands in the overlay wave.
func (s *SettingsList) Activate() {
	if s.selectedIndex < 0 || s.selectedIndex >= len(s.items) {
		return
	}
	item := &s.items[s.selectedIndex]
	if len(item.Values) == 0 {
		return
	}
	cur := indexOf(item.Values, item.CurrentValue)
	next := (cur + 1) % len(item.Values)
	item.CurrentValue = item.Values[next]
	if s.OnChange != nil {
		s.OnChange(item.ID, item.CurrentValue)
	}
}

// Render returns the settings list lines. Port of renderMainList (no-search).
func (s *SettingsList) Render(width int) []string {
	var lines []string

	if len(s.items) == 0 {
		lines = append(lines, s.theme.Hint("  No settings available"))
		return lines
	}

	start := s.selectedIndex - s.maxVisible/2
	if hi := len(s.items) - s.maxVisible; start > hi {
		start = hi
	}
	if start < 0 {
		start = 0
	}
	end := start + s.maxVisible
	if end > len(s.items) {
		end = len(s.items)
	}

	// Max label width for value alignment (capped at 30, matching the TS).
	maxLabelWidth := 0
	for _, item := range s.items {
		if w := VisibleWidth(item.Label); w > maxLabelWidth {
			maxLabelWidth = w
		}
	}
	if maxLabelWidth > 30 {
		maxLabelWidth = 30
	}

	for i := start; i < end; i++ {
		item := s.items[i]
		isSelected := i == s.selectedIndex
		prefix := "  "
		if isSelected {
			prefix = s.theme.Cursor
		}
		prefixWidth := VisibleWidth(prefix)

		labelPadded := item.Label + spaces(maxInt(0, maxLabelWidth-VisibleWidth(item.Label)))
		labelText := s.theme.Label(labelPadded, isSelected)

		separator := "  "
		usedWidth := prefixWidth + maxLabelWidth + VisibleWidth(separator)
		valueMaxWidth := width - usedWidth - 2

		value := item.CurrentValue
		if item.Expandable {
			value += "  " + string(rune(0x203A)) // trailing › for expandable rows
		}
		valueText := s.theme.Value(TruncateToWidth(value, valueMaxWidth, ""), isSelected)

		lines = append(lines, TruncateToWidth(prefix+labelText+separator+valueText, width, ""))
	}

	if start > 0 || end < len(s.items) {
		scrollText := "  (" + itoaUI(s.selectedIndex+1) + "/" + itoaUI(len(s.items)) + ")"
		lines = append(lines, s.theme.Hint(TruncateToWidth(scrollText, width-2, "")))
	}

	if sel := s.items[s.selectedIndex]; sel.Description != "" {
		lines = append(lines, "")
		lines = append(lines, s.theme.Description("  "+sel.Description))
	}

	lines = append(lines, "")
	lines = append(lines, TruncateToWidth(s.theme.Hint("  Enter/Space to change · Esc to cancel"), width, ""))
	return lines
}

func indexOf(xs []string, v string) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}
