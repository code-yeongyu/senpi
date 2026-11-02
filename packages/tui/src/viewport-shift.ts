/**
 * Whether the new frame reads as the old one with `shift` rows inserted above `prevViewportTop`: the rows at
 * `prevViewportTop..+shift` are the old rows right above it, and walking up through the block of rows that keeps
 * matching that reading finds at least one row that really moved. Identical rows (blank or repeated lines) match
 * both readings and prove nothing; the walk stops at the first row the shift does not explain.
 */
export function shiftedBlockMoved(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	shift: number,
	height: number,
): boolean {
	if (shift <= 0 || shift > prevViewportTop) return false;
	for (let row = prevViewportTop; row < prevViewportTop + shift; row++) {
		const scrolled = previousLines[row - shift];
		if (scrolled === undefined || scrolled !== newLines[row]) return false;
	}
	const scanFloor = Math.max(shift, prevViewportTop - 2 * height);
	for (let row = prevViewportTop + shift - 1; row >= scanFloor; row--) {
		const line = newLines[row];
		if (line !== previousLines[row - shift]) return false;
		if (line !== previousLines[row]) return true;
	}
	return false;
}

/**
 * How far the last frame's visible rows moved down in the new frame because rows were inserted above them.
 *
 * A held repaint writes the frame from a start row and lets the rows above the screen scroll into the
 * terminal's scrollback. Rows that sat above the old viewport are already there, so after an insertion
 * above the viewport (a live tool card growing over a tall /btw panel, senpi#3649) the repaint must start
 * where the old viewport's rows went, or every frame pushes another copy of them.
 *
 * A shift counts only when the rows it would skip are exactly the rows already in the scrollback right above
 * the old viewport, the contiguous block of rows above the viewport that matches the shift holds at least one
 * row that really moved (identical rows, such as blank or repeated lines, match both readings and prove
 * nothing), and most of the old visible rows reappear at it. A majority alone is not enough: a tall
 * stable live area matches at any offset after an append, while rows re-laid out in place (a streamed table,
 * #2836) are new rows that must still scroll into the scrollback, so the start stays at the old viewport top.
 */
export function insertedAboveViewport(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	height: number,
	lineCountDelta: number,
): number {
	if (lineCountDelta <= 0) return 0;
	const visibleMatchesAt = (shift: number): number => {
		let matches = 0;
		for (let row = 0; row < height; row++) {
			const previous = previousLines[prevViewportTop + row];
			if (previous !== undefined && previous === newLines[prevViewportTop + shift + row]) matches += 1;
		}
		return matches;
	};
	let best = 0;
	let bestMatches = visibleMatchesAt(0);
	for (let shift = 1; shift <= Math.min(lineCountDelta, prevViewportTop); shift++) {
		if (!shiftedBlockMoved(previousLines, newLines, prevViewportTop, shift, height)) continue;
		const matches = visibleMatchesAt(shift);
		if (matches > bestMatches) {
			best = shift;
			bestMatches = matches;
		}
	}
	return bestMatches * 2 > height ? best : 0;
}
