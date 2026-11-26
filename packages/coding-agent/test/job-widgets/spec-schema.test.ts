import { expect, it } from "vitest";

import {
	JOB_WIDGET_SPEC_SCHEMA,
	sampleLines,
	validateJobWidgetSpec,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { describeEachMatcher, harness, lineMatcher, ScriptedSource, validSpec } from "./support.ts";

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/** Paths of `value` the schema does not declare: a property the author model could never emit. */
function undeclared(value: unknown, schema: unknown, path: string): string[] {
	if (Array.isArray(value)) {
		const items = field(schema, "items");
		return items ? value.flatMap((entry, index) => undeclared(entry, items, `${path}[${index}]`)) : [path];
	}
	if (typeof value !== "object" || value === null) return [];
	const anyOf = field(schema, "anyOf");
	if (Array.isArray(anyOf)) {
		const objectSchema = anyOf.find((candidate) => field(candidate, "properties") !== undefined);
		return objectSchema ? undeclared(value, objectSchema, path) : [path];
	}
	if (field(schema, "additionalProperties") !== undefined) return [];
	return Object.entries(value).flatMap(([key, entry]) => {
		const child = field(field(schema, "properties"), key);
		return child ? undeclared(entry, child, `${path}.${key}`) : [`${path}.${key}`];
	});
}

describeEachMatcher("job widget respond-tool schema", () => {
	it("declares every property a spec using every block kind and option carries", () => {
		const spec = {
			title: "everything",
			rules: [
				{
					from: "out",
					match: String.raw`^(?P<name>\S+) (?P<state>\w+) ms=(?P<ms>\d+)`,
					key: "name",
					count: "runs",
					scale: 1,
				},
				{ from: "pipe:*", match: String.raw`^phase (?P<phase>.+)$`, text: "phase" },
			],
			blocks: [
				{
					kind: "spark",
					field: "ms",
					key: "a",
					label: "ms",
					unit: "ms",
					better: "lower",
					min: 0,
					max: 9,
					targetLabel: "t",
				},
				{ kind: "bars", field: "ms", agg: "mean", label: "ms", unit: "ms", max: 9, better: "lower" },
				{
					kind: "meter",
					field: "runs",
					agg: "count",
					total: { field: "ms", agg: "max", key: "a" },
					label: "runs",
					unit: "r",
				},
				{ kind: "grid", field: "state", label: "jobs", tones: { ok: "success" } },
			],
			headline: { field: "ms", agg: "last", key: "a", unit: "ms", digits: 1, better: "lower", label: "a" },
			stage: "phase",
		};
		const statAndText = {
			...spec,
			blocks: [
				{
					kind: "stat",
					items: [{ field: "ms", agg: "min", label: "best", unit: "ms", digits: 0, better: "lower" }],
				},
				{ kind: "text", field: "phase" },
			],
		};
		for (const candidate of [spec, statAndText, { skip: "nothing to chart" }]) {
			if (!("skip" in candidate)) validSpec(candidate);
			expect(undeclared(candidate, JOB_WIDGET_SPEC_SCHEMA, "spec")).toEqual([]);
		}
	});
});

describeEachMatcher("job widget samples", () => {
	it("hands the dry run its head and tail lines without overlap", () => {
		const out = new ScriptedSource("out");
		const h = harness(undefined, out);
		out.append(Array.from({ length: 35 }, (_, index) => `rps=${index}`).join("\n") + "\n");
		h.ingest();
		const [sample] = sampleLines(h.runtime.samples());
		expect(sample.lines).toEqual(Array.from({ length: 35 }, (_, index) => `rps=${index}`));
		const spec = {
			title: "t",
			rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
			blocks: [{ kind: "spark", field: "rps", label: "rps" }],
		};
		expect(validateJobWidgetSpec(spec, { matcher: lineMatcher(), samples: [sample] }).ok).toBe(true);
	});
});
