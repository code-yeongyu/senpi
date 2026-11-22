export interface SourceRange {
	readonly start: number;
	readonly end: number;
}

interface SourceSpan {
	readonly offset: number;
	readonly length: number;
	/** null marks visible output whose original source cannot be recovered. */
	readonly source: SourceRange | null;
	/** Linear spans map UTF-16 units one-to-one; other spans repeat one source interval. */
	readonly linear: boolean;
}

/** Display-only padding occupies length but has no span. */
export interface SourceRanges {
	readonly length: number;
	readonly spans: readonly SourceSpan[];
}

export const emptyRanges: SourceRanges = { length: 0, spans: [] };

/** Most token slices are contiguous; retain two numbers instead of a span object graph. */
class LinearRanges implements SourceRanges {
	readonly start: number;
	readonly length: number;

	constructor(start: number, length: number) {
		this.start = start;
		this.length = length;
	}

	get spans(): readonly SourceSpan[] {
		return [
			{
				offset: 0,
				length: this.length,
				source: { start: this.start, end: this.start + this.length },
				linear: true,
			},
		];
	}
}

export function linearRanges(start: number, length: number): SourceRanges {
	return length ? new LinearRanges(start, length) : emptyRanges;
}

export function repeatedRange(source: SourceRange | null | undefined, length: number): SourceRanges {
	return length
		? { length, spans: source === undefined ? [] : [{ offset: 0, length, source, linear: false }] }
		: emptyRanges;
}

function firstSpan(ranges: SourceRanges, offset: number): number {
	let low = 0;
	let high = ranges.spans.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const span = ranges.spans[middle];
		if (span.offset + span.length <= offset) low = middle + 1;
		else high = middle;
	}
	return low;
}

export function rangeAt(ranges: SourceRanges, offset: number): SourceRange | null | undefined {
	if (ranges instanceof LinearRanges) {
		if (offset < 0 || offset >= ranges.length) return undefined;
		const start = ranges.start + offset;
		return { start, end: start + 1 };
	}
	const span = ranges.spans[firstSpan(ranges, offset)];
	if (!span || offset < span.offset) return undefined;
	if (!span.linear || !span.source) return span.source;
	const start = span.source.start + offset - span.offset;
	return { start, end: start + 1 };
}

export function sliceRanges(ranges: SourceRanges, from: number, to = ranges.length): SourceRanges {
	const start = Math.max(0, Math.min(ranges.length, from < 0 ? ranges.length + from : from));
	const end = Math.max(start, Math.min(ranges.length, to < 0 ? ranges.length + to : to));
	if (start === 0 && end === ranges.length) return ranges;
	if (ranges instanceof LinearRanges) return linearRanges(ranges.start + start, end - start);
	const spans: SourceSpan[] = [];
	for (let index = firstSpan(ranges, start); index < ranges.spans.length; index++) {
		const span = ranges.spans[index];
		if (span.offset >= end) break;
		const left = Math.max(start, span.offset);
		const right = Math.min(end, span.offset + span.length);
		spans.push({
			offset: left - start,
			length: right - left,
			source:
				span.linear && span.source
					? {
							start: span.source.start + left - span.offset,
							end: span.source.start + right - span.offset,
						}
					: span.source,
			linear: span.linear,
		});
	}
	return compactRanges(end - start, spans);
}

export function concatRanges(parts: readonly SourceRanges[]): SourceRanges {
	if (parts.length === 1) return parts[0];
	const spans: SourceSpan[] = [];
	let length = 0;
	for (const part of parts) {
		for (const span of part.spans) {
			const offset = length + span.offset;
			const previous = spans.at(-1);
			if (
				previous &&
				previous.offset + previous.length === offset &&
				previous.linear === span.linear &&
				(previous.linear
					? previous.source && span.source && previous.source.end === span.source.start
					: previous.source?.start === span.source?.start && previous.source?.end === span.source?.end)
			) {
				spans[spans.length - 1] = {
					...previous,
					length: previous.length + span.length,
					source:
						previous.linear && previous.source && span.source
							? { start: previous.source.start, end: span.source.end }
							: previous.source,
				};
			} else {
				spans.push(length ? { ...span, offset } : span);
			}
		}
		length += part.length;
	}
	return compactRanges(length, spans);
}

function compactRanges(length: number, spans: readonly SourceSpan[]): SourceRanges {
	if (!length) return emptyRanges;
	const span = spans[0];
	return spans.length === 1 && span.offset === 0 && span.length === length && span.linear && span.source
		? linearRanges(span.source.start, length)
		: { length, spans };
}
