import { expect, it } from "vitest";

import type { JobWidgetAgg } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { describeEachMatcher, harness, ScriptedSource, validSpec } from "./support.ts";

describeEachMatcher("job widget aggregations", () => {
	const cases: [JobWidgetAgg, string | undefined][] = [
		["last", "8"],
		["first", "4"],
		["min", "2"],
		["max", "8"],
		["mean", "4.67"],
		["sum", "14"],
		["count", "3"],
		["rate", "0.30"],
		["delta", "4"],
		["change", "100%"],
	];

	it.each(cases)("reduces 4, 2, 8 with %s", (agg, text) => {
		const spec = validSpec({
			title: "agg",
			rules: [{ from: "out", match: String.raw`^ms=(?P<ms>-?[\d.,]+[kKMG]?)` }],
			blocks: [{ kind: "stat", items: [{ field: "ms", agg, label: agg }] }],
			headline: { field: "ms", agg },
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("ms=4\nms=2\nms=8\n");
		h.advance(10_000);
		h.ingest();
		expect(h.derive().view.headline?.text).toBe(text);
	});

	it("reports counts but no values for an empty field, and reads separators and suffixes", () => {
		const spec = validSpec({
			title: "agg",
			rules: [{ from: "out", match: String.raw`^ms=(?P<ms>[\d.,]+[kKMG]?)` }],
			blocks: [
				{
					kind: "stat",
					items: [
						{ field: "ms", agg: "last", label: "last", unit: "ms" },
						{ field: "ms", agg: "count", label: "count" },
						{ field: "ms", agg: "change", label: "change" },
					],
				},
			],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		h.ingest();
		const texts = () => h.derive().view.blocks.flatMap((entry) => (entry.kind === "stat" ? entry.items : []));
		expect(texts().map((item) => item.text)).toEqual(["-", "0", "-"]);
		out.append("ms=0\nms=1,250\nms=1.5k\n");
		h.ingest();
		expect(texts().map((item) => item.text)).toEqual(["1500 ms", "3", "-"]);
	});
});

describeEachMatcher("job widget states", () => {
	it("is pending while a spec is authored, with the lines read so far", () => {
		const out = new ScriptedSource("out");
		const h = harness(undefined, out);
		out.append("compiling a\ncompiling b\n");
		h.ingest();
		expect(h.derive({ authoring: true })).toEqual({
			state: "pending",
			view: { title: "bench job", stage: "compiling b", blocks: [], lines: 2 },
			updatedAtMs: 1_000_000,
		});
	});

	it("falls back to the latest line, a pipe preferred, with ANSI stripped", () => {
		const pipe = new ScriptedSource("pipe:1");
		const out = new ScriptedSource("out");
		const h = harness(undefined, out, pipe);
		pipe.append("compiling a\ncompiling b\n");
		out.append("\x1b[32mwarning: unused\x1b[0m\r\n");
		h.ingest();
		expect(h.derive().state).toBe("fallback");
		expect(h.derive().view).toEqual({ title: "bench job", stage: "compiling b", blocks: [], lines: 3 });
		expect(h.runtime.samples().map((sample) => sample.head)).toEqual([
			["compiling a", "compiling b"],
			["warning: unused"],
		]);
	});

	it("freezes a spec-driven view as done once the job settles", () => {
		const spec = validSpec({
			title: "bench",
			rules: [{ from: "out", match: String.raw`tok=(?P<tok>\d+)` }],
			blocks: [{ kind: "stat", items: [{ field: "tok", agg: "last", label: "tok/s" }] }],
		});
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append("tok=186\n");
		h.advance(2_000);
		h.ingest(true);
		expect(h.derive({ settled: true })).toEqual({
			state: "done",
			view: { title: "bench", blocks: [{ kind: "stat", items: [{ label: "tok/s", text: "186" }] }] },
			updatedAtMs: 1_002_000,
		});
	});

	it("takes a subagent's stage from its own words, never from its tool results", () => {
		const spec = validSpec({
			title: "decode",
			rules: [{ from: "tools", match: String.raw`^BENCH tok_s=(?P<tok>[\d.]+)` }],
			blocks: [{ kind: "spark", field: "tok", label: "tok/s" }],
		});
		for (const installed of [undefined, spec]) {
			const tools = new ScriptedSource("tools");
			const h = harness(installed, tools);
			tools.append("» read src/decode.rs\n34:};\nBENCH tok_s=171\n");
			h.ingest();
			expect(h.derive({ lineStage: false }).view.stage).toBeUndefined();
			expect(h.derive({ lineStage: false, stage: "fusing the quantize step" }).view.stage).toBe(
				"fusing the quantize step",
			);
		}
	});
});
