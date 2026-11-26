/**
 * Per-field bounded series: every match folds into running aggregates, a short window of match
 * counts for `rate`, and a trimmed ring of recent values for sparks.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobWidgetAgg } from "./spec-types.ts";

/** Points a series keeps for sparks. */
export const RING_POINTS = 240;
/**
 * Keys one field keeps a series for. Past it the oldest first-seen key that no spec block names is
 * dropped, so a field keyed per test or per path stays bounded for the life of the job.
 */
export const MAX_FIELD_KEYS = 256;
/** Window of `rate` and lines/s. */
const RATE_WINDOW_MS = 60_000;

export interface TimedCount {
	t: number;
	n: number;
}

export interface TimedValue {
	t: number;
	v: number;
}

/** One key's (or all keys') accumulated matches. */
export interface WidgetSeries {
	/** Matches, including those that carried no number. */
	count: number;
	/** Numbers folded in. */
	values: number;
	first: number;
	last: number;
	min: number;
	max: number;
	sum: number;
	/** Matches per refresh time within the last {@link RATE_WINDOW_MS}, oldest first. */
	recent: TimedCount[];
	/** Newest values, oldest first; between {@link RING_POINTS} and twice that once full. */
	ring: TimedValue[];
	text?: string;
	line?: string;
	updatedAt: number;
}

function emptySeries(): WidgetSeries {
	return {
		count: 0,
		values: 0,
		first: 0,
		last: 0,
		min: Number.POSITIVE_INFINITY,
		max: Number.NEGATIVE_INFINITY,
		sum: 0,
		recent: [],
		ring: [],
		updatedAt: 0,
	};
}

export interface SeriesMatch {
	value: number | undefined;
	text: string | undefined;
	line: string;
	t: number;
}

/** Drops buckets older than the rate window from the front of `recent`. */
export function trimWindow(recent: TimedCount[], t: number): void {
	const horizon = t - RATE_WINDOW_MS;
	let stale = 0;
	while (stale < recent.length && recent[stale].t < horizon) stale += 1;
	if (stale > 0) recent.splice(0, stale);
}

function pushMatch(series: WidgetSeries, match: SeriesMatch): void {
	const { value, text, line, t } = match;
	series.count += 1;
	const bucket = series.recent.at(-1);
	if (bucket?.t === t) bucket.n += 1;
	else {
		series.recent.push({ t, n: 1 });
		trimWindow(series.recent, t);
	}
	if (value !== undefined) {
		if (series.values === 0) series.first = value;
		series.values += 1;
		series.last = value;
		if (value < series.min) series.min = value;
		if (value > series.max) series.max = value;
		series.sum += value;
		series.ring.push({ t, v: value });
		// Trimmed in batches: dropping the oldest point on every push would copy the ring each time.
		if (series.ring.length >= RING_POINTS * 2) series.ring.splice(0, series.ring.length - RING_POINTS);
	}
	if (text) series.text = text;
	series.line = line;
	series.updatedAt = t;
}

/** Window `rate` divides by: the last minute, or the job's age when younger, at least 1 s. */
function rateWindowMs(now: number, startTime: number): number {
	return Math.min(RATE_WINDOW_MS, Math.max(1000, now - startTime));
}

/** Matches per second over the rate window. */
export function windowRate(recent: readonly TimedCount[], now: number, startTime: number): number {
	const horizon = now - RATE_WINDOW_MS;
	let inWindow = 0;
	for (const bucket of recent) if (bucket.t >= horizon) inWindow += bucket.n;
	return inWindow / (rateWindowMs(now, startTime) / 1000);
}

/**
 * Reduce a series. `count` and `rate` are defined on an empty series (0); value aggregations are
 * `undefined` until a number arrived, and `change` is `undefined` when it would divide a move by
 * a zero start.
 */
