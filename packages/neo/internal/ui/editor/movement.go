package editor

// Cursor movement, history navigation, and the sticky-column state machine,
// ported from editor.ts. All columns are rune indices.

// visualLine maps a visual (wrapped) row to a logical line and rune range.
type visualLine struct {
	logicalLine int
	startCol    int
	length      int
}

func (e *Editor) exitHistoryBrowsing() {
	e.historyIndex = -1
	e.historyDraft = nil
}

func (e *Editor) isEditorEmpty() bool {
	return len(e.state.lines) == 1 && e.state.lines[0] == ""
}

func (e *Editor) isOnFirstVisualLine() bool {
	vls := e.buildVisualLineMap(e.lastWidth)
	return e.findCurrentVisualLine(vls) == 0
}

func (e *Editor) isOnLastVisualLine() bool {
	vls := e.buildVisualLineMap(e.lastWidth)
	return e.findCurrentVisualLine(vls) == len(vls)-1
}

func (e *Editor) handleUp() {
	if e.isOnFirstVisualLine() && (e.isEditorEmpty() || e.historyIndex > -1 || e.state.cursorCol == 0) {
		e.navigateHistory(-1)
	} else if e.isOnFirstVisualLine() {
		e.moveToLineStart()
	} else {
		e.moveCursor(-1, 0)
	}
}

func (e *Editor) handleDown() {
	if e.historyIndex > -1 && e.isOnLastVisualLine() {
		e.navigateHistory(1)
	} else if e.isOnLastVisualLine() {
		e.moveToLineEnd()
	} else {
		e.moveCursor(1, 0)
	}
}

func (e *Editor) navigateHistory(direction int) {
	e.lastAction = actionNone
	if len(e.history) == 0 {
		return
	}
	newIndex := e.historyIndex - direction
	if newIndex < -1 || newIndex >= len(e.history) {
		return
	}
	if e.historyIndex == -1 && newIndex >= 0 {
		e.pushUndo()
		draft := e.state.clone()
		e.historyDraft = &draft
	}
	e.historyIndex = newIndex
	if e.historyIndex == -1 {
		draft := e.historyDraft
		e.historyDraft = nil
		if draft != nil {
			e.state = *draft
			e.preferredVisualCol = nil
			e.snappedFromCol = nil
			e.scrollOff = 0
			e.emitChange()
		} else {
			e.setTextInternal("", placeEnd)
		}
	} else {
		placement := placeEnd
		if direction == -1 {
			placement = placeStart
		}
		e.setTextInternal(e.history[e.historyIndex], placement)
	}
}

func (e *Editor) moveToLineStart() {
	e.lastAction = actionNone
	e.setCursorCol(0)
}

func (e *Editor) moveToLineEnd() {
	e.lastAction = actionNone
	e.setCursorCol(runeLen(e.curLine()))
}

func (e *Editor) moveWordBackwards() {
	e.lastAction = actionNone
	line := e.curLine()
	if e.state.cursorCol == 0 {
		if e.state.cursorLine > 0 {
			e.state.cursorLine--
			e.setCursorCol(runeLen(e.curLine()))
		}
		return
	}
	e.setCursorCol(findWordBackward(line, e.state.cursorCol, e.markerAtomicPredicate()))
}

func (e *Editor) moveWordForwards() {
	e.lastAction = actionNone
	line := e.curLine()
	if e.state.cursorCol >= runeLen(line) {
		if e.state.cursorLine < len(e.state.lines)-1 {
			e.state.cursorLine++
			e.setCursorCol(0)
		}
		return
	}
	e.setCursorCol(findWordForward(line, e.state.cursorCol, e.markerAtomicPredicate()))
}

// markerAtomicPredicate returns isPasteMarker for word navigation (matches the
// tui editor passing isPasteMarker as isAtomicSegment).
func (e *Editor) markerAtomicPredicate() func(string) bool {
	return func(s string) bool { return isPasteMarkerText(s) }
}

func (e *Editor) moveCursor(deltaLine, deltaCol int) {
	e.lastAction = actionNone
	vls := e.buildVisualLineMap(e.lastWidth)
	currentVL := e.findCurrentVisualLine(vls)

	if deltaLine != 0 {
		target := currentVL + deltaLine
		if target >= 0 && target < len(vls) {
			e.moveToVisualLine(vls, currentVL, target)
		}
	}

	if deltaCol != 0 {
		line := e.curLine()
		if deltaCol > 0 {
			if e.state.cursorCol < runeLen(line) {
				after := runeSlice(line, e.state.cursorCol, runeLen(line))
				gLen := firstGraphemeLen(after, e.validMarker())
				e.setCursorCol(e.state.cursorCol + gLen)
			} else if e.state.cursorLine < len(e.state.lines)-1 {
				e.state.cursorLine++
				e.setCursorCol(0)
			} else if currentVL < len(vls) {
				vl := vls[currentVL]
				pc := e.state.cursorCol - vl.startCol
				e.preferredVisualCol = &pc
			}
		} else {
			if e.state.cursorCol > 0 {
				before := runeSlice(line, 0, e.state.cursorCol)
				gLen := lastGraphemeLen(before, e.validMarker())
				e.setCursorCol(e.state.cursorCol - gLen)
			} else if e.state.cursorLine > 0 {
				e.state.cursorLine--
				e.setCursorCol(runeLen(e.curLine()))
			}
		}
	}

	if e.acState != acNone {
		e.updateAutocomplete()
	}
}

func (e *Editor) pageScroll(direction int) {
	e.lastAction = actionNone
	pageSize := e.maxVisibleLines()
	vls := e.buildVisualLineMap(e.lastWidth)
	currentVL := e.findCurrentVisualLine(vls)
	target := currentVL + direction*pageSize
	if target < 0 {
		target = 0
	}
	if target > len(vls)-1 {
		target = len(vls) - 1
	}
	e.moveToVisualLine(vls, currentVL, target)
}

func (e *Editor) jumpToChar(char string, dir jumpDir) {
	e.lastAction = actionNone
	forward := dir == jumpForward
	lines := e.state.lines
	target := rune(0)
	for _, r := range char {
		target = r
		break
	}

	step := 1
	end := len(lines)
	if !forward {
		step = -1
		end = -1
	}
	for lineIdx := e.state.cursorLine; lineIdx != end; lineIdx += step {
		lineRunes := []rune(lines[lineIdx])
		isCurrent := lineIdx == e.state.cursorLine
		if forward {
			start := 0
			if isCurrent {
				start = e.state.cursorCol + 1
			}
			for i := start; i < len(lineRunes); i++ {
				if lineRunes[i] == target {
					e.state.cursorLine = lineIdx
					e.setCursorCol(i)
					return
				}
			}
		} else {
			start := len(lineRunes) - 1
			if isCurrent {
				start = e.state.cursorCol - 1
			}
			for i := start; i >= 0; i-- {
				if i < len(lineRunes) && lineRunes[i] == target {
					e.state.cursorLine = lineIdx
					e.setCursorCol(i)
					return
				}
			}
		}
	}
}
