/**
 * Per-source line statistics: what the fallback view shows and the samples the author reads.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { type TimedCount, trimWindow } from "./field-state.ts";
import { truncateText } from "./format.ts";
import type { JobWidgetSampleLines } from "./source-types.ts";

const SAMPLE_HEAD_LINES = 30;
const SAMPLE_TAIL_LINES = 60;
export const MAX_STAGE_CHARS = 200;

export interface SourceStats {
	id: string;
	label: string;
	size: number;
	lines: number;
	head: string[];
	tail: string[];
	lastLine?: string;
	lastActiveAt: number;
	recent: TimedCount[];
}

/** What the author reads about one source. */
export interface JobWidgetSourceSample {
	id: string;
	label: string;
	/** Text read so far, in the source's own unit. */
	size: number;
	/** Non-empty lines read so far. */
	lines: number;
	/** First and last non-empty lines (no overlap), oldest first. */
	head: string[];
	tail: string[];
}

export function newSourceStats(id: string, label: string): SourceStats {
	return { id, label, size: 0, lines: 0, head: [], tail: [], lastActiveAt: 0, recent: [] };
}

/** Folds a refresh's lines into `stats`; returns whether any was non-empty. */
export function recordLines(stats: SourceStats, lines: readonly string[], t: number): boolean {
	let fresh = 0;
	// Lines before `tailFrom` filled the head; the tail only needs the newest non-empty ones.
	let tailFrom = 0;
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].trim().length === 0) continue;
		fresh += 1;
		if (stats.head.length < SAMPLE_HEAD_LINES) {
			stats.head.push(lines[index]);
			tailFrom = index + 1;
		}
	}
	if (fresh === 0) return false;
	const newest: string[] = [];
	for (let index = lines.length - 1; index >= tailFrom && newest.length < SAMPLE_TAIL_LINES; index--) {
		if (lines[index].trim().length > 0) newest.push(lines[index]);
	}
	if (newest.length > 0) {
		stats.lastLine = newest[0];
		newest.reverse();
		stats.tail = [...stats.tail, ...newest].slice(-SAMPLE_TAIL_LINES);
	} else {
		stats.lastLine = stats.head.at(-1);
	}
	stats.lines += fresh;
	stats.lastActiveAt = t;
	stats.recent.push({ t, n: fresh });
	trimWindow(stats.recent, t);
	return true;
}

/** Last non-empty line of the most recently active source, a pipe preferred over the job's own output. */
export function latestLine(all: Iterable<SourceStats>): string | undefined {
	let best: SourceStats | undefined;
	let bestIsPipe = false;
	for (const stats of all) {
		if (!stats.lastLine) continue;
		const isPipe = /(?:^|:)pipe:/.test(stats.id);
		if (!best || (isPipe && !bestIsPipe) || (isPipe === bestIsPipe && stats.lastActiveAt >= best.lastActiveAt)) {
			best = stats;
			bestIsPipe = isPipe;
		}
	}
	return best?.lastLine ? truncateText(best.lastLine.trim(), MAX_STAGE_CHARS) : undefined;
}

export function sourceSample(stats: SourceStats): JobWidgetSourceSample {
	return {
		id: stats.id,
		label: stats.label,
		size: stats.size,
		lines: stats.lines,
		head: stats.head.slice(),
		tail: stats.tail.slice(),
	};
}

/** Samples as plain line lists for the validation dry run. */
export function sampleLines(samples: readonly JobWidgetSourceSample[]): JobWidgetSampleLines[] {
	return samples.map((sample) => ({ id: sample.id, lines: [...sample.head, ...sample.tail] }));
}
