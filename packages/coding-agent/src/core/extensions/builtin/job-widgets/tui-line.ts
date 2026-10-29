/**
 * One terminal line per job widget: `bash_3  Blender render · per frame  ▁▂▃▅▆▇▆▅  rendered 120 · 4.20 s`.
 * A spark draws as 8-level block glyphs, a meter as `[██████░░░░] 120/250`, any other primary block
 * leaves only the headline; a pending job shows how much output was read, a fallback its latest
 * line. The line never exceeds the width it is given, and the numbers are the last thing to go: the
 * block label goes first, then the title shrinks to 8 columns, then the chart (a meter keeps its
 * count), then the headline label; then the title shrinks further or goes, the gaps narrow to one
 * space, and only then is the whole line cut.
 * The look follows oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.), adapted to senpi's widget surface.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { JobWidgetEntry, JobWidgetTone, JobWidgetView } from "./view-types.ts";

export type JobWidgetLineToken = "accent" | "success" | "error" | "muted";

export interface JobWidgetLineStyle {
	fg(token: JobWidgetLineToken, text: string): string;
}

export const PLAIN_LINE_STYLE: JobWidgetLineStyle = { fg: (_token, text) => text };

/** Theme colors, or none at all when `NO_COLOR` is set to a non-empty value. */
export function jobWidgetLineStyle(theme: Theme, env: NodeJS.ProcessEnv = process.env): JobWidgetLineStyle {
	if (env.NO_COLOR) return PLAIN_LINE_STYLE;
	return { fg: (token, text) => theme.fg(token, text) };
}

const SPARK_LEVELS = "▁▂▃▄▅▆▇█";
const ELLIPSIS = "…";
const SGR_RESET = "\x1b[0m";
const MIN_TITLE_COLUMNS = 8;
const GAP = "  ";

export function sparkGlyphs(values: readonly number[], min: number, max: number, columns: number): string {
	const span = max - min;
	const top = SPARK_LEVELS.length - 1;
	return values
		.slice(-columns)
		.map((value) => {
			const level = span > 0 ? Math.round(((value - min) / span) * top) : Math.ceil(top / 2);
			return SPARK_LEVELS[Math.min(top, Math.max(0, level))];
		})
		.join("");
}

function sparkColumns(width: number): number {
	return width >= 100 ? 16 : width >= 60 ? 12 : 8;
}

function meterCells(width: number): number {
	return width >= 60 ? 10 : 6;
}

interface Segment {
	text: string;
	token?: JobWidgetLineToken;
}

function plain(segments: readonly Segment[]): string {
	return segments.map((segment) => segment.text).join("");
}

function styled(segments: readonly Segment[], style: JobWidgetLineStyle): string {
	return segments
		.filter((segment) => segment.text.length > 0)
		.map((segment) => (segment.token ? style.fg(segment.token, segment.text) : segment.text))
		.join("");
}

/** `truncateToWidth` closes every cut with SGR resets; text that carried no styling keeps none. */
function cutPlain(text: string, columns: number): string {
	return truncateToWidth(text, columns, ELLIPSIS).replaceAll(SGR_RESET, "");
}

