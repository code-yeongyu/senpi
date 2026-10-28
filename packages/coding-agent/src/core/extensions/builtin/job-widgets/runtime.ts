/**
 * Deterministic derivation of one job's widget under one spec (or none: the pending and fallback
 * views). Each refresh reads every source's new text, matches the rules reading that source with
 * one call, folds the matches into bounded per-field state, and builds a v1 view. No model is
 * involved past the spec. Installing a new spec starts a fresh runtime.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { FieldStore, windowRate } from "./field-state.ts";
import { truncateText } from "./format.ts";
import { type SourceLineRedactor, SourceLineReader } from "./line-reader.ts";
import type { LineMatcher } from "./matcher.ts";
import { applyMatches, compileSourceMatcher, type SourceMatcher } from "./rule-match.ts";
import {
	type JobWidgetSourceSample,
	latestLine,
	MAX_STAGE_CHARS,
	newSourceStats,
	recordLines,
	type SourceStats,
	sourceSample,
} from "./source-stats.ts";
import type { JobTextSource } from "./source-types.ts";
import { keyedFields, pinnedKeys } from "./spec-rules.ts";
import { type JobWidgetSpec, MAX_TITLE_CHARS } from "./spec-types.ts";
import { buildBlock, buildHeadline, hasData } from "./view-build.ts";
import type { JobWidgetEntryState, JobWidgetView } from "./view-types.ts";

/** Newest lines per source matched per refresh; older lines of a burst are counted, not matched. */
export const MAX_MATCH_LINES = 2000;

export interface JobWidgetViewContext {
	label: string;
	/** A task's stage in its own words; the stage line unless a spec rule reads one. */
	stage?: string;
	/** Whether the newest output line may stand for the stage (a command's output, not tool results). */
	lineStage?: boolean;
	/** A spec request is in flight. */
	authoring: boolean;
	/** The job finished; a spec-driven view freezes as `done`. */
	settled?: boolean;
}

export interface JobWidgetDerivation {
	state: Exclude<JobWidgetEntryState, "skipped">;
	view: JobWidgetView;
	updatedAtMs: number;
}

export interface JobWidgetRuntimeOptions {
	spec: JobWidgetSpec | undefined;
	matcher: LineMatcher;
	startTime: number;
	now?: () => number;
	/**
	 * A fresh redactor per source, fed that source's complete lines in order before they are cut,
	 * matched or kept: views cut long text, a cut token no longer looks like one to a redactor, and
	 * a private key spans lines, so redaction is stateful per source and runs before any cut.
	 */
	redactSource?: () => SourceLineRedactor;
}

export class JobWidgetRuntime {
	readonly spec: JobWidgetSpec | undefined;
	readonly #matcher: LineMatcher;
	readonly #startTime: number;
	readonly #now: () => number;
	readonly #redactSource: (() => SourceLineRedactor) | undefined;
	readonly #readers = new Map<string, SourceLineReader>();
	readonly #stats = new Map<string, SourceStats>();
	readonly #matchers = new Map<string, SourceMatcher | null>();
	readonly #store: FieldStore;
	#lastMatchAt: number | undefined;
	#lastLineAt: number | undefined;
	#unmatchedLines = 0;
	/** Newest non-empty line no rule matched: a live widget's stage when the spec names none. */
	#lastUnmatchedLine: string | undefined;

	constructor(options: JobWidgetRuntimeOptions) {
		this.spec = options.spec;
		this.#matcher = options.matcher;
		this.#startTime = options.startTime;
		this.#now = options.now ?? Date.now;
		this.#redactSource = options.redactSource;
		this.#store = new FieldStore(keyedFields(options.spec), pinnedKeys(options.spec));
	}

	/** Non-empty lines seen since the last match on a source some rule reads: the drift signal. */
	get unmatchedLines(): number {
		return this.#unmatchedLines;
	}

	get lastMatchAt(): number | undefined {
		return this.#lastMatchAt;
	}

