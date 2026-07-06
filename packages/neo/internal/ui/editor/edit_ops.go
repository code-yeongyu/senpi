package editor

import (
	"strings"

	"github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"
)

// normalizeText normalizes CRLF/CR to LF and expands tabs to 4 spaces, matching
// editor.ts normalizeText().
func normalizeText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return strings.ReplaceAll(text, "\t", "    ")
}

// setTextInternal replaces the document without touching history state.
type cursorPlacement int

const (
	placeEnd cursorPlacement = iota
	placeStart
)

func (e *Editor) setTextInternal(text string, placement cursorPlacement) {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 {
		lines = []string{""}
	}
	e.state.lines = lines
	if placement == placeStart {
		e.state.cursorLine = 0
		e.setCursorCol(0)
	} else {
		e.state.cursorLine = len(e.state.lines) - 1
		e.setCursorCol(runeLen(e.state.lines[e.state.cursorLine]))
	}
	e.scrollOff = 0
	e.emitChange()
}

// insertCharacter inserts char at the cursor with undo coalescing (fish-style).
func (e *Editor) insertCharacter(char string, skipCoalescing bool) {
	e.exitHistoryBrowsing()
	if !skipCoalescing {
		if isWhitespaceChar(char) || e.lastAction != actionTypeWord {
			e.pushUndo()
		}
		e.lastAction = actionTypeWord
	}
	line := e.curLine()
	before := runeSlice(line, 0, e.state.cursorCol)
	after := runeSlice(line, e.state.cursorCol, runeLen(line))
	e.state.lines[e.state.cursorLine] = before + char + after
	e.setCursorCol(e.state.cursorCol + runeLen(char))
	e.emitChange()
	e.maybeTriggerAutocompleteAfterInsert(char)
}

// insertTextAtCursorInternal inserts (possibly multi-line) text at the cursor.
func (e *Editor) insertTextAtCursorInternal(text string) {
	if text == "" {
		return
	}
	normalized := normalizeText(text)
	inserted := strings.Split(normalized, "\n")
	line := e.curLine()
	before := runeSlice(line, 0, e.state.cursorCol)
	after := runeSlice(line, e.state.cursorCol, runeLen(line))

	if len(inserted) == 1 {
		e.state.lines[e.state.cursorLine] = before + normalized + after
		e.setCursorCol(e.state.cursorCol + runeLen(normalized))
	} else {
		var newLines []string
		newLines = append(newLines, e.state.lines[:e.state.cursorLine]...)
		newLines = append(newLines, before+inserted[0])
		newLines = append(newLines, inserted[1:len(inserted)-1]...)
		newLines = append(newLines, inserted[len(inserted)-1]+after)
		newLines = append(newLines, e.state.lines[e.state.cursorLine+1:]...)
		e.state.lines = newLines
		e.state.cursorLine += len(inserted) - 1
		e.setCursorCol(runeLen(inserted[len(inserted)-1]))
	}
	e.emitChange()
}

// handlePaste processes pasted content: CSI-u decoding, normalization, printable
// filtering, path-space heuristic, and large-paste markers. Ported from
// handlePaste().
func (e *Editor) handlePaste(pasted string) {
	e.cancelAutocomplete()
	e.exitHistoryBrowsing()
	e.lastAction = actionNone
	e.pushUndo()

	decoded := decodePasteCSIu(pasted)
	clean := normalizeText(decoded)

	var b strings.Builder
	for _, r := range clean {
		if r == '\n' || r >= 32 {
			b.WriteRune(r)
		}
	}
	filtered := b.String()

	if len(filtered) > 0 && strings.ContainsAny(string([]rune(filtered)[0]), "/~.") {
		line := e.curLine()
		if e.state.cursorCol > 0 {
			cb := runeAt(line, e.state.cursorCol-1)
			if isWordChar(cb) {
				filtered = " " + filtered
			}
		}
	}

	pastedLines := strings.Split(filtered, "\n")
	totalChars := runeLen(filtered)
	if len(pastedLines) > 10 || totalChars > 1000 {
		e.pasteCounter++
		id := e.pasteCounter
		e.pastes[id] = filtered
		var marker string
		if len(pastedLines) > 10 {
			marker = "[paste #" + itoa(id) + " +" + itoa(len(pastedLines)) + " lines]"
		} else {
			marker = "[paste #" + itoa(id) + " " + itoa(totalChars) + " chars]"
		}
		e.insertTextAtCursorInternal(marker)
		return
	}
	e.insertTextAtCursorInternal(filtered)
}

func (e *Editor) addNewLine() {
	e.cancelAutocomplete()
	e.exitHistoryBrowsing()
	e.lastAction = actionNone
	e.pushUndo()
	line := e.curLine()
	before := runeSlice(line, 0, e.state.cursorCol)
	after := runeSlice(line, e.state.cursorCol, runeLen(line))
	e.state.lines[e.state.cursorLine] = before
	e.state.lines = insertLineAt(e.state.lines, e.state.cursorLine+1, after)
	e.state.cursorLine++
	e.setCursorCol(0)
	e.emitChange()
}

