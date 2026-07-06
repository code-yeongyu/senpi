package keybindings

import "sort"

// migrate.go ports the legacy keybinding-name migration
// (packages/coding-agent/src/core/keybindings.ts:213-341): old flat names like
// "cursorUp"/"expandTools" are rewritten to namespaced ids
// ("tui.editor.cursorUp"/"app.tools.expand"), the namespaced value wins when
// both an old and a new name are present, and the result is ordered by the
// registry's declaration order.

// keybindingNameMigrations mirrors KEYBINDING_NAME_MIGRATIONS
// (core/keybindings.ts:213-274): legacy flat name -> namespaced action id.
var keybindingNameMigrations = map[string]string{
	"cursorUp":                 "tui.editor.cursorUp",
	"cursorDown":               "tui.editor.cursorDown",
	"cursorLeft":               "tui.editor.cursorLeft",
	"cursorRight":              "tui.editor.cursorRight",
	"cursorWordLeft":           "tui.editor.cursorWordLeft",
	"cursorWordRight":          "tui.editor.cursorWordRight",
	"cursorLineStart":          "tui.editor.cursorLineStart",
	"cursorLineEnd":            "tui.editor.cursorLineEnd",
	"jumpForward":              "tui.editor.jumpForward",
	"jumpBackward":             "tui.editor.jumpBackward",
	"pageUp":                   "tui.editor.pageUp",
	"pageDown":                 "tui.editor.pageDown",
	"deleteCharBackward":       "tui.editor.deleteCharBackward",
	"deleteCharForward":        "tui.editor.deleteCharForward",
	"deleteWordBackward":       "tui.editor.deleteWordBackward",
	"deleteWordForward":        "tui.editor.deleteWordForward",
	"deleteToLineStart":        "tui.editor.deleteToLineStart",
	"deleteToLineEnd":          "tui.editor.deleteToLineEnd",
	"yank":                     "tui.editor.yank",
	"yankPop":                  "tui.editor.yankPop",
	"undo":                     "tui.editor.undo",
	"newLine":                  "tui.input.newLine",
	"submit":                   "tui.input.submit",
	"tab":                      "tui.input.tab",
	"copy":                     "tui.input.copy",
	"selectUp":                 "tui.select.up",
	"selectDown":               "tui.select.down",
	"selectPageUp":             "tui.select.pageUp",
	"selectPageDown":           "tui.select.pageDown",
	"selectConfirm":            "tui.select.confirm",
	"selectCancel":             "tui.select.cancel",
	"interrupt":                "app.interrupt",
	"clear":                    "app.clear",
	"exit":                     "app.exit",
	"suspend":                  "app.suspend",
	"cycleThinkingLevel":       "app.thinking.cycle",
	"cycleModelForward":        "app.model.cycleForward",
	"cycleModelBackward":       "app.model.cycleBackward",
	"selectModel":              "app.model.select",
	"observeSessions":          "app.sessions.observe",
	"expandTools":              "app.tools.expand",
	"toggleThinking":           "app.thinking.toggle",
	"toggleSessionNamedFilter": "app.session.toggleNamedFilter",
	"externalEditor":           "app.editor.external",
	"followUp":                 "app.message.followUp",
	"dequeue":                  "app.message.dequeue",
	"pasteImage":               "app.clipboard.pasteImage",
	"newSession":               "app.session.new",
	"tree":                     "app.session.tree",
	"fork":                     "app.session.fork",
	"resume":                   "app.session.resume",
	"treeFoldOrUp":             "app.tree.foldOrUp",
	"treeUnfoldOrDown":         "app.tree.unfoldOrDown",
	"treeEditLabel":            "app.tree.editLabel",
	"treeToggleLabelTimestamp": "app.tree.toggleLabelTimestamp",
	"toggleSessionPath":        "app.session.togglePath",
	"toggleSessionSort":        "app.session.toggleSort",
	"renameSession":            "app.session.rename",
	"deleteSession":            "app.session.delete",
	"deleteSessionNoninvasive": "app.session.deleteNoninvasive",
}

// MigrateConfig rewrites legacy keybinding names in raw to their namespaced ids,
// returning the migrated config and whether any change occurred. It mirrors
// migrateKeybindingsConfig (core/keybindings.ts:304-324): when a legacy name
// maps to a namespaced id that is ALSO present in the input, the namespaced
// value wins and the legacy entry is dropped (migrated=true). Insertion order is
// then normalized to the registry declaration order.
func MigrateConfig(raw map[string][]string) (map[string][]string, bool) {
	config := map[string][]string{}
	migrated := false

	// Deterministic iteration for stable "already exists" precedence, matching
	// the object-key iteration semantics the TS relies on: process in the input's
	// sorted order so a present namespaced key is observed consistently.
	for _, key := range sortedKeys(raw) {
		value := raw[key]
		nextKey := key
		if mapped, ok := keybindingNameMigrations[key]; ok {
			nextKey = mapped
		}
		if nextKey != key {
			migrated = true
		}
		if key != nextKey {
			if _, exists := raw[nextKey]; exists {
				// Namespaced id already present in the input: keep it, drop legacy.
				migrated = true
				continue
			}
		}
		config[nextKey] = value
	}

	return orderKeybindingsConfig(config), migrated
}

// orderKeybindingsConfig mirrors orderKeybindingsConfig (core/keybindings.ts:326-342):
// keys in registry declaration order first, then any extras sorted lexically.
func orderKeybindingsConfig(config map[string][]string) map[string][]string {
	ordered := map[string][]string{}
	for _, id := range definitionOrder {
		if v, ok := config[id]; ok {
			ordered[id] = v
		}
	}
	for _, key := range sortedKeys(config) {
		if _, ok := ordered[key]; !ok {
			ordered[key] = config[key]
		}
	}
	return ordered
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
