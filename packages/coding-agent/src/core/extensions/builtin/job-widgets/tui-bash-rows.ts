/**
 * Background bash sessions that have no chart, as rows below the TUI editor drawn like the background
 * subagent rows that sit there: `⠦ <command> · bash_2 · running · 1m 5s` while it runs, then for
 * {@link DONE_LINGER_MS} after it exits `✓ … · done`, `✗ … · failed` or `✗ … · killed`. A job
 * whose widget spec draws a chart (`live`, or `done` with a spec view) belongs to the area above
 * the editor instead ({@link isChartedBashJob}), so no job is drawn twice; a running job leaves these
 * rows once its chart appears. The rows repaint only when their text changes: the elapsed time moves
 * once a second for the first hour and once a minute after that, and nothing else ticks.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { ExtensionWidgetOptions } from "../../types.ts";
import { cutPlain, type JobWidgetLineStyle, type JobWidgetLineToken, jobWidgetLineStyle } from "./tui-line.ts";
import type { JobWidgetEntry, JobWidgetState } from "./view-types.ts";

export const JOB_BASH_ROWS_TUI_KEY = "job-widgets-bash";
export const DONE_LINGER_MS = 10_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ROWS = 5;
const MAX_LINE_COLUMNS = 220;
const MIN_SUMMARY_COLUMNS = 12;
const PAD = " ";
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface JobBashRowsOptions {
	setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/** A bash job whose widget spec draws a chart: the area above the editor shows it, not these rows. */
export function isChartedBashJob(entry: JobWidgetEntry): boolean {
	if (entry.kind !== "bash" || entry.view === undefined) return false;
	// A spec view never carries `lines`; the plain (pending, fallback) view always does.
	return entry.state === "live" || (entry.state === "done" && entry.view.lines === undefined);
}

interface Row {
	readonly entry: JobWidgetEntry;
	/** When the job started; absent for a state sent by an engine that predates the field. */
	readonly startedAtMs: number | undefined;
	/** When this area saw it end; absent for a job already done when first seen, which is not shown. */
	readonly doneAtMs: number | undefined;
}

/** `42s`, `1m 5s` for the first hour, then `1h 5m`. */
export function formatRowElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / SECOND_MS));
	const minutes = Math.floor(seconds / 60);
	if (minutes === 0) return `${seconds}s`;
	const hours = Math.floor(minutes / 60);
	return hours === 0 ? `${minutes}m ${seconds % 60}s` : `${hours}h ${minutes % 60}m`;
}

