package ui

import (
	"strings"
	"testing"
)

// Contract source: packages/tui/src/components/settings-list.ts.
// Contract: label/value alignment via a max-label column, a cursor prefix on the
// selected row, an empty-state hint, selected-item description, and a trailing
// hint line. Grok styling uses the ▸ row glyph (settings capture).

func plainSettingsTheme() SettingsListTheme {
	return SettingsListTheme{
		Label:       func(s string, _ bool) string { return s },
		Value:       func(s string, _ bool) string { return s },
		Description: func(s string) string { return s },
		Hint:        func(s string) string { return s },
		Cursor:      "▸ ",
	}
}

func settingsFixture() []SettingItem {
	return []SettingItem{
		{ID: "compact", Label: "Compact mode", CurrentValue: "off", Values: []string{"off", "on"}},
		{ID: "timestamps", Label: "Show timestamps", CurrentValue: "on", Values: []string{"on", "off"}},
		{ID: "theme", Label: "Theme", CurrentValue: "Grok Night"},
	}
}

func TestSettingsList_RendersCursorOnSelected(t *testing.T) {
	sl := NewSettingsList(settingsFixture(), 10, plainSettingsTheme())
	lines := sl.Render(80)
	if len(lines) == 0 {
		t.Fatalf("expected rendered lines")
	}
	// The first (selected) row must carry the ▸ cursor glyph.
	if !strings.Contains(lines[0], "▸") {
		t.Fatalf("selected row should show ▸ cursor, got %q", lines[0])
	}
}

func TestSettingsList_LabelValueAlignment(t *testing.T) {
	sl := NewSettingsList(settingsFixture(), 10, plainSettingsTheme())
	lines := sl.Render(80)
	// Values are right-of the aligned label column; every row's value should
	// start at the same visible column.
	col0 := valueColumn(t, lines[0], "off")
	col1 := valueColumn(t, lines[1], "on")
	if col0 != col1 {
		t.Fatalf("values misaligned: row0 col %d, row1 col %d", col0, col1)
	}
}

func TestSettingsList_EmptyStateHint(t *testing.T) {
	sl := NewSettingsList(nil, 10, plainSettingsTheme())
	lines := sl.Render(80)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "No settings") {
		t.Fatalf("empty settings list should show a hint, got %q", joined)
	}
}

func TestSettingsList_CycleValueOnActivate(t *testing.T) {
	items := settingsFixture()
	var changedID, changedVal string
	sl := NewSettingsList(items, 10, plainSettingsTheme())
	sl.OnChange = func(id, v string) { changedID, changedVal = id, v }
	// Select the compact row (index 0) and activate → cycles off -> on.
	sl.Activate()
	if changedID != "compact" || changedVal != "on" {
		t.Fatalf("activate should cycle compact off->on, got id=%q val=%q", changedID, changedVal)
	}
}

func valueColumn(t *testing.T, line, val string) int {
	t.Helper()
	idx := strings.LastIndex(StripANSI(line), val)
	if idx < 0 {
		t.Fatalf("value %q not found in %q", val, line)
	}
	return VisibleWidth(StripANSI(line)[:idx])
}
