import { describe, expect, it } from "vitest";
import { retryNotBefore } from "../../../src/harness/runtime/drive/retry.ts";

describe("runtime retry delay", () => {
	it("uses capped delay when computing retry readiness", () => {
		// Regression for #8826.
		// The fork's retryDelayMs applies +/-10% jitter before the cap, so the jitter source is
		// pinned to its maximum here to assert the cap deterministically.
		expect(retryNotBefore({ baseDelayMs: 2000, maxAgentDelayMs: 30000, random: () => 1 }, 5, 100)).toBe(30100);
	});

	it("keeps an uncapped delay inside the jitter band", () => {
		expect(retryNotBefore({ baseDelayMs: 1000, maxAgentDelayMs: 30000, random: () => 0 }, 1, 100)).toBe(1000);
		expect(retryNotBefore({ baseDelayMs: 1000, maxAgentDelayMs: 30000, random: () => 1 }, 1, 100)).toBe(1200);
	});
});
