import { isImageLine } from "./terminal-image.ts";
import { shiftedBlockMoved } from "./viewport-shift.ts";

// Keep scroll-region wins cheap when a few visible rows mutate during append streaming.
const MAX_SCROLL_DIFF_ROWS = 4;

export interface ViewportInsertScrollPlan {
	viewportTop: number;
	regionBottom: number;
	insertedRows: string[];
	mutatedRows: Array<{ screenRow: number; content: string }>;
}

function viewportRows(lines: readonly string[], viewportTop: number, height: number): string[] {
	return Array.from({ length: height }, (_, row) => lines[viewportTop + row] ?? "");
}

/**
 * Plan a scroll-region update for a frame that grew by `lineCountDelta` rows below a stable bottom suffix.
 *
 * Scrolling the region pushes the old top `lineCountDelta` visible rows into the terminal's scrollback as
 * they are, so the plan only holds when the new frame keeps exactly those rows there. Rows inserted at or
 * above the viewport top (a live tool card growing above a tall live area such as the /btw panel) break that:
 * the scroll would lose the inserted rows and send stale copies of the live area into the scrollback on
 * every frame (senpi#3649), so such a frame takes the general repaint paths instead. Identical rows can make the
 * departing rows equal the new ones by coincidence, so a frame that reads as rows moved down from above
 * (`shiftedBlockMoved`) is refused too.
 */
export function planViewportInsertScroll(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	height: number,
	lineCountDelta: number,
): ViewportInsertScrollPlan | undefined {
	if (lineCountDelta <= 0 || lineCountDelta >= height) return undefined;

	const maxViewportTop = Math.max(0, newLines.length - height);
	const viewportTop = Math.min(maxViewportTop, prevViewportTop + lineCountDelta);
	if (viewportTop <= prevViewportTop) return undefined;

	const previousVisible = viewportRows(previousLines, prevViewportTop, height);
	const nextVisible = viewportRows(newLines, viewportTop, height);
	if (previousVisible.some(isImageLine) || nextVisible.some(isImageLine)) return undefined;

	const scrolledOut = viewportTop - prevViewportTop;
	for (let row = 0; row < scrolledOut; row++) {
		if (previousVisible[row] !== newLines[prevViewportTop + row]) return undefined;
	}
	if (shiftedBlockMoved(previousLines, newLines, prevViewportTop, scrolledOut, height)) return undefined;

	let stableSuffixRows = 0;
	while (
		stableSuffixRows < height &&
		previousVisible[height - stableSuffixRows - 1] === nextVisible[height - stableSuffixRows - 1]
	) {
		stableSuffixRows += 1;
	}

	const regionHeight = height - stableSuffixRows;
	if (regionHeight <= 0 || regionHeight < lineCountDelta) return undefined;

	const mutatedRows: Array<{ screenRow: number; content: string }> = [];
	for (let row = 0; row < regionHeight - lineCountDelta; row++) {
		if (previousVisible[row + lineCountDelta] !== nextVisible[row]) {
			mutatedRows.push({ screenRow: row, content: nextVisible[row] ?? "" });
			if (mutatedRows.length > MAX_SCROLL_DIFF_ROWS) return undefined;
		}
	}

	return {
		viewportTop,
		regionBottom: regionHeight - 1,
		insertedRows: nextVisible.slice(regionHeight - lineCountDelta, regionHeight),
		mutatedRows,
	};
}
