/**
 * Local repairs: authored mistakes the engine fixes in place instead of spending a retry request.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { patternGroupNames } from "./matcher.ts";
import { isRecord } from "./spec-parse-primitives.ts";
import { FIELD_NAME } from "./spec-types.ts";

export interface RuleGroups {
	match: string;
	key?: string;
	text?: string;
}

/**
 * `key` and `text` name groups of the pattern; authors often name ones it lacks. A `text` on a
 * pattern with no groups at all means the matched text itself, so the pattern is wrapped in that
 * group. Otherwise a missing role is dropped: a block reading the missing field still fails
 * validation, and a spec that never reads it stays usable.
 */
export function repairRuleGroups(match: string, key: string | undefined, text: string | undefined): RuleGroups {
	const groups = new Set(patternGroupNames(match));
	const wrap = text !== undefined && FIELD_NAME.test(text) && groups.size === 0;
	const keyGroup = key !== undefined && groups.has(key) ? key : undefined;
	const textGroup = text !== undefined && (wrap || groups.has(text)) ? text : undefined;
	return {
		match: wrap ? `(?P<${text}>${match})` : match,
		...(keyGroup !== undefined ? { key: keyGroup } : {}),
		...(textGroup !== undefined ? { text: textGroup } : {}),
	};
}

export type MeterTotal =
	| { kind: "unknown" }
	| { kind: "number"; value: number }
	| { kind: "ref"; value: Record<string, unknown> };

/**
 * A meter's whole as authored: a numeric string is the number it spells, and an absent or
 * unreadable whole (`"?"`, `null`) is unknown, which draws the meter as a plain stat.
 */
export function readMeterTotal(raw: unknown): MeterTotal {
	const whole = typeof raw === "string" ? Number(raw) : raw;
	if (isRecord(whole)) return { kind: "ref", value: whole };
	if (typeof whole === "number" && !Number.isNaN(whole)) return { kind: "number", value: whole };
	return { kind: "unknown" };
}
