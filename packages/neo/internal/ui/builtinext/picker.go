package builtinext

import (
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui"
	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/keybindings"
)

// pickerListTheme is the shared SelectList styling used by the files and diff
// pickers (both use the same accent/muted/dim/warning tiers, files.ts:166-172 /
// diff.ts:175-181). selectedText keeps the row's pre-colored glyphs.
func pickerListTheme(r roleStyler) ui.SelectListTheme {
	return ui.SelectListTheme{
		SelectedPrefix: func(s string) string { return r.fg("accent", s) },
		SelectedText:   func(s string) string { return s },
		Description:    func(s string) string { return r.fg("muted", s) },
		ScrollInfo:     func(s string) string { return r.fg("dim", s) },
		NoMatch:        func(s string) string { return r.fg("warning", s) },
	}
}

// handlePickerNav mirrors the shared files.ts / diff.ts custom-component input
// handling: ←/→ page by visibleRows (clamped), ↑↓ navigate, enter confirms
// (onConfirm), esc cancels (onCancel). All bindings resolve through the
// keybinding manager. Returns true when a render should be requested.
func handlePickerNav(km *keybindings.Manager, list *ui.SelectList, visibleRows int, input string, onConfirm, onCancel func()) bool {
	switch {
	case km.Matches(input, "tui.select.confirm"):
		if onConfirm != nil {
			onConfirm()
		}
		return true
	case km.Matches(input, "tui.select.cancel"):
		if onCancel != nil {
			onCancel()
		}
		return true
	case matchesLeft(km, input):
		idx := list.SelectedIndex() - visibleRows
		if idx < 0 {
			idx = 0
		}
		list.SetSelectedIndex(idx)
		return true
	case matchesRight(km, input):
		list.SetSelectedIndex(list.SelectedIndex() + visibleRows)
		return true
	case km.Matches(input, "tui.select.up"):
		list.MoveUp()
		return true
	case km.Matches(input, "tui.select.down"):
		list.MoveDown()
		return true
	}
	return false
}

// matchesLeft / matchesRight resolve the ←/→ paging keys through the keybinding
// key matcher (no hardcoded escape checks). The classic pickers use Key.left /
// Key.right directly; neo routes them through keybindings.MatchesKey against the
// "left"/"right" key ids.
func matchesLeft(_ *keybindings.Manager, input string) bool {
	return keybindings.MatchesKey(input, "left")
}

func matchesRight(_ *keybindings.Manager, input string) bool {
	return keybindings.MatchesKey(input, "right")
}
