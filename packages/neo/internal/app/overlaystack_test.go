package app_test

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/app"
	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/store"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// overlaystack_test.go is the todo-5 contract: a single-active-overlay stack that
// routes keys to the top overlay (scope-switched via the keybinding Manager
// contexts), saves/restores the editor text around open→esc (master task-12
// showExtensionCustom semantics), and translates each overlay's Outcome into an
// RPC command or native store op via an injected Requester (a fake in tests).

// fakeRequester records the commands + file ops the manager issues. Each method
// returns a no-op tea.Cmd so the manager never blocks the Update goroutine.
type fakeRequester struct {
	commands []bridge.Command
	fileOps  []fakeFileOp
}

type fakeFileOp struct {
	op     string
	fields map[string]any
}

func (f *fakeRequester) Request(cmd bridge.Command) tea.Cmd {
	f.commands = append(f.commands, cmd)
	return func() tea.Msg { return nil }
}

func (f *fakeRequester) FileOp(op string, fields map[string]any) tea.Cmd {
	f.fileOps = append(f.fileOps, fakeFileOp{op: op, fields: fields})
	return func() tea.Msg { return nil }
}

func (f *fakeRequester) hasCommand(t string) bool {
	for _, c := range f.commands {
		if c.Type == t {
			return true
		}
	}
	return false
}

func (f *fakeRequester) hasFileOp(op string) bool {
	for _, o := range f.fileOps {
		if o.op == op {
			return true
		}
	}
	return false
}

func overlayKB(t *testing.T) *keybindings.Manager {
	t.Helper()
	return keybindings.NewManager(nil)
}

// --- overlay builders (one per kind) ----------------------------------------

func buildModelSelector() *overlays.ModelSelector {
	return overlays.NewModelSelector(overlays.ModelSelectorOptions{
		Models: []overlays.ModelItem{
			{Provider: "mock", ID: "mock-a", Name: "A", AuthStatus: overlays.AuthConfigured},
			{Provider: "mock", ID: "mock-b", Name: "B", AuthStatus: overlays.AuthConfigured},
		},
		CurrentModel: "mock/mock-a",
		Favorites:    overlays.Favorites(),
	})
}

func buildSessionPicker() *overlays.SessionPicker {
	return overlays.NewSessionPicker(overlays.SessionPickerOptions{
		Sessions: []store.SessionInfo{
			{ID: "s1", Path: "/tmp/s1.jsonl", Name: "First"},
			{ID: "s2", Path: "/tmp/s2.jsonl", Name: "Second"},
		},
	})
}

func buildTree() *overlays.TreeNavigator {
	return overlays.NewTreeNavigator(overlays.TreeOptions{
		Root:          &overlays.TreeNode{ID: "n1", Kind: "message", Role: "user", Text: "root"},
		CurrentLeafID: "n1",
	})
}

func buildSettings() *overlays.SettingsModal {
	return overlays.NewSettingsModal(overlays.SettingsModalOptions{
		CurrentTheme:    "grok",
		AvailableThemes: []string{"grok", "mono"},
	})
}

func buildTheme() *overlays.ThemeSelector {
	return overlays.NewThemeSelector("grok", []string{"grok", "mono"})
}

func buildThinking() *overlays.ThinkingSelector {
	return overlays.NewThinkingSelector("medium", []string{"off", "low", "medium", "high"})
}

func buildTrust() *overlays.TrustSelector {
	return overlays.NewTrustSelector(overlays.TrustOptions{CWD: "/project"})
}

// --- single-active stack basics ---------------------------------------------

// TestOverlayStackPushPopActive proves push makes the stack active + renders the
// overlay frame, and a confirm pops it back to inactive.
func TestOverlayStackPushPopActive(t *testing.T) {
	mgr := app.NewManager(overlayKB(t), &fakeRequester{})
	if mgr.Active() {
		t.Fatal("fresh manager must be inactive")
	}
	mgr.Push(app.OverlayThinking, buildThinking(), "")
	if !mgr.Active() {
		t.Fatal("push must make the stack active")
	}
	if mgr.ActiveKind() != app.OverlayThinking {
		t.Fatalf("ActiveKind = %v, want OverlayThinking", mgr.ActiveKind())
	}
	frame := strings.Join(mgr.Render(80, 24), "\n")
	if !strings.Contains(frame, "medium") {
		t.Fatalf("rendered overlay frame missing the thinking levels; got:\n%s", frame)
	}
	res := mgr.HandleKey("\n") // confirm
	if !res.Handled {
		t.Fatal("confirm must be handled by the active overlay")
	}
	if mgr.Active() {
		t.Fatal("confirm must pop the overlay back to inactive")
	}
}

