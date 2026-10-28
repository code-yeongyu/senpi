/**
 * The output sample a spec request carries: per source the first and the newest lines, cut and
 * budgeted so a busy job cannot blow up the request. Input text is already redacted
 * (`author-redact.ts`), so every byte counted here is a byte the author may see.
 * Ported from oh-my-pi 9df0457b31 `job-widgets/author.ts` (MIT, Copyright Can Boluk et al.).
 */
import { formatSize } from "../../../tools/truncate.ts";
import { truncateText } from "./format.ts";
import type { JobWidgetSourceSample } from "./source-stats.ts";

const MAX_SAMPLE_LINE_CHARS = 300;
export const MAX_SAMPLE_BYTES = 12 * 1024;
/** Lines of one shape (same text but for its digits and spacing) the head, and the tail, of a source keep. */
const MAX_SHAPE_REPEATS = 3;

export interface JobWidgetPromptSource {
	readonly id: string;
	readonly label: string;
	readonly size: string;
	readonly lines: number;
	/** Lines read but not shown: the middle, and repeats that differ only in numbers. */
	readonly omitted: number;
	readonly head: readonly string[];
	readonly tail: readonly string[];
}

interface Taken {
	readonly lines: string[];
	readonly bytes: number;
}

function lineBytes(line: string): number {
	return Buffer.byteLength(line) + 1;
}

function isFenceLine(line: string): boolean {
	const trimmed = line.trimStart();
	return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function lineShape(line: string): string {
	return line.trimStart().replace(/\d+/g, "0").replace(/\s+/g, " ");
}

/**
 * Lines in the order given, each cut at {@link MAX_SAMPLE_LINE_CHARS}, until `limit` bytes. Lines
 * that would open or close the prompt's code fence are left out, and at most
 * {@link MAX_SHAPE_REPEATS} lines of one shape are kept.
 */
function takeLines(lines: readonly string[], limit: number): Taken {
	const out: string[] = [];
	const shapes = new Map<string, number>();
	let bytes = 0;
	for (const line of lines) {
		if (isFenceLine(line)) continue;
		const shape = lineShape(line);
		const repeats = shapes.get(shape) ?? 0;
		if (repeats >= MAX_SHAPE_REPEATS) continue;
		shapes.set(shape, repeats + 1);
		const sample = truncateText(line, MAX_SAMPLE_LINE_CHARS);
		const size = lineBytes(sample);
		if (bytes + size > limit) break;
		bytes += size;
		out.push(sample);
	}
	return { lines: out, bytes };
}

/**
 * Sample lines for the prompt, most active source first, at most {@link MAX_SAMPLE_BYTES} in total
 * with every source getting a fair share of what earlier sources left. Within a share the newest
 * lines come first: they get two thirds (newest backwards, since they show what the job prints
 * now and what drifted), and the first lines get what is left.
 */
export function buildPromptSources(sources: readonly JobWidgetSourceSample[]): JobWidgetPromptSource[] {
	let budget = MAX_SAMPLE_BYTES;
	return sources.map((source, index) => {
		const share = Math.floor(budget / (sources.length - index));
		const tailLimit = source.head.length > 0 ? Math.floor((share * 2) / 3) : share;
		const tail = takeLines(source.tail.slice().reverse(), tailLimit);
		const head = takeLines(source.head, share - tail.bytes);
		budget -= tail.bytes + head.bytes;
		const shown = head.lines.length + tail.lines.length;
		return {
			id: source.id,
			label: source.label,
			size: formatSize(source.size),
			lines: source.lines,
			omitted: Math.max(0, source.lines - shown),
			head: head.lines,
			tail: tail.lines.reverse(),
		};
	});
}
