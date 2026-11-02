import { visibleWidth } from "@code-yeongyu/senpi";
import { appendLines, previewText, type RenderEnvironment, renderPrefixed, style } from "./render-blocks.ts";
import { FRAME_INNER_PREFIX, FRAME_SECTION_PREFIX } from "./render-live.ts";
import { renderStatusEvents } from "./render-status.ts";
import type { EvalCellResult } from "./types.ts";

export function cellOutputSection(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	maxLinesOrBudget: number,
	rowBudget?: number,
): string[] {
	const output = cell.output.trimEnd();
	if (output.length === 0) return [];
	const lines = renderPrefixed("output", environment, FRAME_SECTION_PREFIX);
	const outputColor = cell.status === "error" ? "error" : "toolOutput";
	const styledOutput = output
		.split("\n")
		.map((line) => style(environment.theme, outputColor, line))
		.join("\n");
	const innerWidth = Math.max(1, environment.width - 2);
	if (rowBudget !== undefined) {
		// Fit and pad inside the row budget (review HIGH-C): header + body never exceed the
		// budget, the marker consumes one body row when anything is hidden, and a short section
		// is padded so the block's total height never changes. The marker counts every hidden
		// row (review NEW-1): the kept tail plus the marker together are the whole output.
		const bodyRows = rowBudget - 1;
		const preview = previewText(styledOutput, bodyRows, innerWidth);
		const body: string[] = [];
		const kept = preview.skipped > 0 ? preview.lines.slice(-(bodyRows - 1)) : preview.lines;
		const omitted = preview.skipped + preview.lines.length - kept.length;
		if (omitted > 0) {
			appendLines(
				body,
				renderPrefixed(`${omitted} earlier output lines`, environment, {
					prefix: "│ ",
					continuation: "│ ",
					color: "muted",
				}),
			);
		}
		for (const line of kept) appendLines(body, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		const rows = [...lines, ...body];
		while (rows.length < rowBudget) rows.push(style(environment.theme, "borderMuted", "│ "));
		return rows.slice(0, rowBudget);
	}
	const preview = previewText(styledOutput, maxLinesOrBudget, innerWidth);
	if (preview.skipped > 0)
		appendLines(
			lines,
			renderPrefixed(`${preview.skipped} earlier output lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of preview.lines) appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	return lines;
}

export function cellStatusSection(cell: EvalCellResult, environment: RenderEnvironment, rowBudget?: number): string[] {
	const statusEvents = (cell.statusEvents ?? []).filter((event) => event.op !== "agent");
	if (statusEvents.length === 0) return [];
	if (rowBudget === undefined) {
		const lines = renderPrefixed("status", environment, FRAME_SECTION_PREFIX);
		for (const line of renderStatusEvents(statusEvents, environment))
			appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return lines;
	}
	// Budget in visual ROWS, not events (review HIGH-C). The tail keeps the NEWEST rows (review
	// NEW-2): whole events fold from the front into the exact marker when their rows overflow,
	// and a single event that alone overflows keeps its newest rows while the marker counts the
	// rows cut from its head. Rows are kept or dropped whole, never re-styled (review r4 HIGH-1).
	const first = statusEvents[0];
	const omittedByBound = first?.op === "status-events-omitted" && typeof first.count === "number" ? first.count : 0;
	const visible = omittedByBound > 0 ? statusEvents.slice(1) : statusEvents;
	const bodyRows = rowBudget - 1;
	// Render each event to its own rows so whole events fold cleanly. The fold marker counts
	// exactly the folded events plus the stored bound (review HIGH-2, HIGH-C).
	const perEvent = visible.map((event) => {
		const rendered = renderStatusEvents([event], { ...environment, expanded: true });
		const rows: string[] = [];
		for (const line of rendered) appendLines(rows, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
		return rows;
	});
	// Keep events from the newest until the next-older one would overflow the body; the newest
	// event is always kept, even when it alone overflows (review NEW-2). The fold marker counts
	// exactly the folded events plus the stored bound (review HIGH-2, HIGH-C).
	const keptEvents: string[][] = [];
	let used = 0;
	let firstShown = perEvent.length;
	for (let i = perEvent.length - 1; i >= 0; i--) {
		const rows = perEvent[i] ?? [];
		// The fold marker appears whenever anything older than event i (an earlier event or the
		// stored bound) is hidden, so it reserves one body row of the budget for keeping event i.
		const marker = i > 0 || omittedByBound > 0 ? 1 : 0;
		if (used + rows.length <= bodyRows - marker || keptEvents.length === 0) {
			keptEvents.unshift(rows);
			used += rows.length;
			firstShown = i;
		} else {
			break;
		}
	}
	const skipped = firstShown + omittedByBound;
	const eventRows: string[] = [];
	for (const rows of keptEvents) appendLines(eventRows, rows);
	// A still-overflowing tail is a single event taller than its share: keep its newest rows and
	// count the rows cut from its head in the marker, which then always takes one body row.
	const needsMarker = skipped > 0 || eventRows.length > bodyRows;
	const shownBudget = Math.max(0, bodyRows - (needsMarker ? 1 : 0));
	const cutRows = Math.max(0, eventRows.length - shownBudget);
	const body: string[] = [];
	if (needsMarker) body.push(statusMarker(skipped, cutRows, environment));
	appendLines(body, eventRows.slice(cutRows));
	const rows = [...renderPrefixed("status", environment, FRAME_SECTION_PREFIX), ...body.slice(0, bodyRows)];
	while (rows.length < rowBudget) rows.push(style(environment.theme, "borderMuted", "│ "));
	return rows;
}

// The fold marker is always exactly one row: the longest wording that fits the width wins, so
// both counts survive narrow terminals (review r4 HIGH-1, MEDIUM-1).
function statusMarker(skippedEvents: number, cutRows: number, environment: RenderEnvironment): string {
	const candidates =
		cutRows === 0
			? [`├ … ${skippedEvents} earlier status events`, `├ … ${skippedEvents} earlier`, `├ … ${skippedEvents}`]
			: skippedEvents === 0
				? [`├ … ${cutRows} earlier rows of this event`, `├ … ${cutRows} earlier rows`, `├ … ${cutRows} rows`]
				: [
						`├ … ${skippedEvents} earlier status events, ${cutRows} rows`,
						`├ … ${skippedEvents} events, ${cutRows} rows`,
						`├ … ${skippedEvents} ev, ${cutRows} rows`,
						`├ … ${skippedEvents}ev ${cutRows}r`,
					];
	const innerWidth = Math.max(1, environment.width - visibleWidth(FRAME_INNER_PREFIX.prefix));
	const text = candidates.find((candidate) => visibleWidth(candidate) <= innerWidth) ?? candidates.at(-1) ?? "";
	const [row] = renderPrefixed(text, environment, { prefix: "│ ", continuation: "│ ", color: "dim" });
	return row ?? "";
}
