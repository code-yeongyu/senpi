import { getGraphemeSegmenter, stripTerminalSequences, visibleWidth } from "./utils.ts";
import {
	concatRanges,
	emptyRanges,
	repeatedRange,
	sliceRanges,
	type SourceRange,
	type SourceRanges,
} from "./source-ranges.ts";
export type { SourceRange } from "./source-ranges.ts";

export interface SourceDocument {
	readonly text: string;
	readonly enclosures: Array<SourceRange & { readonly content: SourceRange }>;
	readonly resolveLines?: () => readonly (SourceLine | null | undefined)[] | undefined;
}

export interface SourceLine {
	readonly document: SourceDocument;
	readonly ranges: SourceRanges;
	readonly sourceRow?: number;
	readonly columnOffset?: number;
	readonly unavailable?: boolean;
}

// Undefined rows retain rendered plain text; null rows are known layout padding.
const sources = new WeakMap<readonly string[], (SourceLine | null | undefined)[]>();

export function setLineSources(lines: readonly string[], mapping: readonly (SourceLine | null | undefined)[]): void {
	sources.set(lines, [...mapping]);
}

export function setLineSource(lines: readonly string[], row: number, source: SourceLine | null): void {
	const mapping = sources.get(lines) ?? [];
	mapping[row] = source;
	sources.set(lines, mapping);
}

export function getLineSources(lines: readonly string[]): readonly (SourceLine | null | undefined)[] | undefined {
	return sources.get(lines);
}

/**
 * Preserve provenance when a component copies, pads, or decorates an existing rendered array.
 * columnOffset is the number of inserted ASCII padding spaces, not the width of arbitrary text.
 * Populate unpublished arrays only; retained frames must keep their original provenance.
 */
export function copyLineSources(from: readonly string[], to: string[], rowOffset = 0, columnOffset = 0): string[] {
	const mapping = sources.get(from);
	if (mapping) {
		const result = sources.get(to) ?? [];
		for (let row = 0; row < mapping.length && row + rowOffset < to.length; row++) {
			const line = mapping[row];
			result[row + rowOffset] =
				line && columnOffset
					? line.sourceRow === undefined
						? { ...line, ranges: concatRanges([repeatedRange(undefined, columnOffset), line.ranges]) }
						: { ...line, columnOffset: (line.columnOffset ?? 0) + columnOffset }
					: line;
		}
		sources.set(to, result);
	}
	return to;
}

type SourceSelection = { readonly text: string } | { readonly unavailable: true };

/**
 * Resolve the exact source interval of each selected Markdown document. Enclosures are included
 * only when their complete visible contents were selected; an interior selection remains interior.
 */
export function resolveSourceSelection(
	lines: readonly string[],
	rows: readonly { readonly row: number; readonly start: number; readonly end: number }[],
): SourceSelection | undefined {
	const mapping = sources.get(lines);
	if (!mapping) return undefined;
	const resolvedDocuments = new Map<
		SourceDocument,
		{ lines: readonly (SourceLine | null | undefined)[] | undefined; document: SourceDocument }
	>();
	for (const selection of rows) {
		const document = mapping[selection.row]?.document;
		if (!document?.resolveLines || resolvedDocuments.has(document)) continue;
		const resolved = document.resolveLines();
		resolvedDocuments.set(document, {
			lines: resolved,
			document: { ...(resolved?.find((line) => line)?.document ?? document) },
		});
	}
	const resolveLine = (line: SourceLine | null | undefined): SourceLine | undefined => {
		if (!line) return undefined;
		if (line.sourceRow === undefined) return line;
		const resolved = resolvedDocuments.get(line.document);
		if (!resolved) return undefined;
		if (!resolved.lines) return { document: resolved.document, ranges: emptyRanges, unavailable: true };
		const original = resolved.lines[line.sourceRow];
		if (!original) return undefined;
		return {
			...original,
			document: resolved.document,
			ranges: line.columnOffset
				? concatRanges([repeatedRange(undefined, line.columnOffset), original.ranges])
				: original.ranges,
		};
	};
	const documentLines = new Map<SourceDocument, SourceLine[]>();
	for (const source of mapping) {
		const line = resolveLine(source);
		if (!line) continue;
		const group = documentLines.get(line.document);
		if (group) group.push(line);
		else documentLines.set(line.document, [line]);
	}
	const pieces: string[] = [];
	let active: { document: SourceDocument; start: number; end: number; selected: SourceRange[] } | undefined;
	let usedSource = false;
	let unavailable = false;
	const flush = () => {
		if (!active) return;
		let { start, end } = active;
		const covered: Array<{ start: number; end: number }> = [];
		for (const range of active.selected.sort((left, right) => left.start - right.start)) {
			const previous = covered.at(-1);
			if (previous && previous.end >= range.start) previous.end = Math.max(previous.end, range.end);
			else covered.push({ ...range });
		}
		// A wrapped table can visit source cells out of order. Never fill an unselected hole.
		for (const line of documentLines.get(active.document) ?? []) {
			for (const span of line.ranges.spans) {
				const range = span.source;
				if (!range) continue;
				const left = span.linear ? Math.max(start, range.start) : range.start;
				const right = span.linear ? Math.min(end, range.end) : range.end;
				if (left < start || right > end || left >= right) continue;
				let low = 0;
				let high = covered.length;
				while (low < high) {
					const middle = (low + high) >>> 1;
					if (covered[middle].start <= left) low = middle + 1;
					else high = middle;
				}
				if (low === 0 || covered[low - 1].end < right) unavailable = true;
			}
		}
		// Inner enclosures can make an outer enclosure complete.
		for (const enclosure of active.document.enclosures) {
			if (start <= enclosure.content.start && end >= enclosure.content.end) {
				start = Math.min(start, enclosure.start);
				end = Math.max(end, enclosure.end);
			}
		}
		pieces.push(active.document.text.slice(start, end));
		active = undefined;
	};
	for (const selection of rows) {
		const source = mapping[selection.row];
		if (source === null) continue;
		const line = resolveLine(source);
		const text = stripTerminalSequences(lines[selection.row] ?? "");
		if (!line) {
			// Source-owned blank rows are represented by the source interval.
			// Unmapped plain-text rows must retain their hard blank lines.
			if (source && !text.trim()) continue;
			flush();
			let column = 0;
			let selected = "";
			for (const { segment } of getGraphemeSegmenter().segment(text)) {
				const width = visibleWidth(segment);
				if (column < selection.end && column + width > selection.start) selected += segment;
				column += width;
			}
			pieces.push(selected.trimEnd());
			continue;
		}
		usedSource = true;
		if (active && active.document !== line.document) flush();
		let column = 0;
		let unitStart = text.length;
		let unitEnd = 0;
		for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
			const width = visibleWidth(segment);
			if (column < selection.end && column + width > selection.start) {
				if (line.unavailable && segment.trim()) return { unavailable: true };
				unitStart = Math.min(unitStart, index);
				unitEnd = index + segment.length;
			}
			column += width;
		}
		for (const span of sliceRanges(line.ranges, unitStart, unitEnd).spans) {
			const range = span.source;
			if (range === null) return { unavailable: true };
			if (!active) active = { document: line.document, ...range, selected: [] };
			else {
				active.start = Math.min(active.start, range.start);
				active.end = Math.max(active.end, range.end);
			}
			active.selected.push(range);
		}
	}
	flush();
	return unavailable ? { unavailable: true } : usedSource ? { text: pieces.join("\n") } : undefined;
}
