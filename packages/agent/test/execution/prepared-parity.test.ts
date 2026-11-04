// S36 (senpi#5728): the prepared pipeline, now the loop's only one, answers every path the removed scheduler handled
// exactly as it did. Each expectation was read from that scheduler's code and pinned by hand, and proved against it
// before its removal (#5738, commit fce2238346).
import { expect, it } from "vitest";
import { observe } from "./prepared-parity-fixture.ts";
import { scenarios } from "./prepared-parity-scenarios.ts";

it.each(Object.entries(scenarios))("%s", async (_name, scenario) => {
	expect(await observe(scenario)).toEqual(scenario.expected);
});
