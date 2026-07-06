package editor

// Action identifies a semantic editor operation. The editor resolves every raw
// key sequence to an Action through the Keymap — it never compares raw bytes
// inline (repo rule: no hardcoded key checks; every binding goes through the
// keybinding manager). When the full task-6 keybinding manager lands it will
// satisfy this same interface, so the editor stays binding-agnostic.
type Action string

const (
	ActNone              Action = ""
	ActUndo              Action = "editor.undo"
	ActDeleteToLineEnd   Action = "editor.deleteToLineEnd"
	ActDeleteToLineStart Action = "editor.deleteToLineStart"
	ActDeleteWordBack    Action = "editor.deleteWordBackward"
	ActDeleteWordFwd     Action = "editor.deleteWordForward"
	ActDeleteCharBack    Action = "editor.deleteCharBackward"
	ActDeleteCharFwd     Action = "editor.deleteCharForward"
	ActYank              Action = "editor.yank"
	ActYankPop           Action = "editor.yankPop"
	ActCursorLineStart   Action = "editor.cursorLineStart"
	ActCursorLineEnd     Action = "editor.cursorLineEnd"
	ActCursorWordLeft    Action = "editor.cursorWordLeft"
	ActCursorWordRight   Action = "editor.cursorWordRight"
	ActCursorUp          Action = "editor.cursorUp"
	ActCursorDown        Action = "editor.cursorDown"
	ActCursorLeft        Action = "editor.cursorLeft"
	ActCursorRight       Action = "editor.cursorRight"
	ActPageUp            Action = "editor.pageUp"
	ActPageDown          Action = "editor.pageDown"
	ActJumpForward       Action = "editor.jumpForward"
	ActJumpBackward      Action = "editor.jumpBackward"
	ActNewLine           Action = "input.newLine"
	ActSubmit            Action = "input.submit"
	ActTab               Action = "input.tab"
	ActCopy              Action = "input.copy" // Ctrl+C — parent handles
	ActSelectUp          Action = "select.up"
	ActSelectDown        Action = "select.down"
	ActSelectConfirm     Action = "select.confirm"
	ActSelectCancel      Action = "select.cancel"
)

// Keymap resolves a decoded key (raw terminal sequence) to an Action.
type Keymap interface {
	// Matches reports whether the raw key sequence maps to the given action.
	Matches(raw string, action Action) bool
	// SubmitKeys returns the configured submit key names (for the backslash+
	// enter workaround, which only applies when submit is bound to shift+enter).
	SubmitKeys() []string
}

// defaultKeymap is the built-in TUI editor binding set, ported 1:1 from the raw
// sequences packages/tui/test/editor.test.ts feeds. Each entry maps an Action to
// the set of raw sequences that trigger it, so lookups stay declarative.
type defaultKeymap struct {
	bindings map[Action][]string
	submit   []string
}

// DefaultKeymap returns the neo editor's default keymap.
func DefaultKeymap() Keymap {
	return &defaultKeymap{
		bindings: map[Action][]string{
			ActUndo:              {"\x1b[45;5u"},                    // Ctrl+-
			ActDeleteToLineEnd:   {"\x0b"},                          // Ctrl+K
			ActDeleteToLineStart: {"\x15"},                          // Ctrl+U
			ActDeleteWordBack:    {"\x17", "\x1b\x7f", "\x1b[3;5~"}, // Ctrl+W, Alt+Backspace
			ActDeleteWordFwd:     {"\x1bd", "\x1bD"},                // Alt+D
			ActDeleteCharBack:    {"\x7f", "\x08"},                  // Backspace
			ActDeleteCharFwd:     {"\x1b[3~"},                       // Delete
			ActYank:              {"\x19"},                          // Ctrl+Y
			ActYankPop:           {"\x1by", "\x1bY"},                // Alt+Y
			ActCursorLineStart:   {"\x01", "\x1b[H", "\x1b[1~"},     // Ctrl+A, Home
			ActCursorLineEnd:     {"\x05", "\x1b[F", "\x1b[4~"},     // Ctrl+E, End
			ActCursorWordLeft:    {"\x1b[1;5D", "\x1bb", "\x1b[1;3D"},
			ActCursorWordRight:   {"\x1b[1;5C", "\x1bf", "\x1b[1;3C"},
			ActCursorUp:          {"\x1b[A", "\x10"}, // Up, Ctrl+P
			ActCursorDown:        {"\x1b[B", "\x0e"}, // Down, Ctrl+N
			ActCursorLeft:        {"\x1b[D", "\x02"}, // Left, Ctrl+B
			ActCursorRight:       {"\x1b[C", "\x06"}, // Right, Ctrl+F
			ActPageUp:            {"\x1b[5~"},
			ActPageDown:          {"\x1b[6~"},
			ActJumpForward:       {"\x1d"},     // Ctrl+]
			ActJumpBackward:      {"\x1b\x1d"}, // Alt+Ctrl+]
			ActSubmit:            {"\r", "\x1b[13u"},
			ActTab:               {"\t", "\x1b[9u"},
			ActCopy:              {"\x03"}, // Ctrl+C
			ActSelectUp:          {"\x1b[A", "\x10"},
			ActSelectDown:        {"\x1b[B", "\x0e"},
			ActSelectConfirm:     {"\r"},
			ActSelectCancel:      {"\x1b"},
		},
		submit: []string{"enter", "return"},
	}
}

func (k *defaultKeymap) Matches(raw string, action Action) bool {
	for _, b := range k.bindings[action] {
		if b == raw {
			return true
		}
	}
	return false
}

func (k *defaultKeymap) SubmitKeys() []string { return k.submit }
