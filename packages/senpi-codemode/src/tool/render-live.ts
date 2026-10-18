import { sanitizeTerminalLabel, truncateToVisualLines, visibleWidth } from "@code-yeongyu/senpi";
import { highlightedCode } from "./code-preview.ts";
import { leadsWithHeadline, liveHeadline } from "./live-headline.ts";
import {
	appendLines,
	assertNever,
	LIVE_RENDER_TICK_MS,
	type PrefixStyle,
	type RenderEnvironment,
	renderPrefixed,
	type StatusPresentation,
	spinner,
	style,
} from "./render-blocks.ts";
import { formatThroughputBadge } from "./render-status.ts";
import { cellOutputSection, cellStatusSection } from "./render-tail.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalCellResult, EvalToolDetails } from "./types.ts";

type CellStatus = EvalCellResult["status"];
export type CellThroughput = { readonly calls: number; readonly wallDurationMs: number | undefined };
export type CellBadges = {
	readonly reset: boolean;
	readonly timeout: number | undefined;
	readonly throughput: CellThroughput | undefined;
	/** The call lane still streaming its arguments: the header names the state instead of "running". */
	readonly streaming?: boolean;
};

export const LIVE_LINE_PREFIX: PrefixStyle = { prefix: "╶─ ", continuation: "   ", color: "borderAccent" };
const FRAME_HEADER_PREFIX: PrefixStyle = { prefix: "╭─ ", continuation: "│  ", color: "borderAccent" };
const FRAME_INNER_PREFIX: PrefixStyle = { prefix: "│ ", continuation: "│ ", color: "borderMuted" };
const FRAME_SECTION_PREFIX: PrefixStyle = { prefix: "├─ ", continuation: "│  ", color: "dim" };

export const LIVE_CODE_WINDOW_LINES = 6;
// The live block's total height never changes: header + 6 body rows + border. When output or
// status events exist, they take a fixed tail section and the code window shrinks inside the
// same total (review MEDIUM-2): 6 code rows alone, or 3 code + 3 tail rows.
const LIVE_BODY_ROWS = 6;
const LIVE_TAIL_ROWS = 3;

export function isLiveCellStatus(status: CellStatus): boolean {
	return status === "pending" || status === "running";
}

export function hasLiveCell(details: EvalToolDetails | undefined): boolean {
	return (details?.cells ?? []).some((cell) => isLiveCellStatus(cell.status) && cell.startedAt !== undefined);
}

export function cellPresentation(status: CellStatus, spinnerFrame: number | undefined): StatusPresentation {
	switch (status) {
		case "pending":
			return { label: "pending", icon: "○", color: "muted" };
		case "queued":
			return { label: "queued", icon: "○", color: "muted" };
		case "running":
			return { label: "running", icon: spinner(spinnerFrame), color: "warning" };
		case "detached":
			return { label: "detached", icon: "↗", color: "warning" };
		case "complete":
			return { label: "done", icon: "✓", color: "success" };
		case "error":
			return { label: "error", icon: "✗", color: "error" };
		case "cancelled":
			return { label: "cancelled", icon: "×", color: "error" };
		default:
			return assertNever(status);
	}
}

// A running cell only receives updates on output/status events, so a stored duration
// freezes between them. Non-terminal cells therefore derive elapsed time from the
// render-time clock; terminal cells keep their settled duration verbatim.
export function cellElapsedMs(cell: EvalCellResult, environment: RenderEnvironment): number | undefined {
	if (!isLiveCellStatus(cell.status) || cell.startedAt === undefined) return cell.durationMs;
	return Math.max(0, environment.now - cell.startedAt);
}

// An in-progress row leads with what the cell is doing (senpi#2802). Collapsed, the whole row
// (icon, headline and every badge) always fits one visual line (senpi#2933 review HIGH-1).
// Drop order: reset/timeout, then queued-behind/throughput, then the runtime badge; the
// headline is cut to its floor (never emptied) before elapsed is dropped, and only the final
// pass may drop the base label itself (review MEDIUM-2/3).
export function headlined(
	icon: string,
	summary: string | undefined,
	code: string | undefined,
	rest: string,
	environment: RenderEnvironment,
	options: { readonly badgelessRest?: string; readonly protectedTail?: string } = {},
): string {
	if (environment.expanded)
		return `${icon} ${liveHeadline(summary, code, undefined)} · ${rest}${
			options.protectedTail === undefined ? "" : ` · ${options.protectedTail}`
		}`;
	const headline = liveHeadline(summary, code, undefined);
	const width = Math.max(1, environment.width - 3);
	// When a badge rides the base label and the full rest cannot fit on one line, the badge
	// drops before anything else is cut, and the badge-less form is fitted instead (review
	// MEDIUM-1).
	const fullTail = options.protectedTail === undefined ? rest : `${rest} · ${options.protectedTail}`;
	if (
		options.badgelessRest !== undefined &&
		options.badgelessRest !== rest &&
		visibleWidth(`${icon} ${headline} · ${fullTail}`) > width
	)
		return fitOneLine(icon, headline, options.badgelessRest, width, options.protectedTail);
	return fitOneLine(icon, headline, rest, width, options.protectedTail);
}

