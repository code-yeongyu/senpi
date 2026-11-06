import { expect, it } from "vitest";

import { MAX_MATCH_LINES } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { formatJobWidgetLine, PLAIN_LINE_STYLE } from "../../src/core/extensions/builtin/job-widgets/tui-line.ts";
import { block, describeEachMatcher, harness, ScriptedSource, START, validSpec } from "./support.ts";

const BLENDER_SPEC = {
	title: "Blender render · per-frame time",
	rules: [
		{ from: "out", match: String.raw`^\s*Time: \d+:(?P<frame_s>[\d.]+) \(Saving`, count: "frames" },
		{ from: "out", match: String.raw`Mem:[\d.]+M \(Peak (?P<peak_mb>[\d.]+)M\)` },
		{ from: "out", match: String.raw`^(?P<now>Fra:\d+ .*Rendering \d+ / \d+ samples)$`, text: "now" },
	],
	blocks: [
		{
			kind: "spark",
			field: "frame_s",
			label: "seconds per frame",
			unit: "s",
			better: "lower",
			target: 5,
			targetLabel: "budget 5 s",
		},
		{ kind: "meter", field: "frames", agg: "count", total: 250, label: "frames" },
		{
			kind: "stat",
			items: [
				{ field: "frame_s", agg: "last", label: "last frame", unit: "s", better: "lower" },
				{ field: "peak_mb", agg: "max", label: "peak mem", unit: "MB" },
			],
		},
	],
	headline: { field: "frames", agg: "count", label: "rendered" },
	stage: "now",
};

const BLENDER_LINES = [
	"Fra:120 Mem:2104.32M (Peak 2311.04M) | Time:00:03.81 | Rendering 64 / 64 samples",
	" Time: 00:03.90 (Saving: 00:00.09)",
	"Fra:121 Mem:2110.10M (Peak 2320.40M) | Time:00:04.20 | Rendering 64 / 64 samples",
	" Time: 00:04.30 (Saving: 00:00.10)",
];

