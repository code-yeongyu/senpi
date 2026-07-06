package keybindings

// definitions.go transcribes the two default keybinding tables verbatim:
//   - TUI_KEYBINDINGS from packages/tui/src/keybindings.ts:54-134 (31 actions)
//   - the app KEYBINDINGS spread from core/keybindings.ts:66-211 (44 actions)
//
// Platform-aware entries (app.suspend, app.clipboard.pasteImage) call the
// helpers in registry.go so the default matches the classic runtime.js logic.

type defEntry struct {
	id  string
	def Definition
}

// tuiEntries mirrors TUI_KEYBINDINGS in declaration order.
func tuiEntries() []defEntry {
	return []defEntry{
		{"tui.editor.cursorUp", Definition{[]string{"up"}, "Move cursor up"}},
		{"tui.editor.cursorDown", Definition{[]string{"down"}, "Move cursor down"}},
		{"tui.editor.cursorLeft", Definition{[]string{"left", "ctrl+b"}, "Move cursor left"}},
		{"tui.editor.cursorRight", Definition{[]string{"right", "ctrl+f"}, "Move cursor right"}},
		{"tui.editor.cursorWordLeft", Definition{[]string{"alt+left", "ctrl+left", "alt+b"}, "Move cursor word left"}},
		{"tui.editor.cursorWordRight", Definition{[]string{"alt+right", "ctrl+right", "alt+f"}, "Move cursor word right"}},
		{"tui.editor.cursorLineStart", Definition{[]string{"home", "ctrl+a"}, "Move to line start"}},
		{"tui.editor.cursorLineEnd", Definition{[]string{"end", "ctrl+e"}, "Move to line end"}},
		{"tui.editor.jumpForward", Definition{[]string{"ctrl+]"}, "Jump forward to character"}},
		{"tui.editor.jumpBackward", Definition{[]string{"ctrl+alt+]"}, "Jump backward to character"}},
		{"tui.editor.pageUp", Definition{[]string{"pageUp"}, "Page up"}},
		{"tui.editor.pageDown", Definition{[]string{"pageDown"}, "Page down"}},
		{"tui.editor.deleteCharBackward", Definition{[]string{"backspace"}, "Delete character backward"}},
		{"tui.editor.deleteCharForward", Definition{[]string{"delete", "ctrl+d"}, "Delete character forward"}},
		{"tui.editor.deleteWordBackward", Definition{[]string{"ctrl+w", "alt+backspace"}, "Delete word backward"}},
		{"tui.editor.deleteWordForward", Definition{[]string{"alt+d", "alt+delete"}, "Delete word forward"}},
		{"tui.editor.deleteToLineStart", Definition{[]string{"ctrl+u"}, "Delete to line start"}},
		{"tui.editor.deleteToLineEnd", Definition{[]string{"ctrl+k"}, "Delete to line end"}},
		{"tui.editor.yank", Definition{[]string{"ctrl+y"}, "Yank"}},
		{"tui.editor.yankPop", Definition{[]string{"alt+y"}, "Yank pop"}},
		{"tui.editor.undo", Definition{[]string{"ctrl+-"}, "Undo"}},
		{"tui.input.newLine", Definition{[]string{"shift+enter", "ctrl+j"}, "Insert newline"}},
		{"tui.input.submit", Definition{[]string{"enter"}, "Submit input"}},
		{"tui.input.tab", Definition{[]string{"tab"}, "Tab / autocomplete"}},
		{"tui.input.copy", Definition{[]string{"ctrl+c"}, "Copy selection"}},
		{"tui.select.up", Definition{[]string{"up"}, "Move selection up"}},
		{"tui.select.down", Definition{[]string{"down"}, "Move selection down"}},
		{"tui.select.pageUp", Definition{[]string{"pageUp"}, "Selection page up"}},
		{"tui.select.pageDown", Definition{[]string{"pageDown"}, "Selection page down"}},
		{"tui.select.confirm", Definition{[]string{"enter"}, "Confirm selection"}},
		{"tui.select.cancel", Definition{[]string{"escape", "ctrl+c"}, "Cancel selection"}},
	}
}