const HEADLINE_FLOOR_CELLS = 12;

function fitOneLine(icon: string, headline: string, rest: string, width: number, protectedTail?: string): string {
	const lead = `${icon} `;
	const middle = " · ";
	const tail = protectedTail === undefined ? "" : `${middle}${protectedTail}`;
	const full = `${lead}${headline}${middle}${rest}${tail}`;
	if (visibleWidth(full) <= width) return full;
	// 1) Drop the lowest-priority tail segments (reset/timeout are last in rest), keeping
	//    elapsed appended, until one fits with the full headline.
	let keptRest = rest;
	for (;;) {
		const cut = keptRest.lastIndexOf(middle);
		if (cut <= 0) break;
		const candidate = keptRest.slice(0, cut);
		if (visibleWidth(`${lead}${headline}${middle}${candidate}${tail}`) <= width)
			return `${lead}${headline}${middle}${candidate}${tail}`;
		keptRest = candidate;
	}
	// 2) Cut the headline to its floor before dropping elapsed (review MEDIUM-3).
	const floorBudget = Math.max(4, width - visibleWidth(`${lead}${middle}${keptRest}${tail}`) - 1);
	const floor = Math.max(HEADLINE_FLOOR_CELLS, floorBudget);
	let cutHeadline = headline;
	if (visibleWidth(headline) > floor) {
		const candidate = `${cellPrefixText(headline, floor - 1)}…`;
		if (visibleWidth(`${lead}${candidate}${middle}${keptRest}${tail}`) <= width) cutHeadline = candidate;
	}
	// Step 1 already left only the base label in keptRest, so nothing else can drop before elapsed.
	const finalRest = keptRest;
	if (visibleWidth(`${lead}${cutHeadline}${middle}${finalRest}${tail}`) <= width)
		return `${lead}${cutHeadline}${middle}${finalRest}${tail}`;
	// 3) Drop elapsed, then cut the headline to whatever the base label leaves (review MEDIUM-3).
	if (visibleWidth(`${lead}${cutHeadline}${middle}${finalRest}`) <= width)
		return `${lead}${cutHeadline}${middle}${finalRest}`;
	const budget = Math.max(4, width - visibleWidth(`${lead}${middle}${finalRest}`) - 1);
	const shortened = visibleWidth(cutHeadline) <= budget ? cutHeadline : `${cellPrefixText(cutHeadline, budget - 1)}…`;
	return `${lead}${shortened}${middle}${finalRest}`;
}

function cellPrefixText(text: string, cells: number): string {
	let kept = "";
	let used = 0;
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const width = visibleWidth(segment);
		if (used + width > cells) break;
		kept += segment;
		used += width;
	}
	return kept;
}