function trendToken(tone: JobWidgetTone): JobWidgetLineToken {
	return tone === "success" ? "success" : tone === "error" ? "error" : "muted";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

interface LineParts {
	/** Block label shown after the title; dropped first when the line is too wide. */
	label?: string;
	/** The chart drawing (spark glyphs or meter bar); dropped once the title is down to 8 columns. */
	chart: Segment[];
	/** A meter's own count (`120/250`): drawn after the bar, and kept with the metrics without it. */
	count?: Segment;
	/** The headline and extra numbers, with or without the headline's label. */
	metrics(withHeadlineLabel: boolean): Segment[];
}

function metricSegments(view: JobWidgetView, withHeadlineLabel: boolean, extra?: string): Segment[] {
	const segments: Segment[] = [];
	const headline = view.headline;
	if (headline) {
		if (headline.label && withHeadlineLabel) {
			segments.push({ text: `${oneLine(headline.label)} `, token: "muted" });
		}
		segments.push({ text: oneLine(headline.text) });
		if (headline.trend) segments.push({ text: ` ${headline.trend.text}`, token: trendToken(headline.trend.tone) });
	}
	if (extra) {
		if (segments.length > 0) segments.push({ text: " · ", token: "muted" });
		segments.push({ text: extra });
	}
	return segments;
}

function viewParts(entry: JobWidgetEntry, view: JobWidgetView, width: number): LineParts {
	if (entry.state === "pending") {
		const lines = view.lines ?? 0;
		const metrics: Segment[] = [
			{ text: `reading output · ${lines} ${lines === 1 ? "line" : "lines"}`, token: "muted" },
		];
		return { chart: [], metrics: () => metrics };
	}
	if (entry.state === "fallback") {
		const metrics: Segment[] = view.stage ? [{ text: oneLine(view.stage), token: "muted" }] : [];
		return { chart: [], metrics: () => metrics };
	}
	const primary = view.blocks[0];
	const chartToken: JobWidgetLineToken = entry.state === "done" ? "muted" : "accent";
	if (primary?.kind === "spark" && primary.values.length > 0) {
		return {
			label: primary.label,
			chart: [
				{ text: sparkGlyphs(primary.values, primary.min, primary.max, sparkColumns(width)), token: chartToken },
			],
			metrics: (withHeadlineLabel) => metricSegments(view, withHeadlineLabel, primary.last),
		};
	}
	if (primary?.kind === "meter") {
		const cells = meterCells(width);
		const filled = Math.round(Math.min(1, Math.max(0, primary.value)) * cells);
		return {
			label: primary.label,
			chart: [
				{ text: "[", token: "muted" },
				{ text: "█".repeat(filled), token: chartToken },
				{ text: "░".repeat(cells - filled), token: "muted" },
				{ text: "]", token: "muted" },
			],
			count: { text: oneLine(primary.text) },
			metrics: (withHeadlineLabel) => metricSegments(view, withHeadlineLabel),
		};
	}
	return { chart: [], metrics: (withHeadlineLabel) => metricSegments(view, withHeadlineLabel) };
}

function idToken(entry: JobWidgetEntry): JobWidgetLineToken {
	if (entry.state === "live") return "accent";
	if (entry.state === "done") return "success";
	return "muted";
}

export interface JobWidgetLineOptions {
	/** Lead with the job id (the widget area does; a `bash_output` result already names its job). */
	showId?: boolean;
}

/**
 * The entry as one line no wider than `width` columns, or `undefined` for an entry with nothing to
 * draw (skipped, or no view).
 */
export function formatJobWidgetLine(
	entry: JobWidgetEntry,
	width: number,
	style: JobWidgetLineStyle,
	options: JobWidgetLineOptions = {},
): string | undefined {
	const view = entry.view;
	if (entry.state === "skipped" || view === undefined || width <= 0) return undefined;
	const parts = viewParts(entry, view, width);
	const title = oneLine(view.title);
	const titleWidth = visibleWidth(title);

	interface Shape {
		title: string;
		blockLabel: boolean;
		chart: boolean;
		headlineLabel: boolean;
		gap: string;
	}
	/** The pieces present (id, title, chart/count, metrics), joined by the gap. */
	const compose = (shape: Shape): Segment[] => {
		const pieces: Segment[][] = [];
		if (options.showId !== false) pieces.push([{ text: entry.id, token: idToken(entry) }]);
		if (shape.title.length > 0) {
			const label = shape.blockLabel && parts.label ? ` · ${oneLine(parts.label)}` : "";
			pieces.push([{ text: shape.title }, ...(label ? [{ text: label, token: "muted" as const }] : [])]);
		}
		const bar = shape.chart ? parts.chart : [];
		const chart = [...bar, ...(parts.count ? [...(bar.length > 0 ? [{ text: " " }] : []), parts.count] : [])];
		if (chart.length > 0) pieces.push(chart);
		const metrics = parts.metrics(shape.headlineLabel);
		if (metrics.length > 0) pieces.push(metrics);
		return pieces.flatMap((piece, index) => (index === 0 ? piece : [{ text: shape.gap }, ...piece]));
	};
	const fits = (segments: readonly Segment[]): boolean => visibleWidth(plain(segments)) <= width;
	/** The line with the title cut to whatever room is left, if that leaves it at least `minTitle` columns. */
	const shrunk = (shape: Omit<Shape, "title" | "blockLabel">, minTitle: number): Segment[] | undefined => {
		const without = compose({ ...shape, title: "", blockLabel: false });
		const room = width - visibleWidth(plain(without)) - visibleWidth(shape.gap);
		if (room >= Math.min(minTitle, titleWidth)) {
			const cut = titleWidth <= room ? title : cutPlain(title, room);
			if (cut.length > 0 && cut !== ELLIPSIS) {
				const candidate = compose({ ...shape, title: cut, blockLabel: false });
				if (fits(candidate)) return candidate;
			}
		}
		return minTitle === 0 && fits(without) ? without : undefined;
	};

	for (const blockLabel of [true, false]) {
		const candidate = compose({ title, blockLabel, chart: true, headlineLabel: true, gap: GAP });
		if (fits(candidate)) return styled(candidate, style);
	}
	for (const headlineLabel of [true, false]) {
		for (const chart of [true, false]) {
			const candidate = shrunk({ chart, headlineLabel, gap: GAP }, MIN_TITLE_COLUMNS);
			if (candidate) return styled(candidate, style);
		}
	}
	for (const gap of [GAP, " "]) {
		const candidate = shrunk({ chart: false, headlineLabel: false, gap }, 0);
		if (candidate) return styled(candidate, style);
	}
	// Nothing fits whole: cut from the end, with the numbers leading when there are any.
	const hasNumbers = parts.count !== undefined || parts.metrics(false).length > 0;
	const narrow = compose({
		title: hasNumbers ? "" : title,
		blockLabel: false,
		chart: false,
		headlineLabel: false,
		gap: " ",
	});
	return style === PLAIN_LINE_STYLE
		? cutPlain(plain(narrow), width)
		: truncateToWidth(styled(narrow, style), width, ELLIPSIS);
}
