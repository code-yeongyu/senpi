/**
 * Structural parsing of a value reference (headline, stat item, meter total).
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { isRecord, readAgg, readBetter, readFieldName, readNumber, readString } from "./spec-parse-primitives.ts";
import { type JobWidgetAgg, type JobWidgetValueRef, MAX_KEY_CHARS, MAX_UNIT_CHARS } from "./spec-types.ts";

/** `defaultAgg` stands in for an absent `agg` (a meter drawn as a stat); otherwise `agg` is required. */
export function parseValueRef(
	value: unknown,
	where: string,
	errors: string[],
	defaultAgg?: JobWidgetAgg,
): JobWidgetValueRef | undefined {
	if (!isRecord(value)) {
		errors.push(`${where}: expected an object`);
		return undefined;
	}
	const field = readFieldName(value.field, `${where}.field`, errors);
	const key = readString(value.key, `${where}.key`, errors, { max: MAX_KEY_CHARS });
	const agg = readAgg(value.agg, `${where}.agg`, errors, defaultAgg);
	const unit = readString(value.unit, `${where}.unit`, errors, { cut: MAX_UNIT_CHARS });
	const digits = readNumber(value.digits, `${where}.digits`, errors);
	if (digits !== undefined && (!Number.isInteger(digits) || digits < 0 || digits > 4)) {
		errors.push(`${where}.digits: expected an integer 0–4`);
	}
	const better = readBetter(value.better, `${where}.better`, errors);
	if (field === undefined || agg === undefined) return undefined;
	return {
		field,
		agg,
		...(key !== undefined ? { key } : {}),
		...(unit !== undefined ? { unit } : {}),
		...(digits !== undefined ? { digits } : {}),
		...(better !== undefined ? { better } : {}),
	};
}
