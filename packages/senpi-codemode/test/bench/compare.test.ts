import { describe, expect, it } from "vitest";
import { admitHost, type BenchInput, decide, type PairedBlock, type Series } from "../../scripts/bench-compare.ts";
import { injectSlow, parseInjection } from "../../scripts/bench-inject.ts";

// Adjacent repetitions share the host's state (120, 100, 110 ms), and each pair partner differs by under 1%.
const jitter = [0.004, -0.006, 0.002];

function blocks(ratio: number): readonly PairedBlock[] {
	return Array.from({ length: 3 }, (_, block) => ({
		first: [120, 100, 110].map((value) => ({ cpuMs: value, wallMs: value, p95Ms: value })),
		second: [120, 100, 110].map((value, rep) => {
			const paired = value * Math.exp(jitter[(rep + block) % 3] ?? 0);
			return { cpuMs: paired * ratio, wallMs: paired, p95Ms: paired };
		}),
	}));
}

const series: Series = {
	scenario: "warm-cell-1000",
	runtimeId: "js-bun",
	present: { base: true, head: true },
	calibration: blocks(1.02),
	comparison: blocks(1),
};
const input: BenchInput = {
	reps: 3,
	runtimes: ["js-bun", "js-node", "py", "rb", "jl"].map((id) => ({
		id,
		base: { available: true, version: "same-version" },
		head: { available: true, version: "same-version" },
	})),
	blockLoads: [1, 2, 1],
	series: [series],
};

describe("paired benchmark verdicts", () => {
	it("detects an injected head slowdown without widening calibration", () => {
		// Given measured equal sides and a head-only fault injection.
		const injection = parseInjection("head:warm-cell-1000:1.3");
		// When the same injection path used by the CLI feeds the comparator.
		const result = decide({ ...input, series: [injectSlow(series, [injection])] });
		// Then the slowdown is rejected against the original measured band.
		expect(result.exitCode).toBe(1);
		const cpu = result.results.find((entry) => entry.metric === "cpu");
		expect(cpu?.threshold).toBeLessThan(0.05);
		expect(cpu?.ratio).toBeCloseTo(1.3, 2);
	});

	it("passes when paired ratios stay inside each row's measured band", () => {
		// Given matching code with a two-percent measured noise band.
		// When all paired metrics are evaluated.
		const result = decide(input);
		// Then noisy individual repetitions do not create a regression.
		expect(result.exitCode).toBe(0);
	});

	it("names the regressed workload when paired CPU increases", () => {
		// Given a 25-percent CPU regression and unchanged wall time.
		const slowed = { ...input, series: [{ ...series, comparison: blocks(1.25) }] };
		// When the comparator gates the run.
		const result = decide(slowed);
		// Then the failed metric identifies the workload.
		expect(result.exitCode).toBe(1);
		const failed = result.results.filter((entry) => entry.verdict === "FAIL");
		expect(failed).toMatchObject([{ scenario: "warm-cell-1000", metric: "cpu" }]);
		expect(failed[0]?.ratio).toBeCloseTo(1.25, 2);
		expect(result.lines[0]).toContain("warm-cell-1000 js-bun: paired cpu ratio 1.25");
	});

	it("returns inconclusive when calibration is too noisy", () => {
		// Given an eight-percent A/A CPU offset.
		const noisy = { ...input, series: [{ ...series, calibration: blocks(1.08) }] };
		// When the run is judged.
		const result = decide(noisy);
		// Then the host noise is not waived into a pass or regression.
		expect(result).toMatchObject({ exitCode: 3, verdict: "INCONCLUSIVE" });
		expect(result.results.find((entry) => entry.metric === "cpu")).toMatchObject({
			verdict: "NOISE-LIMITED",
			threshold: 0.05,
		});
	});

	it.each(["js-node", "jl"])("invalidates the run when required %s is missing", (id) => {
		// Given one unavailable interpreter on the head.
		const runtimes = input.runtimes.map((runtime) =>
			runtime.id === id ? { ...runtime, head: { available: false } } : runtime,
		);
		// When every other workload is healthy.
		const result = decide({ ...input, runtimes });
		// Then no partial runtime matrix can pass.
		expect(result.exitCode).toBe(3);
	});

	it("invalidates a comparison across different interpreter versions", () => {
		// Given the same runtime with a changed version.
		const runtimes = [
			{ id: "py", base: { available: true, version: "3.13" }, head: { available: true, version: "3.14" } },
		];
		// When timing samples themselves match.
		const result = decide({ ...input, runtimes });
		// Then the confounded comparison is rejected.
		expect(result.exitCode).toBe(3);
	});

	it("invalidates a scenario missing only on one side", () => {
		// Given a capability present only on the head.
		const partial = { ...series, present: { base: false, head: true } };
		// When the full report is judged.
		const result = decide({ ...input, series: [series, partial] });
		// Then the missing comparator is not silently skipped.
		expect(result.exitCode).toBe(3);
	});

	it("invalidates a required scenario absent on both sides", () => {
		// Given a healthy matrix whose cold-start workload was omitted entirely.
		const missing = { ...series, scenario: "cold-start", present: { base: false, head: false } };
		// When the comparator receives the otherwise complete run.
		const result = decide({ ...input, series: [series, missing] });
		// Then required evidence cannot be silently skipped.
		expect(result).toMatchObject({ exitCode: 3, verdict: "INCONCLUSIVE", skipped: [] });
		expect(result.lines.some((line) => line.includes("cold-start") && line.includes("js-bun"))).toBe(true);
	});

	it("skips only an explicitly optional scenario absent on both sides", () => {
		// Given an unshipped capability alongside complete required measurements.
		const missing = {
			...series,
			scenario: "managed-install",
			optional: true,
			present: { base: false, head: false },
		};
		// When the comparator evaluates the matrix.
		const result = decide({ ...input, series: [series, missing] });
		// Then the future capability does not invalidate today's measurement.
		expect(result.exitCode).toBe(0);
		expect(result.skipped).toHaveLength(1);
	});

	it("refuses before measurement when injected host load is 81", () => {
		// Given a host above the admission ceiling.
		// When admission runs.
		const result = admitHost(81);
		// Then no benchmark work is admitted.
		expect(result).toMatchObject({ exitCode: 2, verdict: "REFUSED" });
	});

	it("refuses when load crosses the ceiling between measurements", () => {
		// Given an admitted host whose next measurement would start overloaded.
		const result = decide({ ...input, blockLoads: [12, 81, 14] });
		// Then the captured admission sample retains REFUSED, not INCONCLUSIVE.
		expect(result).toMatchObject({ exitCode: 2, verdict: "REFUSED" });
	});

	it("invalidates truncated samples instead of comparing the surviving minima", () => {
		// Given one lost head repetition in an otherwise complete run.
		const comparison = blocks(1).map((block) => ({ ...block, second: block.second.slice(1) }));
		// When the comparator receives the partial report.
		const result = decide({ ...input, series: [{ ...series, comparison }] });
		// Then missing evidence cannot yield PASS.
		expect(result.exitCode).toBe(3);
	});

	it.each(["wallMs", "p95Ms"] as const)("rejects a regression in %s even when CPU is unchanged", (metric) => {
		// Given a wall or tail-latency regression without a CPU increase.
		const comparison = blocks(1).map((block) => ({
			...block,
			second: block.second.map((rep) => ({ ...rep, [metric]: Number(rep[metric]) * 1.25 })),
		}));
		// When every metric is gated independently.
		const result = decide({ ...input, series: [{ ...series, comparison }] });
		// Then CPU cannot conceal the latency regression.
		expect(result.exitCode).toBe(1);
	});
});
