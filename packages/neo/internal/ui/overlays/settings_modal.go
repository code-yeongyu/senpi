package overlays

import (
	"charm.land/lipgloss/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// settings_modal.go ports the settings-selector.ts bordered modal (per the grok
// /settings capture). It presents boolean toggles + the theme submenu; toggling
// a row emits a write_settings op that the shell persists via the store's
// lockfile protocol (WithSettingsLock — read-current, merge only the changed
// field, write, release; never whole-file overwrite). The theme row writes the
// neo.theme key, NEVER the classic theme key, so a concurrently-running classic
// senpi is unaffected (additive-only guardrail).

// settingRow is one settings entry: a stable key, a display label, and a value.
type settingRow struct {
	key    string
	label  string
	toggle bool // true for boolean rows
	value  bool // current boolean value
	submen bool // true for submenu rows (theme)
}

// SettingsModalOptions seeds the modal from current settings.
type SettingsModalOptions struct {
	CurrentTheme    string
	AvailableThemes []string
	AutoCompact     bool
	ShowImages      bool
	HideThinking    bool
	QuietStartup    bool
}

// SettingsModal is the bordered settings overlay.
type SettingsModal struct {
	rows            []settingRow
	selectedIndex   int
	currentTheme    string
	availableThemes []string
	th              *theme.Theme
}

// NewSettingsModal builds the modal with the toggle rows + a theme submenu row.
func NewSettingsModal(opts SettingsModalOptions) *SettingsModal {
	th, _ := theme.Load(theme.Options{Name: theme.DefaultThemeName})
	rows := []settingRow{
		{key: "autoCompact", label: "Auto-compact", toggle: true, value: opts.AutoCompact},
		{key: "showImages", label: "Show images", toggle: true, value: opts.ShowImages},
		{key: "hideThinkingBlock", label: "Hide thinking block", toggle: true, value: opts.HideThinking},
		{key: "quietStartup", label: "Quiet startup", toggle: true, value: opts.QuietStartup},
		{key: "theme", label: "Theme", submen: true},
	}
	return &SettingsModal{
		rows:            rows,
		currentTheme:    opts.CurrentTheme,
		availableThemes: opts.AvailableThemes,
		th:              th,
	}
}

// SelectRow moves the selection to the row with the given key (test seam).
func (o *SettingsModal) SelectRow(key string) {
	for i, r := range o.rows {
		if r.key == key {
			o.selectedIndex = i
			return
		}
	}
}

// ChooseTheme applies a theme choice and returns the write op (neo.theme). Used
// by the shell after the theme submenu resolves.
func (o *SettingsModal) ChooseTheme(name string) Outcome {
	o.currentTheme = name
	return selectFileOp("write_settings", map[string]any{
		"key":   NeoThemeSettingsKey,
		"value": name,
	})
}

// HandleKey routes navigation + toggle/confirm + cancel.
func (o *SettingsModal) HandleKey(data string, kb *keybindings.Manager, savedText string) Outcome {
	switch {
	case matches(kb, data, "tui.select.up"):
		if o.selectedIndex > 0 {
			o.selectedIndex--
		}
		return none()
	case matches(kb, data, "tui.select.down"):
		if o.selectedIndex < len(o.rows)-1 {
			o.selectedIndex++
		}
		return none()
	case matches(kb, data, "tui.select.confirm"):
		row := &o.rows[o.selectedIndex]
		if row.toggle {
			row.value = !row.value
			return selectFileOp("write_settings", map[string]any{"key": row.key, "value": row.value})
		}
		// Submenu (theme): the shell opens the theme selector; return none so the
		// modal stays open and the follow-up ChooseTheme carries the write.
		return none()
	case matches(kb, data, "tui.select.cancel"):
		return cancel(savedText)
	}
	return none()
}

// RenderPlain renders the modal without color for content assertions.
func (o *SettingsModal) RenderPlain(width int) []string { return o.render(width, false) }

// RenderStyled renders the modal with grok styling for the QA harness.
func (o *SettingsModal) RenderStyled(width int) []string { return o.render(width, true) }

func (o *SettingsModal) render(width int, styled bool) []string {
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
	lines = append(lines, style(o.th.AccentBlue, "Settings"))
	lines = append(lines, "")
	for i, r := range o.rows {
		prefix := "  "
		label := r.label
		if i == o.selectedIndex {
			prefix = style(o.th.AccentBlue, "▸ ")
			label = style(o.th.AccentBlue, r.label)
		}
		var valueText string
		switch {
		case r.toggle:
			if r.value {
				valueText = style(o.th.AccentGreen, "on")
			} else {
				valueText = style(o.th.TextMuted, "off")
			}
		case r.submen:
			valueText = style(o.th.TextSecondary, o.currentTheme) + " " + style(o.th.TextMuted, "›")
		}
		lines = append(lines, prefix+label+"  "+valueText)
	}
	lines = append(lines, border...)
	return lines
}
