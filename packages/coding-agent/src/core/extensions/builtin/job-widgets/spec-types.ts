/**
 * The declarative widget spec a cheap model writes once per job: rules that pull numbers and
 * words out of output lines, and the blocks that draw them.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */
import type { JobWidgetTone } from "./view-types.ts";

/** How a field's values reduce to one number. */
export type JobWidgetAgg = "last" | "first" | "min" | "max" | "mean" | "sum" | "count" | "rate" | "delta" | "change";

export const JOB_WIDGET_AGGS: readonly JobWidgetAgg[] = [
	"last",
	"first",
	"min",
	"max",
	"mean",
	"sum",
	"count",
	"rate",
	"delta",
	"change",
];

/**
 * One line-matching rule. Every named group but `key` feeds the field of the same name with its
 * capture: a number, or text for the `text` group (and for a capture that holds no number).
 */
export interface JobWidgetRule {
	/** Source id (`out`, `pipe:1`, `tools`), `*` for all, a trailing `*` for a prefix (`pipe:*`). */
	from: string;
	/** RE2 syntax with named groups, `(?P<name>…)` or `(?<name>…)`, matched per line. */
	match: string;
	/** Group splitting every field of the rule into one series per key; not a field itself. */
	key?: string;
	/** Group whose capture is kept as text, never parsed as a number. */
	text?: string;
	/** Field counting the rule's matches. */
	count?: string;
	/** Multiplies every number the rule captures. */
	scale?: number;
}

/** A field one rule feeds. */
export interface JobWidgetRuleField {
	field: string;
	/** The capture is kept as text, never parsed as a number. */
	text: boolean;
	/** The rule's `count`: fed by the match itself, not a capture. */
	count: boolean;
}

export type JobWidgetBetter = "higher" | "lower";

/** A number derived from one field. */
export interface JobWidgetValueRef {
	field: string;
	key?: string;
	agg: JobWidgetAgg;
	unit?: string;
	digits?: number;
	better?: JobWidgetBetter;
}

export interface JobWidgetSparkSpec {
	kind: "spark";
	field: string;
	key?: string;
	label: string;
	unit?: string;
	better?: JobWidgetBetter;
	target?: number;
	targetLabel?: string;
	min?: number;
	max?: number;
}

export interface JobWidgetBarsSpec {
	kind: "bars";
	field: string;
	agg: JobWidgetAgg;
	label: string;
	unit?: string;
	max?: number;
	better?: JobWidgetBetter;
}

export interface JobWidgetMeterSpec {
	kind: "meter";
	field: string;
	agg: JobWidgetAgg;
	key?: string;
	total: number | JobWidgetValueRef;
	label: string;
	unit?: string;
}

export type JobWidgetStatItemSpec = JobWidgetValueRef & { label: string };

export interface JobWidgetStatSpec {
	kind: "stat";
	items: JobWidgetStatItemSpec[];
}

export interface JobWidgetGridSpec {
	kind: "grid";
	field: string;
	label: string;
	/** Tone by the key's latest text: case-insensitive substring, first listed wins. */
	tones: Record<string, JobWidgetTone>;
}

export interface JobWidgetTextSpec {
	kind: "text";
	field: string;
}

export type JobWidgetBlockSpec =
	| JobWidgetSparkSpec
	| JobWidgetBarsSpec
	| JobWidgetMeterSpec
	| JobWidgetStatSpec
	| JobWidgetGridSpec
	| JobWidgetTextSpec;

export type JobWidgetHeadlineSpec = JobWidgetValueRef & { label?: string };

export interface JobWidgetSpec {
	/** What is watched, at most {@link MAX_TITLE_CHARS}. */
	title: string;
	/** 1 to {@link MAX_RULES}. */
	rules: JobWidgetRule[];
	/** 1 to {@link MAX_BLOCKS}; the first is the primary block compact views show. */
	blocks: JobWidgetBlockSpec[];
	headline?: JobWidgetHeadlineSpec;
	/** Field whose latest captured text is the stage line. */
	stage?: string;
}

export const MAX_TITLE_CHARS = 48;
export const MAX_RULES = 12;
export const MAX_BLOCKS = 4;
export const MAX_STAT_ITEMS = 4;
export const MAX_PATTERN_CHARS = 400;
export const MAX_LABEL_CHARS = 48;
export const MAX_UNIT_CHARS = 12;
export const MAX_GRID_TONES = 12;
export const MAX_KEY_CHARS = 120;
export const FIELD_NAME = /^[a-z][a-z0-9_]{0,23}$/;
export const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const SOURCE_ID = /^(?:\*|[A-Za-z0-9_:.-]{1,64}\*?)$/;
