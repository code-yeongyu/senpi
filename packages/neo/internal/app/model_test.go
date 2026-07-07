package app_test

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// newTestModel builds a Model bound to the default theme and pure-default
// keybindings, hermetic (no real ~/.senpi read via the sentinel agent dir).
func newTestModel(t *testing.T) *app.Model {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	return app.NewModel(app.Deps{
		Theme:   th,
		Keys:    keybindings.NewManager(nil),
		AppName: "senpi",
	})
}

// wideCardBorder is the rounded top-left corner the welcome card draws only at
// wide widths (>= the welcome reflow width). The editor/footer never draw it, so
// its presence is a reliable proxy for "the frame reflowed to the wide layout".
const wideCardBorder = "╭"

// TestUpdateWindowSizeReflowsView proves Update(tea.WindowSizeMsg) re-renders the
// View at the new width: the wide welcome card appears at 120 columns and is gone
// (compact layout) at 60 columns.
func TestUpdateWindowSizeReflowsView(t *testing.T) {
	m := newTestModel(t)

	if _, cmd := m.Update(tea.WindowSizeMsg{Width: 120, Height: 36}); cmd != nil {
		_ = cmd
	}
	wide := m.View().Content
	if !strings.Contains(wide, wideCardBorder) {
		t.Fatalf("expected wide welcome card border %q at 120 cols, view was:\n%s", wideCardBorder, wide)
	}

	m.Update(tea.WindowSizeMsg{Width: 60, Height: 20})
	narrow := m.View().Content
	if strings.Contains(narrow, wideCardBorder) {
		t.Fatalf("expected compact layout (no %q) at 60 cols, view was:\n%s", wideCardBorder, narrow)
	}
}

// TestExitKeyReturnsQuit proves the app.exit key (ctrl+d by default), resolved
// through the keybinding Manager, returns tea.Quit when the editor is empty.
func TestExitKeyReturnsQuit(t *testing.T) {
	m := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})

	_, cmd := m.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
	if cmd == nil {
		t.Fatal("expected a command from the app.exit key, got nil")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("expected tea.QuitMsg from app.exit key, got %T", cmd())
	}
}

// TestInterruptEmitsAbortRequested proves the app.interrupt key (escape by
// default) emits an AbortRequested message for the session adapter (todo 2) to
// consume — not a quit.
func TestInterruptEmitsAbortRequested(t *testing.T) {
	m := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})

	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if cmd == nil {
		t.Fatal("expected a command from the app.interrupt key, got nil")
	}
	if _, ok := cmd().(app.AbortRequested); !ok {
		t.Fatalf("expected app.AbortRequested from app.interrupt key, got %T", cmd())
	}
}

// TestViewSmallTerminalNoPanic proves View degrades gracefully at and below the
// 40x10 floor without panicking.
func TestViewSmallTerminalNoPanic(t *testing.T) {
	sizes := []struct{ w, h int }{{40, 10}, {20, 6}, {1, 1}}
	for _, s := range sizes {
		m := newTestModel(t)
		m.Update(tea.WindowSizeMsg{Width: s.w, Height: s.h})
		got := m.View().Content // must not panic
		if got == "" {
			t.Errorf("empty view at %dx%d", s.w, s.h)
		}
	}
}

// TestViewContainsWelcomePreFirstTurn proves the composed frame shows the welcome
// card (bearing the app label) before any turn has run, even before the first
// WindowSizeMsg arrives.
func TestViewContainsWelcomePreFirstTurn(t *testing.T) {
	m := newTestModel(t)
	content := m.View().Content
	if !strings.Contains(content, "senpi") {
		t.Fatalf("expected welcome card app label %q pre-first-turn, view was:\n%s", "senpi", content)
	}
}

// TestNewProgramConstructs proves the program constructor builds a runnable
// bubbletea program from Deps without altscreen (constructed, not run).
func TestNewProgramConstructs(t *testing.T) {
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	p := app.NewProgram(app.Deps{Theme: th, Keys: keybindings.NewManager(nil), AppName: "senpi"})
	if p == nil {
		t.Fatal("NewProgram returned nil")
	}
}
