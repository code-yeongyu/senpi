import { expect, it } from "vitest";

import {
	JOB_WIDGET_SPEC_SCHEMA,
	jobWidgetSkip,
	type JobWidgetSampleLines,
	validateJobWidgetSpec,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { describeEachMatcher, lineMatcher, validSpec } from "./support.ts";

const base = {
	title: "t",
	rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
	blocks: [{ kind: "spark", field: "rps", label: "rps" }],
};

function errorsOf(value: unknown, samples?: readonly JobWidgetSampleLines[], brief?: string): string[] {
	const checked = validateJobWidgetSpec(value, { matcher: lineMatcher(), samples, brief });
	return checked.ok ? [] : checked.errors;
}

const withRule = (match: string) => ({ ...base, rules: [{ from: "out", match }] });

describeEachMatcher("job widget spec validation rejects", () => {
	const rejections: [string, unknown, string][] = [
		["lookbehind", withRule(String.raw`(?<=rps=)(?P<rps>\d+)`), "rules[0].match: lookaround"],
		["negative lookahead", withRule(String.raw`rps=(?!0)(?P<rps>\d+)`), "rules[0].match: lookaround"],
		["a numbered backreference", withRule(String.raw`(?P<rps>\d)\1`), "rules[0].match: backreference \\1"],
		["a named backreference", withRule(String.raw`(?<rps>\d)\k<rps>`), "rules[0].match: named backreference"],
		[
			"a pattern over 400 characters",
			withRule(`(?P<rps>\\d+)${"x".repeat(390)}`),
			"rules[0].match: at most 400 characters",
		],
		[
			"more than 12 rules",
			{ ...base, rules: Array.from({ length: 13 }, () => base.rules[0]) },
			"rules: expected 1–12 entries, got 13",
		],
		[
			"more than 4 blocks",
			{ ...base, blocks: Array.from({ length: 5 }, () => base.blocks[0]) },
			"blocks: expected 1–4 entries, got 5",
		],
		[
			"a block reading a field no rule feeds",
			{ ...base, blocks: [{ kind: "text", field: "phase" }] },
			'blocks[0] (text): unknown field "phase"; no rule has a group (?P<phase>…) or count "phase"',
		],
		[
			"a numeric aggregation over a match count",
			{
				...base,
				rules: [{ from: "out", match: "^done", count: "done" }],
				blocks: [{ kind: "stat", items: [{ field: "done", agg: "mean", label: "avg" }] }],
			},
			'blocks[0] (stat).items[0]: agg "mean" needs numbers, but field "done" only counts matches or keeps text',
		],
		[
			"a block key naming the key group",
			{
				title: "bench",
				rules: [{ from: "out", match: String.raw`^model=(?P<model>\S+) tok=(?P<tok>\d+)`, key: "model" }],
				blocks: [{ kind: "spark", field: "tok", label: "tok/s", key: "model" }],
			},
			'blocks[0] (spark).key: "model" is the name of the key group',
		],
		[
			"a grid tone outside the contract",
			{ ...base, blocks: [{ kind: "grid", field: "rps", label: "jobs", tones: { ok: "accent" } }] },
			"blocks[0].tones.ok: expected one of success, error, warning, pending, info, muted, neutral",
		],
	];

	it.each(rejections)("%s", (_name, spec, message) => {
		const errors = errorsOf(spec);
		expect(errors.some((error) => error.startsWith(message))).toBe(true);
	});

	it("a pattern the engine cannot compile, naming the rule", () => {
		expect(errorsOf(withRule(String.raw`rps=(?P<rps>\d+`))).toEqual([expect.stringMatching(/^rules\[0\]\.match: /)]);
	});

	it("a constant meter total or spark target the job never states", () => {
		const spec = {
			...base,
			blocks: [
				{ kind: "spark", field: "rps", label: "req/s", target: 60 },
				{ kind: "meter", field: "rps", agg: "count", total: 100, label: "ticks" },
			],
		};
		const samples = [{ id: "out", lines: ["rps=56 after 40 of 75 ticks"] }];
		expect(errorsOf(spec, samples, "bench --rps")).toEqual([
			"blocks[0] (spark).target: 60 appears nowhere in the job or its output; set a target only when the job states one",
			"blocks[1] (meter).total: 100 appears nowhere in the job or its output; read the total from a line (a value ref) or show the value as a stat",
		]);
		const stated = {
			...spec,
			blocks: [
				{ ...spec.blocks[0], target: 1200 },
				{ ...spec.blocks[1], total: 75 },
			],
		};
		expect(errorsOf(stated, samples, "bench --rps, goal 1.2k req/s")).toEqual([]);
	});

	it("rules that match no sample line, or capture words where numbers are read", () => {
		expect(errorsOf(base, [{ id: "out", lines: ["throughput 56/s"] }])).toEqual([
			"no rule matches any sample line; copy the exact text of lines that carry the numbers",
		]);
		const words = withRule(String.raw`rps=(?P<rps>\S+)`);
		expect(errorsOf(words, [{ id: "out", lines: ["rps=n/a"] }])).toEqual([
			'blocks[0] (spark): field "rps" needs numbers, but its group captured "n/a" in the samples; capture only the digits',
		]);
		expect(errorsOf(words, [{ id: "out", lines: ["rps=n/a", "rps=56"] }])).toEqual([]);
	});

	it("rules reading the tool-call marker lines of a subagent's tool results", () => {
		const spec = {
			title: "subagent",
			rules: [{ from: "tools", match: "^» ", count: "calls" }],
			blocks: [{ kind: "stat", items: [{ field: "calls", agg: "count", label: "tool calls" }] }],
		};
		const [error] = errorsOf(spec, [{ id: "tools", lines: ["» bash run the bench", "BENCH tok_s=171"] }]);
		expect(error).toMatch(/^rules\[0\]: matches `» <tool> <intent>` lines/);
	});
});

describeEachMatcher("job widget spec local repairs", () => {
	it("accepts both named-group spellings", () => {
		const spec = validSpec({
			...base,
			rules: [
				{ from: "out", match: String.raw`rps=(?P<rps>\d+)` },
				{ from: "out", match: String.raw`p99=(?<p99>\d+)` },
			],
			blocks: [{ kind: "stat", items: [{ field: "p99", agg: "last", label: "p99" }] }, base.blocks[0]],
		});
		expect(spec.rules.map((rule) => rule.match)).toEqual([String.raw`rps=(?P<rps>\d+)`, String.raw`p99=(?<p99>\d+)`]);
	});

	it("draws a meter with an unknown total as a stat and reads a numeric-string total", () => {
		for (const total of [undefined, "<UNKNOWN>", null]) {
			expect(
				validSpec({ ...base, blocks: [{ kind: "meter", field: "rps", agg: "count", label: "req", total }] }).blocks,
			).toEqual([{ kind: "stat", items: [{ field: "rps", agg: "count", label: "req" }] }]);
		}
		const spec = validSpec({
			...base,
			blocks: [{ kind: "meter", field: "rps", agg: "count", label: "req", total: "96" }],
		});
		expect(spec.blocks[0]).toEqual({ kind: "meter", field: "rps", agg: "count", total: 96, label: "req" });
	});

	// The schema requires only `kind` on a block, so an absent bars or meter `agg` must not cost a retry.
	const aggDefaults: [string, Record<string, unknown>, unknown][] = [
		[
			"bars without agg",
			{ kind: "bars", field: "rps", label: "rps" },
			{ kind: "bars", field: "rps", agg: "last", label: "rps" },
		],
		[
			"bars with a null agg",
			{ kind: "bars", field: "rps", agg: null, label: "rps" },
			{ kind: "bars", field: "rps", agg: "last", label: "rps" },
		],
		[
			"a meter without agg",
			{ kind: "meter", field: "rps", total: { field: "rps", agg: "max" }, label: "rps" },
			{ kind: "meter", field: "rps", agg: "last", total: { field: "rps", agg: "max" }, label: "rps" },
		],
		[
			"a meter without agg or a known total",
			{ kind: "meter", field: "rps", label: "rps" },
			{ kind: "stat", items: [{ field: "rps", agg: "last", label: "rps" }] },
		],
	];

	it.each(aggDefaults)("reads %s as agg last", (_name, authored, parsed) => {
		const blockSchema = (JOB_WIDGET_SPEC_SCHEMA.properties as { blocks: { items: { required: string[] } } }).blocks
			.items;
		expect(blockSchema.required).not.toContain("agg");
		const rules = [{ from: "out", match: String.raw`(?P<host>\S+) rps=(?P<rps>\d+)`, key: "host" }];
		expect(validSpec({ ...base, rules, blocks: [authored] }).blocks).toEqual([parsed]);
	});

	it("still rejects an agg outside the contract, and an absent agg where the schema requires one", () => {
		expect(errorsOf({ ...base, blocks: [{ kind: "bars", field: "rps", agg: "avg", label: "rps" }] })).toEqual([
			"blocks[0].agg: expected one of last, first, min, max, mean, sum, count, rate, delta, change",
		]);
		const refSchema = (JOB_WIDGET_SPEC_SCHEMA.properties as { headline: { required: string[] } }).headline;
		expect(refSchema.required).toContain("agg");
		expect(errorsOf({ ...base, headline: { field: "rps" } })).toEqual([
			"headline.agg: expected one of last, first, min, max, mean, sum, count, rate, delta, change",
		]);
	});

	it("wraps a groupless pattern in its `text` group and drops roles naming missing groups", () => {
		const wrapped = validSpec({
			title: "pip",
			rules: [{ from: "out", match: "^(?:Installing|Successfully installed)", text: "phase" }],
			blocks: [{ kind: "text", field: "phase" }],
		});
		expect(wrapped.rules[0].match).toBe("(?P<phase>^(?:Installing|Successfully installed))");
		const dropped = validSpec({
			title: "build",
			rules: [{ from: "out", match: String.raw`^Finished .*in (?P<secs>[\d.]+)s`, text: "done", key: "profile" }],
			blocks: [{ kind: "spark", field: "secs", label: "s" }],
		});
		expect(dropped.rules).toEqual([{ from: "out", match: String.raw`^Finished .*in (?P<secs>[\d.]+)s` }]);
	});

	it("cuts an overlong title and labels to fit instead of rejecting them", () => {
		const spec = validSpec({
			...base,
			title: "loadtest · keep-alive pool · 256 connections · goal 2000 rps",
			blocks: [{ kind: "spark", field: "rps", label: "rps", unit: "requests/second" }],
		});
		expect(spec.title).toBe("loadtest · keep-alive pool · 256 connections · …");
		expect(spec.blocks[0]).toMatchObject({ unit: "requests/se…" });
	});

	it("reads a skip answer as declining to draw", () => {
		expect(jobWidgetSkip({ skip: " no quantity worth charting " })).toBe("no quantity worth charting");
		expect(jobWidgetSkip({ skip: "  " })).toBeUndefined();
		expect(jobWidgetSkip(base)).toBeUndefined();
	});
});