func (e *Editor) shouldSubmitOnBackslashEnter(data string) bool {
	if e.DisableSubmit {
		return false
	}
	if data != "\r" && data != "\x1b[13u" {
		return false
	}
	hasShiftEnter := false
	for _, k := range e.keymap.SubmitKeys() {
		if k == "shift+enter" || k == "shift+return" {
			hasShiftEnter = true
		}
	}
	if !hasShiftEnter {
		return false
	}
	line := e.curLine()
	return e.state.cursorCol > 0 && runeAt(line, e.state.cursorCol-1) == '\\'
}

func (e *Editor) submitValue() {
	e.cancelAutocomplete()
	result := strings.TrimSpace(e.expandPasteMarkers(joinLines(e.state.lines)))
	e.state = editorState{lines: []string{""}, cursorLine: 0, cursorCol: 0}
	e.pastes = map[int]string{}
	e.pasteCounter = 0
	e.exitHistoryBrowsing()
	e.scrollOff = 0
	e.undo.clear()
	e.lastAction = actionNone
	if e.OnChange != nil {
		e.OnChange("")
	}
	if e.OnSubmit != nil {
		e.OnSubmit(result)
	}
}

func (e *Editor) handleBackspace() {
	e.exitHistoryBrowsing()
	e.lastAction = actionNone
	if e.state.cursorCol > 0 {
		e.pushUndo()
		line := e.curLine()
		before := runeSlice(line, 0, e.state.cursorCol)
		gLen := lastGraphemeLen(before, e.validMarker())
		newBefore := runeSlice(line, 0, e.state.cursorCol-gLen)
		after := runeSlice(line, e.state.cursorCol, runeLen(line))
		e.state.lines[e.state.cursorLine] = newBefore + after
		e.setCursorCol(e.state.cursorCol - gLen)
	} else if e.state.cursorLine > 0 {
		e.pushUndo()
		cur := e.curLine()
		prev := e.state.lines[e.state.cursorLine-1]
		e.state.lines[e.state.cursorLine-1] = prev + cur
		e.state.lines = removeLineAt(e.state.lines, e.state.cursorLine)
		e.state.cursorLine--
		e.setCursorCol(runeLen(prev))
	}
	e.emitChange()
	e.retriggerAutocompleteAfterEdit()
}

func (e *Editor) handleForwardDelete() {
	e.exitHistoryBrowsing()
	e.lastAction = actionNone
	line := e.curLine()
	if e.state.cursorCol < runeLen(line) {
		e.pushUndo()
		after := runeSlice(line, e.state.cursorCol, runeLen(line))
		gLen := firstGraphemeLen(after, e.validMarker())
		before := runeSlice(line, 0, e.state.cursorCol)
		rest := runeSlice(line, e.state.cursorCol+gLen, runeLen(line))
		e.state.lines[e.state.cursorLine] = before + rest
	} else if e.state.cursorLine < len(e.state.lines)-1 {
		e.pushUndo()
		next := e.state.lines[e.state.cursorLine+1]
		e.state.lines[e.state.cursorLine] = line + next
		e.state.lines = removeLineAt(e.state.lines, e.state.cursorLine+1)
	}
	e.emitChange()
	e.retriggerAutocompleteAfterEdit()
}

func (e *Editor) doUndo() {
	e.exitHistoryBrowsing()
	snap, ok := e.undo.pop()
	if !ok {
		return
	}
	e.state = snap
	e.lastAction = actionNone
	e.preferredVisualCol = nil
	e.emitChange()
}

// expandPasteMarkers replaces each live marker with its stored content.
func (e *Editor) expandPasteMarkers(text string) string {
	result := text
	for id, content := range e.pastes {
		re := markerRegexForID(id)
		result = re.ReplaceAllString(result, replaceLiteral(content))
	}
	return result
}

// validMarker returns a predicate matching marker strings with a live paste id.
func (e *Editor) validMarker() func(string) bool {
	return func(marker string) bool {
		if !isPasteMarkerText(marker) {
			return false
		}
		id := parseMarkerID(marker)
		_, ok := e.pastes[id]
		return ok
	}
}

// firstGraphemeLen returns the rune length of the first grapheme (or atomic
// marker) in s.
func firstGraphemeLen(s string, validMarker func(string) bool) int {
	segs := segmentGraphemes(s, validMarker)
	if len(segs) == 0 {
		return 1
	}
	return runeLen(segs[0].Text)
}

// lastGraphemeLen returns the rune length of the last grapheme (or atomic
// marker) in s.
func lastGraphemeLen(s string, validMarker func(string) bool) int {
	segs := segmentGraphemes(s, validMarker)
	if len(segs) == 0 {
		return 1
	}
	return runeLen(segs[len(segs)-1].Text)
}

func isWordChar(r rune) bool {
	return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

var _ = textwidth.Visible // keep import when other helpers move