export function cellHeader(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string {
	const spinnerFrame =
		environment.spinnerFrame ?? Math.floor((cellElapsedMs(cell, environment) ?? 0) / LIVE_RENDER_TICK_MS);
	const presentation =
		badges.streaming === true
			? { label: "streaming", icon: spinner(spinnerFrame), color: "warning" as const }
			: cellPresentation(cell.status, spinnerFrame);
	const runtimeBadge = cell.runtime === undefined ? "" : ` (${formatRuntimeBadge(cell.language, cell.runtime)})`;
	const base = leadsWithHeadline(cell.status)
		? `eval ${cell.language} ${presentation.label}`
		: `eval ${cell.language} ${presentation.label} ${presentation.icon}`;
	const segments: string[] = [];
	// The runtime badge is droppable like any badge (review MEDIUM-2): it sits after
	// queued-behind/throughput so those drop first. Elapsed is passed separately as the
	// protected tail, so it is dropped only after the headline is cut (review MEDIUM-3).
	if (cell.queuedBehind !== undefined && cell.queuedBehind.length > 0)
		segments.push(`queued behind ${cell.queuedBehind.map(sanitizeTerminalLabel).join(", ")}`);
	else if (cell.queuedBehind !== undefined && cell.status === "queued")
		segments.push(`waiting for the ${cell.language} kernel to be ready`);
	const throughputBadge = badges.throughput === undefined ? undefined : formatThroughputBadge(badges.throughput);
	if (throughputBadge !== undefined) segments.push(throughputBadge);
	if (runtimeBadge !== "") segments.push(runtimeBadge.trimStart());
	if (badges.reset) segments.push("reset");
	if (badges.timeout !== undefined) segments.push(`timeout ${badges.timeout}s`);
	const elapsedMs = badges.throughput?.wallDurationMs ?? cellElapsedMs(cell, environment);
	const protectedTail = elapsedMs === undefined ? undefined : formatDuration(elapsedMs);
	const header = leadsWithHeadline(cell.status)
		? headlined(presentation.icon, cell.summary, cell.code, joinSegments(base, segments), environment, {
				protectedTail,
			})
		: joinSegments(base, protectedTail === undefined ? segments : [...segments, protectedTail]);
	return style(environment.theme, presentation.color, header);
}

function joinSegments(base: string, segments: readonly string[]): string {
	return segments.length === 0 ? base : `${base} · ${segments.join(" · ")}`;
}

// A live row is a framed block of constant total height: header + LIVE_BODY_ROWS body rows +
// border, whether or not output or status events have arrived. New code lines scroll the code
// window upward inside its share; the hidden prefix folds into one "N earlier code lines" row
// counted inside the share, so the block never grows the transcript.
export function renderLiveCellFrame(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	badges: CellBadges,
): string[] {
	const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, FRAME_HEADER_PREFIX);
	const hasOutput = cell.output.trimEnd().length > 0;
	const hasStatus = (cell.statusEvents ?? []).some((event) => event.op !== "agent");
	// The tail always keeps its full row count (review HIGH-C): a short section is padded, and
	// each section fits itself inside the budget in visual rows with exact omission markers.
	const tail: string[] = [];
	if (hasOutput) appendLines(tail, cellOutputSection(cell, environment, LIVE_TAIL_ROWS, LIVE_TAIL_ROWS));
	else if (hasStatus) appendLines(tail, cellStatusSection(cell, environment, LIVE_TAIL_ROWS));
	const codeRows = tail.length === 0 ? LIVE_BODY_ROWS : LIVE_BODY_ROWS - LIVE_TAIL_ROWS;
	appendLines(lines, liveCodeWindow(cell, environment, codeRows));
	appendLines(lines, tail);
	lines.push(style(environment.theme, "borderMuted", "╰─"));
	return lines;
}

function liveCodeWindow(cell: EvalCellResult, environment: RenderEnvironment, windowRows: number): string[] {
	const innerWidth = Math.max(1, environment.width - 2);
	// Streamed code is not yet trusted input: a hostile or half-arrived chunk can carry escape and
	// control characters, and the collapsed row must stay inert in the terminal (senpi#2839).
	const code = highlightedCode(sanitizeCellCode(cell.code), cell.language, environment.theme, environment.repaint);
	// Fill from the bottom by VISUAL rows so the newest source line is always fully visible
	// (review HIGH-B); the marker counts hidden SOURCE lines. When the source overflows, the
	// marker takes one of the window's rows.
	const allRows = visualLines(code, innerWidth);
	const totalRows = allRows.length;
	const fits = totalRows <= windowRows;
	const budget = fits ? windowRows : windowRows - 1;
	const kept = allRows.slice(Math.max(0, totalRows - budget));
	const skippedVisual = totalRows - kept.length;
	const hiddenSourceLines = countHiddenSourceLines(code, innerWidth, skippedVisual);
	const windowLines: string[] = [];
	if (!fits)
		appendLines(
			windowLines,
			renderPrefixed(`${hiddenSourceLines} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	for (const line of kept) appendLines(windowLines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	while (windowLines.length < windowRows) windowLines.push(style(environment.theme, "borderMuted", "│ "));
	return windowLines;
}

// The source lines whose first visual row lies above the first shown row (review HIGH-B):
// walk the code's own lines, wrap each, and count a line as hidden as soon as the cut reaches
// its first row — a line the cut slices through is hidden even though its tail still shows.
function countHiddenSourceLines(code: string, innerWidth: number, skippedVisual: number): number {
	if (skippedVisual <= 0) return 0;
	let consumed = 0;
	let hidden = 0;
	for (const sourceLine of code.split("\n")) {
		if (consumed >= skippedVisual) break;
		hidden += 1;
		consumed += Math.max(1, visualLines(sourceLine, innerWidth).length);
	}
	return hidden;
}

const TERMINAL_ESCAPE_SEQUENCE =
	/(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const TERMINAL_CONTROL_RUN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g;

// The window strips escape sequences and control characters (senpi#2839) but never collapses
// whitespace: indentation and inner spacing carry meaning in every language (review HIGH-A),
// and tabs expand to two spaces.
function visualLines(text: string, width: number): string[] {
	return truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines.map((line) => line.trimEnd());
}

function sanitizeCellCode(code: string): string {
	return code
		.split("\n")
		.map((line) => line.replace(TERMINAL_ESCAPE_SEQUENCE, "").replace(TERMINAL_CONTROL_RUN, "").replace(/\t/g, "  "))
		.join("\n");
}

export { FRAME_HEADER_PREFIX, FRAME_INNER_PREFIX, FRAME_SECTION_PREFIX };
