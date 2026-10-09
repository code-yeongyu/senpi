import { describe, expect, it } from "vitest";
import { resolveCommandPath } from "../src/interpreters/resolve-command.ts";
import { memoryGlobalsHarness } from "./kernels/memory-globals-harness.ts";

const MIB = 1024 * 1024;
const N = 8;

describe.each(["jl", "rb"] as const)("lazy memory globals %s", (language) => {
	const command = resolveCommandPath(language === "jl" ? "julia" : "ruby");

	it.skipIf(command === undefined)(
		"does no globals work or payload serialization below threshold",
		async () => {
			const harness = await memoryGlobalsHarness(language, 10 * MIB);
			try {
				// Given: a below-threshold current footprint and the real, instrumented interpreter.
				// When: N ordinary successful scalar cells run.
				const results = [];
				for (let index = 0; index < N; index++) {
					const result = await harness.kernel.run({
						cellId: `ordinary-${index}`,
						code: "1 + 1",
					});
					expect(result.ok, JSON.stringify(result)).toBe(true);
					results.push(result);
				}
				// Then: neither the runner nor the host carries unused diagnostics.
				console.log(
					`WORK ${language} N=${N} walks=${harness.counts.walks} payloads=${harness.counts.payloads} footprints=${harness.counts.footprints}`,
				);
				expect(results.every((result) => result.ok)).toBe(true);
				expect(harness.counts).toEqual({
					walks: 0,
					payloads: 0,
					footprints: N,
				});
				expect(results.every((result) => result.memory === undefined)).toBe(true);
			} finally {
				await harness.close();
			}
		},
		120_000,
	);

	it.skipIf(command === undefined)(
		"preserves above threshold notice and globals payload",
		async () => {
			const harness = await memoryGlobalsHarness(language, 128 * MIB);
			try {
				// Given: exact and sampled containers, using the same bounded sizer as main.
				const code =
					language === "jl"
						? 'big_blob = repeat("a", 4 * 1024 * 1024); rows = [repeat("x", 200) for _ in 1:10_000]; nothing'
						: 'big_blob = "a" * (4 * 1024 * 1024); rows = Array.new(10_000) { "x" * 200 }; nil';
				// When: the footprint is above threshold and its notice is shown.
				const first = await harness.kernel.run({ cellId: "above", code });
				// Then: the walk runs and the complete notice payload remains main's.
				console.log(
					`ABOVE ${language} N=1 walks=${harness.counts.walks} notice=${first.memory?.notice !== undefined}`,
				);
				expect(first.ok).toBe(true);
				expect(harness.counts.walks).toBe(1);
				expect(harness.counts.footprints).toBe(1);
				expect(first.memory).toMatchSnapshot();
			} finally {
				await harness.close();
			}
		},
		120_000,
	);

	it.skipIf(command === undefined)(
		"collects globals above threshold when hysteresis suppresses notice",
		async () => {
			const harness = await memoryGlobalsHarness(language, 128 * MIB);
			try {
				// Given: a notice already shown at this footprint.
				const code =
					language === "jl"
						? 'big_blob = repeat("a", 4 * 1024 * 1024); nothing'
						: 'big_blob = "a" * (4 * 1024 * 1024); nil';
				const first = await harness.kernel.run({ cellId: "above", code });
				expect(first.ok, JSON.stringify(first)).toBe(true);
				const before = harness.counts.walks;
				// When: another cell holds the same above-threshold footprint.
				const suppressed = await harness.kernel.run({
					cellId: "suppressed",
					code: "1 + 1",
				});
				// Then: only notice text is suppressed, not the bounded globals walk.
				console.log(
					`SUPPRESSED ${language} N=1 walks=${harness.counts.walks - before} globals=${suppressed.memory?.globals?.length}`,
				);
				expect(suppressed.ok).toBe(true);
				expect(harness.counts.walks - before).toBe(1);
				expect(suppressed.memory?.globals).toEqual(first.memory?.globals);
				expect(suppressed.memory?.globals?.length).toBeGreaterThan(0);
				expect(suppressed.memory?.notice).toBeUndefined();
			} finally {
				await harness.close();
			}
		},
		120_000,
	);
});
