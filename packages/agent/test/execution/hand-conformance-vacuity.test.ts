// senpi#5482 (S27a): FAULT-HAND-MULTI-01 must fail when the hand is never made unreachable. The harness here keeps the
// link up (its disconnect and reconnect do nothing), so the case's "dependent calls pause" assertion has to catch a
// scope settling during the window it claims is unreachable.
import { describe, expect, it, vi } from "vitest";
import { FAULT_HAND_CASES } from "../../src/execution/testing/fault-hand-cases.ts";
import type * as Harness from "../../src/execution/testing/hand-harness.ts";
import { handAdapters } from "./hand-adapters.ts";

vi.mock("../../src/execution/testing/hand-harness.ts", async (importOriginal) => {
	const harness = await importOriginal<typeof Harness>();
	return {
		...harness,
		openHandRig: async (...args: Parameters<typeof harness.openHandRig>) => ({
			...(await harness.openHandRig(...args)),
			disconnect: () => {},
			reconnect: () => {},
		}),
	};
});

describe("FAULT-HAND-MULTI-01 vacuity", () => {
	it("fails when the link between session and hand never drops", async () => {
		const run = FAULT_HAND_CASES.get("FAULT-HAND-MULTI-01");
		if (run === undefined) throw new Error("no implementation for FAULT-HAND-MULTI-01");
		await expect(run(handAdapters("linux"))).rejects.toThrow(
			"FAULT-HAND-MULTI-01: dependent calls pause while the hand is unreachable",
		);
	});
});
