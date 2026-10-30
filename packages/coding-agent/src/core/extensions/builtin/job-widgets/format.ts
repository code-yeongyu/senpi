/**
 * Display text for job widgets: `186 tok/s`, `5.37 ms`, `12.3k req`, `▲ 15%`, and text cut to fit.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobWidgetBetter } from "./spec-types.ts";
import type { JobWidgetTrend } from "./view-types.ts";

const COMPACT_STEPS: readonly (readonly [number, string])[] = [
	[1e12, "T"],
	[1e9, "G"],
	[1e6, "M"],
	[1e3, "k"],
];

/** Text of a value that has not arrived yet. */
export const MISSING_VALUE_TEXT = "-";

/** Values from here up print compacted (`12.3k`); smaller ones print in full (`4096`). */
const COMPACT_FROM = 10_000;

/** `text` cut to `max` characters, the last one an ellipsis when anything was cut. */
export function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** `value / step` printed: one decimal below 100 (judged after rounding, so 99.96 prints `100`), else none. */
function compactText(value: number, step: number, digits: number | undefined): string {
	const scaled = value / step;
	if (digits !== undefined) return scaled.toFixed(digits);
	const oneDecimal = scaled.toFixed(1);
	return Math.abs(Number(oneDecimal)) >= 100 ? scaled.toFixed(0) : oneDecimal;
}

/**
 * A number with its unit: auto decimals (>= 100 -> 0, >= 10 -> 1, else 2) unless `digits` is
 * given, whole numbers without decimals, large values compacted (`12.3k`). A value that rounds up
 * to 1000 of a suffix moves to the next one (`999_999` -> `1.0M`, never `1000k`). `%` attaches to
 * the number; other units follow a space.
 */
export function formatWidgetNumber(value: number, unit?: string, digits?: number): string {
	if (!Number.isFinite(value)) return MISSING_VALUE_TEXT;
	const magnitude = Math.abs(value);
	let text: string | undefined;
	if (magnitude >= COMPACT_FROM) {
		const index = COMPACT_STEPS.findIndex(([step]) => magnitude >= step);
		const [step, suffix] = COMPACT_STEPS[index];
		const scaled = compactText(value, step, digits);
		const larger = COMPACT_STEPS[index - 1];
		text =
			Math.abs(Number(scaled)) >= 1000 && larger
				? `${compactText(value, larger[0], digits)}${larger[1]}`
				: `${scaled}${suffix}`;
	}
	text ??=
		Number.isInteger(value) && digits === undefined
			? String(value)
			: value.toFixed(digits ?? (magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2));
	if (!unit) return text;
	return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

/**
 * How `last` moved from `first`, judged against `better`: `▲ 15%` / `▼ 3.2%`, or the absolute move
 * with its unit when `first` is 0. `success` toward `better`, `error` away from it; `undefined`
 * when nothing moved.
 */
export function formatWidgetTrend(
	first: number,
	last: number,
	better: JobWidgetBetter,
	unit?: string,
): JobWidgetTrend | undefined {
	const delta = last - first;
	if (delta === 0 || !Number.isFinite(delta)) return undefined;
	const arrow = delta > 0 ? "▲" : "▼";
	const tone = delta > 0 === (better === "higher") ? "success" : "error";
	if (first === 0) return { text: `${arrow} ${formatWidgetNumber(Math.abs(delta), unit)}`, tone };
	const percent = Math.abs(delta / first) * 100;
	return { text: `${arrow} ${percent.toFixed(percent >= 10 ? 0 : 1)}%`, tone };
}
