import { isReadSummaryPath } from "./read-folders/index.ts";
import {
	READ_FOLD_SETTINGS,
	type ReadFolder,
	type ReadFolderResult,
	type ReadFoldRange,
	type ReadLineRange,
} from "./read-folders/types.ts";

export type ReadSegment =
	| (ReadLineRange & { readonly kind: "kept"; readonly text: string })
	| (ReadLineRange & { readonly kind: "elided" });
export type RenderedReadView = {
	readonly text: string;
	readonly elidedRanges: readonly ReadLineRange[];
	readonly footer: {
		readonly text: string;
		readonly rereads: readonly { readonly offset: number; readonly limit: number }[];
	};
};
export type ReadSummaryFallback =
	| "unsupported_language"
	| "prose_exempt"
	| "parse_failure"
	| "stale_source"
	| "invalid_ranges"
	| "too_short"
	| "no_elision"
	| "skeleton_exceeds_budget"
	| "visible_budget_unreachable"
	| "no_output_saving";
export type SegmentedReadView =
	| {
			readonly status: "summary";
			readonly segments: readonly ReadSegment[];
			readonly visibleSourceLines: number;
			readonly rendered: RenderedReadView;
	  }
	| { readonly status: "no_summary"; readonly reason: ReadSummaryFallback };

/** Compose only untruncated default text reads; each reader owns its existing raw path. */
export function createDefaultReadSummary(input: {
	readonly path: string;
	readonly text: string;
	readonly offset?: number;
	readonly limit?: number;
	readonly folder?: ReadFolder;
	readonly truncated: boolean;
}): RenderedReadView | undefined {
	const { path, text, offset, limit, folder, truncated } = input;
	if (!folder || offset !== undefined || limit !== undefined || truncated || !isReadSummaryPath(path))
		return undefined;
	if (text.includes("\0") || text.split("\n").length < READ_FOLD_SETTINGS.minTotalLines) return undefined;
	const view = createSegmentedReadView({ text, parsed: folder.fold({ path, text, settings: READ_FOLD_SETTINGS }) });
	switch (view.status) {
		case "summary":
			return view.rendered;
		case "no_summary":
			return undefined;
		default:
			return view satisfies never;
	}
}

export class InvalidReadSegmentsError extends Error {
	readonly code = "invalid_segments";
	constructor() {
		super("Read segments must cover the source exactly, in order, without altering kept lines");
	}
}

function validRange(range: ReadLineRange, total: number): boolean {
	return (
		Number.isSafeInteger(range.startLine) &&
		Number.isSafeInteger(range.endLine) &&
		range.startLine >= 1 &&
		range.endLine >= range.startLine &&
		range.endLine <= total
	);
}

/** The sole validator/renderer/footer implementation. Synthetic lines are never source slices. */
export function renderSegmentedReadView({
	text,
	segments,
}: {
	readonly text: string;
	readonly segments: readonly ReadSegment[];
}): RenderedReadView {
	const lines = text.split("\n");
	const parts: string[] = [];
	const elidedRanges: ReadLineRange[] = [];
	let cursor = 1;
	for (const segment of segments) {
		if (!validRange(segment, lines.length) || segment.startLine !== cursor) throw new InvalidReadSegmentsError();
		switch (segment.kind) {
			case "kept":
				if (segment.text !== lines.slice(segment.startLine - 1, segment.endLine).join("\n"))
					throw new InvalidReadSegmentsError();
				parts.push(segment.text);
				break;
			case "elided":
				parts.push("…");
				elidedRanges.push({ startLine: segment.startLine, endLine: segment.endLine });
				break;
			default:
				segment satisfies never;
				throw new InvalidReadSegmentsError();
		}
		cursor = segment.endLine + 1;
	}
	if (cursor !== lines.length + 1) throw new InvalidReadSegmentsError();
	const rereads = elidedRanges.map((range) => ({
		offset: range.startLine,
		limit: range.endLine - range.startLine + 1,
	}));
	const footerText = rereads.length
		? `[Elided source: ${rereads.map((r) => `offset=${r.offset} limit=${r.limit}`).join("; ")}. Reread source before editing; markers are not source.]`
		: "";
	if (footerText) parts.push("", footerText);
	return { text: parts.join("\n"), elidedRanges, footer: { text: footerText, rereads } };
}