describeEachMatcher("job widget derivation", () => {
	it("charts a Blender render: frame times against the budget, frames toward the stated total", () => {
		const spec = validSpec(
			BLENDER_SPEC,
			[{ id: "out", lines: BLENDER_LINES }],
			"blender -b scene.blend -a -e 250  # budget 5 s per frame",
		);
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(`${BLENDER_LINES.join("\n")}\n`);
		h.ingest();
		const derived = h.derive();
		expect(derived.state).toBe("live");
		expect(derived.view.headline).toEqual({ text: "2", label: "rendered" });
		expect(derived.view.stage).toBe(BLENDER_LINES[2]);
		const spark = block(derived, "spark");
		expect(spark).toMatchObject({ values: [3.9, 4.3], last: "4.30 s", marks: [{ value: 5, label: "budget 5 s" }] });
		expect(spark.min).toBeCloseTo(3.79);
		expect(spark.max).toBeCloseTo(5.11);
		expect(block(derived, "meter")).toEqual({ kind: "meter", label: "frames", value: 2 / 250, text: "2/250" });
		expect(block(derived, "stat").items).toEqual([
			{ label: "last frame", text: "4.30 s", trend: { text: "▲ 10%", tone: "error" } },
			{ label: "peak mem", text: "2320 MB" },
		]);
	});

	it("counts nextest PASS lines and shows the latest FAIL, leaving out blocks with nothing yet", () => {
		const spec = validSpec({
			title: "nextest",
			rules: [
				{ from: "out", match: String.raw`^\s*PASS \[`, count: "pass" },
				{ from: "out", match: String.raw`^\s*FAIL \[\s*[\d.]+s\] (?P<fail>.+)$`, text: "fail" },
				{ from: "out", match: String.raw`^\s*(?:PASS|FAIL) \[\s*(?<secs>[\d.]+)s\]` },
			],
			blocks: [
				{ kind: "spark", field: "secs", label: "duration", unit: "s" },
				{ kind: "stat", items: [{ field: "pass", agg: "count", label: "passed" }] },
				{ kind: "text", field: "fail" },
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		h.ingest();
		expect(h.derive().view.blocks).toEqual([{ kind: "stat", items: [{ label: "passed", text: "0" }] }]);
		out.append("        PASS [   0.012s] pi-natives line_match::tests::named_groups\n");
		out.append("        FAIL [   0.020s] pi-natives line_match::tests::invalid\n");
		h.ingest();
		const blocks = h.derive().view.blocks;
		expect(blocks[0]).toMatchObject({ kind: "spark", label: "duration", values: [0.012, 0.02], last: "0.02 s" });
		expect(blocks.slice(1)).toEqual([
			{ kind: "stat", items: [{ label: "passed", text: "1" }] },
			{ kind: "text", text: "pi-natives line_match::tests::invalid" },
		]);
	});

	it("colours a CI status grid by each job's latest status word", () => {
		const spec = validSpec({
			title: "CI",
			rules: [{ from: "*", match: String.raw`^(?P<mark>[✓✗*])\s+(?P<name>\S+)`, key: "name", text: "mark" }],
			blocks: [
				{ kind: "grid", field: "mark", label: "jobs", tones: { "✓": "success", "✗": "error", "*": "pending" } },
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("✓ lint (1m02s)\n✗ test-linux (4m11s)\n* build-macos\n");
		h.ingest();
		out.append("✓ build-macos (6m40s)\n");
		h.ingest();
		expect(block(h.derive(), "grid").cells).toEqual([
			{ key: "lint", tone: "success", text: "✓" },
			{ key: "test-linux", tone: "error", text: "✗" },
			{ key: "build-macos", tone: "success", text: "✓" },
		]);
	});

	it("draws eval results as bars per model and a keyed headline for one model", () => {
		const finish = String.raw`^finish \S+ (?P<model>\S+) t\d+: reward=(?P<reward>[\d.]+) tests=(?P<passed>\d+)/(?P<all>\d+)`;
		const lines = [
			"finish bash openai/gpt-6-luna t1: reward=1 tests=36/36 stop=done",
			"finish bash anthropic/claude-sonnet-5 t1: reward=0 tests=20/36 stop=done",
			"finish bash openai/gpt-6-luna t2: reward=0 tests=27/36 stop=done",
			"finish bash anthropic/claude-sonnet-5 t2: reward=1 tests=36/36 stop=done",
		];
		const spec = validSpec(
			{
				title: "eval · tests passed",
				rules: [{ from: "out", match: finish, key: "model", count: "trials" }],
				blocks: [
					{ kind: "bars", field: "passed", agg: "mean", label: "tests passed", max: 36 },
					{ kind: "meter", field: "trials", agg: "count", total: 9, label: "trials", unit: "trials" },
				],
				headline: { field: "passed", agg: "last", key: "openai/gpt-6-luna", label: "luna" },
			},
			[{ id: "out", lines }],
			"eval --models 2 --trials 9",
		);
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(`start bash openai/gpt-6-luna t1\n${lines.join("\n")}\n`);
		h.ingest();
		const derived = h.derive();
		expect(block(derived, "bars")).toEqual({
			kind: "bars",
			label: "tests passed",
			max: 36,
			items: [
				{ key: "gpt-6-luna", value: 31.5, text: "31.5" },
				{ key: "claude-sonnet-5", value: 28, text: "28" },
			],
		});
		expect(block(derived, "meter")).toMatchObject({ value: 4 / 9, text: "4/9 trials" });
		expect(derived.view.headline).toEqual({ text: "27", label: "luna" });
	});

	it("draws load-test throughput as a spark with its target mark and a trending headline", () => {
		const spec = validSpec({
			title: "load test",
			rules: [{ from: "pipe:*", match: String.raw`^req \d+ rps=(?P<rps>[\d.]+)` }],
			blocks: [{ kind: "spark", field: "rps", label: "req/s", unit: "req/s", better: "higher", target: 60 }],
			headline: { field: "rps", agg: "last", unit: "req/s", better: "higher" },
		});
		const pipe = new ScriptedSource("pipe:1");
		const out = new ScriptedSource("out");
		const h = harness(spec, pipe, out);
		pipe.append("warming up\nreq 1 rps=40\nreq 2 rps=48\n");
		out.append("req 9 rps=999\n");
		h.ingest();
		pipe.append("req 8 rps=56\n");
		h.ingest();
		const derived = h.derive();
		expect(derived.view.headline).toEqual({ text: "56 req/s", trend: { text: "▲ 40%", tone: "success" } });
		expect(block(derived, "spark")).toMatchObject({
			values: [40, 48, 56],
			last: "56 req/s",
			marks: [{ value: 60, label: "target 60 req/s" }],
		});
		expect(derived.view.stage).toBe("warming up");
	});

	it("keeps at most 48 spark points from the newest series values", () => {
		const spec = validSpec({
			title: "steps",
			rules: [{ from: "out", match: String.raw`^step (?P<step>\d+)` }],
			blocks: [{ kind: "spark", field: "step", label: "step" }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		for (const [from, to] of [
			[1, 400],
			[401, 1000],
		]) {
			for (let step = from; step <= to; step++) out.append(`step ${step}\n`);
			h.ingest();
		}
		const spark = block(h.derive(), "spark");
		expect(spark.values).toHaveLength(48);
		expect(spark.values[0]).toBe(763);
		expect(spark.last).toBe("1000");
	});

	const STEP_LINES = ["step 23/60 loss=1.540 acc=0.580", "step 24/60 loss=1.509 acc=0.590"];
	const STEPS_TOTAL = { field: "steps", agg: "last" };
	it.each([
		["a literal total", { total: 60 }, "24/60"],
		["a literal total and a unit restating it", { total: 60, unit: "/60" }, "24/60"],
		["a literal total and a spaced restating unit", { total: 60, unit: "/ 60" }, "24/60"],
		["a literal total and a unit restating it before a real unit", { total: 60, unit: "of 60 steps" }, "24/60 steps"],
		["a total key", { total: STEPS_TOTAL }, "24/60"],
		["a total key and a unit restating it", { total: STEPS_TOTAL, unit: "/60" }, "24/60"],
		["a total key and a real unit", { total: STEPS_TOTAL, unit: "steps" }, "24/60 steps"],
		["a label containing the total", { total: 60, label: "steps of 60" }, "24/60"],
	])("shows a meter's count once with %s", (_name, meter, text) => {
		const spec = validSpec(
			{
				title: "training",
				rules: [{ from: "out", match: String.raw`^step (?P<step>\d+)/(?P<steps>\d+)` }],
				blocks: [{ kind: "meter", field: "step", agg: "last", label: "steps", ...meter }],
			},
			[{ id: "out", lines: STEP_LINES }],
			"python train.py --steps 60",
		);
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(`${STEP_LINES.join("\n")}\n`);
		h.ingest();
		const derived = h.derive();
		expect(block(derived, "meter")).toMatchObject({ value: 24 / 60, text });
		const line = formatJobWidgetLine(
			{ id: "bash_1", kind: "bash", state: "live", view: derived.view, updatedAtMs: START },
			120,
			PLAIN_LINE_STYLE,
		);
		expect(line).toContain(`] ${text}`);
		expect(line?.split("60").length).toBe("label" in meter ? 3 : 2);
	});

	it("draws a meter whose total is unknown as its value alone", () => {
		const spec = validSpec({
			title: "training",
			rules: [{ from: "out", match: String.raw`^step (?P<step>\d+)/(?P<steps>\d+)` }],
			blocks: [{ kind: "meter", field: "step", agg: "last", label: "steps", total: "?" }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(`${STEP_LINES.join("\n")}\n`);
		h.ingest();
		expect(h.derive().view.blocks).toEqual([{ kind: "stat", items: [{ label: "steps", text: "24" }] }]);
	});

	it("matches only the newest lines of a burst but counts every line", () => {
		const spec = validSpec({
			title: "burst",
			rules: [{ from: "out", match: "^tick", count: "ticks" }],
			blocks: [{ kind: "stat", items: [{ field: "ticks", agg: "count", label: "ticks" }] }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("tick\n".repeat(MAX_MATCH_LINES + 500));
		h.ingest();
		expect(block(h.derive(), "stat").items[0].text).toBe(String(MAX_MATCH_LINES));
		expect(h.runtime.totalLines).toBe(MAX_MATCH_LINES + 500);
	});
});
