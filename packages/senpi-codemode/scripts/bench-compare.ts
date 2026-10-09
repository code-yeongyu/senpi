/**
 * The authoritative timing comparator (plan todo 2): paired interleaved repetitions, the trimmed mean of paired
 * log ratios, and an A/A-calibrated threshold per row capped at 0.05 for CPU, wall and p95. Pure: no I/O, no clocks.
 */

import { type HeadBudget, headBudgetFor, headBudgetViolations, type Observation } from "./bench-head-budget.ts";
import { median, trimmedMean } from "./bench-stats.ts";
import {
	type BandScope,
	cappedThreshold,
	DEFAULT_BAND_SCOPE,
	globalNoiseBand,
	MAX_BAND,
	minimumDetectableEffect,
	rowNoiseBand,
} from "./bench-threshold.ts";
import { invalidations, metricsOf } from "./bench-validate.ts";

export const LOAD_REFUSAL = 80;

export type Metric = "cpu" | "wall" | "p95";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "REFUSED";
export type RowVerdict = "PASS" | "FAIL" | "NOISE-LIMITED";

export interface Rep {
	readonly cpuMs: number;
	readonly wallMs: number;
	readonly p95Ms?: number;
	readonly observations?: Readonly<Record<string, Observation>>;
}

/** Repetitions of both sides of one block, index-aligned: rep i of `first` ran adjacent to rep i of `second`. */
export interface PairedBlock {
	readonly first: readonly Rep[];
	readonly second: readonly Rep[];
}

export interface Series {
	readonly scenario: string;
	readonly runtimeId: string;
	readonly optional?: boolean;
	readonly present: { readonly base: boolean; readonly head: boolean };
	readonly calibration: readonly PairedBlock[];
	readonly comparison: readonly PairedBlock[];
}

export interface RuntimeSide {
	readonly available: boolean;
	readonly version?: string;
}

export interface RuntimeStatus {
	readonly id: string;
	readonly base: RuntimeSide;
	readonly head: RuntimeSide;
}

export interface BenchInput {
	/** Rows judged on the head alone; defaults to HEAD_BUDGETS. */
	readonly headBudgets?: readonly HeadBudget[];
	readonly runtimes: readonly RuntimeStatus[];
	readonly blockLoads: readonly number[];
	readonly reps: number;
	readonly series: readonly Series[];
	readonly failures?: readonly string[];
	readonly bandScope?: BandScope;
}

export interface SeriesResult {
	readonly scenario: string;
	readonly runtimeId: string;
	readonly metric: Metric;
	readonly calibrationRatios: readonly number[];
	readonly pairedRatios: readonly number[];
	readonly band: number;
	readonly threshold: number;
	/** Smallest slowdown this row can detect at its measured band (`minimumDetectableEffect`). */
	readonly mde: number;
	readonly ratio: number;
	readonly medianPairedRatio: number;
	readonly verdict: RowVerdict;
	/** Set when the row is judged by an absolute head budget instead of the base ratio. */
	readonly headBudget?: {
		readonly maxMedianWallMs: number;
		readonly maxMedianCpuMs: number;
		readonly reason: string;
		readonly violations: readonly string[];
	};
}

export interface Decision {
	readonly exitCode: 0 | 1 | 2 | 3;
	readonly verdict: Verdict;
	readonly bandScope: BandScope;
	readonly lines: readonly string[];
	readonly results: readonly SeriesResult[];
	readonly skipped: readonly string[];
}

export function admitHost(load1: number): Decision | undefined {
	if (load1 <= LOAD_REFUSAL) return undefined;
	const line = `host refused: 1-minute load ${load1.toFixed(2)} > ${LOAD_REFUSAL}; rerun on a quieter host`;
	return {
		exitCode: 2,
		verdict: "REFUSED",
		bandScope: DEFAULT_BAND_SCOPE,
		lines: [line],
		results: [],
		skipped: [],
	};
}

function metricValue(rep: Rep, metric: Metric): number | undefined {
	switch (metric) {
		case "cpu":
			return rep.cpuMs;
		case "wall":
			return rep.wallMs;
		case "p95":
			return rep.p95Ms;
	}
}

/** Per adjacent pair: log(second / first). Blocks are pooled; a pair missing a value contributes nothing. */
export function pairedLogRatios(blocks: readonly PairedBlock[], metric: Metric): number[] {
	const ratios: number[] = [];
	for (const block of blocks) {
		block.first.forEach((rep, index) => {
			const first = metricValue(rep, metric);
			const partner = block.second[index];
			const second = partner === undefined ? undefined : metricValue(partner, metric);
			if (first !== undefined && second !== undefined) ratios.push(Math.log(second / first));
		});
	}
	return ratios;
}

