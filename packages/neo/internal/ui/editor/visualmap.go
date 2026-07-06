package editor

import "github.com/code-yeongyu/senpi/packages/neo/internal/ui/editor/textwidth"

// buildVisualLineMap maps logical lines to visual (wrapped) rows at the given
// width. Ported from buildVisualLineMap().
func (e *Editor) buildVisualLineMap(width int) []visualLine {
	var vls []visualLine
	for i, line := range e.state.lines {
		lineVisWidth := textwidth.Visible(line)
		switch {
		case runeLen(line) == 0:
			vls = append(vls, visualLine{logicalLine: i, startCol: 0, length: 0})
		case lineVisWidth <= width:
			vls = append(vls, visualLine{logicalLine: i, startCol: 0, length: runeLen(line)})
		default:
			for _, chunk := range e.getWrappedLine(i, width).chunks {
				vls = append(vls, visualLine{logicalLine: i, startCol: chunk.StartIndex, length: chunk.EndIndex - chunk.StartIndex})
			}
		}
	}
	return vls
}

func (e *Editor) findVisualLineAt(vls []visualLine, line, col int) int {
	for i := 0; i < len(vls); i++ {
		vl := vls[i]
		if vl.logicalLine != line {
			continue
		}
		offset := col - vl.startCol
		isLastSeg := i == len(vls)-1 || vls[i+1].logicalLine != vl.logicalLine
		if offset >= 0 && (offset < vl.length || (isLastSeg && offset == vl.length)) {
			return i
		}
	}
	return len(vls) - 1
}

func (e *Editor) findCurrentVisualLine(vls []visualLine) int {
	return e.findVisualLineAt(vls, e.state.cursorLine, e.state.cursorCol)
}

// moveToVisualLine moves the cursor to targetVL applying sticky-column logic and
// paste-marker snapping. Ported from moveToVisualLine().
func (e *Editor) moveToVisualLine(vls []visualLine, currentVL, targetVL int) {
	if currentVL < 0 || currentVL >= len(vls) || targetVL < 0 || targetVL >= len(vls) {
		return
	}
	cur := vls[currentVL]
	tgt := vls[targetVL]

	var currentVisualCol int
	if e.snappedFromCol != nil {
		vlIndex := e.findVisualLineAt(vls, cur.logicalLine, *e.snappedFromCol)
		currentVisualCol = *e.snappedFromCol - vls[vlIndex].startCol
	} else {
		currentVisualCol = e.state.cursorCol - cur.startCol
	}

	isLastSource := currentVL == len(vls)-1 || vls[currentVL+1].logicalLine != cur.logicalLine
	sourceMax := cur.length
	if !isLastSource {
		sourceMax = max0(cur.length - 1)
	}
	isLastTarget := targetVL == len(vls)-1 || vls[targetVL+1].logicalLine != tgt.logicalLine
	targetMax := tgt.length
	if !isLastTarget {
		targetMax = max0(tgt.length - 1)
	}

	moveTo := e.computeVerticalMoveColumn(currentVisualCol, sourceMax, targetMax)

	e.state.cursorLine = tgt.logicalLine
	targetCol := tgt.startCol + moveTo
	logicalLine := e.state.lines[tgt.logicalLine]
	e.state.cursorCol = minInt(targetCol, runeLen(logicalLine))

	// Snap cursor to atomic segment boundary (paste markers).
	segs := segmentGraphemes(logicalLine, e.validMarker())
	for _, seg := range segs {
		if seg.Index > e.state.cursorCol {
			break
		}
		if runeLen(seg.Text) <= 1 {
			continue
		}
		if e.state.cursorCol < seg.Index+runeLen(seg.Text) {
			isContinuation := seg.Index < tgt.startCol
			isMovingDown := targetVL > currentVL
			if isContinuation && isMovingDown {
				segEnd := seg.Index + runeLen(seg.Text)
				next := targetVL + 1
				for next < len(vls) && vls[next].logicalLine == tgt.logicalLine && vls[next].startCol < segEnd {
					next++
				}
				if next < len(vls) {
					e.moveToVisualLine(vls, currentVL, next)
					return
				}
			}
			snapped := e.state.cursorCol
			e.snappedFromCol = &snapped
			e.state.cursorCol = seg.Index
			return
		}
	}
	e.snappedFromCol = nil
}

// computeVerticalMoveColumn implements the sticky-column decision table.
// Ported from computeVerticalMoveColumn().
func (e *Editor) computeVerticalMoveColumn(currentVisualCol, sourceMax, targetMax int) int {
	hasPreferred := e.preferredVisualCol != nil
	cursorInMiddle := currentVisualCol < sourceMax
	targetTooShort := targetMax < currentVisualCol

	if !hasPreferred || cursorInMiddle {
		if targetTooShort {
			pc := currentVisualCol
			e.preferredVisualCol = &pc
			return targetMax
		}
		e.preferredVisualCol = nil
		return currentVisualCol
	}

	targetCantFitPreferred := targetMax < *e.preferredVisualCol
	if targetTooShort || targetCantFitPreferred {
		return targetMax
	}
	result := *e.preferredVisualCol
	e.preferredVisualCol = nil
	return result
}

func (e *Editor) maxVisibleLines() int {
	v := e.rows * 3 / 10
	if v < 5 {
		return 5
	}
	return v
}

func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
