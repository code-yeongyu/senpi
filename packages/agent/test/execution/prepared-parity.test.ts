// S36 (senpi#5728): the prepared pipeline, now the loop's only one, answers every path the removed scheduler handled
// exactly as it did. Each expectation was read from that scheduler's code and pinned by hand, and proved against it
// before its removal (#5738, commit fce2238346). The one intended divergence is pinned on its own below.
import { expect, it } from "vitest";
import { call, observe } from "./prepared-parity-fixture.ts";
import { scenarios } from "./prepared-parity-scenarios.ts";

it.each(Object.entries(scenarios))("%s", async (_name, scenario) => {
	expect(await observe(scenario)).toEqual(scenario.expected);
});

// Intended divergence (S18b, e54a0082d8): the removed scheduler ran both calls of a batch that repeats a call ID, each
// effect twice under one ID, with two results the provider cannot tell apart. The prepared pipeline keys a call's
// command by that ID, so it refuses the whole batch before any call starts.
it("refuses a batch that repeats a call ID before any call runs", async () => {
	expect(
		await observe({
			calls: [call("dup", "echo", { n: 0 }), call("dup", "echo", { n: 1 })],
			expected: { starts: [], calls: {}, results: [], turns: 1 },
		}),
	).toMatchObject({
		starts: [],
		calls: {},
		results: [],
		error: expect.stringContaining("duplicate tool call id in one batch"),
	});
});
