/**
 * The `job_widget_state` v1 contract: display-ready views a client draws as-is. Numbers arrive
 * formatted, series arrive downsampled, so no client runs a regex or parses job output.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.), reshaped to the senpi v1 contract.
 */

export type JobWidgetTone = "success" | "error" | "warning" | "pending" | "info" | "muted" | "neutral";

export const JOB_WIDGET_TONES: readonly JobWidgetTone[] = [
	"success",
	"error",
	"warning",
	"pending",
	"info",
	"muted",
	"neutral",
];

/** Where a job's widget is: `skipped` carries no view. */
export type JobWidgetEntryState = "pending" | "live" | "done" | "skipped" | "fallback";

export interface JobWidgetTrend {
	text: string;
	tone: JobWidgetTone;
}

export interface JobWidgetHeadline {
	text: string;
	label?: string;
	trend?: JobWidgetTrend;
}

export interface JobWidgetSparkMark {
	value: number;
	label: string;
}

export interface JobWidgetSparkBlock {
	kind: "spark";
	label: string;
	values: number[];
	min: number;
	max: number;
	marks?: JobWidgetSparkMark[];
	last: string;
}

export interface JobWidgetBarItem {
	key: string;
	value: number;
	text: string;
}

export interface JobWidgetBarsBlock {
	kind: "bars";
	label: string;
	items: JobWidgetBarItem[];
	max: number;
}

export interface JobWidgetMeterBlock {
	kind: "meter";
	label: string;
	/** Fraction done, 0..1. */
	value: number;
	text: string;
}

export interface JobWidgetStatItem {
	label: string;
	text: string;
	trend?: JobWidgetTrend;
}

export interface JobWidgetStatBlock {
	kind: "stat";
	items: JobWidgetStatItem[];
}

export interface JobWidgetGridCell {
	key: string;
	tone: JobWidgetTone;
	text: string;
}

export interface JobWidgetGridBlock {
	kind: "grid";
	label: string;
	cells: JobWidgetGridCell[];
}

export interface JobWidgetTextBlock {
	kind: "text";
	text: string;
}

export type JobWidgetBlock =
	| JobWidgetSparkBlock
	| JobWidgetBarsBlock
	| JobWidgetMeterBlock
	| JobWidgetStatBlock
	| JobWidgetGridBlock
	| JobWidgetTextBlock;

export interface JobWidgetView {
	title: string;
	headline?: JobWidgetHeadline;
	stage?: string;
	/** At most 4; the first is the primary block compact rows draw. */
	blocks: JobWidgetBlock[];
	/** Non-empty lines read so far; set for pending and fallback views. */
	lines?: number;
}

export interface JobWidgetEntry {
	/** `bash_id` or `st_` task id. */
	id: string;
	kind: "bash" | "task";
	state: JobWidgetEntryState;
	/** Absent for skipped. */
	view?: JobWidgetView;
	updatedAtMs: number;
}

/** Payload of the `job_widget_state` extension event. */
export interface JobWidgetState {
	v: 1;
	sessionId: string;
	jobs: JobWidgetEntry[];
}