interface Row {
	readonly series: Series;
	readonly metric: Metric;
	readonly calibration: readonly number[];
	readonly comparison: readonly number[];
}

function judge(row: Row, band: number): SeriesResult {
	const ratio = Math.exp(trimmedMean(row.comparison));
	const threshold = cappedThreshold(band);
	const regressed = !(ratio <= 1 + band);
	const verdict: RowVerdict = regressed ? "FAIL" : band > MAX_BAND || !Number.isFinite(band) ? "NOISE-LIMITED" : "PASS";
	return {
		scenario: row.series.scenario,
		runtimeId: row.series.runtimeId,
		metric: row.metric,
		calibrationRatios: row.calibration.map(Math.exp),
		pairedRatios: row.comparison.map(Math.exp),
		band,
		threshold,
		mde: minimumDetectableEffect(band),
		ratio,
		medianPairedRatio: Math.exp(median(row.comparison)),
		verdict,
	};
}

/** The head side of every comparison block, in order. */
function headReps(series: Series): Rep[] {
	return series.comparison.flatMap((block) => [...block.second]);
}

function judgeHeadBudget(judged: SeriesResult, series: Series, budget: HeadBudget): SeriesResult {
	const violations = headBudgetViolations(budget, headReps(series), judged.metric);
	return {
		...judged,
		verdict: violations.length === 0 ? "PASS" : "FAIL",
		headBudget: {
			maxMedianWallMs: budget.maxMedianWallMs,
			maxMedianCpuMs: budget.maxMedianCpuMs,
			reason: budget.reason,
			violations,
		},
	};
}

function percent(value: number): string {
	return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

/** The honest claim of a run with no FAIL row and at least one noise-limited row. */
export const NOISE_LIMITED_CLAIM =
	"no regression detected; rows marked noise-limited can only detect slowdowns above their stated MDE";

export function decide(input: BenchInput): Decision {
	const refusal = admitHost(Math.max(...input.blockLoads));
	if (refusal) return refusal;
	const bandScope = input.bandScope ?? DEFAULT_BAND_SCOPE;
	const measured = input.series.filter((series) => series.present.base && series.present.head);
	const skipped = input.series
		.filter((series) => series.optional && !series.present.base && !series.present.head)
		.map((series) => `${series.scenario} ${series.runtimeId}: not present on head`);
	const rows: Row[] = measured.flatMap((series) =>
		metricsOf(series).map((metric) => ({
			series,
			metric,
			calibration: pairedLogRatios(series.calibration, metric),
			comparison: pairedLogRatios(series.comparison, metric),
		})),
	);
	const sharedBand = globalNoiseBand(rows.map((row) => row.calibration));
	const results = rows.map((row) => {
		const judged = judge(row, bandScope === "global" ? sharedBand : rowNoiseBand(row.calibration));
		const budget = headBudgetFor(row.series.scenario, row.series.runtimeId, input.headBudgets);
		return budget === undefined ? judged : judgeHeadBudget(judged, row.series, budget);
	});
	const invalid = invalidations(input);
	if (rows.length === 0) invalid.push("no A/A calibration ratios were measured");
	const base = { bandScope, results, skipped };
	if (invalid.length > 0)
		return { exitCode: 3, verdict: "INCONCLUSIVE", lines: invalid.map((line) => `INCONCLUSIVE: ${line}`), ...base };
	const named = (result: SeriesResult) => `${result.scenario} ${result.runtimeId}`;
	const failed = results.filter((result) => result.verdict === "FAIL");
	if (failed.length > 0)
		return {
			exitCode: 1,
			verdict: "FAIL",
			lines: failed.map((result) =>
				result.headBudget === undefined
					? `FAIL: ${named(result)}: paired ${result.metric} ratio ${result.ratio.toFixed(2)} > 1.00 + band ${percent(result.band)}`
					: `FAIL: ${named(result)}: ${result.metric} head budget missed: ${result.headBudget.violations.join("; ")}`,
			),
			...base,
		};
	const limited = results.filter((result) => result.verdict === "NOISE-LIMITED");
	if (limited.length > 0)
		return {
			exitCode: 3,
			verdict: "INCONCLUSIVE",
			lines: [
				...limited.map(
					(result) =>
						`INCONCLUSIVE: ${named(result)}: ${result.metric} A/A noise band ${percent(result.band)} > ${MAX_BAND.toFixed(2)} (noise-limited); can only detect slowdowns above MDE ${percent(result.mde)}`,
				),
				NOISE_LIMITED_CLAIM,
			],
			...base,
		};
	return { exitCode: 0, verdict: "PASS", lines: [], ...base };
}
