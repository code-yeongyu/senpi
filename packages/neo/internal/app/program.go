package app

import (
	tea "charm.land/bubbletea/v2"
)

// NewProgram builds the root bubbletea program from its dependencies. It uses no
// alternate screen (neo renders inline, matching the classic TUI); keyboard
// enhancements are requested through the Model's View, not a program option
// (bubbletea v2.0.8 exposes no WithKeyboardEnhancements option), and the
// terminal's reply arrives as tea.KeyboardEnhancementsMsg.
func NewProgram(deps Deps) *tea.Program {
	return tea.NewProgram(NewModel(deps))
}
