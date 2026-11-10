// S36 (senpi#5728): the prepared pipeline, now the loop's only one, answers every path the removed scheduler handled
// exactly as it did. Each expectation was read from that scheduler's code and pinned by hand, and proved against it
// before its removal (#5738, commit fce2238346). A batch that repeats a call ID is pinned on its own below.
import { expect, it } from "vitest";
import { call, observe } from "./prepared-parity-fixture.ts";
import { scenarios } from "./prepared-parity-scenarios.ts";

it.each(Object.entries(scenarios))("%s", async (_name, scenario) => {
	expect(await observe(scenario)).toEqual(scenario.expected);
});

// senpi#5796: a model may repeat a call ID inside one message. The removed scheduler ran each such block as its own call,
// and so does the prepared pipeline now: it keys a call's command by its block position, not the shared ID.
it("runs each block of a batch that repeats a call ID as its own call, as the removed scheduler did", async () => {
	expect(
		await observe({
			calls: [call("dup", "echo", { n: 0 }), call("dup", "echo", { n: 1 })],
			expected: { starts: [], calls: {}, results: [], turns: 1 },
		}),
	).toEqual({
		starts: ["dup echo", "dup echo"],
		calls: { dup: "start start update update end end msg msg" },
		results: ['dup echo ok {"n":0}', 'dup echo ok {"n":1}'],
		turns: 2,
	});
});
