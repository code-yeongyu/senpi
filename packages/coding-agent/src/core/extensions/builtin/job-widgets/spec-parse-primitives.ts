/**
 * Field-level readers for an authored spec: each reads one value, records why it is unusable,
 * and returns `undefined` then. Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import { truncateText } from "./format.ts";
import { FIELD_NAME, JOB_WIDGET_AGGS, type JobWidgetAgg, type JobWidgetBetter } from "./spec-types.ts";
import { JOB_WIDGET_TONES, type JobWidgetTone } from "./view-types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readList(
	value: unknown,
	where: string,
	errors: string[],
	min: number,
	max: number,
): unknown[] | undefined {
	if (!Array.isArray(value)) {
		errors.push(`${where}: expected an array`);
		return undefined;
	}
	if (value.length < min || value.length > max) {
		errors.push(`${where}: expected ${min}–${max} entries, got ${value.length}`);
		return undefined;
	}
	return value;
}

export interface ReadStringOptions {
	/** Longer text is an error. */
	max?: number;
	/** Longer display text is cut to fit instead of sent back for a retry. */
	cut?: number;
	required?: boolean;
}

export function readString(
	value: unknown,
	where: string,
	errors: string[],
	options: ReadStringOptions = {},
): string | undefined {
	if (value === undefined || value === null) {
		if (options.required) errors.push(`${where}: required`);
		return undefined;
	}
	if (typeof value !== "string") {
		errors.push(`${where}: expected a string`);
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		if (options.required) errors.push(`${where}: must not be empty`);
		return undefined;
	}
	if (options.max !== undefined && trimmed.length > options.max) {
		errors.push(`${where}: at most ${options.max} characters`);
		return undefined;
	}
	return options.cut === undefined ? trimmed : truncateText(trimmed, options.cut);
}

export function readNumber(value: unknown, where: string, errors: string[]): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		errors.push(`${where}: expected a finite number`);
		return undefined;
	}
	return value;
}

export function readFieldName(value: unknown, where: string, errors: string[]): string | undefined {
	const name = readString(value, where, errors, { required: true });
	if (name !== undefined && !FIELD_NAME.test(name)) {
		errors.push(`${where}: "${name}" must match ${FIELD_NAME.source}`);
		return undefined;
	}
	return name;
}

/** An absent `agg` is `fallback` when one is given (bars and meters); an unknown one is an error. */
export function readAgg(
	value: unknown,
	where: string,
	errors: string[],
	fallback?: JobWidgetAgg,
): JobWidgetAgg | undefined {
	if ((value === undefined || value === null) && fallback !== undefined) return fallback;
	const agg = JOB_WIDGET_AGGS.find((candidate) => candidate === value);
	if (agg === undefined) errors.push(`${where}: expected one of ${JOB_WIDGET_AGGS.join(", ")}`);
	return agg;
}

export function readBetter(value: unknown, where: string, errors: string[]): JobWidgetBetter | undefined {
	if (value === undefined || value === null) return undefined;
	if (value === "higher" || value === "lower") return value;
	errors.push(`${where}: expected "higher" or "lower"`);
	return undefined;
}

export function readTone(value: unknown, where: string, errors: string[]): JobWidgetTone | undefined {
	const tone = JOB_WIDGET_TONES.find((candidate) => candidate === value);
	if (tone === undefined) errors.push(`${where}: expected one of ${JOB_WIDGET_TONES.join(", ")}`);
	return tone;
}

/** `{ [name]: value }`, or `{}` when `value` is absent, for spreading optional properties. */
export function optional<T>(value: T | undefined, name: string): Record<string, T> {
	return value === undefined ? {} : { [name]: value };
}
