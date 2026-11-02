import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	formatJobWidgetLine,
	jobWidgetLineStyle,
	PLAIN_LINE_STYLE,
	sparkGlyphs,
} from "../../src/core/extensions/builtin/job-widgets/tui-line.ts";
import type { JobWidgetEntry } from "../../src/core/extensions/builtin/job-widgets/view-types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (text: string): string => text.replace(ANSI, "");

const spark: JobWidgetEntry = {
	id: "bash_3",
	kind: "bash",
	state: "live",
	updatedAtMs: 1,
	view: {
		title: "Blender render",
		headline: { text: "120", label: "rendered" },
		blocks: [
			{
				kind: "spark",
				label: "per-frame time",
				values: [1, 2, 3, 5, 6, 7, 6, 5],
				min: 1,
				max: 7,
				last: "4.20 s",
			},
		],
	},
};
const meter: JobWidgetEntry = {
	id: "bash_4",
	kind: "bash",
	state: "live",
	updatedAtMs: 1,
	view: { title: "eval run", blocks: [{ kind: "meter", label: "trials", value: 0.6, text: "120/250" }] },
};
const headlineOnly: JobWidgetEntry = {
	id: "bash_5",
	kind: "bash",
	state: "live",
	updatedAtMs: 1,
	view: {
		title: "bench",
		headline: { text: "186 tok/s", label: "decode", trend: { text: "▲ 15%", tone: "success" } },
		blocks: [{ kind: "stat", items: [{ label: "p99", text: "212 ms" }] }],
	},
};
const pending: JobWidgetEntry = {
	id: "bash_6",
	kind: "bash",
	state: "pending",
	updatedAtMs: 1,
	view: { title: "make -j8", blocks: [], lines: 42 },
};
const fallback: JobWidgetEntry = {
	id: "bash_7",
	kind: "bash",
	state: "fallback",
	updatedAtMs: 1,
	view: { title: "npm test", stage: "PASS src/a.test.ts (12 tests)", blocks: [], lines: 9 },
};
const done: JobWidgetEntry = { ...spark, id: "bash_8", state: "done" };
const skipped: JobWidgetEntry = { id: "bash_9", kind: "bash", state: "skipped", updatedAtMs: 1 };

