/**
 * The TUI's job widget area above the editor, fed by `job_widget_state`. It shows while some job is
 * live or pending, or a finished one is still lingering: one line per job, newest first, at most
 * {@link MAX_JOB_WIDGET_LINES} plus `+N more`. A finished job stays {@link DONE_LINGER_MS} after it
 * is first seen done; one already done in a new area's first state (a reload re-sends every job the
 * registry still holds) has expired and never shows; skipped jobs never show. Nothing polls: a state redraws only when what it
 * shows changed, and the one timer that runs is the next linger expiry.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import { cutPlain, formatJobWidgetLine, type JobWidgetLineStyle, jobWidgetLineStyle } from "./tui-line.ts";
import type { JobWidgetEntry, JobWidgetState } from "./view-types.ts";

export const JOB_WIDGET_TUI_KEY = "job-widgets";
const MAX_JOB_WIDGET_LINES = 3;
export const DONE_LINGER_MS = 10_000;
const PAD = " ";

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface JobWidgetAreaOptions {
	setWidget(key: string, content: WidgetFactory | undefined): void;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

interface AreaRows {
	readonly entries: readonly JobWidgetEntry[];
	readonly more: number;
}

class JobWidgetAreaComponent implements Component {
	readonly #style: JobWidgetLineStyle;
	#rows: AreaRows;
	#cache: { width: number; lines: string[] } | undefined;

	constructor(style: JobWidgetLineStyle, rows: AreaRows) {
		this.#style = style;
		this.#rows = rows;
	}

	setRows(rows: AreaRows): void {
		this.#rows = rows;
		this.#cache = undefined;
	}

	render(width: number): string[] {
		if (this.#cache?.width === width) return this.#cache.lines;
		const inner = Math.max(0, width - PAD.length * 2);
		const lines: string[] = [];
		for (const entry of this.#rows.entries) {
			const line = formatJobWidgetLine(entry, inner, this.#style);
			if (line !== undefined) lines.push(`${PAD}${line}`);
		}
		const more = this.#rows.more > 0 ? cutPlain(`+${this.#rows.more} more`, inner) : "";
		if (more.length > 0) lines.push(`${PAD}${this.#style.fg("muted", more)}`);
		this.#cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.#cache = undefined;
	}
}

export class JobWidgetArea {
	readonly #setWidget: JobWidgetAreaOptions["setWidget"];
	readonly #env: NodeJS.ProcessEnv;
	readonly #now: () => number;
	readonly #doneSince = new Map<string, number>();
	#jobs: readonly JobWidgetEntry[] = [];
	#shownKey: string | undefined;
	#component: JobWidgetAreaComponent | undefined;
	#tui: TUI | undefined;
	#lingerTimer: ReturnType<typeof setTimeout> | undefined;
	#seenState = false;
	#disposed = false;

	constructor(options: JobWidgetAreaOptions) {
		this.#setWidget = options.setWidget;
		this.#env = options.env ?? process.env;
		this.#now = options.now ?? Date.now;
	}

	update(state: JobWidgetState): void {
		if (this.#disposed) return;
		this.#jobs = state.jobs;
		const now = this.#now();
		// A job already done in the first state finished before this area existed: its linger is over.
		const doneAt = this.#seenState ? now : Number.NEGATIVE_INFINITY;
		this.#seenState = true;
		const present = new Set<string>();
		for (const job of state.jobs) {
			present.add(job.id);
			if (job.state !== "done") this.#doneSince.delete(job.id);
			else if (!this.#doneSince.has(job.id)) this.#doneSince.set(job.id, doneAt);
		}
		for (const id of this.#doneSince.keys()) if (!present.has(id)) this.#doneSince.delete(id);
		this.#redraw();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#lingerTimer);
		this.#lingerTimer = undefined;
		if (this.#shownKey !== undefined) this.#setWidget(JOB_WIDGET_TUI_KEY, undefined);
		this.#shownKey = undefined;
		this.#component = undefined;
		this.#tui = undefined;
	}

	#lingering(entry: JobWidgetEntry, now: number): boolean {
		const since = this.#doneSince.get(entry.id);
		return since !== undefined && now - since < DONE_LINGER_MS;
	}

	#rows(now: number): AreaRows | undefined {
		const shown = [...this.#jobs]
			.reverse()
			.filter((entry) => entry.state !== "skipped" && entry.view !== undefined)
			.filter((entry) => entry.state !== "done" || this.#lingering(entry, now));
		const active = shown.some(
			(entry) => entry.state === "live" || entry.state === "pending" || entry.state === "done",
		);
		if (!active) return undefined;
		return {
			entries: shown.slice(0, MAX_JOB_WIDGET_LINES),
			more: Math.max(0, shown.length - MAX_JOB_WIDGET_LINES),
		};
	}

	#redraw(): void {
		const now = this.#now();
		const rows = this.#rows(now);
		this.#armLinger(now);
		if (rows === undefined) {
			if (this.#shownKey !== undefined) this.#setWidget(JOB_WIDGET_TUI_KEY, undefined);
			this.#shownKey = undefined;
			this.#component = undefined;
			this.#tui = undefined;
			return;
		}
		const key = JSON.stringify({ more: rows.more, rows: rows.entries.map(({ updatedAtMs: _at, ...rest }) => rest) });
		if (key === this.#shownKey) return;
		this.#shownKey = key;
		if (this.#component) {
			this.#component.setRows(rows);
			this.#tui?.requestRender();
			return;
		}
		this.#setWidget(JOB_WIDGET_TUI_KEY, (tui, theme) => {
			const component = new JobWidgetAreaComponent(jobWidgetLineStyle(theme, this.#env), rows);
			this.#component = component;
			this.#tui = tui;
			return component;
		});
	}

	#armLinger(now: number): void {
		clearTimeout(this.#lingerTimer);
		this.#lingerTimer = undefined;
		let next: number | undefined;
		for (const since of this.#doneSince.values()) {
			const expiry = since + DONE_LINGER_MS;
			if (expiry > now && (next === undefined || expiry < next)) next = expiry;
		}
		if (next === undefined) return;
		this.#lingerTimer = setTimeout(() => {
			this.#lingerTimer = undefined;
			this.#redraw();
		}, next - now);
		this.#lingerTimer.unref?.();
	}
}
