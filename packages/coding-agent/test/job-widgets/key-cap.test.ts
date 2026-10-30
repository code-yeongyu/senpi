import { describe, expect, it } from "vitest";

import { FieldStore, MAX_FIELD_KEYS } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { block, harness, ScriptedSource, validSpec } from "./support.ts";

const KEYS = 100_000;

function match(value: number) {
	return { value, text: undefined, line: `v=${value}`, t: 0 };
}

describe("job widget keys per field", () => {
	it("holds at most MAX_FIELD_KEYS series after 100,000 distinct keys, evicting the oldest first-seen", () => {
		const store = new FieldStore(new Set(["ms"]), new Map([["ms", new Set(["k0"])]]));
		for (let index = 0; index < KEYS; index++) store.push("ms", `k${index}`, match(index));

		expect(MAX_FIELD_KEYS).toBe(256);
		expect(store.keyCount("ms")).toBe(MAX_FIELD_KEYS);
		expect(store.series("ms").count).toBe(KEYS);
		expect(store.series("ms", "k0")).toMatchObject({ count: 1, last: 0 });
		expect(store.series("ms", "k1").count).toBe(0);
		const kept = store.keys("ms", MAX_FIELD_KEYS).map(([key]) => key);
		expect(kept[0]).toBe("k0");
		expect(kept.slice(1)).toEqual(Array.from({ length: MAX_FIELD_KEYS - 1 }, (_, i) => `k${KEYS - 255 + i}`));
	});

	const views: [number, string[]][] = [
		[16, Array.from({ length: 16 }, (_, i) => `k${KEYS - 16 + i}`)],
		[48, Array.from({ length: 48 }, (_, i) => `k${KEYS - 48 + i}`)],
		[0, []],
	];

	it.each(views)("hands a view only the newest %i keys", (limit, newest) => {
		const store = new FieldStore(new Set(["ms"]));
		for (let index = 0; index < KEYS; index++) store.push("ms", `k${index}`, match(index));
		expect(store.keys("ms", limit).map(([key]) => key)).toEqual(newest);
	});

	it("keeps a key seen again at its first-seen place until it is evicted", () => {
		const store = new FieldStore(new Set(["ms"]));
		for (let index = 0; index < MAX_FIELD_KEYS; index++) store.push("ms", `k${index}`, match(index));
		store.push("ms", "k0", match(7));
		store.push("ms", "new", match(1));
		// k0 was first seen first, so it is the one evicted; its repeat did not move it.
		expect(store.series("ms", "k0").count).toBe(0);
		expect(store.keys("ms", 2).map(([key]) => key)).toEqual([`k${MAX_FIELD_KEYS - 1}`, "new"]);
	});

	it("draws the newest bars and grid keys and a pinned headline key after more keys than the cap", () => {
		const keys = 1_000;
		const lines = Array.from({ length: keys }, (_, index) => `t${index} ok ms=${index}`);
		const spec = validSpec(
			{
				title: "tests",
				rules: [{ from: "out", match: String.raw`^(?P<name>\S+) (?P<state>\w+) ms=(?P<ms>\d+)`, key: "name" }],
				blocks: [
					{ kind: "bars", field: "ms", agg: "last", label: "ms" },
					{ kind: "grid", field: "state", label: "tests", tones: { ok: "success" } },
				],
				headline: { field: "ms", agg: "last", key: "t0", label: "first" },
			},
			[{ id: "out", lines: lines.slice(0, 3) }],
		);
		const out = new ScriptedSource("out");
		const h = harness(spec, out);
		out.append(`${lines.join("\n")}\n`);
		h.ingest();
		const derived = h.derive();
		expect(block(derived, "bars").items.map((item) => item.key)).toEqual(
			Array.from({ length: 16 }, (_, i) => `t${keys - 16 + i}`),
		);
		expect(block(derived, "grid").cells.map((cell) => cell.key)).toEqual(
			Array.from({ length: 48 }, (_, i) => `t${keys - 48 + i}`),
		);
		expect(derived.view.headline).toEqual({ text: "0", label: "first" });
	});
});
