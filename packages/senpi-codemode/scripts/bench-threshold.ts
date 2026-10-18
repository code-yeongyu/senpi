import { trimmedMean, trimmedMeanStandardError } from "./bench-stats.ts";

/** No gated row may regress more than this, whatever its measured noise. */
export const MAX_BAND = 0.05;

/**
 * Standard errors added to a row's A/A offset. About 3.3 is a one-sided 5% family-wise bound over the ~120
 * gated rows; the margin above it absorbs the standard error itself being estimated from the calibration pairs.
 */
export const THRESHOLD_Z = 4;

/**
 * `row`: every row gets its own band from ITS calibration pairs through `rowNoiseBand` - one rule, row-sized constants.
 * `global`: one band for all rows - the largest `rowNoiseBand` over rows. Same statistic, only the scope differs,
 * so every row's shared band is at least its own: global scope never fails a clean row that row scope passes.
 * (A percentile of the bare A/A offsets would fail a fixed share of clean rows by construction.)
 */
export type BandScope = "row" | "global";
export const DEFAULT_BAND_SCOPE: BandScope = "row";

export function parseBandScope(value: string): BandScope {
	if (value === "row" || value === "global") return value;
	throw new RangeError(`--band-scope expects row or global, got ${value}`);
}

/** The single calibration rule: |A/A offset| + THRESHOLD_Z standard errors, as a ratio deviation. */
export function rowNoiseBand(calibrationLogRatios: readonly number[]): number {
	const offset = Math.abs(trimmedMean(calibrationLogRatios));
	return Math.expm1(offset + THRESHOLD_Z * trimmedMeanStandardError(calibrationLogRatios));
}

export function globalNoiseBand(calibrationLogRatiosPerRow: readonly (readonly number[])[]): number {
	return Math.max(...calibrationLogRatiosPerRow.map(rowNoiseBand));
}

/**
 * The smallest slowdown a row can detect, as a ratio deviation: the band itself (the floor variant, no extra z).
 * A row FAILs only when its paired ratio exceeds 1 + band, so a true slowdown below the band is not flagged on
 * average and one at the band is flagged about half the time. For a clean row this equals its threshold; for a
 * noise-limited row it exceeds MAX_BAND and states the largest slowdown that row could miss.
 */
export function minimumDetectableEffect(band: number): number {
	return band;
}

export function cappedThreshold(band: number): number {
	return Math.min(band, MAX_BAND);
}