// appEntries mirrors the app KEYBINDINGS in core/keybindings.ts:68-210. The two
// platform-aware entries defer to helpers so the default matches the host.
func appEntries() []defEntry {
	return []defEntry{
		{"app.interrupt", Definition{[]string{"escape"}, "Cancel or abort"}},
		{"app.clear", Definition{[]string{"ctrl+c"}, "Clear editor"}},
		{"app.exit", Definition{[]string{"ctrl+d"}, "Exit when editor is empty"}},
		{"app.suspend", Definition{suspendDefault(), "Suspend to background"}},
		{"app.thinking.cycle", Definition{[]string{"shift+tab"}, "Cycle thinking level"}},
		{"app.model.cycleForward", Definition{[]string{"ctrl+p"}, "Cycle to next model"}},
		{"app.model.cycleBackward", Definition{[]string{"shift+ctrl+p"}, "Cycle to previous model"}},
		{"app.model.select", Definition{[]string{"ctrl+l"}, "Open model selector"}},
		{"app.history.search", Definition{[]string{"ctrl+r"}, "Search prompt history across sessions"}},
		{"app.sessions.observe", Definition{[]string{"ctrl+s"}, "Observe session transcripts"}},
		{"app.tools.expand", Definition{[]string{"ctrl+o"}, "Toggle tool output"}},
		{"app.thinking.toggle", Definition{[]string{"ctrl+t"}, "Toggle thinking blocks"}},
		{"app.session.toggleNamedFilter", Definition{[]string{"ctrl+n"}, "Toggle named session filter"}},
		{"app.editor.external", Definition{[]string{"ctrl+g"}, "Open external editor"}},
		{"app.message.followUp", Definition{[]string{"alt+enter"}, "Queue follow-up message"}},
		{"app.message.dequeue", Definition{[]string{"alt+up"}, "Restore queued messages"}},
		{"app.clipboard.pasteImage", Definition{pasteImageDefault(), "Paste image from clipboard"}},
		{"app.session.new", Definition{[]string{}, "Start a new session"}},
		{"app.session.tree", Definition{[]string{}, "Open session tree"}},
		{"app.session.fork", Definition{[]string{}, "Fork current session"}},
		{"app.session.resume", Definition{[]string{}, "Resume a session"}},
		{"app.tree.foldOrUp", Definition{[]string{"ctrl+left", "alt+left"}, "Fold tree branch or move up"}},
		{"app.tree.unfoldOrDown", Definition{[]string{"ctrl+right", "alt+right"}, "Unfold tree branch or move down"}},
		{"app.tree.editLabel", Definition{[]string{"shift+l"}, "Edit tree label"}},
		{"app.tree.toggleLabelTimestamp", Definition{[]string{"shift+t"}, "Toggle tree label timestamps"}},
		{"app.session.togglePath", Definition{[]string{"ctrl+p"}, "Toggle session path display"}},
		{"app.session.toggleSort", Definition{[]string{"ctrl+s"}, "Toggle session sort mode"}},
		{"app.session.rename", Definition{[]string{"ctrl+r"}, "Rename session"}},
		{"app.session.delete", Definition{[]string{"ctrl+d"}, "Delete session"}},
		{"app.session.deleteNoninvasive", Definition{[]string{"ctrl+backspace"}, "Delete session when query is empty"}},
		{"app.models.save", Definition{[]string{"ctrl+s"}, "Save model selection"}},
		{"app.models.toggleFavorite", Definition{[]string{"ctrl+f"}, "Toggle favorite model"}},
		{"app.models.enableAll", Definition{[]string{"ctrl+a"}, "Enable all models"}},
		{"app.models.clearAll", Definition{[]string{"ctrl+x"}, "Clear all models"}},
		{"app.models.toggleProvider", Definition{[]string{"ctrl+p"}, "Toggle all models for provider"}},
		{"app.models.reorderUp", Definition{[]string{"alt+up"}, "Move model up in order"}},
		{"app.models.reorderDown", Definition{[]string{"alt+down"}, "Move model down in order"}},
		{"app.tree.filter.default", Definition{[]string{"ctrl+d"}, "Tree filter: default view"}},
		{"app.tree.filter.noTools", Definition{[]string{"ctrl+t"}, "Tree filter: hide tool results"}},
		{"app.tree.filter.userOnly", Definition{[]string{"ctrl+u"}, "Tree filter: user messages only"}},
		{"app.tree.filter.labeledOnly", Definition{[]string{"ctrl+l"}, "Tree filter: labeled entries only"}},
		{"app.tree.filter.all", Definition{[]string{"ctrl+a"}, "Tree filter: show all entries"}},
		{"app.tree.filter.cycleForward", Definition{[]string{"ctrl+o"}, "Tree filter: cycle forward"}},
		{"app.tree.filter.cycleBackward", Definition{[]string{"shift+ctrl+o"}, "Tree filter: cycle backward"}},
	}
}

func buildDefinitionOrder() []string {
	entries := append(tuiEntries(), appEntries()...)
	order := make([]string, len(entries))
	for i, e := range entries {
		order[i] = e.id
	}
	return order
}

func buildDefinitions() map[string]Definition {
	entries := append(tuiEntries(), appEntries()...)
	m := make(map[string]Definition, len(entries))
	for _, e := range entries {
		m[e.id] = e.def
	}
	return m
}