describe("job widget lines", () => {
	beforeAll(() => initTheme("dark"));

	const rows: Array<[string, JobWidgetEntry, string[]]> = [
		["spark", spark, ["bash_3", "Blender render · per-frame time", "▁▂▃▆▇█▇▆", "rendered 120 · 4.20 s"]],
		["meter", meter, ["bash_4", "eval run · trials", "[██████░░░░] 120/250"]],
		["headline", headlineOnly, ["bash_5", "bench", "decode 186 tok/s ▲ 15%"]],
		["pending", pending, ["bash_6", "make -j8", "reading output · 42 lines"]],
		["fallback", fallback, ["bash_7", "npm test", "PASS src/a.test.ts (12 tests)"]],
		["done", done, ["bash_8", "Blender render", "rendered 120 · 4.20 s"]],
	];

	for (const [name, entry, wanted] of rows) {
		it(`draws a ${name} job within 40, 80 and 120 columns`, () => {
			for (const width of [40, 80, 120]) {
				const line = formatJobWidgetLine(entry, width, jobWidgetLineStyle(theme, {}));
				expect(line, `${name} at ${width}`).toBeDefined();
				expect(visibleWidth(line ?? ""), `${name} at ${width}`).toBeLessThanOrEqual(width);
				expect(strip(line ?? "").startsWith(entry.id)).toBe(true);
			}
			const wide = strip(formatJobWidgetLine(entry, 120, jobWidgetLineStyle(theme, {})) ?? "");
			for (const part of wanted) expect(wide).toContain(part);
		});
	}

	it("keeps the numbers when the line is narrow: the label and title give way first", () => {
		const narrow = strip(formatJobWidgetLine(spark, 40, PLAIN_LINE_STYLE) ?? "");
		expect(narrow).toContain("rendered 120");
		expect(narrow).not.toContain("per-frame time");
	});

	const cjkSpark: JobWidgetEntry = {
		...spark,
		id: "bash_12",
		view: {
			title: "ブレンダーのレンダリング処理",
			headline: { text: "120", label: "rendered", trend: { text: "▲ 3%", tone: "success" } },
			blocks: spark.view?.blocks ?? [],
		},
	};
	const meterWithHeadline: JobWidgetEntry = {
		...meter,
		view: {
			title: "eval run",
			headline: { text: "186 tok/s", label: "decode", trend: { text: "▲ 15%", tone: "success" } },
			blocks: meter.view?.blocks ?? [],
		},
	};
	const narrowRows: Array<[string, JobWidgetEntry, number, string[]]> = [
		["CJK-titled spark", cjkSpark, 38, ["bash_12", "120 ▲ 3%", "4.20 s"]],
		["meter with a labelled, trended headline", meterWithHeadline, 40, ["bash_4", "120/250", "186 tok/s ▲ 15%"]],
		["meter with a labelled, trended headline", meterWithHeadline, 38, ["bash_4", "120/250", "186 tok/s ▲ 15%"]],
		["meter with a labelled, trended headline", meterWithHeadline, 30, ["bash_4", "120/250", "186 tok/s ▲ 15%"]],
		["meter-only job", meter, 30, ["bash_4", "eval run", "120/250"]],
	];
	for (const [name, entry, width, wanted] of narrowRows) {
		it(`keeps the numbers of a ${name} at ${width} columns`, () => {
			for (const style of [PLAIN_LINE_STYLE, jobWidgetLineStyle(theme, {})]) {
				const line = formatJobWidgetLine(entry, width, style) ?? "";
				expect(visibleWidth(line), `${name} at ${width}: ${strip(line)}`).toBeLessThanOrEqual(width);
				for (const part of wanted) expect(strip(line), `${name} at ${width}`).toContain(part);
			}
		});
	}

	const wideHeadlineLabel: JobWidgetEntry = {
		...spark,
		view: {
			title: "Blender render",
			headline: { text: "120", label: "frames rendered in this pass" },
			blocks: spark.view?.blocks ?? [],
		},
	};
	// Block label, then the chart, then the headline label with the chart back, then both.
	const orderRows: Array<[number, { blockLabel: boolean; chart: boolean; headlineLabel: boolean }]> = [
		[92, { blockLabel: true, chart: true, headlineLabel: true }],
		[91, { blockLabel: false, chart: true, headlineLabel: true }],
		[69, { blockLabel: false, chart: true, headlineLabel: true }],
		[68, { blockLabel: false, chart: false, headlineLabel: true }],
		[59, { blockLabel: false, chart: false, headlineLabel: true }],
		[58, { blockLabel: false, chart: true, headlineLabel: false }],
		[40, { blockLabel: false, chart: true, headlineLabel: false }],
		[39, { blockLabel: false, chart: false, headlineLabel: false }],
	];
	for (const [width, kept] of orderRows) {
		it(`gives way in order for a wide headline label at ${width} columns`, () => {
			const line = formatJobWidgetLine(wideHeadlineLabel, width, PLAIN_LINE_STYLE) ?? "";
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line).toContain("120 · 4.20 s");
			expect({
				blockLabel: line.includes("per-frame time"),
				chart: /[▁▂▃▄▅▆▇█]/.test(line),
				headlineLabel: line.includes("frames rendered in this pass"),
			}).toEqual(kept);
		});
	}

	it("draws nothing for a skipped job", () => {
		expect(formatJobWidgetLine(skipped, 80, PLAIN_LINE_STYLE)).toBeUndefined();
	});

	it("drops the id for a bash_output summary", () => {
		const line = formatJobWidgetLine(spark, 80, PLAIN_LINE_STYLE, { showId: false }) ?? "";
		expect(line.startsWith("Blender render")).toBe(true);
	});

	it("uses theme colors, and none at all under NO_COLOR", () => {
		expect(formatJobWidgetLine(spark, 80, jobWidgetLineStyle(theme, {}))).toMatch(ANSI);
		expect(formatJobWidgetLine(spark, 80, jobWidgetLineStyle(theme, { NO_COLOR: "1" }))).not.toMatch(/\x1b/);
	});

	it("scales sparks over 8 levels and shows only the newest columns", () => {
		expect(sparkGlyphs([0, 1, 2, 3, 4, 5, 6, 7], 0, 7, 8)).toBe("▁▂▃▄▅▆▇█");
		expect(sparkGlyphs([0, 7, 0, 7], 0, 7, 2)).toBe("▁█");
		expect(sparkGlyphs([3, 3], 3, 3, 8)).toBe("▅▅");
	});
});
