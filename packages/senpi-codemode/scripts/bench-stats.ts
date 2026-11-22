/** Fraction cut from EACH end before averaging: the interquartile mean. */
export const TRIM_FRACTION = 0.25;

function sorted(values: readonly number[]): number[] {
	return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number {
	const ordered = sorted(values);
	const middle = Math.floor(ordered.length / 2);
	if (ordered.length === 0) return Number.NaN;
	return ordered.length % 2 === 1
		? (ordered[middle] ?? Number.NaN)
		: ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], fraction: number): number {
	const ordered = sorted(values);
	if (ordered.length === 0) return Number.NaN;
	const rank = Math.max(1, Math.ceil(fraction * ordered.length));
	return ordered[rank - 1] ?? Number.NaN;
}

function trimCount(length: number): number {
	return Math.floor(TRIM_FRACTION * length);
}

export function trimmedMean(values: readonly number[]): number {
	const ordered = sorted(values);
	const cut = trimCount(ordered.length);
	const kept = ordered.slice(cut, ordered.length - cut);
	if (kept.length === 0) return Number.NaN;
	return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

/**
 * Tukey-McLaughlin standard error of the trimmed mean: the winsorized variance scaled by the kept count.
 * Needs at least two kept values; fewer yields NaN, which callers treat as unmeasured noise.
 */
export function trimmedMeanStandardError(values: readonly number[]): number {
	const ordered = sorted(values);
	const count = ordered.length;
	const cut = trimCount(count);
	const kept = count - 2 * cut;
	if (kept < 2) return Number.NaN;
	const low = ordered[cut] ?? Number.NaN;
	const high = ordered[count - cut - 1] ?? Number.NaN;
	const winsorized = ordered.map((value) => Math.min(high, Math.max(low, value)));
	const mean = winsorized.reduce((sum, value) => sum + value, 0) / count;
	const variance = winsorized.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
	return Math.sqrt(((count - 1) * variance) / (kept * (kept - 1)));
}
