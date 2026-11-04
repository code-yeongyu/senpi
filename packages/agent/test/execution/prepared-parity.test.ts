// S36 (senpi#5728): before the loop's own scheduler is removed, the prepared pipeline must answer every path that
// scheduler handles exactly as it does. Each expectation was read from the scheduler's code and pinned by hand; the
// `legacy` row proves it is today's behavior, the `prepared` row proves the replacement keeps it.
import { describe, expect, it } from "vitest";
import { observe, type Pipeline } from "./prepared-parity-fixture.ts";
import { scenarios } from "./prepared-parity-scenarios.ts";

const pipelines: readonly Pipeline[] = ["legacy", "prepared"];

describe.each(pipelines)("the %s pipeline", (pipeline) => {
	it.each(Object.entries(scenarios))("%s", async (_name, scenario) => {
		expect(await observe(pipeline, scenario)).toEqual(scenario.expected);
	});
});
