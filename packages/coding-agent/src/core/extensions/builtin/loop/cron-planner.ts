import type { EffectiveInterval, EffectiveIntervalUnit, RequestedInterval } from "./types.ts";

// `types.ts` is the single type home for the whole extension; these are re-exported so
// existing consumers of the planner keep importing the canonical declarations.
export type { EffectiveInterval, RequestedInterval };

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function pluralize(count: number, singular: string, plural: string): string {
	return count === 1 ? `${count} ${singular}` : `${count} ${plural}`;
}

/**
 * Converts a user-requested interval into an effective cadence the scheduler
 * can express with the restricted display cron forms. Seconds are coarsened to
 * minutes; large minute/hour values roll up to hours/days with half-up
 * rounding. Whenever the effective value differs from the request, the result
 * carries a notice naming both the requested and effective cadence.
 */
export function normalizeInterval(requested: RequestedInterval): EffectiveInterval & { intervalMs: number } {
	let value: number;
	let unit: EffectiveIntervalUnit;
	let rounded: boolean;

	switch (requested.unit) {
		case "s": {
			value = Math.max(1, Math.ceil(requested.value / 60));
			unit = "m";
			rounded = true;
			break;
		}
		case "m": {
			if (requested.value >= 60) {
				value = Math.round(requested.value / 60);
				unit = "h";
				rounded = true;
			} else {
				value = requested.value;
				unit = "m";
				rounded = false;
			}
			break;
		}
		case "h": {
			if (requested.value >= 24) {
				value = Math.round(requested.value / 24);
				unit = "d";
				rounded = true;
			} else {
				value = requested.value;
				unit = "h";
				rounded = false;
			}
			break;
		}
		case "d": {
			value = requested.value;
			unit = "d";
			rounded = false;
			break;
		}
	}

	const human =
		unit === "m"
			? pluralize(value, "minute", "minutes")
			: unit === "h"
				? pluralize(value, "hour", "hours")
				: pluralize(value, "day", "days");

	const intervalMs = unit === "m" ? value * MS_PER_MINUTE : unit === "h" ? value * MS_PER_HOUR : value * MS_PER_DAY;

	const roundingNotice = rounded ? `Requested ${requested.raw} rounds to ${human}.` : undefined;

	return { value, unit, human, rounded, roundingNotice, intervalMs };
}

/**
 * Returns a restricted 5-field cron expression for DISPLAY ONLY. The scheduler
 * uses intervalMs + absolute nextFireAt; this string is shown to the user.
 */
export function describeCron(effective: Pick<EffectiveInterval, "value" | "unit">): string {
	switch (effective.unit) {
		case "m":
			return `*/${effective.value} * * * *`;
		case "h":
			return `0 */${effective.value} * * *`;
		case "d":
			return `0 0 */${effective.value} * *`;
	}
}

/**
 * Computes the absolute timestamp of the next scheduled fire. Pure: takes
 * nowMs as a parameter and never reads the clock internally.
 */
export function computeNextFireAt(nowMs: number, intervalMs: number): number {
	return nowMs + intervalMs;
}
