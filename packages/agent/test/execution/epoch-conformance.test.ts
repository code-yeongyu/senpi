// senpi#5729 (S35: R7.e, Z2.EPOCH.S35): the EPOCH, MULTI-EPOCH and KILL-EPOCH conformance cases on a memory store and
// the in-process reference transport, through the suite runner's case map.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { EPOCH_CASES } from "../../src/execution/testing/epoch-cases.ts";
import { KILL_EPOCH_CASES } from "../../src/execution/testing/kill-epoch.ts";
import { MULTI_EPOCH_CASES } from "../../src/execution/testing/multi-epoch-cases.ts";
import { handAdapters } from "./hand-adapters.ts";

const cases = new Map([...EPOCH_CASES, ...MULTI_EPOCH_CASES, ...KILL_EPOCH_CASES]);

describe("epoch floor conformance (EPOCH, MULTI-EPOCH, KILL-EPOCH)", () => {
	for (const [id, run] of cases) {
		it(id, async () => {
			await run(handAdapters("linux"));
		});
	}

	it("has a runnable implementation for every registered epoch case", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(EPOCH-|MULTI-EPOCH-|KILL-EPOCH-)/.test(id));
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
		expect(registry.map(({ id }) => id)).toEqual([
			"EPOCH-01",
			"EPOCH-02",
			"EPOCH-03",
			"MULTI-EPOCH-01",
			"KILL-EPOCH-01-B",
			"KILL-EPOCH-01-D",
			"KILL-EPOCH-02-B",
			"KILL-EPOCH-02-D",
		]);
	});
});
