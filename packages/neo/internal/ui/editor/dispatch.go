package editor

import "strings"

const (
	bracketedPasteStart = "\x1b[200~"
	bracketedPasteEnd   = "\x1b[201~"
)

// HandleInput processes one raw terminal key sequence exactly as the tui editor
// does (handleInput). It decodes bracketed paste, jump mode, and resolves every
// binding through the keymap. Ported from editor.ts handleInput().
func (e *Editor) HandleInput(data string) {
	// Character jump mode (awaiting next character).
	if e.jumpMode != jumpNone {
		if e.keymap.Matches(data, ActJumpForward) || e.keymap.Matches(data, ActJumpBackward) {
			e.jumpMode = jumpNone
			return
		}
		printable, ok := decodePrintableKey(data)
		if !ok && len(data) > 0 && data[0] >= 32 {
			printable, ok = data, true
		}
		if ok {
			dir := e.jumpMode
			e.jumpMode = jumpNone
			e.jumpToChar(printable, dir)
			return
		}
		// Control character: cancel and fall through to normal handling.
		e.jumpMode = jumpNone
	}

	// Bracketed paste framing (single-message form used by the tui suite).
	if strings.Contains(data, bracketedPasteStart) {
		e.pasteActive = true
		e.pasteBuffer = ""
		data = strings.Replace(data, bracketedPasteStart, "", 1)
	}
	if e.pasteActive {
		e.pasteBuffer += data
		if idx := strings.Index(e.pasteBuffer, bracketedPasteEnd); idx != -1 {
			content := e.pasteBuffer[:idx]
			if content != "" {
				e.handlePaste(content)
			}
			e.pasteActive = false
			remaining := e.pasteBuffer[idx+len(bracketedPasteEnd):]
			e.pasteBuffer = ""
			if remaining != "" {
				e.HandleInput(remaining)
			}
		}
		return
	}

	kb := e.keymap

	// Ctrl+C: let parent handle.
	if kb.Matches(data, ActCopy) {
		return
	}

	// Undo.
	if kb.Matches(data, ActUndo) {
		e.doUndo()
		return
	}

	// Autocomplete-mode key handling.
	if e.acState != acNone && e.acList != nil {
		if kb.Matches(data, ActSelectCancel) {
			e.cancelAutocomplete()
			return
		}
		if kb.Matches(data, ActSelectUp) || kb.Matches(data, ActSelectDown) {
			e.acList.handleInput(data, kb)
			return
		}
		if kb.Matches(data, ActTab) {
			e.acceptAutocomplete(false)
			return
		}
		if kb.Matches(data, ActSelectConfirm) {
			if e.acceptAutocomplete(true) {
				// slash prefix: fall through to submit
			} else {
				return
			}
		}
	}

	// Tab: trigger completion.
	if kb.Matches(data, ActTab) && e.acState == acNone {
		e.handleTabCompletion()
		return
	}

	// Deletion actions.
	if kb.Matches(data, ActDeleteToLineEnd) {
		e.deleteToEndOfLine()
		return
	}
	if kb.Matches(data, ActDeleteToLineStart) {
		e.deleteToStartOfLine()
		return
	}
	if kb.Matches(data, ActDeleteWordBack) {
		e.deleteWordBackwards()
		return
	}
	if kb.Matches(data, ActDeleteWordFwd) {
		e.deleteWordForward()
		return
	}
	if kb.Matches(data, ActDeleteCharBack) || matchesShiftBackspace(data) {
		e.handleBackspace()
		return
	}
	if kb.Matches(data, ActDeleteCharFwd) || matchesShiftDelete(data) {
		e.handleForwardDelete()
		return
	}

	// Kill-ring yank.
	if kb.Matches(data, ActYank) {
		e.yank()
		return
	}
	if kb.Matches(data, ActYankPop) {
		e.yankPop()
		return
	}

	// Cursor line/word movement.
	if kb.Matches(data, ActCursorLineStart) {
		e.moveToLineStart()
		return
	}
	if kb.Matches(data, ActCursorLineEnd) {
		e.moveToLineEnd()
		return
	}
	if kb.Matches(data, ActCursorWordLeft) {
		e.moveWordBackwards()
		return
	}
	if kb.Matches(data, ActCursorWordRight) {
		e.moveWordForwards()
		return
	}

	// New line vs submit.
	if kb.Matches(data, ActNewLine) || isNewLineSequence(data) {
		if e.shouldSubmitOnBackslashEnter(data) {
			e.handleBackspace()
			e.submitValue()
			return
		}
		e.addNewLine()
		return
	}
	if kb.Matches(data, ActSubmit) {
		if e.DisableSubmit {
			return
		}
		currentLine := e.curLine()
		if e.state.cursorCol > 0 && runeAt(currentLine, e.state.cursorCol-1) == '\\' {
			e.handleBackspace()
			e.addNewLine()
			return
		}
		e.submitValue()
		return
	}

	// Arrow navigation (with history).
	if kb.Matches(data, ActCursorUp) {
		e.handleUp()
		return
	}
	if kb.Matches(data, ActCursorDown) {
		e.handleDown()
		return
	}
	if kb.Matches(data, ActCursorRight) {
		e.moveCursor(0, 1)
		return
	}
	if kb.Matches(data, ActCursorLeft) {
		e.moveCursor(0, -1)
		return
	}

	// Page scroll.
	if kb.Matches(data, ActPageUp) {
		e.pageScroll(-1)
		return
	}
	if kb.Matches(data, ActPageDown) {
		e.pageScroll(1)
		return
	}

	// Character-jump triggers.
	if kb.Matches(data, ActJumpForward) {
		e.jumpMode = jumpForward
		return
	}
	if kb.Matches(data, ActJumpBackward) {
		e.jumpMode = jumpBackward
		return
	}

	// Shift+Space -> regular space.
	if matchesShiftSpace(data) {
		e.insertCharacter(" ", false)
		return
	}

	// Printable CSI-u / modifyOtherKeys.
	if printable, ok := decodePrintableKey(data); ok {
		e.insertCharacter(printable, false)
		return
	}

	// Regular characters (first byte >= 32).
	if len(data) > 0 && data[0] >= 32 {
		e.insertCharacter(data, false)
	}
}

// matchesShiftBackspace / matchesShiftDelete / matchesShiftSpace mirror the
// matchesKey(...) fallbacks in editor.ts for the shifted variants.
func matchesShiftBackspace(data string) bool {
	return data == "\x1b[127;2u" || data == "\x1b[8;2u"
}
func matchesShiftDelete(data string) bool {
	return data == "\x1b[3;2~"
}
func matchesShiftSpace(data string) bool {
	return data == "\x1b[32;2u"
}

// isNewLineSequence ports editor.ts's newline detection for shift+enter and the
// various terminal encodings (excluding the keymap ActNewLine already checked).
func isNewLineSequence(data string) bool {
	if data == "\x1b\r" || data == "\x1b[13;2~" || data == "\x1b[13;2u" {
		return true
	}
	if len(data) > 1 && data[0] == 10 { // "\n" with trailing bytes
		return true
	}
	if len(data) > 1 && strings.Contains(data, "\x1b") && strings.Contains(data, "\r") {
		return true
	}
	if data == "\n" {
		return true
	}
	return false
}

// runeAt returns the rune at rune-index i in s, or 0 if out of range.
func runeAt(s string, i int) rune {
	r := []rune(s)
	if i < 0 || i >= len(r) {
		return 0
	}
	return r[i]
}