/** Milliseconds until {@link formatRowElapsed} of a clock at `ms` next changes. */
function nextElapsedChange(ms: number): number {
	const step = ms >= HOUR_MS ? MINUTE_MS : SECOND_MS;
	return step - (Math.max(0, ms) % step);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

interface Ending {
	readonly mark: string;
	readonly status: string;
	readonly token: JobWidgetLineToken;
}

function ending(entry: JobWidgetEntry): Ending {
	switch (entry.outcome) {
		case "success":
			return { mark: "✓", status: "done", token: "success" };
		case "failed":
			return { mark: "✗", status: "failed", token: "error" };
		case "killed":
			return { mark: "✗", status: "killed", token: "error" };
		default:
			return { mark: "■", status: "exited", token: "muted" };
	}
}

function ended(entry: JobWidgetEntry): boolean {
	return entry.state === "done" || entry.state === "skipped";
}

export function formatBashRow(row: Row, now: number, width: number, style: JobWidgetLineStyle): string {
	const { entry } = row;
	const age = row.startedAtMs === undefined ? undefined : (row.doneAtMs ?? now) - row.startedAtMs;
	const done = ended(entry) ? ending(entry) : undefined;
	const tick = age === undefined ? 0 : Math.floor(age / SECOND_MS);
	const mark = done?.mark ?? SPINNER[tick % SPINNER.length] ?? SPINNER[0];
	const markToken: JobWidgetLineToken = done?.token ?? "accent";
	const elapsed = age === undefined ? undefined : formatRowElapsed(age);
	const status = done?.status ?? "running";
	const tail = ` · ${[entry.id, status, ...(elapsed === undefined ? [] : [elapsed])].join(" · ")}`;
	const summary = oneLine(entry.view?.title ?? entry.id);
	const room = width - visibleWidth(`${mark} ${tail}`);
	const shown = cutPlain(summary, Math.max(MIN_SUMMARY_COLUMNS, room));
	const line = `${style.fg(markToken, mark)} ${shown}${style.fg("muted", tail)}`;
	if (visibleWidth(`${mark} ${shown}${tail}`) <= width) return line;
	return truncateToWidth(line, width, "…");
}

class JobBashRowsComponent implements Component {
	readonly #style: JobWidgetLineStyle;
	#lines: (width: number, style: JobWidgetLineStyle) => string[];

	constructor(style: JobWidgetLineStyle, lines: (width: number, style: JobWidgetLineStyle) => string[]) {
		this.#style = style;
		this.#lines = lines;
	}

	set(lines: (width: number, style: JobWidgetLineStyle) => string[]): void {
		this.#lines = lines;
	}

	render(width: number): string[] {
		const inner = Math.min(MAX_LINE_COLUMNS, Math.max(0, width - PAD.length * 2));
		if (inner === 0) return [];
		return this.#lines(inner, this.#style).map((line) => `${PAD}${line}`);
	}

	invalidate(): void {}
}

export class JobBashRows {
	readonly #setWidget: JobBashRowsOptions["setWidget"];
	readonly #env: NodeJS.ProcessEnv;
	readonly #now: () => number;
	#rows = new Map<string, Row>();
	#component: JobBashRowsComponent | undefined;
	#tui: TUI | undefined;
	#shownKey: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(options: JobBashRowsOptions) {
		this.#setWidget = options.setWidget;
		this.#env = options.env ?? process.env;
		this.#now = options.now ?? Date.now;
	}

	update(state: JobWidgetState): void {
		if (this.#disposed) return;
		const now = this.#now();
		const next = new Map<string, Row>();
		for (const entry of state.jobs) {
			if (entry.kind !== "bash" || isChartedBashJob(entry)) continue;
			const previous = this.#rows.get(entry.id);
			if (!ended(entry)) {
				if (entry.view !== undefined)
					next.set(entry.id, { entry, startedAtMs: entry.startedAtMs, doneAtMs: undefined });
				continue;
			}
			// Seen running, now ended: show how it ended. Already ended when first seen (a reload): not shown.
			if (previous === undefined) continue;
			const doneAtMs = previous.doneAtMs ?? now;
			const view = entry.view ?? previous.entry.view;
			next.set(entry.id, {
				entry: { ...entry, ...(view ? { view } : {}) },
				startedAtMs: previous.startedAtMs,
				doneAtMs,
			});
		}
		this.#rows = next;
		this.#redraw();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#component) this.#setWidget(JOB_BASH_ROWS_TUI_KEY, undefined);
		this.#component = undefined;
		this.#tui = undefined;
	}

	#visible(now: number): Row[] {
		for (const [id, row] of this.#rows) {
			if (row.doneAtMs !== undefined && now - row.doneAtMs >= DONE_LINGER_MS) this.#rows.delete(id);
		}
		return [...this.#rows.values()].reverse();
	}

	#redraw(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const now = this.#now();
		const rows = this.#visible(now);
		if (rows.length === 0) {
			if (this.#component) this.#setWidget(JOB_BASH_ROWS_TUI_KEY, undefined);
			this.#component = undefined;
			this.#tui = undefined;
			this.#shownKey = undefined;
			return;
		}
		const shown = rows.slice(0, MAX_ROWS);
		const more = rows.length - shown.length;
		const lines = (width: number, style: JobWidgetLineStyle): string[] => {
			const out = shown.map((row) => formatBashRow(row, now, width, style));
			if (more > 0) out.push(style.fg("muted", cutPlain(`+${more} more`, width)));
			return out;
		};
		this.#arm(rows, now);
		// Repaint only when what the rows say changed (a new job, a new status, the elapsed time moving).
		const key = JSON.stringify(lines(MAX_LINE_COLUMNS, { fg: (_token, text) => text }));
		if (this.#component && key === this.#shownKey) return;
		this.#shownKey = key;
		if (this.#component) {
			this.#component.set(lines);
			this.#tui?.requestRender();
			return;
		}
		this.#setWidget(
			JOB_BASH_ROWS_TUI_KEY,
			(tui, theme) => {
				const component = new JobBashRowsComponent(jobWidgetLineStyle(theme, this.#env), lines);
				this.#component = component;
				this.#tui = tui;
				return component;
			},
			{ placement: "belowEditor" },
		);
	}

	/** One timer: the next moment some row's text changes (its elapsed time, or a done row's expiry). */
	#arm(rows: readonly Row[], now: number): void {
		let wait: number | undefined;
		for (const row of rows) {
			let left: number | undefined;
			if (row.doneAtMs !== undefined) left = row.doneAtMs + DONE_LINGER_MS - now;
			else if (row.startedAtMs !== undefined) left = nextElapsedChange(now - row.startedAtMs);
			if (left !== undefined && (wait === undefined || left < wait)) wait = left;
		}
		if (wait === undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#redraw();
		}, wait);
		this.#timer.unref?.();
	}
}
