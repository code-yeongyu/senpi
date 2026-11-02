/**
 * Structural parsing of one authored block. Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can
 * Boluk et al.).
 */
import { parseValueRef } from "./spec-parse-ref.ts";
import {
	isRecord,
	optional,
	readAgg,
	readBetter,
	readFieldName,
	readList,
	readNumber,
	readString,
	readTone,
} from "./spec-parse-primitives.ts";
import { readMeterTotal } from "./spec-repair.ts";
import {
	type JobWidgetAgg,
	type JobWidgetBlockSpec,
	type JobWidgetStatItemSpec,
	type JobWidgetValueRef,
	MAX_GRID_TONES,
	MAX_KEY_CHARS,
	MAX_LABEL_CHARS,
	MAX_STAT_ITEMS,
	MAX_UNIT_CHARS,
} from "./spec-types.ts";
import type { JobWidgetTone } from "./view-types.ts";

/** What a bars or meter block without `agg` reduces its field with. */
const DEFAULT_BLOCK_AGG: JobWidgetAgg = "last";

export function parseBlock(value: unknown, where: string, errors: string[]): JobWidgetBlockSpec | undefined {
	if (!isRecord(value)) {
		errors.push(`${where}: expected an object`);
		return undefined;
	}
	const before = errors.length;
	const block = parseBlockKind(value, where, errors);
	return errors.length === before ? block : undefined;
}

function parseBlockKind(
	value: Record<string, unknown>,
	where: string,
	errors: string[],
): JobWidgetBlockSpec | undefined {
	const label = (): string =>
		readString(value.label, `${where}.label`, errors, { cut: MAX_LABEL_CHARS, required: true }) ?? "";
	const unit = (): Record<string, string> =>
		optional(readString(value.unit, `${where}.unit`, errors, { cut: MAX_UNIT_CHARS }), "unit");
	const field = (): string => readFieldName(value.field, `${where}.field`, errors) ?? "";
	const key = (): Record<string, string> =>
		optional(readString(value.key, `${where}.key`, errors, { max: MAX_KEY_CHARS }), "key");
	const better = (): Record<string, "higher" | "lower"> =>
		optional(readBetter(value.better, `${where}.better`, errors), "better");
	// The schema leaves a block's `agg` optional: an absent one is `last` rather than a retry. An
	// unknown one is an error, which drops the block, so the `?? DEFAULT_BLOCK_AGG` never reaches a spec.
	const agg = () => readAgg(value.agg, `${where}.agg`, errors, DEFAULT_BLOCK_AGG) ?? DEFAULT_BLOCK_AGG;
	switch (value.kind) {
		case "spark":
			return {
				kind: "spark",
				field: field(),
				label: label(),
				...key(),
				...unit(),
				...better(),
				...optional(readNumber(value.target, `${where}.target`, errors), "target"),
				...optional(
					readString(value.targetLabel, `${where}.targetLabel`, errors, { cut: MAX_LABEL_CHARS }),
					"targetLabel",
				),
				...optional(readNumber(value.min, `${where}.min`, errors), "min"),
				...optional(readNumber(value.max, `${where}.max`, errors), "max"),
			};
		case "bars":
			return {
				kind: "bars",
				field: field(),
				agg: agg(),
				label: label(),
				...unit(),
				...optional(readNumber(value.max, `${where}.max`, errors), "max"),
				...better(),
			};
		case "meter":
			return parseMeter(value, where, errors, { field, agg, label, key, unit });
		case "stat":
			return { kind: "stat", items: parseStatItems(value.items, `${where}.items`, errors) };
		case "grid":
			return { kind: "grid", field: field(), label: label(), tones: parseTones(value.tones, where, errors) };
		case "text":
			return { kind: "text", field: field() };
		default:
			errors.push(`${where}.kind: expected spark, bars, meter, stat, grid or text`);
			return undefined;
	}
}

interface MeterReaders {
	field: () => string;
	agg: () => JobWidgetValueRef["agg"];
	label: () => string;
	key: () => Record<string, string>;
	unit: () => Record<string, string>;
}

function parseMeter(
	value: Record<string, unknown>,
	where: string,
	errors: string[],
	read: MeterReaders,
): JobWidgetBlockSpec | undefined {
	const whole = readMeterTotal(value.total);
	if (whole.kind === "unknown") {
		const ref = parseValueRef(value, where, errors, DEFAULT_BLOCK_AGG);
		return ref && { kind: "stat", items: [{ ...ref, label: read.label() }] };
	}
	let total: number | JobWidgetValueRef | undefined;
	if (whole.kind === "number") {
		if (!Number.isFinite(whole.value) || whole.value <= 0) errors.push(`${where}.total: expected a positive number`);
		else total = whole.value;
	} else {
		total = parseValueRef(whole.value, `${where}.total`, errors);
	}
	return {
		kind: "meter",
		field: read.field(),
		agg: read.agg(),
		total: total ?? 1,
		label: read.label(),
		...read.key(),
		...read.unit(),
	};
}

function parseStatItems(value: unknown, where: string, errors: string[]): JobWidgetStatItemSpec[] {
	const items: JobWidgetStatItemSpec[] = [];
	readList(value, where, errors, 1, MAX_STAT_ITEMS)?.forEach((item, index) => {
		const itemWhere = `${where}[${index}]`;
		const ref = parseValueRef(item, itemWhere, errors);
		const label = isRecord(item)
			? readString(item.label, `${itemWhere}.label`, errors, { cut: MAX_LABEL_CHARS, required: true })
			: undefined;
		if (ref && label !== undefined) items.push({ ...ref, label });
	});
	return items;
}

function parseTones(value: unknown, where: string, errors: string[]): Record<string, JobWidgetTone> {
	const tones: Record<string, JobWidgetTone> = {};
	if (!isRecord(value)) {
		errors.push(`${where}.tones: expected an object of status substring → tone`);
		return tones;
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_GRID_TONES) errors.push(`${where}.tones: at most ${MAX_GRID_TONES} entries`);
	for (const [status, raw] of entries.slice(0, MAX_GRID_TONES)) {
		const tone = readTone(raw, `${where}.tones.${status}`, errors);
		if (tone !== undefined) tones[status] = tone;
	}
	return tones;
}
