package markdown

import "strings"

// getLongestWordWidth returns the visible width of the longest word, capped.
func getLongestWordWidth(text string, maxWidth int) int {
	longest := 0
	for _, w := range strings.Fields(text) {
		if vw := visibleWidth(w); vw > longest {
			longest = vw
		}
	}
	if maxWidth <= 0 {
		return longest
	}
	if longest > maxWidth {
		return maxWidth
	}
	return longest
}

func (m *Markdown) wrapCellText(text string, maxWidth int) []string {
	if maxWidth < 1 {
		maxWidth = 1
	}
	return wrapTextWithAnsi(text, maxWidth)
}

// renderTable renders a table with width-aware wrapping. Port of markdown.ts
// renderTable.
func (m *Markdown) renderTable(t *tableToken, availableWidth int, nextType tokenType, sc *inlineStyleContext) []string {
	var lines []string
	numCols := len(t.header)
	if numCols == 0 {
		return lines
	}

	borderOverhead := 3*numCols + 1
	availableForCells := availableWidth - borderOverhead
	if availableForCells < numCols {
		var fallback []string
		if t.raw != "" {
			fallback = wrapTextWithAnsi(t.raw, availableWidth)
		}
		if nextType != -1 && nextType != tokSpace {
			fallback = append(fallback, "")
		}
		return fallback
	}

	const maxUnbrokenWordWidth = 30

	naturalWidths := make([]int, numCols)
	minWordWidths := make([]int, numCols)
	for i := 0; i < numCols; i++ {
		headerText := m.renderInlineTokens(t.header[i].inline, sc)
		naturalWidths[i] = visibleWidth(headerText)
		w := getLongestWordWidth(headerText, maxUnbrokenWordWidth)
		if w < 1 {
			w = 1
		}
		minWordWidths[i] = w
	}
	for _, row := range t.rows {
		for i := 0; i < len(row) && i < numCols; i++ {
			cellText := m.renderInlineTokens(row[i].inline, sc)
			if vw := visibleWidth(cellText); vw > naturalWidths[i] {
				naturalWidths[i] = vw
			}
			w := getLongestWordWidth(cellText, maxUnbrokenWordWidth)
			if w > minWordWidths[i] {
				minWordWidths[i] = w
			}
		}
	}

	minColumnWidths := make([]int, numCols)
	copy(minColumnWidths, minWordWidths)
	minCellsWidth := sum(minColumnWidths)

	if minCellsWidth > availableForCells {
		for i := range minColumnWidths {
			minColumnWidths[i] = 1
		}
		remaining := availableForCells - numCols
		if remaining > 0 {
			totalWeight := 0
			for _, w := range minWordWidths {
				if w-1 > 0 {
					totalWeight += w - 1
				}
			}
			growth := make([]int, numCols)
			for i, w := range minWordWidths {
				weight := w - 1
				if weight < 0 {
					weight = 0
				}
				if totalWeight > 0 {
					growth[i] = (weight * remaining) / totalWeight
				}
			}
			for i := 0; i < numCols; i++ {
				minColumnWidths[i] += growth[i]
			}
			allocated := sum(growth)
			leftover := remaining - allocated
			for i := 0; leftover > 0 && i < numCols; i++ {
				minColumnWidths[i]++
				leftover--
			}
		}
		minCellsWidth = sum(minColumnWidths)
	}

	totalNaturalWidth := sum(naturalWidths) + borderOverhead
	var columnWidths []int

	if totalNaturalWidth <= availableWidth {
		columnWidths = make([]int, numCols)
		for i, w := range naturalWidths {
			columnWidths[i] = maxInt(w, minColumnWidths[i])
		}
	} else {
		totalGrowPotential := 0
		for i, w := range naturalWidths {
			if d := w - minColumnWidths[i]; d > 0 {
				totalGrowPotential += d
			}
		}
		extraWidth := availableForCells - minCellsWidth
		if extraWidth < 0 {
			extraWidth = 0
		}
		columnWidths = make([]int, numCols)
		for i, minWidth := range minColumnWidths {
			naturalWidth := naturalWidths[i]
			minWidthDelta := naturalWidth - minWidth
			if minWidthDelta < 0 {
				minWidthDelta = 0
			}
			grow := 0
			if totalGrowPotential > 0 {
				grow = (minWidthDelta * extraWidth) / totalGrowPotential
			}
			columnWidths[i] = minWidth + grow
		}
		allocated := sum(columnWidths)
		remaining := availableForCells - allocated
		for remaining > 0 {
			grew := false
			for i := 0; i < numCols && remaining > 0; i++ {
				if columnWidths[i] < naturalWidths[i] {
					columnWidths[i]++
					remaining--
					grew = true
				}
			}
			if !grew {
				break
			}
		}
	}

	// Top border
	lines = append(lines, "┌─"+joinRepeat(columnWidths, "─", "─┬─")+"─┐")

	// Header
	headerCellLines := make([][]string, numCols)
	for i := 0; i < numCols; i++ {
		text := m.renderInlineTokens(t.header[i].inline, sc)
		headerCellLines[i] = m.wrapCellText(text, columnWidths[i])
	}
	headerLineCount := maxLen(headerCellLines)
	for li := 0; li < headerLineCount; li++ {
		parts := make([]string, numCols)
		for ci := 0; ci < numCols; ci++ {
			text := ""
			if li < len(headerCellLines[ci]) {
				text = headerCellLines[ci][li]
			}
			pad := columnWidths[ci] - visibleWidth(text)
			if pad < 0 {
				pad = 0
			}
			parts[ci] = m.theme.Bold(text + strings.Repeat(" ", pad))
		}
		lines = append(lines, "│ "+strings.Join(parts, " │ ")+" │")
	}

	// Separator
	separatorLine := "├─" + joinRepeat(columnWidths, "─", "─┼─") + "─┤"
	lines = append(lines, separatorLine)

	// Rows
	for ri, row := range t.rows {
		rowCellLines := make([][]string, numCols)
		for ci := 0; ci < numCols; ci++ {
			text := ""
			if ci < len(row) {
				text = m.renderInlineTokens(row[ci].inline, sc)
			}
			rowCellLines[ci] = m.wrapCellText(text, columnWidths[ci])
		}
		rowLineCount := maxLen(rowCellLines)
		for li := 0; li < rowLineCount; li++ {
			parts := make([]string, numCols)
			for ci := 0; ci < numCols; ci++ {
				text := ""
				if li < len(rowCellLines[ci]) {
					text = rowCellLines[ci][li]
				}
				pad := columnWidths[ci] - visibleWidth(text)
				if pad < 0 {
					pad = 0
				}
				parts[ci] = text + strings.Repeat(" ", pad)
			}
			lines = append(lines, "│ "+strings.Join(parts, " │ ")+" │")
		}
		if ri < len(t.rows)-1 {
			lines = append(lines, separatorLine)
		}
	}

	// Bottom border
	lines = append(lines, "└─"+joinRepeat(columnWidths, "─", "─┴─")+"─┘")

	if nextType != -1 && nextType != tokSpace {
		lines = append(lines, "")
	}
	return lines
}

// helpers

func sum(xs []int) int {
	t := 0
	for _, x := range xs {
		t += x
	}
	return t
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func maxLen(rows [][]string) int {
	m := 0
	for _, r := range rows {
		if len(r) > m {
			m = len(r)
		}
	}
	return m
}

// joinRepeat builds a border segment string: for widths [w0,w1,...], it renders
// repeat(fill,w0) + sep + repeat(fill,w1) + ... matching pi's
// columnWidths.map(w => fill.repeat(w)).join(sep).
func joinRepeat(widths []int, fill, sep string) string {
	parts := make([]string, len(widths))
	for i, w := range widths {
		parts[i] = strings.Repeat(fill, w)
	}
	return strings.Join(parts, sep)
}
