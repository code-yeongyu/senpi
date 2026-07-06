// Package overlays implements the neo interactive overlay suite (plan task 12):
// model selector + favorites editor, session picker, tree navigator, settings
// modal, theme selector, thinking selector, trust prompt, hotkeys view, and
// session info/stats. Each overlay is a small state machine with a Render
// method; keys resolve through internal/ui/keybindings (never a hardcoded key
// check), styling comes only from internal/theme, and every overlay honors the
// showExtensionCustom save/restore semantics (interactive-mode.ts:2714-2723):
// esc/cancel restores the editor text that was active when the overlay opened.
//
// The overlays are transport-agnostic: they emit an Outcome describing the RPC
// command (or file op) the app shell should perform, so they can be unit-tested
// with scripted open->filter->act->verify flows without a live bridge.
package overlays

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// OutcomeKind classifies what an overlay's key handling produced.
type OutcomeKind int

const (
	// OutcomeNone means the key was consumed but nothing terminal happened
	// (navigation, filter edit, toggle) — the overlay stays open.
	OutcomeNone OutcomeKind = iota
	// OutcomeSelect means the user confirmed a selection; Command carries the
	// RPC/action the shell should perform. The overlay closes.
	OutcomeSelect
	// OutcomeCancel means the user cancelled (esc/ctrl+c). The shell restores the
	// saved editor text (RestoreText) and closes the overlay.
	OutcomeCancel
)

// Outcome is the result of feeding a key to an overlay. Command is a
// bridge-command name (e.g. "set_model", "switch_session", "set_thinking_level")
// plus payload fields; the shell maps it onto internal/bridge. FileOp is set for
// overlays that act via the native store (session rename/delete) rather than an
// RPC command.
type Outcome struct {
	Kind        OutcomeKind
	Command     string
	Fields      map[string]any
	FileOp      string
	RestoreText string
}

// none is the common "consumed, stay open" outcome.
func none() Outcome { return Outcome{Kind: OutcomeNone} }

// cancel builds a cancel outcome carrying the saved editor text to restore.
func cancel(savedText string) Outcome {
	return Outcome{Kind: OutcomeCancel, RestoreText: savedText}
}

// selectCmd builds a select outcome for an RPC command.
func selectCmd(command string, fields map[string]any) Outcome {
	return Outcome{Kind: OutcomeSelect, Command: command, Fields: fields}
}

// selectFileOp builds a select outcome for a native store operation (no RPC).
func selectFileOp(op string, fields map[string]any) Outcome {
	return Outcome{Kind: OutcomeSelect, FileOp: op, Fields: fields}
}

// matchesInScope reports whether raw key data triggers action within scope. It
// is the single seam every overlay uses to resolve keys — no overlay compares
// raw byte sequences directly, so user keybinding overrides apply everywhere
// (repo rule: every binding resolves through internal/ui/keybindings).
func matchesInScope(m *keybindings.Manager, data, action string, scope keybindings.Scope) bool {
	for _, id := range m.ResolveScoped(data, scope) {
		if id == action {
			return true
		}
	}
	return false
}

// matches reports whether raw key data triggers action, without a scope (used
// for the tui.select.* chords shared by every list overlay).
func matches(m *keybindings.Manager, data, action string) bool {
	return m.Matches(data, action)
}
