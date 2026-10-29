/**
 * Turns spec blocks plus derived field state into display-ready v1 blocks.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { aggregateSeries, downsample, type FieldStore, RING_POINTS } from "./field-state.ts";
import { formatWidgetNumber, formatWidgetTrend, MISSING_VALUE_TEXT, truncateText } from "./format.ts";
import type {
	JobWidgetAgg,
	JobWidgetBlockSpec,
	JobWidgetHeadlineSpec,
	JobWidgetSparkSpec,
	JobWidgetValueRef,
} from "./spec-types.ts";
import type {
	JobWidgetBlock,
	JobWidgetHeadline,
	JobWidgetSparkBlock,
	JobWidgetTone,
	JobWidgetTrend,
} from "./view-types.ts";

const SPARK_POINTS = 48;
const MAX_BAR_ITEMS = 16;
const MAX_GRID_CELLS = 48;
const MAX_TEXT_CHARS = 200;

/** Aggregations whose value a trend arrow can describe; counts, rates and derived numbers have none. */
const TREND_AGGS: ReadonlySet<JobWidgetAgg> = new Set(["last", "min", "max"]);

export interface BuildContext {
	store: FieldStore;
	now: number;
	startTime: number;
}

interface BuiltValue {
	text: string;
	value: number | undefined;
	trend?: JobWidgetTrend;
}

function buildValue(ref: JobWidgetValueRef, ctx: BuildContext): BuiltValue {
	const series = ctx.store.series(ref.field, ref.key);
	const value = aggregateSeries(series, ref.agg, ctx.now, ctx.startTime);
	const unit = ref.agg === "change" ? "%" : ref.unit;
	const text = value === undefined ? MISSING_VALUE_TEXT : formatWidgetNumber(value, unit, ref.digits);
	const trend =
		ref.better && TREND_AGGS.has(ref.agg) && series.values >= 2
			? formatWidgetTrend(series.first, series.last, ref.better, ref.unit)
			: undefined;
	return { text, value, ...(trend ? { trend } : {}) };
}

export function buildHeadline(ref: JobWidgetHeadlineSpec, ctx: BuildContext): JobWidgetHeadline | undefined {
	const { text, value, trend } = buildValue(ref, ctx);
	if (value === undefined) return undefined;
	return { text, ...(ref.label ? { label: ref.label } : {}), ...(trend ? { trend } : {}) };
}

export function buildBlock(block: JobWidgetBlockSpec, ctx: BuildContext): JobWidgetBlock {
	switch (block.kind) {
		case "spark":
			return buildSpark(block, ctx);
		case "bars": {
			const entries = ctx.store.keys(block.field, MAX_BAR_ITEMS);
			const unit = block.agg === "change" ? "%" : block.unit;
			const values = entries.map(([, series]) => aggregateSeries(series, block.agg, ctx.now, ctx.startTime) ?? 0);
			const labels = keyLabels(entries.map(([key]) => key));
			const items = entries.map(([key], index) => ({
				key: labels[index] || key || block.label,
				value: values[index],
				text: formatWidgetNumber(values[index], unit),
			}));
			const peak = Math.max(0, ...values);
			return { kind: "bars", label: block.label, items, max: block.max ?? (peak > 0 ? peak : 1) };
		}
		case "meter": {
			const series = ctx.store.series(block.field, block.key);
			const value = aggregateSeries(series, block.agg, ctx.now, ctx.startTime) ?? 0;
			const total = typeof block.total === "number" ? block.total : (buildValue(block.total, ctx).value ?? 0);
			const fraction = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
			const text = `${formatWidgetNumber(value)}/${formatWidgetNumber(total, block.unit)}`;
			return { kind: "meter", label: block.label, value: fraction, text };
		}
		case "stat":
			return {
				kind: "stat",
				items: block.items.map((item) => {
					const { text, trend } = buildValue(item, ctx);
					return { label: item.label, text, ...(trend ? { trend } : {}) };
				}),
			};
		case "grid": {
			const entries = ctx.store.keys(block.field, MAX_GRID_CELLS);
			const labels = keyLabels(entries.map(([key]) => key));
			return {
				kind: "grid",
				label: block.label,
				cells: entries.map(([key, series], index) => {
					const raw =
						series.text ?? (series.values > 0 ? formatWidgetNumber(series.last) : (series.line?.trim() ?? ""));
					const text = truncateText(raw, MAX_TEXT_CHARS);
					return { key: labels[index] || key || block.label, tone: gridTone(block.tones, text), text };
				}),
			};
		}
		case "text": {
			const series = ctx.store.series(block.field);
			return { kind: "text", text: truncateText(series.text ?? series.line?.trim() ?? "", MAX_TEXT_CHARS) };
		}
	}
}

