package keybindings

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

// normalize_test.go covers the bubbletea v2 KeyPressMsg -> canonical key-id
// bridge. bubbletea parses raw bytes itself (kitty enhancements on) into a
// structured Key; NormalizeKeyMsg maps that structure into the same key-id
// vocabulary the registry uses (escape/pageUp/pageDown, shift+ctrl+... order),
// so the Manager can resolve a KeyPressMsg to actions WITHOUT any hardcoded key
// comparison. Written RED first.

func TestNormalizeKeyMsg_SpecialKeys(t *testing.T) {
	cases := []struct {
		name string
		msg  tea.KeyPressMsg
		want string
	}{
		{"escape", tea.KeyPressMsg{Code: tea.KeyEscape}, "escape"},
		{"enter", tea.KeyPressMsg{Code: tea.KeyEnter}, "enter"},
		{"tab", tea.KeyPressMsg{Code: tea.KeyTab}, "tab"},
		{"shift+tab", tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}, "shift+tab"},
		{"pageUp", tea.KeyPressMsg{Code: tea.KeyPgUp}, "pageUp"},
		{"pageDown", tea.KeyPressMsg{Code: tea.KeyPgDown}, "pageDown"},
		{"up", tea.KeyPressMsg{Code: tea.KeyUp}, "up"},
		{"alt+up", tea.KeyPressMsg{Code: tea.KeyUp, Mod: tea.ModAlt}, "alt+up"},
		{"backspace", tea.KeyPressMsg{Code: tea.KeyBackspace}, "backspace"},
		{"ctrl+left", tea.KeyPressMsg{Code: tea.KeyLeft, Mod: tea.ModCtrl}, "ctrl+left"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NormalizeKeyMsg(c.msg); got != c.want {
				t.Errorf("NormalizeKeyMsg(%s) = %q, want %q", c.name, got, c.want)
			}
		})
	}
}

func TestNormalizeKeyMsg_LetterAndModifiers(t *testing.T) {
	cases := []struct {
		name string
		msg  tea.KeyPressMsg
		want string
	}{
		{"c", tea.KeyPressMsg{Code: 'c', Text: "c"}, "c"},
		{"ctrl+c", tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}, "ctrl+c"},
		{"ctrl+p", tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl}, "ctrl+p"},
		{"shift+ctrl+p", tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl | tea.ModShift}, "shift+ctrl+p"},
		{"alt+enter", tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModAlt}, "alt+enter"},
		{"ctrl+o", tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl}, "ctrl+o"},
		{"ctrl+r", tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl}, "ctrl+r"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NormalizeKeyMsg(c.msg); got != c.want {
				t.Errorf("NormalizeKeyMsg(%s) = %q, want %q", c.name, got, c.want)
			}
		})
	}
}

// The Manager must resolve a KeyPressMsg to actions through the normalized id,
// so the neo update loop never hardcodes a key comparison. This is the contract
// the whole task hinges on: shift+tab -> app.thinking.cycle, ctrl+o ->
// app.tools.expand, ctrl+r -> app.history.search.
func TestManager_MatchesKeyMsg_ScriptedKeys(t *testing.T) {
	m := NewManager(nil)
	cases := []struct {
		name   string
		msg    tea.KeyPressMsg
		action string
	}{
		{"shift+tab cycles thinking", tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}, "app.thinking.cycle"},
		{"ctrl+o expands tools", tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl}, "app.tools.expand"},
		{"ctrl+r searches history", tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl}, "app.history.search"},
		{"escape interrupts", tea.KeyPressMsg{Code: tea.KeyEscape}, "app.interrupt"},
		{"ctrl+l selects model", tea.KeyPressMsg{Code: 'l', Mod: tea.ModCtrl}, "app.model.select"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !m.MatchesKeyMsg(c.msg, c.action) {
				t.Errorf("MatchesKeyMsg(%s) did not trigger %s", c.name, c.action)
			}
		})
	}
}

// Scope resolution over a KeyPressMsg must stay deterministic and scope-aware:
// ctrl+p is model-cycle in the editor and provider-toggle in the models overlay.
func TestManager_ResolveKeyMsgScoped_CtrlP(t *testing.T) {
	m := NewManager(nil)
	ctrlP := tea.KeyPressMsg{Code: 'p', Mod: tea.ModCtrl}
	editor := m.ResolveKeyMsgScoped(ctrlP, ScopeEditor)
	models := m.ResolveKeyMsgScoped(ctrlP, ScopeModels)
	if !contains(editor, "app.model.cycleForward") || contains(editor, "app.models.toggleProvider") {
		t.Errorf("editor ctrl+p = %v", editor)
	}
	if !contains(models, "app.models.toggleProvider") || contains(models, "app.model.cycleForward") {
		t.Errorf("models ctrl+p = %v", models)
	}
}
