package app

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/theme"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/builtinext"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/overlays"
)

// builtinext_overlay.go adapts the two chord-launched builtinext ports (history
// search, session observer) onto the app.Overlay contract. The builtinext
// components expose HandleInput(string)/Render(width) and fire a Done callback
// on their terminal action; the adapters translate that into the overlays.Outcome
// the Manager consumes. Kept as thin wrappers (like NewFavoritesOverlay) so the
// builtinext production code stays untouched.

// historyOverlay adapts builtinext.HistorySearchOverlay. Selecting a prompt sets
// the editor to that prompt (history-search/index.ts:53), carried back as the
// Outcome's RestoreText; cancel restores the pre-open editor text.
type historyOverlay struct {
	inner  *builtinext.HistorySearchOverlay
	result historyResult
}

type historyResult struct {
	done     bool
	selected bool
	text     string
}

// NewHistoryOverlay builds the history-search overlay over the indexed prompt
// entries and wraps it as an app.Overlay.
func NewHistoryOverlay(entries []builtinext.HistoryEntry, th *theme.Theme, keys *keybindings.Manager) Overlay {
	a := &historyOverlay{}
	a.inner = builtinext.NewHistorySearchOverlay(builtinext.HistorySearchOptions{
		Entries:       entries,
		Theme:         th,
		Keybindings:   keys,
		RequestRender: func() {}, // the Update→View cycle redraws after HandleKey returns
		Done: func(e builtinext.HistoryEntry, selected bool) {
			a.result = historyResult{done: true, selected: selected, text: e.Text}
		},
	})
	a.inner.SetFocused(true)
	return a
}

// HandleKey feeds the key to the inner overlay and maps its Done signal onto an
// Outcome: a selected prompt closes with RestoreText set to the prompt (the
// editor becomes that prompt); a cancel closes restoring the saved text; anything
// else stays open.
func (a *historyOverlay) HandleKey(data string, _ *keybindings.Manager, savedText string) overlays.Outcome {
	a.result = historyResult{}
	a.inner.HandleInput(data)
	if !a.result.done {
		return overlays.Outcome{Kind: overlays.OutcomeNone}
	}
	if a.result.selected && a.result.text != "" {
		return overlays.Outcome{Kind: overlays.OutcomeSelect, RestoreText: a.result.text}
	}
	return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
}

func (a *historyOverlay) RenderStyled(width int) []string { return a.inner.Render(width) }
func (a *historyOverlay) RenderPlain(width int) []string {
	return stripANSILines(a.inner.Render(width))
}

// observerOverlay adapts builtinext.SessionHudOverlay. Its Done callback fires
// only on close (the observe chord in the viewer, or cancel in the picker), which
// the adapter maps onto a cancel Outcome; navigation and open-session keys stay
// open.
type observerOverlay struct {
	inner *builtinext.SessionHudOverlay
	done  bool
}

// NewObserverOverlay builds the session-observer HUD over the scanned session
// summaries and wraps it as an app.Overlay.
func NewObserverOverlay(sessions []builtinext.SessionHudEntry, th *theme.Theme, keys *keybindings.Manager) Overlay {
	a := &observerOverlay{}
	a.inner = builtinext.NewSessionHudOverlay(builtinext.SessionHudOptions{
		Sessions:      sessions,
		Theme:         th,
		Keybindings:   keys,
		RequestRender: func() {},
		Done:          func() { a.done = true },
	})
	return a
}

// HandleKey feeds the key to the inner HUD; a Done signal closes the overlay
// (restoring the saved editor text), everything else keeps it open.
func (a *observerOverlay) HandleKey(data string, _ *keybindings.Manager, savedText string) overlays.Outcome {
	a.done = false
	a.inner.HandleInput(data)
	if a.done {
		return overlays.Outcome{Kind: overlays.OutcomeCancel, RestoreText: savedText}
	}
	return overlays.Outcome{Kind: overlays.OutcomeNone}
}

func (a *observerOverlay) RenderStyled(width int) []string { return a.inner.Render(width) }
func (a *observerOverlay) RenderPlain(width int) []string {
	return stripANSILines(a.inner.Render(width))
}

// stripANSILines removes color escapes from each rendered line for the plain
// render contract (content assertions), mirroring the other overlays' RenderPlain.
func stripANSILines(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = ui.StripANSI(l)
	}
	return out
}