	/** Non-empty lines read across every source. */
	get totalLines(): number {
		let total = 0;
		for (const stats of this.#stats.values()) total += stats.lines;
		return total;
	}

	/** Non-empty lines per second across every source over the rate window. */
	get linesPerSecond(): number {
		const recent = [...this.#stats.values()].flatMap((stats) => stats.recent);
		return windowRate(recent, this.#now(), this.#startTime);
	}

	/** Reads every source's new text; `flush` ends lines in progress. Returns whether a line arrived. */
	ingest(sources: readonly JobTextSource[], flush: boolean): boolean {
		const t = this.#now();
		let changed = false;
		for (const source of sources) {
			let reader = this.#readers.get(source.id);
			if (!reader || reader.source !== source) {
				reader = new SourceLineReader(source, this.#redactSource?.());
				this.#readers.set(source.id, reader);
			}
			const { lines, end } = reader.read(flush);
			let stats = this.#stats.get(source.id);
			if (!stats) {
				stats = newSourceStats(source.id, source.label);
				this.#stats.set(source.id, stats);
			}
			stats.size = end;
			if (lines.length === 0) continue;
			changed = true;
			if (recordLines(stats, lines, t)) this.#lastLineAt = t;
			this.#matchLines(source.id, lines, t);
		}
		return changed;
	}

	#sourceMatcher(id: string): SourceMatcher | undefined {
		const known = this.#matchers.get(id);
		if (known !== undefined) return known ?? undefined;
		const entry = this.spec ? compileSourceMatcher(this.spec, this.#matcher, id) : undefined;
		this.#matchers.set(id, entry ?? null);
		return entry;
	}

	#matchLines(sourceId: string, lines: readonly string[], t: number): void {
		const entry = this.#sourceMatcher(sourceId);
		if (!entry) return;
		const window = lines.length > MAX_MATCH_LINES ? lines.slice(-MAX_MATCH_LINES) : lines;
		const matched = applyMatches(entry, window, t, this.#store);
		const lastMatched = matched.size > 0 ? Math.max(...matched) : -1;
		if (lastMatched >= 0) this.#lastMatchAt = t;
		let unmatched = 0;
		for (let index = lastMatched + 1; index < window.length; index++) {
			if (window[index].trim().length > 0) unmatched += 1;
		}
		this.#unmatchedLines = lastMatched >= 0 ? unmatched : this.#unmatchedLines + unmatched;
		for (let index = window.length - 1; index >= 0; index--) {
			const line = window[index].trim();
			if (matched.has(index) || line.length === 0) continue;
			this.#lastUnmatchedLine = truncateText(line, MAX_STAGE_CHARS);
			break;
		}
	}

	/** First and last lines per source, most active first, for the author and the dry run. */
	samples(): JobWidgetSourceSample[] {
		return [...this.#stats.values()]
			.filter((stats) => stats.lines > 0)
			.sort((a, b) => b.lines - a.lines)
			.map(sourceSample);
	}

	derive(context: JobWidgetViewContext): JobWidgetDerivation {
		const now = this.#now();
		const updatedAtMs = this.#lastMatchAt ?? this.#lastLineAt ?? this.#startTime;
		const lineStage = context.lineStage === true;
		const spec = this.spec;
		if (!spec) {
			const stage = context.stage ?? (lineStage ? latestLine(this.#stats.values()) : undefined);
			const title = truncateText(context.label.replace(/\s+/g, " ").trim(), MAX_TITLE_CHARS);
			return {
				state: context.authoring ? "pending" : "fallback",
				view: { title, ...(stage ? { stage } : {}), blocks: [], lines: this.totalLines },
				updatedAtMs,
			};
		}
		const ctx = { store: this.#store, now, startTime: this.#startTime };
		const headline = spec.headline ? buildHeadline(spec.headline, ctx) : undefined;
		const stage =
			(spec.stage ? this.#specStage(spec.stage) : undefined) ??
			context.stage ??
			(lineStage ? this.#lastUnmatchedLine : undefined);
		return {
			state: context.settled ? "done" : "live",
			view: {
				title: spec.title,
				...(headline ? { headline } : {}),
				...(stage ? { stage } : {}),
				blocks: spec.blocks.map((block) => buildBlock(block, ctx)).filter(hasData),
			},
			updatedAtMs,
		};
	}

	#specStage(field: string): string | undefined {
		const series = this.#store.series(field);
		const text = (series.text ?? series.line)?.trim();
		return text ? truncateText(text, MAX_STAGE_CHARS) : undefined;
	}
}
