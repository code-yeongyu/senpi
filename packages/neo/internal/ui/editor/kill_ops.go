package editor

// Kill-ring editing operations, ported from editor.ts. Backward deletions
// prepend into the kill ring; forward deletions append. Consecutive kills
// accumulate while lastAction stays "kill".

func (e *Editor) deleteToStartOfLine() {
	e.exitHistoryBrowsing()
	line := e.curLine()
	if e.state.cursorCol > 0 {
		e.pushUndo()
		deleted := runeSlice(line, 0, e.state.cursorCol)
		e.killRing.push(deleted, true, e.lastAction == actionKill)
		e.lastAction = actionKill
		e.state.lines[e.state.cursorLine] = runeSlice(line, e.state.cursorCol, runeLen(line))
		e.setCursorCol(0)
	} else if e.state.cursorLine > 0 {
		e.pushUndo()
		e.killRing.push("\n", true, e.lastAction == actionKill)
		e.lastAction = actionKill
		prev := e.state.lines[e.state.cursorLine-1]
		e.state.lines[e.state.cursorLine-1] = prev + line
		e.state.lines = removeLineAt(e.state.lines, e.state.cursorLine)
		e.state.cursorLine--
		e.setCursorCol(runeLen(prev))
	}
	e.emitChange()
}

func (e *Editor) deleteToEndOfLine() {
	e.exitHistoryBrowsing()
	line := e.curLine()
	if e.state.cursorCol < runeLen(line) {
		e.pushUndo()
		deleted := runeSlice(line, e.state.cursorCol, runeLen(line))
		e.killRing.push(deleted, false, e.lastAction == actionKill)
		e.lastAction = actionKill
		e.state.lines[e.state.cursorLine] = runeSlice(line, 0, e.state.cursorCol)
	} else if e.state.cursorLine < len(e.state.lines)-1 {
		e.pushUndo()
		e.killRing.push("\n", false, e.lastAction == actionKill)
		e.lastAction = actionKill
		next := e.state.lines[e.state.cursorLine+1]
		e.state.lines[e.state.cursorLine] = line + next
		e.state.lines = removeLineAt(e.state.lines, e.state.cursorLine+1)
	}
	e.emitChange()
}

func (e *Editor) deleteWordBackwards() {
	e.exitHistoryBrowsing()
	line := e.curLine()
	if e.state.cursorCol == 0 {
		if e.state.cursorLine > 0 {
			e.pushUndo()
			e.killRing.push("\n", true, e.lastAction == actionKill)
			e.lastAction = actionKill
			prev := e.state.lines[e.state.cursorLine-1]
			e.state.lines[e.state.cursorLine-1] = prev + line
			e.state.lines = removeLineAt(e.state.lines, e.state.cursorLine)
			e.state.cursorLine--
			e.setCursorCol(runeLen(prev))
		}
	} else {
		e.pushUndo()
		wasKill := e.lastAction == actionKill
		oldCol := e.state.cursorCol
		e.moveWordBackwards()
		deleteFrom := e.state.cursorCol
		e.setCursorCol(oldCol)
		deleted := runeSlice(line, deleteFrom, e.state.cursorCol)
		e.killRing.push(deleted, true, wasKill)
		e.lastAction = actionKill
		e.state.lines[e.state.cursorLine] = runeSlice(line, 0, deleteFrom) + runeSlice(line, e.state.cursorCol, runeLen(line))
		e.setCursorCol(deleteFrom)
	}
	e.emitChange()
}

func (e *Editor) deleteWordForward() {
	e.exitHistoryBrowsing()
	line := e.curLine()
	if e.state.cursorCol >= runeLen(line) {
		if e.state.cursorLine < len(e.state.lines)-1 {
			e.pushUndo()
			e.killRing.push("\n", false, e.lastAction == actionKill)
			e.lastAction = actionKill
			next := e.state.lines[e.state.cursorLine+1]
			e.state.lines[e.state.cursorLine] = line + next
			e.state.lines = removeLineAt(e.state.lines, e.state.cursorLine+1)
		}
	} else {
		e.pushUndo()
		wasKill := e.lastAction == actionKill
		oldCol := e.state.cursorCol
		e.moveWordForwards()
		deleteTo := e.state.cursorCol
		e.setCursorCol(oldCol)
		deleted := runeSlice(line, e.state.cursorCol, deleteTo)
		e.killRing.push(deleted, false, wasKill)
		e.lastAction = actionKill
		e.state.lines[e.state.cursorLine] = runeSlice(line, 0, e.state.cursorCol) + runeSlice(line, deleteTo, runeLen(line))
	}
	e.emitChange()
}

func (e *Editor) yank() {
	if e.killRing.length() == 0 {
		return
	}
	e.pushUndo()
	text, _ := e.killRing.peek()
	e.insertYankedText(text)
	e.lastAction = actionYank
}

func (e *Editor) yankPop() {
	if e.lastAction != actionYank || e.killRing.length() <= 1 {
		return
	}
	e.pushUndo()
	e.deleteYankedText()
	e.killRing.rotate()
	text, _ := e.killRing.peek()
	e.insertYankedText(text)
	e.lastAction = actionYank
}

func (e *Editor) insertYankedText(text string) {
	e.exitHistoryBrowsing()
	lines := splitLines(text)
	line := e.curLine()
	before := runeSlice(line, 0, e.state.cursorCol)
	after := runeSlice(line, e.state.cursorCol, runeLen(line))
	if len(lines) == 1 {
		e.state.lines[e.state.cursorLine] = before + text + after
		e.setCursorCol(e.state.cursorCol + runeLen(text))
	} else {
		e.state.lines[e.state.cursorLine] = before + lines[0]
		for i := 1; i < len(lines)-1; i++ {
			e.state.lines = insertLineAt(e.state.lines, e.state.cursorLine+i, lines[i])
		}
		lastIdx := e.state.cursorLine + len(lines) - 1
		e.state.lines = insertLineAt(e.state.lines, lastIdx, lines[len(lines)-1]+after)
		e.state.cursorLine = lastIdx
		e.setCursorCol(runeLen(lines[len(lines)-1]))
	}
	e.emitChange()
}

func (e *Editor) deleteYankedText() {
	yanked, ok := e.killRing.peek()
	if !ok || yanked == "" {
		return
	}
	yankLines := splitLines(yanked)
	if len(yankLines) == 1 {
		line := e.curLine()
		deleteLen := runeLen(yanked)
		before := runeSlice(line, 0, e.state.cursorCol-deleteLen)
		after := runeSlice(line, e.state.cursorCol, runeLen(line))
		e.state.lines[e.state.cursorLine] = before + after
		e.setCursorCol(e.state.cursorCol - deleteLen)
	} else {
		startLine := e.state.cursorLine - (len(yankLines) - 1)
		startCol := runeLen(e.state.lines[startLine]) - runeLen(yankLines[0])
		afterCursor := runeSlice(e.state.lines[e.state.cursorLine], e.state.cursorCol, runeLen(e.state.lines[e.state.cursorLine]))
		beforeYank := runeSlice(e.state.lines[startLine], 0, startCol)
		e.state.lines = spliceLines(e.state.lines, startLine, len(yankLines), beforeYank+afterCursor)
		e.state.cursorLine = startLine
		e.setCursorCol(startCol)
	}
	e.emitChange()
}