function validHierarchy(ranges: readonly ReadFoldRange[], total: number): boolean {
	const queue = [{ ranges, startLine: 0, endLine: total + 1 }];
	for (let i = 0; i < queue.length; i++) {
		const parent = queue[i];
		let previous = parent.startLine;
		for (const range of parent.ranges) {
			if (!validRange(range, total) || range.startLine <= previous || range.endLine >= parent.endLine) return false;
			previous = range.endLine;
			queue.push({ ranges: range.children, startLine: range.startLine, endLine: range.endLine });
		}
	}
	return true;
}

const lengthOf = (range: ReadLineRange) => range.endLine - range.startLine + 1;

/** Breadth-first refinement counts only retained source lines, never sentinels/footer lines. */
export function createSegmentedReadView({
	text,
	parsed,
}: {
	readonly text: string;
	readonly parsed: ReadFolderResult;
}): SegmentedReadView {
	const raw = (reason: ReadSummaryFallback): SegmentedReadView => ({ status: "no_summary", reason });
	switch (parsed.status) {
		case "unsupported":
			return raw(parsed.reason);
		case "parse_failure":
			return raw("parse_failure");
		case "parsed":
			break;
		default:
			return parsed satisfies never;
	}
	if (parsed.text !== text) return raw("stale_source");
	const lines = text.split("\n");
	if (!validHierarchy(parsed.ranges, lines.length)) return raw("invalid_ranges");
	if (lines.length < READ_FOLD_SETTINGS.minTotalLines) return raw("too_short");
	if (!parsed.ranges.length) return raw("no_elision");
	let visible = lines.length - parsed.ranges.reduce((sum, r) => sum + lengthOf(r), 0);
	if (visible > READ_FOLD_SETTINGS.unfoldLimit) return raw("skeleton_exceeds_budget");
	const selected = new Set(parsed.ranges);
	const queue = [...parsed.ranges];
	for (let i = 0; visible < READ_FOLD_SETTINGS.unfoldUntil && i < queue.length; i++) {
		const parent = queue[i];
		const nextVisible = visible + lengthOf(parent) - parent.children.reduce((sum, r) => sum + lengthOf(r), 0);
		// Later steps only increase visibility, so an oversized step cannot become safe later.
		if (nextVisible > READ_FOLD_SETTINGS.unfoldLimit) continue;
		selected.delete(parent);
		for (const child of parent.children) selected.add(child);
		queue.push(...parent.children);
		visible = nextVisible;
	}
	if (visible < READ_FOLD_SETTINGS.unfoldUntil) return raw("visible_budget_unreachable");
	if (!selected.size) return raw("no_elision");
	const segments: ReadSegment[] = [];
	let cursor = 1;
	for (const range of [...selected].sort((a, b) => a.startLine - b.startLine)) {
		if (cursor < range.startLine)
			segments.push({
				kind: "kept",
				startLine: cursor,
				endLine: range.startLine - 1,
				text: lines.slice(cursor - 1, range.startLine - 1).join("\n"),
			});
		segments.push({ kind: "elided", startLine: range.startLine, endLine: range.endLine });
		cursor = range.endLine + 1;
	}
	if (cursor <= lines.length)
		segments.push({
			kind: "kept",
			startLine: cursor,
			endLine: lines.length,
			text: lines.slice(cursor - 1).join("\n"),
		});
	const rendered = renderSegmentedReadView({ text, segments });
	const encoder = new TextEncoder();
	if (encoder.encode(rendered.text).length >= encoder.encode(text).length) return raw("no_output_saving");
	return { status: "summary", segments, visibleSourceLines: visible, rendered };
}
