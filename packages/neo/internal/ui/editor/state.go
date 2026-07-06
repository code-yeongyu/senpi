package editor

// editorState is the editor's undoable document state: the logical lines and the
// cursor position (line index + rune column within that line). Ported from the
// EditorState interface in packages/tui/src/components/editor.ts.
type editorState struct {
	lines      []string
	cursorLine int
	cursorCol  int // rune offset within lines[cursorLine]
}

// clone returns a deep copy (lines slice is copied) so snapshots are detached.
func (s editorState) clone() editorState {
	lines := make([]string, len(s.lines))
	copy(lines, s.lines)
	return editorState{lines: lines, cursorLine: s.cursorLine, cursorCol: s.cursorCol}
}

// undoStack stores deep clones of editor states with clone-on-push semantics,
// ported from packages/tui/src/undo-stack.ts.
type undoStack struct {
	stack []editorState
}

func (u *undoStack) push(s editorState) { u.stack = append(u.stack, s.clone()) }

func (u *undoStack) pop() (editorState, bool) {
	if len(u.stack) == 0 {
		return editorState{}, false
	}
	top := u.stack[len(u.stack)-1]
	u.stack = u.stack[:len(u.stack)-1]
	return top, true
}

func (u *undoStack) clear() { u.stack = u.stack[:0] }