// TestOverlayOpenEscRestoresEditorText proves opening an overlay saves the editor
// text and esc/cancel surfaces it for restore (master task-12 semantics).
func TestOverlayOpenEscRestoresEditorText(t *testing.T) {
	mgr := app.NewManager(overlayKB(t), &fakeRequester{})
	mgr.Push(app.OverlaySettings, buildSettings(), "draft text")
	res := mgr.HandleKey("\x1b") // esc
	if !res.Handled {
		t.Fatal("esc must be handled while an overlay is active")
	}
	if !res.Restore || res.RestoreText != "draft text" {
		t.Fatalf("esc must restore the saved editor text; got Restore=%v Text=%q", res.Restore, res.RestoreText)
	}
	if mgr.Active() {
		t.Fatal("esc must pop the overlay")
	}
}

// TestOverlayScopeConflictCtrlP proves ctrl+p resolves deterministically by
// scope: model-cycle (cycle_model) in the editor scope when no overlay is open,
// and the models-overlay's own scope (NO cycle_model) when the model selector is
// active.
func TestOverlayScopeConflictCtrlP(t *testing.T) {
	// Inactive: editor scope → app.model.cycleForward → cycle_model.
	inactive := &fakeRequester{}
	mgrA := app.NewManager(overlayKB(t), inactive)
	res := mgrA.HandleKey("\x10") // ctrl+p
	if !res.Handled {
		t.Fatal("inactive ctrl+p must be handled as a model cycle")
	}
	if !inactive.hasCommand("cycle_model") {
		t.Fatalf("inactive ctrl+p must emit cycle_model; got %+v", inactive.commands)
	}

	// Models overlay active: ctrl+p resolves in the models scope and must NOT
	// cycle the model.
	active := &fakeRequester{}
	mgrB := app.NewManager(overlayKB(t), active)
	mgrB.Push(app.OverlayModel, buildModelSelector(), "")
	res2 := mgrB.HandleKey("\x10")
	if !res2.Handled {
		t.Fatal("the active model overlay must consume ctrl+p")
	}
	if active.hasCommand("cycle_model") {
		t.Fatalf("ctrl+p must NOT cycle the model while the selector is open; got %+v", active.commands)
	}
}

// TestOverlayInactiveNonActionFallsThrough proves keys with no overlay-related
// app action are NOT handled by the manager when inactive, so the editor still
// gets them.
func TestOverlayInactiveNonActionFallsThrough(t *testing.T) {
	mgr := app.NewManager(overlayKB(t), &fakeRequester{})
	if res := mgr.HandleKey("a"); res.Handled {
		t.Fatal("a plain character must fall through to the editor when inactive")
	}
	if res := mgr.HandleKey("\x1b"); res.Handled {
		t.Fatal("esc must fall through to the app interrupt handler when inactive")
	}
}

