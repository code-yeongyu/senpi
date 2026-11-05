// senpi#5482 (S27a: Z2.HAND, Z2.KILL, QX2.S27a): the KILL-HAND, MULTI-HAND/KILL and FAULT-HAND conformance cases on a
// memory store and the in-process reference transport, through the suite runner's case map.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { FAULT_HAND_CASES } from "../../src/execution/testing/fault-hand-cases.ts";
import { KILL_HAND_CASES, KILL_HAND_DECLARATIONS } from "../../src/execution/testing/kill-hand.ts";
import { MULTI_HAND_CASES } from "../../src/execution/testing/multi-hand-cases.ts";
import { handAdapters } from "./hand-adapters.ts";

const cases = new Map([...KILL_HAND_CASES, ...MULTI_HAND_CASES, ...FAULT_HAND_CASES]);

describe("hand conformance (KILL-HAND, MULTI-HAND, FAULT-HAND)", () => {
	for (const [id, run] of cases) {
		it(id, async () => {
			await run(handAdapters("linux"));
		});
	}

	it("has a runnable implementation for every registered hand case, both placements killed at every commit", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) =>
			/^(KILL-HAND-|MULTI-HAND-|MULTI-KILL-|FAULT-HAND-)/.test(id),
		);
		expect(findImplementationGaps(registry, cases)).toEqual({ unimplemented: [], unregistered: [] });
		expect(new Set(KILL_HAND_DECLARATIONS.map(({ placement }) => placement))).toEqual(
			new Set(["split-local", "cross-machine"]),
		);
		expect(KILL_HAND_DECLARATIONS).toHaveLength(32);
	});
});
