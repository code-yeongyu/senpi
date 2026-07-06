package keybindings

import (
	"reflect"
	"sort"
	"testing"
)

// registry_test.go ports packages/tui/test/keybindings.test.ts (KeybindingsManager
// contract) plus the plan task-6 acceptance criteria:
//   - every action id from BOTH tables (TUI defaults + 44 app actions) resolves
//   - an override fixture flips a binding
//   - the scope-conflict test (ctrl+p editor vs models) is deterministic
//
// Written RED first against the stub Manager/Definitions.

// ---- ported from keybindings.test.ts ----

func TestManager_CtrlJDefaultNewlineAlias(t *testing.T) {
	m := NewManager(nil)
	if got := m.Keys("tui.input.newLine"); !reflect.DeepEqual(got, []string{"shift+enter", "ctrl+j"}) {
		t.Fatalf("Keys(tui.input.newLine) = %v, want [shift+enter ctrl+j]", got)
	}
	if !m.Matches("\n", "tui.input.newLine") {
		t.Errorf("Matches(\\n, tui.input.newLine) = false, want true")
	}
	if !m.Matches("\x1b[106;5u", "tui.input.newLine") {
		t.Errorf("Matches(ctrl+j CSI-u, tui.input.newLine) = false, want true")
	}
}

func TestManager_NoEvictSelectorConfirmWhenSubmitRebound(t *testing.T) {
	m := NewManager(map[string][]string{"tui.input.submit": {"enter", "ctrl+enter"}})
	if got := m.Keys("tui.input.submit"); !reflect.DeepEqual(got, []string{"enter", "ctrl+enter"}) {
		t.Errorf("Keys(tui.input.submit) = %v, want [enter ctrl+enter]", got)
	}
	if got := m.Keys("tui.select.confirm"); !reflect.DeepEqual(got, []string{"enter"}) {
		t.Errorf("Keys(tui.select.confirm) = %v, want [enter]", got)
	}
}

func TestManager_NoEvictCursorBindingsWhenKeyReused(t *testing.T) {
	m := NewManager(map[string][]string{"tui.select.up": {"up", "ctrl+p"}})
	if got := m.Keys("tui.select.up"); !reflect.DeepEqual(got, []string{"up", "ctrl+p"}) {
		t.Errorf("Keys(tui.select.up) = %v, want [up ctrl+p]", got)
	}
	if got := m.Keys("tui.editor.cursorUp"); !reflect.DeepEqual(got, []string{"up"}) {
		t.Errorf("Keys(tui.editor.cursorUp) = %v, want [up]", got)
	}
}

func TestManager_ReportsDirectUserConflictWithoutEvictingDefaults(t *testing.T) {
	m := NewManager(map[string][]string{
		"tui.input.submit":   {"ctrl+x"},
		"tui.select.confirm": {"ctrl+x"},
	})
	conflicts := m.Conflicts()
	if len(conflicts) != 1 || conflicts[0].Key != "ctrl+x" {
		t.Fatalf("Conflicts() = %+v, want one conflict on ctrl+x", conflicts)
	}
	got := append([]string(nil), conflicts[0].Actions...)
	sort.Strings(got)
	want := []string{"tui.input.submit", "tui.select.confirm"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("conflict actions = %v, want %v", got, want)
	}
	if kb := m.Keys("tui.editor.cursorLeft"); !reflect.DeepEqual(kb, []string{"left", "ctrl+b"}) {
		t.Errorf("Keys(tui.editor.cursorLeft) = %v, want [left ctrl+b]", kb)
	}
}

// ---- plan task-6 acceptance: every action id from BOTH tables resolves ----

