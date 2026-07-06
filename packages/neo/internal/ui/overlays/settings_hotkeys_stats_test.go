package overlays_test

import (
	"strings"
	"testing"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// --- settings modal ---------------------------------------------------------

// TestSettingsModalBordered: the settings overlay is a bordered modal (rule
// lines top+bottom) with a title, per grok capture.
func TestSettingsModalBordered(t *testing.T) {
	o := overlays.NewSettingsModal(overlays.SettingsModalOptions{
		CurrentTheme:    "grok-night",
		AvailableThemes: []string{"grok-night", "grok-day"},
		AutoCompact:     true,
	})
	out := o.RenderPlain(80)
	if len(out) < 3 {
		t.Fatalf("settings modal too short: %v", out)
	}
	if !strings.Contains(out[0], "─") || !strings.Contains(out[len(out)-1], "─") {
		t.Errorf("settings modal must be bordered top+bottom; got first=%q last=%q", out[0], out[len(out)-1])
	}
	joined := strings.Join(out, "\n")
	if !strings.Contains(joined, "Settings") {
		t.Errorf("missing Settings title; got:\n%s", joined)
	}
}

// TestSettingsToggleEmitsWrite: toggling a boolean row (enter on a toggle) emits a
// write_settings op for that key via the lockfile protocol.
func TestSettingsToggleEmitsWrite(t *testing.T) {
	o := overlays.NewSettingsModal(overlays.SettingsModalOptions{
		CurrentTheme:    "grok-night",
		AvailableThemes: []string{"grok-night", "grok-day"},
		AutoCompact:     true,
	})
	kb := newKB(t)
	// The first row is autoCompact; toggle it.
	o.SelectRow("autoCompact")
	res := o.HandleKey("\n", kb, "")
	if res.Kind != overlays.OutcomeSelect || res.FileOp != "write_settings" {
		t.Fatalf("got %+v, want write_settings", res)
	}
	if res.Fields["key"] != "autoCompact" {
		t.Errorf("key = %v, want autoCompact", res.Fields["key"])
	}
	if res.Fields["value"] != false {
		t.Errorf("value = %v, want false (toggled off)", res.Fields["value"])
	}
}

// TestSettingsThemeWritesNeoKey: choosing a theme in the settings modal writes
// the neo.theme key, NEVER the classic theme key (guardrail).
func TestSettingsThemeWritesNeoKey(t *testing.T) {
	o := overlays.NewSettingsModal(overlays.SettingsModalOptions{
		CurrentTheme:    "grok-night",
		AvailableThemes: []string{"grok-night", "grok-day"},
	})
	kb := newKB(t)
	o.SelectRow("theme")
	res := o.HandleKey("\n", kb, "") // enter the theme submenu / cycle
	// The theme row cycles or opens a submenu; either way its write targets
	// neo.theme. Force a theme-change and assert the emitted key.
	res = o.ChooseTheme("grok-day")
	if res.FileOp != "write_settings" {
		t.Fatalf("theme change must write settings; got %+v", res)
	}
	if res.Fields["key"] != overlays.NeoThemeSettingsKey {
		t.Errorf("theme key = %v, want %s (never classic 'theme')", res.Fields["key"], overlays.NeoThemeSettingsKey)
	}
}

// TestSettingsCancelRestores: esc restores editor text.
func TestSettingsCancelRestores(t *testing.T) {
	o := overlays.NewSettingsModal(overlays.SettingsModalOptions{CurrentTheme: "grok-night", AvailableThemes: []string{"grok-night"}})
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "editor draft")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "editor draft" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}

// --- hotkeys view -----------------------------------------------------------

// TestHotkeysViewFromRegistry: the hotkeys view lists action → key bindings drawn
// from the keybinding registry (not a hardcoded list). A known app action with
// its default key must appear.
func TestHotkeysViewFromRegistry(t *testing.T) {
	mgr := keybindings.NewManager(nil)
	o := overlays.NewHotkeysView(mgr)
	out := strings.Join(o.RenderPlain(120), "\n")
	// app.model.select defaults to ctrl+l; its description must be listed.
	if !strings.Contains(out, "Open model selector") {
		t.Errorf("hotkeys view missing app.model.select description; got:\n%s", out)
	}
	if !strings.Contains(strings.ToLower(out), "ctrl+l") {
		t.Errorf("hotkeys view missing ctrl+l binding; got:\n%s", out)
	}
}

// TestHotkeysViewHonorsOverrides: a user override changes the displayed binding.
func TestHotkeysViewHonorsOverrides(t *testing.T) {
	mgr := keybindings.NewManager(map[string][]string{
		"app.model.select": {"ctrl+m"},
	})
	o := overlays.NewHotkeysView(mgr)
	out := strings.ToLower(strings.Join(o.RenderPlain(120), "\n"))
	if !strings.Contains(out, "ctrl+m") {
		t.Errorf("hotkeys view must reflect user override ctrl+m; got:\n%s", out)
	}
}

// TestHotkeysCancel: esc closes the view (restoring editor).
func TestHotkeysCancel(t *testing.T) {
	o := overlays.NewHotkeysView(keybindings.NewManager(nil))
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "draft")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "draft" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}

// --- session stats ----------------------------------------------------------

// TestSessionStatsRendersFields: the stats view surfaces the get_session_stats
// payload fields (message count, tokens, model).
func TestSessionStatsRendersFields(t *testing.T) {
	o := overlays.NewSessionStats(overlays.SessionStats{
		SessionID:    "sess-xyz",
		MessageCount: 42,
		InputTokens:  1000,
		OutputTokens: 500,
		Model:        "openai/faux-1",
	})
	out := strings.Join(o.RenderPlain(120), "\n")
	for _, want := range []string{"sess-xyz", "42", "openai/faux-1"} {
		if !strings.Contains(out, want) {
			t.Errorf("stats view missing %q; got:\n%s", want, out)
		}
	}
}

// TestSessionStatsCancel: esc closes the view (restoring editor).
func TestSessionStatsCancel(t *testing.T) {
	o := overlays.NewSessionStats(overlays.SessionStats{SessionID: "s"})
	kb := newKB(t)
	res := o.HandleKey("\x1b", kb, "draft")
	if res.Kind != overlays.OutcomeCancel || res.RestoreText != "draft" {
		t.Errorf("cancel/restore failed: %+v", res)
	}
}
