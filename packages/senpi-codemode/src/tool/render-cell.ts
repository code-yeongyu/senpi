import { highlightedCode } from "./code-preview.ts";
import { leadsWithHeadline } from "./live-headline.ts";
import { renderAgentProgressEvents } from "./render-agent.ts";
import {
	appendLines,
	assertNever,
	CODE_PREVIEW_LINES,
	OUTPUT_PREVIEW_LINES,
	previewText,
	type RenderBlock,
	type RenderEnvironment,
	renderAllVisualLines,
	renderPrefixed,
	SUMMARY_PREVIEW_LINES,
	style,
} from "./render-blocks.ts";
import {
	type CellBadges,
	cellElapsedMs,
	cellHeader,
	cellPresentation,
	FRAME_HEADER_PREFIX,
	FRAME_INNER_PREFIX,
	headlined,
	LIVE_LINE_PREFIX,
	renderLiveCellFrame,
} from "./render-live.ts";
import { formatThroughputBadge } from "./render-status.ts";
import { cellOutputSection, cellStatusSection } from "./render-tail.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalCellResult } from "./types.ts";

export type { CellBadges } from "./render-live.ts";
export { LIVE_CODE_WINDOW_LINES } from "./render-live.ts";

// A summary has no length limit, so a collapsed block shows its first lines and marks the cut.
function summaryVisualLines(summary: string, width: number, expanded: boolean): string[] {
	const lines = renderAllVisualLines(summary, width);
	if (expanded || lines.length <= SUMMARY_PREVIEW_LINES) return lines;
	const kept = renderAllVisualLines(summary, Math.max(1, width - 1)).slice(0, SUMMARY_PREVIEW_LINES);
	kept[SUMMARY_PREVIEW_LINES - 1] = `${kept[SUMMARY_PREVIEW_LINES - 1] ?? ""}…`;
	return kept;
}

export function summaryBlock(summary: string, theme: RenderEnvironment["theme"], expanded: boolean): RenderBlock {
	return {
		kind: "dynamic",
		render: (width) => summaryVisualLines(summary, width, expanded).map((line) => style(theme, "muted", line)),
	};
}

export function renderCell(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string[] {
	const agentEvents = (cell.statusEvents ?? []).filter((event) => event.op === "agent");
	const lines = renderCellFrame(cell, environment, badges);
	if (agentEvents.length > 0) appendLines(lines, renderAgentProgressEvents(agentEvents, environment));
	return lines;
}

function renderCellFrame(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string[] {
	switch (cell.status) {
		case "pending":
		case "queued":
		case "running":
			return environment.expanded
				? renderExpandedCellFrame(cell, environment, badges)
				: renderLiveCellFrame(cell, environment, badges);
		case "complete":
		case "error":
		case "cancelled":
			return environment.expanded
				? renderExpandedCellFrame(cell, environment, badges)
				: renderTerminalCellLine(cell, environment, badges);
		case "detached":
			return environment.expanded
				? renderExpandedCellFrame(cell, environment, badges)
				: renderDetachedCellFrame(cell, environment, badges);
		default:
			return assertNever(cell.status);
	}
}

// A terminal row collapses to one line: icon, the cell's headline (summary or first code line),
// status and duration. The full frame stays reachable through the expand action.
function renderTerminalCellLine(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string[] {
	const presentation = cellPresentation(cell.status, environment.spinnerFrame);
	const runtimeBadge = cell.runtime === undefined ? "" : ` (${formatRuntimeBadge(cell.language, cell.runtime)})`;
	// The runtime badge rides the base label when it fits (review MEDIUM-1); when it would wrap
	// the row it drops like any badge, so the done row stays one line at any width.
	const segments: string[] = [];
	if (badges.throughput !== undefined) {
		const badge = formatThroughputBadge(badges.throughput);
		if (badge !== undefined) segments.push(badge);
	}
	const elapsedMs = badges.throughput?.wallDurationMs ?? cellElapsedMs(cell, environment);
	if (elapsedMs !== undefined) segments.push(formatDuration(elapsedMs));
	if (badges.reset) segments.push("reset");
	if (badges.timeout !== undefined) segments.push(`timeout ${badges.timeout}s`);
	const tail = segments.length === 0 ? "" : ` · ${segments.join(" · ")}`;
	const rest = `eval ${cell.language}${runtimeBadge} ${presentation.label}${tail}`;
	const badgelessRest = runtimeBadge === "" ? rest : `eval ${cell.language} ${presentation.label}${tail}`;
	const line = style(
		environment.theme,
		presentation.color,
		headlined(presentation.icon, cell.summary, cell.code, rest, environment, { badgelessRest }),
	);
	return renderPrefixed(line, environment, LIVE_LINE_PREFIX);
}

// A detached row keeps its collapsed frame: the cell is no longer live, but its output and status
// history are the reason it is inspected, so they stay visible without expand.
function renderDetachedCellFrame(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string[] {
	if (cell.output.trim().length === 0) {
		const statusEvents = (cell.statusEvents ?? []).filter((event) => event.op !== "agent");
		if (statusEvents.length === 0)
			return renderPrefixed(cellHeader(cell, environment, badges), environment, LIVE_LINE_PREFIX);
	}
	return renderExpandedCellFrame(cell, environment, badges, { collapsedPreviews: true });
}

function renderExpandedCellFrame(
	cell: EvalCellResult,
	environment: RenderEnvironment,
	badges: CellBadges,
	options: { readonly collapsedPreviews?: boolean } = {},
): string[] {
	const previewsCollapsed = options.collapsedPreviews === true && !environment.expanded;
	const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, FRAME_HEADER_PREFIX);
	if (cell.summary !== undefined && !leadsWithHeadline(cell.status)) {
		appendLines(
			lines,
			summaryVisualLines(cell.summary, Math.max(1, environment.width - 2), environment.expanded).map(
				(line) => `${style(environment.theme, "muted", "│ ")}${style(environment.theme, "muted", line)}`,
			),
		);
	}
	const innerWidth = Math.max(1, environment.width - 2);
	const codePreview = previewText(
		highlightedCodeForFrame(cell, environment),
		previewsCollapsed ? CODE_PREVIEW_LINES : Number.POSITIVE_INFINITY,
		innerWidth,
	);
	if (codePreview.skipped > 0) {
		appendLines(
			lines,
			renderPrefixed(`${codePreview.skipped} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	}
	for (const line of codePreview.lines) appendLines(lines, renderPrefixed(line, environment, FRAME_INNER_PREFIX));
	appendLines(
		lines,
		cellOutputSection(cell, environment, previewsCollapsed ? OUTPUT_PREVIEW_LINES : Number.POSITIVE_INFINITY),
	);
	appendLines(lines, cellStatusSection(cell, environment));
	lines.push(style(environment.theme, "borderMuted", "╰─"));
	return lines;
}

function highlightedCodeForFrame(cell: EvalCellResult, environment: RenderEnvironment): string {
	return highlightedCode(cell.code, cell.language, environment.theme, environment.repaint);
}
