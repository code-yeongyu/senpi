/**
 * For each `shift` in 1..`length - 1`, how many rows the rows ending at `end` (read upwards) keep matching the
 * same rows read `shift` rows higher: the Z-array of `lines[end - 1]`, `lines[end - 2]`, ... over `length` rows.
 */
function upwardRepeatLengths(lines: readonly string[], end: number, length: number): number[] {
	const at = (index: number) => lines[end - 1 - index];
	const lengths = new Array<number>(length).fill(0);
	let left = 0;
	let right = 0;
	for (let index = 1; index < length; index++) {
		let matched = index < right ? Math.min(right - index, lengths[index - left] ?? 0) : 0;
		while (index + matched < length && at(matched) === at(index + matched)) matched++;
		lengths[index] = matched;
		if (index + matched > right) {
			left = index;
			right = index + matched;
		}
	}
	return lengths;
}

/**
 * A check, per shift, of whether the new frame reads as the old one with `shift` rows inserted above
 * `prevViewportTop`: the rows at `prevViewportTop..+shift` are the old rows right above it, and walking up through
 * the block of rows that keeps matching that reading finds at least one row that really moved. Identical rows
 * (blank or repeated lines) match both readings and prove nothing; the walk stops at the first row the shift
 * does not explain.
 *
 * The walk has no fixed floor (senpi#3669). Rows above `firstChanged`, the first row where the frames differ,
 * are unchanged, so the search for the highest changed row above the viewport stops there and costs no more
 * than the rows the frame diff already compared. Above the viewport the unchanged rows between that row and
 * the viewport top match a shift exactly when they repeat with that period, which one Z-array pass over them
 * answers for every shift up to `maxShift`. The search runs once per frame, and only when a shift passes the
 * rows it skips and none of them moved.
 */
export function shiftedBlockCheck(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	firstChanged: number,
	maxShift: number,
): (shift: number) => boolean {
	let unchangedAbove: { lastChanged: number; run: number; repeats: number[] } | undefined;
	const readUnchangedAbove = () => {
		if (unchangedAbove) return unchangedAbove;
		const floor = Math.max(0, firstChanged);
		let lastChanged = prevViewportTop - 1;
		while (lastChanged >= floor && newLines[lastChanged] === previousLines[lastChanged]) lastChanged--;
		if (lastChanged < floor) lastChanged = -1;
		const run = prevViewportTop - 1 - lastChanged;
		const repeats = upwardRepeatLengths(previousLines, prevViewportTop, Math.min(prevViewportTop, run + maxShift));
		unchangedAbove = { lastChanged, run, repeats };
		return unchangedAbove;
	};
	return (shift) => {
		if (shift <= 0 || shift > prevViewportTop) return false;
		let skippedRowMoved = false;
		for (let row = prevViewportTop; row < prevViewportTop + shift; row++) {
			const scrolled = previousLines[row - shift];
			if (scrolled === undefined || scrolled !== newLines[row]) return false;
			if (newLines[row] !== previousLines[row]) skippedRowMoved = true;
		}
		if (skippedRowMoved) return true;
		const { lastChanged, run, repeats } = readUnchangedAbove();
		if (lastChanged < shift) return false;
		if (run > 0 && (repeats[shift] ?? 0) < run) return false;
		return newLines[lastChanged] === previousLines[lastChanged - shift];
	};
}

function sharedPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let length = 0;
	while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length++;
	return length;
}

/**
 * How far the last frame's visible rows moved up across `prevViewportTop` in the new frame (senpi#3669).
 *
 * A re-layout that shortens rows above the viewport (a wrapped table cell unwrapping as its column widens) while
 * the frame grows below puts the old top rows above the viewport. A repaint from the old viewport top then
 * overwrites their screen rows, so they are in neither the scrollback nor the screen until the catch-up replay.
 *
 * Re-laid rows are new strings, so exact matches cannot follow them. A re-laid row keeps its leading content
 * (its label, its first cell) and changes later (padding, column widths), so each offset is scored by the
 * prefix every changed old visible row shares with the new row at that offset. Rows unchanged in place are not
 * at risk and are not scored. An upward offset counts only when it scores strictly higher than staying in
 * place, so an in-place re-layout (the #2836 streamed table) keeps its start and adds no copies, and rows
 * that look alike everywhere tie and stay in place.
 */
export function movedAboveViewport(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	height: number,
): number {
	if (newLines[prevViewportTop] === previousLines[prevViewportTop]) return 0;
	const changedRows: number[] = [];
	for (let row = prevViewportTop; row < prevViewportTop + height; row++) {
		const previous = previousLines[row];
		if (previous !== undefined && previous !== newLines[row]) changedRows.push(row);
	}
	const resemblanceAt = (up: number): number => {
		let total = 0;
		for (const row of changedRows) total += sharedPrefixLength(previousLines[row] ?? "", newLines[row - up] ?? "");
		return total;
	};
	let best = 0;
	let bestResemblance = resemblanceAt(0);
	for (let up = 1; up <= Math.min(height, prevViewportTop); up++) {
		const resemblance = resemblanceAt(up);
		if (resemblance > bestResemblance) {
			best = up;
			bestResemblance = resemblance;
		}
	}
	return best;
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
	firstChanged: number,
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
	const maxShift = Math.min(lineCountDelta, prevViewportTop);
	const shiftedBlockMoved = shiftedBlockCheck(previousLines, newLines, prevViewportTop, firstChanged, maxShift);
	let best = 0;
	let bestMatches = visibleMatchesAt(0);
	for (let shift = 1; shift <= maxShift; shift++) {
		if (!shiftedBlockMoved(shift)) continue;
		const matches = visibleMatchesAt(shift);
		if (matches > bestMatches) {
			best = shift;
			bestMatches = matches;
		}
	}
	return bestMatches * 2 > height ? best : 0;
}
