import { describe, expect, it } from "vitest";
import {
	type BenchInput,
	decide,
	NOISE_LIMITED_CLAIM,
	type PairedBlock,
	pairedLogRatios,
	type Series,
} from "../../scripts/bench-compare.ts";
import { globalNoiseBand, MAX_BAND, rowNoiseBand } from "../../scripts/bench-threshold.ts";
import { noisyBlocks, REPS } from "./noisy-fixture.ts";

function row(scenario: string, runtimeId: string, calibration: readonly PairedBlock[], ratio = 1): Series {
	return {
		scenario,
		runtimeId,
		present: { base: true, head: true },
		calibration,
		comparison: noisyBlocks(scenario.length * 31 + runtimeId.length, 0.04, ratio),
	};
}

function run(series: readonly Series[], extra: Partial<BenchInput> = {}): ReturnType<typeof decide> {
	return decide({
		reps: REPS,
		runtimes: Array.from(new Set(series.map((entry) => entry.runtimeId)), (id) => ({
			id,
			base: { available: true, version: "same" },
			head: { available: true, version: "same" },
		})),
		blockLoads: [3, 4, 3],
		series,
		...extra,
	});
}

describe("per-row A/A-calibrated thresholds", () => {
	it("derives every row's band from its own calibration pairs through one shared rule", () => {
		// Given rows in different runtimes and scenarios, two of them with identical calibration pairs.
		const quiet = noisyBlocks(7, 0.02);
		const series = [
			row("warm-cell", "py", quiet),
			row("detach", "jl", quiet),
			row("cold-start", "rb", noisyBlocks(9, 0.1)),
		];
		// When the comparator judges them.
		const result = run(series);
		// Then each reported band is exactly the shared rule applied to that row's own pairs.
		for (const entry of result.results) {
			const source = series.find((candidate) => candidate.scenario === entry.scenario);
			if (!source) throw new Error(`no series for ${entry.scenario}`);
			expect(entry.band).toBe(rowNoiseBand(pairedLogRatios(source.calibration, entry.metric)));
		}
		const band = (scenario: string) =>
			result.results.find((entry) => entry.scenario === scenario)?.band ?? Number.NaN;
		expect(band("warm-cell")).toBe(band("detach"));
		expect(band("cold-start")).toBeGreaterThan(band("warm-cell"));
	});

	it("keeps a quiet row's tighter threshold and caps a noisy row at the ceiling", () => {
		// Given a quiet row and a row whose A/A noise is far above five percent.
		const result = run([row("warm-cell", "py", noisyBlocks(3, 0.02)), row("interrupt", "rb", noisyBlocks(4, 0.6))]);
		const quiet = result.results.find((entry) => entry.scenario === "warm-cell" && entry.metric === "cpu");
		const noisy = result.results.find((entry) => entry.scenario === "interrupt" && entry.metric === "cpu");
		// Then the quiet threshold stays below the cap and the noisy one is held to it.
		expect(quiet?.threshold).toBe(quiet?.band);
		expect(quiet?.threshold).toBeLessThan(MAX_BAND);
		expect(noisy?.band).toBeGreaterThan(MAX_BAND);
		expect(noisy?.threshold).toBe(MAX_BAND);
	});

	it("passes matching code whose paired noise meets the bound despite large host drift", () => {
		// Given +-30% shared host drift and 4% independent per-sample noise on both sides.
		const result = run([row("warm-cell", "py", noisyBlocks(11, 0.04))]);
		// Then the band stays under the cap and identical code passes.
		expect(result.results.every((entry) => entry.band <= MAX_BAND)).toBe(true);
		expect(result).toMatchObject({ exitCode: 0, verdict: "PASS" });
	});

	it("detects a 1.25x head shift on the same noisy series and names the row", () => {
		// Given the same noisy host with the head 25% slower.
		const result = run([row("warm-cell", "py", noisyBlocks(11, 0.04), 1.25)]);
		// Then the regression fails the run and names the workload.
		expect(result.exitCode).toBe(1);
		expect(result.results.filter((entry) => entry.verdict === "FAIL").map((entry) => entry.metric)).toEqual([
			"cpu",
			"wall",
		]);
		expect(result.lines.some((line) => line.startsWith("FAIL: warm-cell py: paired cpu ratio 1.2"))).toBe(true);
	});

	it("reports a row whose calibration noise exceeds the cap as noise-limited, never as passed", () => {
		// Given identical code on a row whose A/A noise is far above five percent.
		const result = run([row("warm-cell", "py", noisyBlocks(3, 0.02)), row("interrupt", "rb", noisyBlocks(4, 0.6))]);
		// Then that row is inconclusive and the run cannot pass.
		const noisy = result.results.filter((entry) => entry.scenario === "interrupt");
		expect(noisy.map((entry) => entry.verdict)).toEqual(["NOISE-LIMITED", "NOISE-LIMITED"]);
		expect(result).toMatchObject({ exitCode: 3, verdict: "INCONCLUSIVE" });
		expect(result.lines.some((line) => line.includes("interrupt rb: cpu") && line.includes("noise-limited"))).toBe(
			true,
		);
	});

	it("still fails a noise-limited row that regresses beyond its own noise band", () => {
		// Given a noisy row whose head is twice as slow.
		const result = run([row("interrupt", "rb", noisyBlocks(4, 0.6), 2)]);
		// Then exceeding even the measured noise is a regression, not an inconclusive result.
		expect(result.exitCode).toBe(1);
	});

	it("derives each row's minimum detectable effect from that row's own band, not a constant", () => {
		// Given rows of three different calibration noise levels.
		const result = run([
			row("warm-cell", "py", noisyBlocks(3, 0.02)),
			row("cold-start", "rb", noisyBlocks(9, 0.1)),
			row("interrupt", "jl", noisyBlocks(4, 0.6)),
		]);
		// Then every row's MDE is its own band, so the MDEs differ as the bands do.
		for (const entry of result.results) expect(entry.mde).toBe(entry.band);
		const cpu = result.results.filter((entry) => entry.metric === "cpu");
		expect(cpu).toHaveLength(3);
		expect(new Set(cpu.map((entry) => entry.mde)).size).toBe(3);
	});

	it("states an MDE above five percent for a noise-limited row and the honest no-regression claim", () => {
		// Given identical code with one row whose A/A noise is far above five percent.
		const result = run([row("warm-cell", "py", noisyBlocks(3, 0.02)), row("interrupt", "rb", noisyBlocks(4, 0.6))]);
		const noisy = result.results.filter((entry) => entry.verdict === "NOISE-LIMITED");
		// Then that row shows the largest slowdown it could miss, and the run claims only what it measured.
		expect(noisy.length).toBeGreaterThan(0);
		for (const entry of noisy) expect(entry.mde).toBeGreaterThan(MAX_BAND);
		const cpu = noisy.find((entry) => entry.metric === "cpu");
		expect(result.lines).toContain(
			`INCONCLUSIVE: interrupt rb: cpu A/A noise band ${cpu?.band.toFixed(3)} > 0.05 (noise-limited); can only detect slowdowns above MDE ${cpu?.mde.toFixed(3)}`,
		);
		expect(result.lines.at(-1)).toBe(NOISE_LIMITED_CLAIM);
	});

	it("keeps a clean row's MDE within its threshold", () => {
		// Given a quiet row that passes.
		const result = run([row("warm-cell", "py", noisyBlocks(11, 0.04))]);
		// Then each row can detect any slowdown its threshold gates.
		expect(result.exitCode).toBe(0);
		for (const entry of result.results) expect(entry.mde).toBeLessThanOrEqual(entry.threshold);
	});

	it("switches to one shared band with the global scope knob", () => {
		// Given rows of different noise judged with the global scope.
		const series = [row("warm-cell", "py", noisyBlocks(3, 0.02)), row("cold-start", "rb", noisyBlocks(9, 0.1))];
		const result = run(series, { bandScope: "global" });
		// Then every row carries the same band: the row rule's largest band over all rows.
		const shared = globalNoiseBand(
			series.flatMap((entry) =>
				(["cpu", "wall"] as const).map((metric) => pairedLogRatios(entry.calibration, metric)),
			),
		);
		const rowBands = series.flatMap((entry) =>
			(["cpu", "wall"] as const).map((metric) => rowNoiseBand(pairedLogRatios(entry.calibration, metric))),
		);
		expect(shared).toBe(Math.max(...rowBands));
		expect(result.bandScope).toBe("global");
		expect(new Set(result.results.map((entry) => entry.band))).toEqual(new Set([shared]));
	});

	it("never fails a clean self-vs-self run of many rows under the global scope", () => {
		// Given 60 clean series (120 rows) of identical code over five independent noise draws.
		for (const seed of [1, 2, 3, 4, 5]) {
			const series = Array.from({ length: 60 }, (_, index) => ({
				scenario: `scenario-${index}`,
				runtimeId: "py",
				present: { base: true, head: true },
				calibration: noisyBlocks(seed * 1000 + index, 0.03),
				comparison: noisyBlocks(seed * 1000 + index + 500, 0.03),
			}));
			// When both scopes judge it.
			const row = run(series);
			const global = run(series, { bandScope: "global" });
			// Then neither scope reports a regression on identical code.
			expect(row.results.filter((entry) => entry.verdict === "FAIL")).toEqual([]);
			expect(global.results.filter((entry) => entry.verdict === "FAIL")).toEqual([]);
			expect(global.exitCode).not.toBe(1);
		}
	});
});
