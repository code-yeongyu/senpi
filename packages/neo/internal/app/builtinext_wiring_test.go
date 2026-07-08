package app

import (
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/extui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// builtinext_wiring_test.go is the task-11 wiring contract: the welcome card
// advertises "Search history ctrl+r" and "Resume session ctrl+s", so the
// assembled Model's key router MUST open the two builtinext overlays when those
// chords are pressed (classic senpi interactive-mode.ts:2850/2857
// onAction("app.history.search")/onAction("app.sessions.observe")). Both chords
// resolve through the keybindings Manager (no raw key strings) and build their
// overlays from local session-dir data.

// nopExtClient/nopExtResponder/nopDirectiveSink are inert seams: the wiring under
// test only presses ctrl+r/ctrl+s, so no extension request round-trips through
// them.
type nopExtClient struct{}

func (nopExtClient) Request(bridge.Command, time.Duration) (bridge.Response, error) {
	return bridge.Response{}, nil
}

type nopExtResponder struct{}

func (nopExtResponder) RespondExtensionUI(bridge.ExtensionUIResponse) error { return nil }

type nopDirectiveSink struct{}

func (nopDirectiveSink) ApplyDirective(extui.Directive) {}

// newWiredOverlayModel builds a Model with the overlay-launching collaborators the
// ctrl+r/ctrl+s chords need: the keybinding Manager, the editor, and the ExtUI
// (which owns the overlay Manager consulted by openAppOverlay). agentDir points at
// a hermetic temp dir so the session index reads no real user data.
func newWiredOverlayModel(t *testing.T) *Model {
	t.Helper()
	th, err := theme.Load(theme.Options{Name: theme.DefaultThemeName, AgentDir: "\x00nonexistent"})
	if err != nil {
		t.Fatalf("theme.Load: %v", err)
	}
	keys := keybindings.NewManager(nil)
	ed := editor.New(editor.Options{PaddingX: 1})
	ed.SetFocused(true)
	requester := &overlayRequester{agentDir: t.TempDir(), cwd: t.TempDir()}
	mgr := NewManager(keys, requester)
	extctl := NewExtUI(extui.Deps{Theme: th, Keybindings: keys}, mgr, nopExtClient{}, nopExtResponder{}, nopDirectiveSink{})
	m := &Model{theme: th, keys: keys, editor: ed, extui: extctl, requester: requester}
	m.SetOverlays(extctl)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	return m
}

// TestHistorySearchChordOpensOverlay proves ctrl+r (app.history.search) opens the
// history-search overlay through the assembled Model's key router.
func TestHistorySearchChordOpensOverlay(t *testing.T) {
	m := newWiredOverlayModel(t)

	m.Update(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl})

	if got := m.overlayMgr().ActiveKind(); got != OverlayHistory {
		t.Fatalf("ctrl+r must open OverlayHistory; ActiveKind = %v", got)
	}
	if frame := m.overlayMgr().Render(100, 30); len(frame) == 0 {
		t.Fatal("history overlay must render a non-empty frame")
	}
}

// TestSessionObserveChordOpensOverlay proves ctrl+s (app.sessions.observe) opens
// the session-observer HUD through the assembled Model's key router.
func TestSessionObserveChordOpensOverlay(t *testing.T) {
	m := newWiredOverlayModel(t)

	m.Update(tea.KeyPressMsg{Code: 's', Mod: tea.ModCtrl})

	if got := m.overlayMgr().ActiveKind(); got != OverlayObserver {
		t.Fatalf("ctrl+s must open OverlayObserver; ActiveKind = %v", got)
	}
	if frame := m.overlayMgr().Render(100, 30); len(frame) == 0 {
		t.Fatal("observer overlay must render a non-empty frame")
	}
}