// TestOverlayCommandEmissionTable is the per-overlay command-emission table: each
// of the ten overlay kinds is driven through its confirm/action path and the
// emitted RPC command or native store op is asserted against the fake client.
func TestOverlayCommandEmissionTable(t *testing.T) {
	cases := []struct {
		name       string
		kind       app.OverlayKind
		build      func() app.Overlay
		setup      func(app.Overlay)
		key        string
		wantCmd    string
		wantFileOp string
	}{
		{
			name: "model", kind: app.OverlayModel,
			build: func() app.Overlay { return buildModelSelector() },
			key:   "\n", wantCmd: "set_model",
		},
		{
			name: "favorites", kind: app.OverlayFavorites,
			build: func() app.Overlay { return app.NewFavoritesOverlay(buildModelSelector()) },
			setup: func(o app.Overlay) { o.HandleKey("\x06", keybindings.NewManager(nil), "") }, // ctrl+f toggle
			key:   "\x13", wantFileOp: "save_favorites",                                         // ctrl+s save
		},
		{
			name: "session", kind: app.OverlaySession,
			build: func() app.Overlay { return buildSessionPicker() },
			key:   "\n", wantCmd: "switch_session",
		},
		{
			name: "tree", kind: app.OverlayTree,
			build: func() app.Overlay { return buildTree() },
			key:   "\n", wantCmd: "fork",
		},
		{
			name: "settings", kind: app.OverlaySettings,
			build: func() app.Overlay { return buildSettings() },
			key:   "\n", wantFileOp: "write_settings",
		},
		{
			name: "theme", kind: app.OverlayTheme,
			build: func() app.Overlay { return buildTheme() },
			key:   "\n", wantFileOp: "write_settings",
		},
		{
			name: "thinking", kind: app.OverlayThinking,
			build: func() app.Overlay { return buildThinking() },
			key:   "\n", wantCmd: "set_thinking_level",
		},
		{
			name: "trust", kind: app.OverlayTrust,
			build: func() app.Overlay { return buildTrust() },
			key:   "\n", wantCmd: "trust",
		},
		{
			name: "hotkeys", kind: app.OverlayHotkeys,
			build: func() app.Overlay { return overlays.NewHotkeysView(keybindings.NewManager(nil)) },
			key:   "\n", // read-only: enter emits nothing
		},
		{
			name: "stats", kind: app.OverlayStats,
			build: func() app.Overlay { return overlays.NewSessionStats(overlays.SessionStats{SessionID: "s1"}) },
			key:   "\n", // read-only: enter emits nothing
		},
		{
			name: "history", kind: app.OverlayHistory,
			build: func() app.Overlay {
				return app.NewHistoryOverlay([]builtinext.HistoryEntry{{Text: "deploy production release", SessionID: "a", Timestamp: 1_000}}, parityTheme(t), overlayKB(t))
			},
			key: "\n", // confirm selects a prompt into the editor: no RPC/file-op
		},
		{
			name: "observer", kind: app.OverlayObserver,
			build: func() app.Overlay {
				return app.NewObserverOverlay([]builtinext.SessionHudEntry{{ID: "s", ShortID: "s", Path: "/nonexistent/s.jsonl", LastUserText: "hi"}}, parityTheme(t), overlayKB(t))
			},
			key: "\x1b", // esc closes the picker: no RPC/file-op
		},
	}

	if len(cases) != 12 {
		t.Fatalf("expected all 12 overlay kinds, got %d", len(cases))
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := &fakeRequester{}
			mgr := app.NewManager(overlayKB(t), req)
			ov := tc.build()
			mgr.Push(tc.kind, ov, "")
			if tc.setup != nil {
				tc.setup(ov)
			}
			mgr.HandleKey(tc.key)

			if tc.wantCmd != "" && !req.hasCommand(tc.wantCmd) {
				t.Fatalf("%s: expected RPC command %q; got commands=%+v fileOps=%+v", tc.name, tc.wantCmd, req.commands, req.fileOps)
			}
			if tc.wantFileOp != "" && !req.hasFileOp(tc.wantFileOp) {
				t.Fatalf("%s: expected file op %q; got commands=%+v fileOps=%+v", tc.name, tc.wantFileOp, req.commands, req.fileOps)
			}
			if tc.wantCmd == "" && tc.wantFileOp == "" {
				if len(req.commands) != 0 || len(req.fileOps) != 0 {
					t.Fatalf("%s: read-only overlay must emit nothing; got commands=%+v fileOps=%+v", tc.name, req.commands, req.fileOps)
				}
			}
		})
	}
}

// --- model.go key-routing integration ---------------------------------------

// TestModelRoutesKeysToActiveOverlay proves that when the stack is active the
// composed View shows the overlay frame (not the editor) and esc pops the overlay
// AND restores the half-typed editor text through the model's key routing.
func TestModelRoutesKeysToActiveOverlay(t *testing.T) {
	m := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 36})

	mgr := app.NewManager(keybindings.NewManager(nil), &fakeRequester{})
	mgr.Push(app.OverlaySettings, buildSettings(), "draft text")
	m.SetOverlays(mgr)

	overlayView := m.View().Content
	if !strings.Contains(overlayView, "Settings") {
		t.Fatalf("active overlay must capture the frame; view was:\n%s", overlayView)
	}

	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if mgr.Active() {
		t.Fatal("esc must pop the overlay via model key routing")
	}
	restored := m.View().Content
	if !strings.Contains(restored, "draft text") {
		t.Fatalf("esc must restore the half-typed editor text; view was:\n%s", restored)
	}
}

// TestModelActiveOverlaySuppressesInterrupt proves esc while an overlay is open
// cancels the overlay instead of emitting AbortRequested (the app interrupt).
func TestModelActiveOverlaySuppressesInterrupt(t *testing.T) {
	m := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})

	mgr := app.NewManager(keybindings.NewManager(nil), &fakeRequester{})
	mgr.Push(app.OverlayThinking, buildThinking(), "")
	m.SetOverlays(mgr)

	_, cmd := m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if cmd != nil {
		if _, ok := cmd().(app.AbortRequested); ok {
			t.Fatal("esc must cancel the overlay, not emit AbortRequested")
		}
	}
	if mgr.Active() {
		t.Fatal("esc must have cancelled the overlay")
	}
}
