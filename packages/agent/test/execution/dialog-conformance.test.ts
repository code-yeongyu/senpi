// senpi#5823 (S26b: KILL-DIALOG, QX2.S26b FAULT-DIALOG-01): a remote dialog pending on the session while the hand is
// killed or its link faults, on a memory store and the in-process reference transport, through the suite runner's case map.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { DIALOG_CASES } from "../../src/execution/testing/dialog-cases.ts";
import { handAdapters } from "./hand-adapters.ts";

describe("dialog conformance (KILL-DIALOG, FAULT-DIALOG)", () => {
	for (const [id, run] of DIALOG_CASES) {
		it(id, async () => {
			await run(handAdapters("linux"));
		});
	}

	it("has a runnable implementation for every registered dialog case", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => /^(KILL|FAULT)-DIALOG-/.test(id));
		expect(registry.map(({ id }) => id)).toEqual(["KILL-DIALOG-01-SL", "KILL-DIALOG-01-XM", "FAULT-DIALOG-01"]);
		expect(findImplementationGaps(registry, DIALOG_CASES)).toEqual({ unimplemented: [], unregistered: [] });
	});
});
