package keybindings

import "sort"

// scopes.go defines the contextual key-resolution tables. In the classic TUI a
// component only consults the bindings relevant to the surface it draws (the
// editor checks editor + input bindings, the models overlay checks its own
// sub-scope), so the SAME chord resolves to different actions by scope. This
// mirrors how interactive-mode.ts dispatches keys to the focused component's
// keybinding checks rather than a single global table.
//
// ResolveScoped returns the action ids a raw sequence triggers within a scope,
// in that scope's declared priority order, so callers get a deterministic result
// even when a chord is bound to several actions in-scope.

// scopeActions lists, per scope, the action ids that scope resolves, in priority
// order. Ordering follows the classic component's own check order.
var scopeActions = map[Scope][]string{
	ScopeEditor: {
		// App-level chords the interactive shell checks before/around the editor.
		"app.interrupt", "app.clear", "app.exit", "app.suspend",
		"app.thinking.cycle", "app.thinking.toggle",
		"app.model.cycleForward", "app.model.cycleBackward", "app.model.select",
		"app.history.search", "app.sessions.observe", "app.tools.expand",
		"app.session.toggleNamedFilter", "app.editor.external",
		"app.message.followUp", "app.message.dequeue", "app.clipboard.pasteImage",
		"app.session.new", "app.session.tree", "app.session.fork", "app.session.resume",
		// Editor + input bindings.
		"tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.cursorLeft",
		"tui.editor.cursorRight", "tui.editor.cursorWordLeft", "tui.editor.cursorWordRight",
		"tui.editor.cursorLineStart", "tui.editor.cursorLineEnd",
		"tui.editor.jumpForward", "tui.editor.jumpBackward",
		"tui.editor.pageUp", "tui.editor.pageDown",
		"tui.editor.deleteCharBackward", "tui.editor.deleteCharForward",
		"tui.editor.deleteWordBackward", "tui.editor.deleteWordForward",
		"tui.editor.deleteToLineStart", "tui.editor.deleteToLineEnd",
		"tui.editor.yank", "tui.editor.yankPop", "tui.editor.undo",
		"tui.input.newLine", "tui.input.submit", "tui.input.tab", "tui.input.copy",
	},
	ScopeSelector: {
		"tui.select.up", "tui.select.down", "tui.select.pageUp",
		"tui.select.pageDown", "tui.select.confirm", "tui.select.cancel",
	},
	ScopeModels: {
		// The models overlay's own sub-scope: ctrl+p toggles a provider here, NOT
		// model cycling. Its save/favorite/reorder chords live only in this scope.
		"app.models.save", "app.models.toggleFavorite", "app.models.enableAll",
		"app.models.clearAll", "app.models.toggleProvider",
		"app.models.reorderUp", "app.models.reorderDown",
		"tui.select.up", "tui.select.down", "tui.select.pageUp",
		"tui.select.pageDown", "tui.select.confirm", "tui.select.cancel",
	},
	ScopeSession: {
		"app.session.togglePath", "app.session.toggleSort", "app.session.rename",
		"app.session.delete", "app.session.deleteNoninvasive",
		"app.session.toggleNamedFilter",
		"tui.select.up", "tui.select.down", "tui.select.pageUp",
		"tui.select.pageDown", "tui.select.confirm", "tui.select.cancel",
	},
	ScopeTree: {
		"app.tree.foldOrUp", "app.tree.unfoldOrDown", "app.tree.editLabel",
		"app.tree.toggleLabelTimestamp",
		"app.tree.filter.default", "app.tree.filter.noTools", "app.tree.filter.userOnly",
		"app.tree.filter.labeledOnly", "app.tree.filter.all",
		"app.tree.filter.cycleForward", "app.tree.filter.cycleBackward",
		"tui.select.up", "tui.select.down", "tui.select.pageUp",
		"tui.select.pageDown", "tui.select.confirm", "tui.select.cancel",
	},
}

// ResolveScoped returns the action ids triggered by raw data within scope, in the
// scope's priority order. It is deterministic: the returned slice order is the
// scope's declared order, independent of map iteration.
func (m *Manager) ResolveScoped(data string, scope Scope) []string {
	actions, ok := scopeActions[scope]
	if !ok {
		return nil
	}
	var out []string
	for _, id := range actions {
		if m.Matches(data, id) {
			out = append(out, id)
		}
	}
	return out
}

// orderedKeys returns the map keys sorted lexicographically, for deterministic
// conflict output.
func orderedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