// expectedActionIDs is the exhaustive set of action ids the registry must carry:
// the 31 TUI defaults (keybindings.ts) + the 44 app actions (core/keybindings.ts).
func expectedActionIDs() []string {
	return []string{
		// tui.editor.* (21)
		"tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.cursorLeft",
		"tui.editor.cursorRight", "tui.editor.cursorWordLeft", "tui.editor.cursorWordRight",
		"tui.editor.cursorLineStart", "tui.editor.cursorLineEnd", "tui.editor.jumpForward",
		"tui.editor.jumpBackward", "tui.editor.pageUp", "tui.editor.pageDown",
		"tui.editor.deleteCharBackward", "tui.editor.deleteCharForward",
		"tui.editor.deleteWordBackward", "tui.editor.deleteWordForward",
		"tui.editor.deleteToLineStart", "tui.editor.deleteToLineEnd",
		"tui.editor.yank", "tui.editor.yankPop", "tui.editor.undo",
		// tui.input.* (4)
		"tui.input.newLine", "tui.input.submit", "tui.input.tab", "tui.input.copy",
		// tui.select.* (6)
		"tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown",
		"tui.select.confirm", "tui.select.cancel",
		// app.* (44)
		"app.interrupt", "app.clear", "app.exit", "app.suspend", "app.thinking.cycle",
		"app.model.cycleForward", "app.model.cycleBackward", "app.model.select",
		"app.history.search", "app.sessions.observe", "app.tools.expand",
		"app.thinking.toggle", "app.session.toggleNamedFilter", "app.editor.external",
		"app.message.followUp", "app.message.dequeue", "app.clipboard.pasteImage",
		"app.session.new", "app.session.tree", "app.session.fork", "app.session.resume",
		"app.tree.foldOrUp", "app.tree.unfoldOrDown", "app.tree.editLabel",
		"app.tree.toggleLabelTimestamp", "app.session.togglePath", "app.session.toggleSort",
		"app.session.rename", "app.session.delete", "app.session.deleteNoninvasive",
		"app.models.save", "app.models.toggleFavorite", "app.models.enableAll",
		"app.models.clearAll", "app.models.toggleProvider", "app.models.reorderUp",
		"app.models.reorderDown", "app.tree.filter.default", "app.tree.filter.noTools",
		"app.tree.filter.userOnly", "app.tree.filter.labeledOnly", "app.tree.filter.all",
		"app.tree.filter.cycleForward", "app.tree.filter.cycleBackward",
	}
}

func TestRegistry_EveryActionIDResolves(t *testing.T) {
	defs := Definitions()
	want := expectedActionIDs()
	if len(defs) != len(want) {
		t.Errorf("Definitions() has %d entries, want %d", len(defs), len(want))
	}
	m := NewManager(nil)
	for _, id := range want {
		def, ok := defs[id]
		if !ok {
			t.Errorf("registry missing action id %q", id)
			continue
		}
		// The DefaultKeys of every action must round-trip through the manager:
		// its resolved key list must equal the definition's default keys.
		if got := m.Keys(id); !reflect.DeepEqual(got, def.DefaultKeys) {
			t.Errorf("Keys(%q) = %v, want default %v", id, got, def.DefaultKeys)
		}
	}
	// No stray extra ids beyond the expected set.
	wantSet := map[string]bool{}
	for _, id := range want {
		wantSet[id] = true
	}
	for id := range defs {
		if !wantSet[id] {
			t.Errorf("registry has unexpected action id %q", id)
		}
	}
}

// TestRegistry_ExactDefaultBindings pins the exact default keys for the app
// actions the plan brief calls out, so a wrong transcription fails loudly.
func TestRegistry_ExactDefaultBindings(t *testing.T) {
	m := NewManager(nil)
	cases := map[string][]string{
		"app.interrupt":                 {"escape"},
		"app.clear":                     {"ctrl+c"},
		"app.exit":                      {"ctrl+d"},
		"app.thinking.cycle":            {"shift+tab"},
		"app.model.cycleForward":        {"ctrl+p"},
		"app.model.cycleBackward":       {"shift+ctrl+p"},
		"app.model.select":              {"ctrl+l"},
		"app.history.search":            {"ctrl+r"},
		"app.sessions.observe":          {"ctrl+s"},
		"app.tools.expand":              {"ctrl+o"},
		"app.thinking.toggle":           {"ctrl+t"},
		"app.session.toggleNamedFilter": {"ctrl+n"},
		"app.editor.external":           {"ctrl+g"},
		"app.message.followUp":          {"alt+enter"},
		"app.message.dequeue":           {"alt+up"},
		"app.tree.foldOrUp":             {"ctrl+left", "alt+left"},
		"app.tree.unfoldOrDown":         {"ctrl+right", "alt+right"},
		"app.session.new":               {},
		"app.tree.filter.cycleBackward": {"shift+ctrl+o"},
	}
	for id, want := range cases {
		got := m.Keys(id)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Keys(%q) = %v, want %v", id, got, want)
		}
	}
}