function buildSpark(block: JobWidgetSparkSpec, ctx: BuildContext): JobWidgetSparkBlock {
	const series = ctx.store.series(block.field, block.key);
	const ring = series.ring.length > RING_POINTS ? series.ring.slice(-RING_POINTS) : series.ring;
	const values = downsample(ring, SPARK_POINTS).map((point) => point.v);
	const marks =
		block.target === undefined
			? undefined
			: [
					{
						value: block.target,
						label: block.targetLabel ?? `target ${formatWidgetNumber(block.target, block.unit)}`,
					},
				];
	const { min, max } = sparkDomain([...values, ...(marks ?? []).map((mark) => mark.value)], block.min, block.max);
	return {
		kind: "spark",
		label: block.label,
		values,
		min,
		max,
		...(marks ? { marks } : {}),
		last: series.values > 0 ? formatWidgetNumber(series.last, block.unit) : MISSING_VALUE_TEXT,
	};
}

/**
 * A spark's value domain: the data's range (values and marks) padded by 10% on both sides, so a
 * series moving within 160-186 does not draw as a flat bar; a flat series pads by max(1, 5% of its
 * value). The bottom stays at or above 0 when every bound is non-negative. A spec's bounds win.
 */
function sparkDomain(bounds: readonly number[], specMin?: number, specMax?: number): { min: number; max: number } {
	let min = 0;
	let max = 1;
	if (bounds.length > 0) {
		const lo = Math.min(...bounds);
		const hi = Math.max(...bounds);
		const pad = hi > lo ? (hi - lo) * 0.1 : Math.max(1, Math.abs(hi) * 0.05);
		min = lo >= 0 ? Math.max(0, lo - pad) : lo - pad;
		max = hi + pad;
	}
	min = specMin ?? min;
	max = specMax ?? max;
	if (max <= min) max = min + 1;
	return { min, max };
}

/** Whether a block has anything to draw; meters and stats always do. */
export function hasData(block: JobWidgetBlock): boolean {
	switch (block.kind) {
		case "text":
			return block.text.length > 0;
		case "bars":
			return block.items.length > 0;
		case "grid":
			return block.cells.length > 0;
		case "spark":
			return block.values.length > 0;
		case "meter":
		case "stat":
			return true;
	}
}

/**
 * Labels for keys: the last `/` segment when every key has one and those segments stay unique
 * (`openai/gpt-6-luna` -> `gpt-6-luna`), else the keys as they are.
 */
function keyLabels(keys: readonly string[]): string[] {
	if (keys.length === 0 || !keys.every((key) => key.includes("/"))) return keys.slice();
	const short = keys.map((key) => key.slice(key.lastIndexOf("/") + 1));
	return short.every((label) => label.length > 0) && new Set(short).size === short.length ? short : keys.slice();
}

/** Tone of a grid cell: the first `tones` entry whose status is a case-insensitive substring of the text. */
function gridTone(tones: Readonly<Record<string, JobWidgetTone>>, text: string): JobWidgetTone {
	const lower = text.toLowerCase();
	for (const [status, tone] of Object.entries(tones)) {
		if (lower.includes(status.toLowerCase())) return tone;
	}
	return "neutral";
}
