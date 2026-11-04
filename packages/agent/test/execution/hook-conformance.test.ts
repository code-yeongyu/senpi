// senpi#5726 (S33: KILL-HOOK): the user's machine killed around a forwarded loop-hook call and its reply, on the
// in-process reference transport, through the suite runner's case map.
import { describe, expect, it } from "vitest";
import { findImplementationGaps } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { KILL_HOOK_CASES, KILL_HOOK_DECLARATIONS } from "../../src/execution/testing/kill-hook.ts";
import { handAdapters } from "./hand-adapters.ts";

describe("loop-hook conformance (KILL-HOOK)", () => {
	for (const [id, run] of KILL_HOOK_CASES) {
		it(id, async () => {
			await run(handAdapters("linux"));
		});
	}

	it("registers every KILL-HOOK case with an implementation, killed at each point of the call", () => {
		const registry = CONFORMANCE_REGISTRY.filter(({ id }) => id.startsWith("KILL-HOOK-"));
		expect(findImplementationGaps(registry, KILL_HOOK_CASES)).toEqual({ unimplemented: [], unregistered: [] });
		expect(KILL_HOOK_DECLARATIONS.map(({ at }) => at)).toEqual([
			"received",
			"started",
			"ran",
			"replied",
			"committed",
		]);
	});
});