// TestRegistry_SuspendDefaultIsPlatformAware mirrors core/keybindings.ts:71-74:
// ctrl+z everywhere except Windows (empty there). We assert the non-Windows
// value on this host and that pasteImage defaults to ctrl+v off-Windows.
func TestRegistry_SuspendAndPasteImageDefaults(t *testing.T) {
	m := NewManager(nil)
	if got := m.Keys("app.suspend"); !reflect.DeepEqual(got, []string{"ctrl+z"}) {
		t.Errorf("Keys(app.suspend) = %v, want [ctrl+z] on non-Windows", got)
	}
	if got := m.Keys("app.clipboard.pasteImage"); !reflect.DeepEqual(got, []string{"ctrl+v"}) {
		t.Errorf("Keys(app.clipboard.pasteImage) = %v, want [ctrl+v] on non-Windows", got)
	}
}

// ---- plan task-6 acceptance: override fixture flips a binding ----

func TestRegistry_OverrideFlipsBinding(t *testing.T) {
	// Default app.tools.expand is ctrl+o; the override flips it to ctrl+x.
	m := NewManager(map[string][]string{"app.tools.expand": {"ctrl+x"}})
	if got := m.Keys("app.tools.expand"); !reflect.DeepEqual(got, []string{"ctrl+x"}) {
		t.Errorf("Keys(app.tools.expand) after override = %v, want [ctrl+x]", got)
	}
	if m.Matches("\x0f", "app.tools.expand") { // ctrl+o raw
		t.Errorf("ctrl+o should no longer trigger app.tools.expand after override")
	}
	if !m.Matches("\x18", "app.tools.expand") { // ctrl+x raw
		t.Errorf("ctrl+x should trigger app.tools.expand after override")
	}
}

// ---- plan task-6 acceptance: scope conflict (ctrl+p editor vs models) ----

func TestRegistry_ScopeConflictCtrlP_Deterministic(t *testing.T) {
	m := NewManager(nil)
	// ctrl+p raw is 0x10 (DLE). In the editor scope it drives model cycling; in
	// the models overlay scope it toggles a provider. Resolution must be
	// deterministic per scope.
	ctrlP := "\x10"
	editorActs := m.ResolveScoped(ctrlP, ScopeEditor)
	modelsActs := m.ResolveScoped(ctrlP, ScopeModels)

	if !contains(editorActs, "app.model.cycleForward") {
		t.Errorf("editor scope ctrl+p = %v, want app.model.cycleForward", editorActs)
	}
	if contains(editorActs, "app.models.toggleProvider") {
		t.Errorf("editor scope ctrl+p must NOT resolve app.models.toggleProvider, got %v", editorActs)
	}
	if !contains(modelsActs, "app.models.toggleProvider") {
		t.Errorf("models scope ctrl+p = %v, want app.models.toggleProvider", modelsActs)
	}
	if contains(modelsActs, "app.model.cycleForward") {
		t.Errorf("models scope ctrl+p must NOT resolve app.model.cycleForward, got %v", modelsActs)
	}
	// Determinism: repeated calls yield identical order.
	for i := 0; i < 5; i++ {
		if !reflect.DeepEqual(m.ResolveScoped(ctrlP, ScopeEditor), editorActs) {
			t.Fatalf("ResolveScoped not deterministic across calls")
		}
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