export function aggregateSeries(
	series: WidgetSeries,
	agg: JobWidgetAgg,
	now: number,
	startTime: number,
): number | undefined {
	if (agg === "count") return series.count;
	if (agg === "rate") return windowRate(series.recent, now, startTime);
	if (series.values === 0) return undefined;
	switch (agg) {
		case "last":
			return series.last;
		case "first":
			return series.first;
		case "min":
			return series.min;
		case "max":
			return series.max;
		case "sum":
			return series.sum;
		case "mean":
			return series.sum / series.values;
		case "delta":
			return series.last - series.first;
		case "change":
			if (series.first === 0) return series.last === 0 ? 0 : undefined;
			return ((series.last - series.first) / Math.abs(series.first)) * 100;
	}
}

/** Equal-count bucket means, at most `points` of them, each with its last point's time. */
export function downsample(ring: readonly TimedValue[], points: number): TimedValue[] {
	if (ring.length <= points) return ring.slice();
	const out: TimedValue[] = [];
	for (let bucket = 0; bucket < points; bucket++) {
		const from = Math.floor((bucket * ring.length) / points);
		const to = Math.floor(((bucket + 1) * ring.length) / points);
		let sum = 0;
		for (let index = from; index < to; index++) sum += ring[index].v;
		out.push({ t: ring[to - 1].t, v: sum / (to - from) });
	}
	return out;
}

/**
 * Every field's series per key (`""` when its rules capture no key), plus every match merged.
 * A field keeps at most {@link MAX_FIELD_KEYS} keys; `pinned` keys (the ones spec blocks name)
 * are never evicted, so a keyed headline or spark never restarts its series.
 */
export class FieldStore {
	readonly #fields = new Map<string, { keys: Map<string, WidgetSeries>; all: WidgetSeries }>();
	readonly #keyed: ReadonlySet<string>;
	readonly #pinned: ReadonlyMap<string, ReadonlySet<string>>;

	constructor(keyed: ReadonlySet<string>, pinned: ReadonlyMap<string, ReadonlySet<string>> = new Map()) {
		this.#keyed = keyed;
		this.#pinned = pinned;
	}

	push(name: string, key: string, match: SeriesMatch): void {
		let field = this.#fields.get(name);
		if (!field) {
			const all = emptySeries();
			// Without keys the one series is the merged one: fold each match in once.
			field = { keys: this.#keyed.has(name) ? new Map() : new Map([["", all]]), all };
			this.#fields.set(name, field);
		}
		let series = field.keys.get(key);
		if (!series) {
			if (field.keys.size >= MAX_FIELD_KEYS) this.#evictOldest(name, field.keys);
			series = emptySeries();
			field.keys.set(key, series);
		}
		pushMatch(series, match);
		if (series !== field.all) pushMatch(field.all, match);
	}

	/** The merged series without `key`, else that key's; an empty series for an unseen field or key. */
	series(name: string, key?: string): WidgetSeries {
		const field = this.#fields.get(name);
		if (!field) return emptySeries();
		if (key === undefined) return field.all;
		return field.keys.get(key) ?? emptySeries();
	}

	/** How many keys a field holds a series for. */
	keyCount(name: string): number {
		return this.#fields.get(name)?.keys.size ?? 0;
	}

	/** A field's newest `limit` keys by first sight, oldest first, with their series. */
	keys(name: string, limit: number): [string, WidgetSeries][] {
		const keys = this.#fields.get(name)?.keys;
		if (!keys || limit <= 0) return [];
		let skip = keys.size - limit;
		const out: [string, WidgetSeries][] = [];
		// Insertion order is first-seen order; the map holds at most MAX_FIELD_KEYS entries.
		for (const entry of keys) {
			if (skip > 0) skip -= 1;
			else out.push(entry);
		}
		return out;
	}

	/** Drops the oldest first-seen key no block names; pinned keys are few, so the walk is short. */
	#evictOldest(name: string, keys: Map<string, WidgetSeries>): void {
		const pinned = this.#pinned.get(name);
		for (const key of keys.keys()) {
			if (pinned?.has(key)) continue;
			keys.delete(key);
			return;
		}
	}
}
