package app

import (
	tea "charm.land/bubbletea/v2"

	"github.com/code-yeongyu/senpi/packages/neo/internal/bridge"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// overlaystack.go is the todo-5 overlay-manager: a single-active-overlay stack
// that captures the frame + key input while a modal is open, routes keys to the
// top overlay (whose HandleKey resolves through its OWN keybinding scope, so the
// same chord means different things per surface — ctrl+p cycles a model in the
// editor but toggles a provider in the models overlay), and translates each
// overlay's Outcome into an RPC command or a native store op via the injected
// Requester. It also owns the master-task-12 showExtensionCustom save/restore
// contract: the editor text live when an overlay opens is saved and restored on
// esc/cancel.
//
// Guardrails (plan todo 5): no overlay-specific key handling outside the
// keybinding Manager scopes (every action resolves through ResolveScoped, never a
// raw byte compare); commands leave as tea.Cmd, so the manager never blocks the
// Update goroutine on a Request.

// Overlay is the contract every modal overlay component satisfies (the todo-12
// suite: model/favorites/session/tree/settings/theme/thinking/trust/hotkeys/
// stats). HandleKey resolves the key through the overlay's own scope and returns
// an Outcome; RenderPlain/RenderStyled draw the overlay frame.
type Overlay interface {
	HandleKey(data string, kb *keybindings.Manager, savedText string) overlays.Outcome
	RenderPlain(width int) []string
	RenderStyled(width int) []string
}

// Requester is the command-issuer seam the manager acts through. Request issues
// an RPC command; FileOp performs a native store operation (settings/session/
// favorites writes done locally via the lockfile protocol, never sent to the
// bridge). Both return a tea.Cmd so the actual I/O runs off the Update goroutine.
// Tests inject a fake that records the calls.
type Requester interface {
	Request(cmd bridge.Command) tea.Cmd
	FileOp(op string, fields map[string]any) tea.Cmd
}

// OverlayKind enumerates the twelve modal overlays the manager can host. The zero
// value OverlayNone means no overlay (ActiveKind on an empty stack). OverlayHistory
// and OverlayObserver are the two builtinext ports (history search ctrl+r, session
// observer ctrl+s); they read local session-dir data, so openAppOverlay builds +
// pushes them immediately like the other local-data overlays.
type OverlayKind int

const (
	OverlayNone OverlayKind = iota
	OverlayModel
	OverlayFavorites
	OverlaySession
	OverlayTree
	OverlaySettings
	OverlayTheme
	OverlayThinking
	OverlayTrust
	OverlayHotkeys
	OverlayStats
	OverlayHistory
	OverlayObserver
)

// OverlayKeyResult is what HandleKey reports back to the Model's key router.
// Handled is true when the manager consumed the key (always true while an overlay
// is active; when inactive, true only for an overlay-launching app chord). Cmd is
// the RPC/file-op command to run (may be nil). Restore asks the Model to restore
// the editor text (RestoreText) after an overlay closed.
type OverlayKeyResult struct {
	Cmd         tea.Cmd
	RestoreText string
	Handled     bool
	Restore     bool
	// OpenKind names the overlay an inactive-scope chord just requested a fetch
	// for (e.g. ctrl+l → OverlayModel). The main wiring records it as the pending
	// open so the fetch response builds + pushes that overlay. OverlayNone means
	// the key opened no overlay.
	OpenKind OverlayKind
}

// overlayEntry is one pushed overlay plus the editor text saved when it opened.
type overlayEntry struct {
	overlay   Overlay
	savedText string
	kind      OverlayKind
}

// Manager is the single-active-overlay stack. Only the top entry renders and
// receives keys. It implements the Model's OverlayStack interface.
type Manager struct {
	kb    *keybindings.Manager
	req   Requester
	stack []overlayEntry
}

// NewManager builds an overlay manager over a keybinding manager and a command
// issuer.
func NewManager(kb *keybindings.Manager, req Requester) *Manager {
	return &Manager{kb: kb, req: req}
}

// Active reports whether a modal overlay is open and capturing the frame + keys.
func (m *Manager) Active() bool { return len(m.stack) > 0 }

// ActiveKind returns the top overlay's kind, or OverlayNone when the stack is
// empty.
func (m *Manager) ActiveKind() OverlayKind {
	if len(m.stack) == 0 {
		return OverlayNone
	}
	return m.stack[len(m.stack)-1].kind
}

// Push opens an overlay, capturing the editor text live at open so esc/cancel can
// restore it (master task-12 showExtensionCustom semantics).
func (m *Manager) Push(kind OverlayKind, o Overlay, savedEditorText string) {
	m.stack = append(m.stack, overlayEntry{overlay: o, savedText: savedEditorText, kind: kind})
}

// pop removes the top overlay.
func (m *Manager) pop() {
	if len(m.stack) == 0 {
		return
	}
	m.stack = m.stack[:len(m.stack)-1]
}

// Render draws the top overlay's styled frame, clamped to the available height.
// Only meaningful when Active is true.
func (m *Manager) Render(width, height int) []string {
	if len(m.stack) == 0 {
		return nil
	}
	lines := m.stack[len(m.stack)-1].overlay.RenderStyled(width)
	if height > 0 && len(lines) > height {
		lines = lines[:height]
	}
	return lines
}

// HandleKey routes a raw key. While an overlay is active it goes to the top
// overlay (scope-switched inside that overlay's HandleKey); when inactive the
// manager still claims the overlay-launching editor-scope chords (model cycle,
// thinking cycle, open model selector) and leaves everything else to the Model's
// app chords + editor.
func (m *Manager) HandleKey(raw string) OverlayKeyResult {
	if m.Active() {
		return m.handleActive(raw)
	}
	return m.handleInactive(raw)
}

// handleActive delegates to the top overlay and translates its Outcome. Any key
// is consumed (Handled) while a modal is open, so the editor never sees it.
func (m *Manager) handleActive(raw string) OverlayKeyResult {
	top := m.stack[len(m.stack)-1]
	saved := top.savedText
	out := top.overlay.HandleKey(raw, m.kb, saved)
	switch out.Kind {
	case overlays.OutcomeCancel:
		m.pop()
		return OverlayKeyResult{Handled: true, Restore: true, RestoreText: saved}
	case overlays.OutcomeSelect:
		cmd := m.dispatch(out)
		m.pop()
		// A terminal select normally restores the pre-open editor text. The history
		// overlay is the exception: selecting a prompt sets the editor to that prompt
		// (history-search/index.ts:53), which it signals via a non-empty Outcome
		// RestoreText. Every RPC/file-op overlay leaves RestoreText empty, so they
		// keep the pre-open restore.
		restore := saved
		if out.RestoreText != "" {
			restore = out.RestoreText
		}
		return OverlayKeyResult{Handled: true, Cmd: cmd, Restore: true, RestoreText: restore}
	default: // OutcomeNone: consumed, overlay stays open.
		return OverlayKeyResult{Handled: true}
	}
}

// handleInactive resolves the editor-scope chords that launch or drive model
// state without an overlay: ctrl+p / shift+ctrl+p cycle the model (favorites-aware
// on the server), shift+tab cycles the thinking level, and ctrl+l opens the model
// selector (fetching the model list; the response builds + pushes the overlay in
// the main wiring). Every other key is left unhandled for the Model to route.
func (m *Manager) handleInactive(raw string) OverlayKeyResult {
	for _, action := range m.kb.ResolveScoped(raw, keybindings.ScopeEditor) {
		switch action {
		case "app.model.cycleForward":
			return m.emit(bridge.Command{Type: "cycle_model", Fields: map[string]any{"direction": "forward"}})
		case "app.model.cycleBackward":
			return m.emit(bridge.Command{Type: "cycle_model", Fields: map[string]any{"direction": "backward"}})
		case "app.thinking.cycle":
			return m.emit(bridge.Command{Type: "cycle_thinking_level"})
		case "app.model.select":
			return OverlayKeyResult{Handled: true, Cmd: m.Open(OverlayModel), OpenKind: OverlayModel}
		}
	}
	return OverlayKeyResult{Handled: false}
}

// emit wraps a single RPC command emission as a handled key result.
func (m *Manager) emit(cmd bridge.Command) OverlayKeyResult {
	return OverlayKeyResult{Handled: true, Cmd: m.req.Request(cmd)}
}

// dispatch turns a terminal overlay Outcome into the command it names: an RPC
// command (Command) or a native store op (FileOp).
func (m *Manager) dispatch(out overlays.Outcome) tea.Cmd {
	switch {
	case out.Command != "":
		return m.req.Request(bridge.Command{Type: out.Command, Fields: out.Fields})
	case out.FileOp != "":
		return m.req.FileOp(out.FileOp, out.Fields)
	}
	return nil
}

// Open emits the fetch an overlay needs before it can render (get_available_models
// for the model/favorites selectors, get_tree for the tree navigator,
// get_session_stats for the stats view, a native session scan for the picker).
// The main wiring (todo 9) builds + pushes the overlay when the fetch resolves;
// the local-data overlays (settings/theme/thinking/trust/hotkeys) need no fetch
// and return nil here.
func (m *Manager) Open(kind OverlayKind) tea.Cmd {
	switch kind {
	case OverlayModel, OverlayFavorites:
		return m.req.Request(bridge.Command{Type: "get_available_models"})
	case OverlayTree:
		return m.req.Request(bridge.Command{Type: "get_tree"})
	case OverlayStats:
		return m.req.Request(bridge.Command{Type: "get_session_stats"})
	case OverlaySession:
		return m.req.FileOp("scan_sessions", nil)
	}
	return nil
}

// favoritesOverlay wraps the model selector as the favorites editor: it is the
// same component (ctrl+f toggles a favorite) plus the ctrl+s save action, which
// persists the favorite set through the native store (model-favorites.ts
// persistence). The save resolves through ScopeModels — no raw key compare.
type favoritesOverlay struct {
	*overlays.ModelSelector
}

// NewFavoritesOverlay adapts a model selector into the favorites-editor overlay.
func NewFavoritesOverlay(ms *overlays.ModelSelector) Overlay {
	return favoritesOverlay{ModelSelector: ms}
}

// HandleKey adds the favorites save (app.models.save) on top of the model
// selector's own key handling. Save emits a save_favorites file op carrying the
// live favorite set; every other key delegates to the wrapped selector.
func (f favoritesOverlay) HandleKey(data string, kb *keybindings.Manager, savedText string) overlays.Outcome {
	for _, action := range kb.ResolveScoped(data, keybindings.ScopeModels) {
		if action == "app.models.save" {
			fav := f.CurrentFavorites()
			return overlays.Outcome{
				Kind:   overlays.OutcomeSelect,
				FileOp: "save_favorites",
				Fields: map[string]any{"ids": fav.IDs, "all": fav.All},
			}
		}
	}
	return f.ModelSelector.HandleKey(data, kb, savedText)
}
