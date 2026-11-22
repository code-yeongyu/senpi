import { describe, expect, it } from "vitest";
import { resolveCommandPath } from "../../../src/interpreters/resolve-command.ts";
import { memoryGlobalsHarness } from "../memory-globals-harness.ts";

const command = resolveCommandPath("julia");
const declarationCount = `count(name -> startswith(string(name), "SENPI_SIZER_") ||
    name in (:SenpiSizer, :senpi_size, :senpi_sampled, :senpi_over_budget, :senpi_largest_globals),
    names(Main, all=true))`;

describe("Julia lazy globals declarations (Refs senpi#3048)", () => {
	it.skipIf(command === undefined)(
		"installs zero sizing declarations before a below-threshold first result",
		async () => {
			// Given: the real runner with a below-notice footprint.
			const harness = await memoryGlobalsHarness("jl", 10 * 1024 * 1024);
			try {
				// When: the first cell observes actual installed sizing bindings.
				const result = await harness.kernel.run({ cellId: "first", code: declarationCount });
				// Then: deferred diagnostics installed no constants, types or functions.
				expect(result.ok, JSON.stringify(result)).toBe(true);
				if (!result.ok) throw new Error(result.error.message);
				expect(Number(result.valueRepr)).toBe(0);
				expect(harness.counts.walks).toBe(0);
				expect(result.memory).toBeUndefined();
			} finally {
				await harness.close();
			}
		},
		120_000,
	);
});
