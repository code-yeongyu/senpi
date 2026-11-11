/**
 * Background bash sessions as rows below the TUI editor, drawn like the background subagent rows that
 * sit there: `⠦ <command> · bash_2 · running · 1m 5s`, a spinner while it runs, `✓ … · done · <time>`
 * for {@link DONE_LINGER_MS} after it exits. Every running bash job has a row whether or not a widget
 * spec was ever written for it (a silent job, a skipped or failed spec); a live spec's headline stands
 * in for `running`. Task jobs are left to the area above the editor, so no job is drawn twice. The row
 * ticks every {@link FRAME_MS} only while some job runs; otherwise the one timer is the linger expiry.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionWidgetOptions } from "../../types.ts";
import { cutPlain } from "./tui-line.ts";
import type { JobWidgetEntry, JobWidgetState } from "./view-types.ts";

export const JOB_BASH_ROWS_TUI_KEY = "job-widgets-bash";
export const DONE_LINGER_MS = 10_000;
export const FRAME_MS = 250;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DONE_MARK = "✓";
const MAX_ROWS = 5;
const MAX_LINE_COLUMNS = 220;
const MIN_SUMMARY_COLUMNS = 12;
const PAD = " ";

type WidgetFactory = (tui: TUI) => Component & { dispose?(): void };

export interface JobBashRowsOptions {
	setWidget(key: string, content: WidgetFactory | undefined, options?: ExtensionWidgetOptions): void;
	now?: () => number;
}

interface Row {
	readonly entry: JobWidgetEntry;
	/** When the job started; absent for a state sent by an engine that predates the field. */
	readonly startedAtMs: number | undefined;
	/** When this area saw it end; absent for a job already done when first seen, which is not shown. */
	readonly doneAtMs: number | undefined;
}

export function formatRowElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function status(entry: JobWidgetEntry): string {
	if (entry.state === "done") return "done";
	const headline = entry.state === "live" ? entry.view?.headline : undefined;
	if (!headline) return "running";
	return oneLine(headline.label ? `${headline.label} ${headline.text}` : headline.text);
}

export function formatBashRow(row: Row, now: number, width: number): string {
	const { entry } = row;
	const done = entry.state === "done";
	const mark = done ? DONE_MARK : (SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? SPINNER[0]);
	const end = row.doneAtMs ?? now;
	const elapsed = row.startedAtMs === undefined ? undefined : formatRowElapsed(end - row.startedAtMs);
	const tail = [entry.id, status(entry), ...(elapsed === undefined ? [] : [elapsed])].join(" · ");
	const summary = oneLine(entry.view?.title ?? entry.id);
	const room = width - visibleWidth(`${mark}  · ${tail}`);
	const shown = cutPlain(summary, Math.max(MIN_SUMMARY_COLUMNS, room));
	return cutPlain(`${mark} ${shown} · ${tail}`, width);
}

class JobBashRowsComponent implements Component {
	#rows: readonly Row[];
	#more: number;
	#now: number;

	constructor(rows: readonly Row[], more: number, now: number) {
		this.#rows = rows;
		this.#more = more;
		this.#now = now;
	}

	set(rows: readonly Row[], more: number, now: number): void {
		this.#rows = rows;
		this.#more = more;
		this.#now = now;
	}

	render(width: number): string[] {
		const inner = Math.min(MAX_LINE_COLUMNS, Math.max(0, width - PAD.length * 2));
		if (inner === 0) return [];
		const lines = this.#rows.map((row) => `${PAD}${formatBashRow(row, this.#now, inner)}`);
		if (this.#more > 0) lines.push(`${PAD}${cutPlain(`+${this.#more} more`, inner)}`);
		return lines;
	}

	invalidate(): void {}
}

export class JobBashRows {
	readonly #setWidget: JobBashRowsOptions["setWidget"];
	readonly #now: () => number;
	#rows = new Map<string, Row>();
	#component: JobBashRowsComponent | undefined;
	#tui: TUI | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(options: JobBashRowsOptions) {
		this.#setWidget = options.setWidget;
		this.#now = options.now ?? Date.now;
	}

	update(state: JobWidgetState): void {
		if (this.#disposed) return;
		const now = this.#now();
		const next = new Map<string, Row>();
		for (const entry of state.jobs) {
			if (entry.kind !== "bash" || entry.view === undefined || entry.state === "skipped") continue;
			const previous = this.#rows.get(entry.id);
			const endedNow = previous !== undefined && previous.entry.state !== "done";
			const doneAtMs = entry.state === "done" ? (endedNow ? now : previous?.doneAtMs) : undefined;
			next.set(entry.id, { entry, startedAtMs: entry.startedAtMs, doneAtMs });
		}
		// A row that was running and is now gone or skipped ended without a widget spec: show it done.
		for (const [id, row] of this.#rows) {
			if (next.has(id)) continue;
			if (row.entry.state !== "done")
				next.set(id, { ...row, entry: { ...row.entry, state: "done" }, doneAtMs: now });
			else if (row.doneAtMs !== undefined) next.set(id, row);
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
		return [...this.#rows.values()]
			.filter((row) => row.entry.state !== "done" || row.doneAtMs !== undefined)
			.reverse();
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
			return;
		}
		const shown = rows.slice(0, MAX_ROWS);
		const more = rows.length - shown.length;
		if (this.#component) {
			this.#component.set(shown, more, now);
			this.#tui?.requestRender();
		} else {
			this.#setWidget(
				JOB_BASH_ROWS_TUI_KEY,
				(tui) => {
					const component = new JobBashRowsComponent(shown, more, now);
					this.#component = component;
					this.#tui = tui;
					return component;
				},
				{ placement: "belowEditor" },
			);
		}
		this.#arm(rows, now);
	}

	#arm(rows: readonly Row[], now: number): void {
		let wait: number | undefined;
		if (rows.some((row) => row.entry.state !== "done")) wait = FRAME_MS - (now % FRAME_MS);
		else {
			for (const row of rows) {
				const left = (row.doneAtMs ?? now) + DONE_LINGER_MS - now;
				if (wait === undefined || left < wait) wait = left;
			}
		}
		if (wait === undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#redraw();
		}, wait);
		this.#timer.unref?.();
	}
}
