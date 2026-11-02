import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decide } from "../../scripts/bench-compare.ts";
import { type RunPlan, runBlocks, SPIKE_RETRIES } from "../../scripts/bench-run.ts";

const host = vi.hoisted(() => ({ calls: 0, cores: 8, loadAfter: (_call: number): number => 0 }));

vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	loadavg: () => {
		host.calls += 1;
		return [host.loadAfter(host.calls), 0, 0];
	},
	availableParallelism: () => host.cores,
}));

afterEach(() => {
	host.calls = 0;
	host.loadAfter = () => 0;
});

const plan: RunPlan = {
	targets: { base: "base-fixture", head: "head-fixture" },
	runtimes: [{ id: "js-bun", language: "js", jsRuntime: "bun" }],
	blocks: 3,
	reps: 3,
	scriptRoot: fileURLToPath(new URL("./runtime-fixture", import.meta.url)),
	env: process.env,
	log: () => {},
};

describe("paired runtime scheduling", () => {
	it("keeps each paired repetition adjacent when runtime processes are retained", async () => {
		// Given real subprocesses whose measurement replies arrive only on request.
		// When three complete blocks run through the production benchmark scheduler.
		const run = await runBlocks(plan);
		// Then every base/head and calibration pair shares the same local measurement window.
		expect(run.failures).toEqual([]);
		for (const block of run.blocks) {
			const measured = block.measurements.filter(({ rep }) => rep >= 0);
			for (let index = 0; index < measured.length; index += 2) {
				const first = measured[index];
				const second = measured[index + 1];
				if (!first || !second) throw new Error("paired measurement missing");
				expect(second.scenario).toBe(first.scenario);
				expect(second.rep).toBe(first.rep);
				if (first.role === "comparison") {
					expect(second.role).toBe("comparison");
					expect(second.side).not.toBe(first.side);
				} else {
					expect(second.role).not.toBe(first.role);
					expect(second.side).toBe("base");
				}
			}
			// And the recorded order alternates which side goes first on every repetition, not once per block.
			for (let rep = 0; rep < plan.reps; rep += 1) {
				const first = measured.find((entry) => entry.rep === rep && entry.role === "comparison");
				expect(first?.side).toBe((block.index + rep) % 2 === 0 ? "base" : "head");
			}
		}
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(0);
		// And every block records an ordered wall-clock window, so host activity can be checked for overlap.
		const windows = run.blocks.map((block) => [Date.parse(block.startedAt), Date.parse(block.endedAt)] as const);
		for (const [index, [start, end]] of windows.entries()) {
			expect(end).toBeGreaterThanOrEqual(start);
			expect(start).toBeGreaterThanOrEqual(windows[index - 1]?.[1] ?? start);
		}
	}, 30_000);

	it("re-runs only the block a host-load spike over 80 hits, keeping the others (senpi#2909)", async () => {
		// Given a host whose load jumps past 80 for a short stretch inside block 2 only.
		let spikeCalls = 0;
		let blockTwoStarted = false;
		const log = (line: string) => {
			if (line.startsWith("block 2/3 start")) blockTwoStarted = true;
		};
		host.loadAfter = () => {
			if (!blockTwoStarted || spikeCalls >= 3) return 1;
			spikeCalls += 1;
			return 81;
		};
		// When the scheduler measures.
		const run = await runBlocks({ ...plan, log, settle: async () => {} });
		// Then all three blocks complete, block 2 once, and nothing from the discarded attempt survives.
		expect(run.failures).toEqual([]);
		expect(run.blocks.map((block) => block.index)).toEqual([0, 1, 2]);
		expect(Math.max(...run.admissionLoads)).toBeLessThanOrEqual(80);
		for (const block of run.blocks)
			expect(
				Math.max(...block.measurements.map(({ loadStart, loadEnd }) => Math.max(loadStart, loadEnd))),
			).toBeLessThanOrEqual(80);
		// And the kept retry of block 2 keeps the alternation keyed on its block index, not on the attempt.
		const retried = run.blocks[1];
		if (!retried) throw new Error("block 2 missing");
		for (let rep = 0; rep < plan.reps; rep += 1) {
			const first = retried.measurements.find((entry) => entry.rep === rep && entry.role === "comparison");
			expect(first?.side).toBe((1 + rep) % 2 === 0 ? "base" : "head");
		}
		const blockTwoReports = (run.reports["js-bun"] ?? []).filter((entry) => entry.block === 1);
		expect(blockTwoReports).toHaveLength(4);
		expect(run.retriedBlocks.map(({ block }) => block)).toEqual([1]);
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(0);
	}, 60_000);

	it("labels a block that spikes over 80 on every attempt instead of refusing the run (senpi#2909)", async () => {
		// Given a host whose load stays past 80 while block 1 runs, then calms.
		let blockTwoStarted = false;
		const log = (line: string) => {
			if (line.startsWith("block 2/3 start")) blockTwoStarted = true;
		};
		host.loadAfter = () => (blockTwoStarted ? 1 : 81);
		// When the scheduler measures.
		const run = await runBlocks({ ...plan, log, settle: async () => {} });
		// Then block 1 is labelled after its retries, blocks 2 and 3 are kept, and the run is inconclusive, not refused.
		const labelled = run.failures.filter((line) => line.startsWith("host load spike in block 1"));
		expect(labelled).toHaveLength(1);
		expect(labelled[0]).toContain(`${SPIKE_RETRIES + 1} attempts`);
		expect(run.blocks.map((block) => block.index)).toEqual([1, 2]);
		expect((run.reports["js-bun"] ?? []).some((entry) => entry.block === 0)).toBe(false);
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(3);
	}, 60_000);

	it("discards a first runtime's reports when a later runtime in the same attempt spikes (senpi#2909)", async () => {
		// Given two runtimes, and a spike that starts only once the second runtime begins measuring in block 1.
		let secondRuntimeStarted = false;
		let spikes = 0;
		const log = (line: string) => {
			if (line.startsWith("block 1/1 js-node")) secondRuntimeStarted = true;
		};
		host.loadAfter = () => {
			if (!secondRuntimeStarted || spikes >= 2) return 1;
			spikes += 1;
			return 81;
		};
		const twoRuntimes: RunPlan = {
			...plan,
			blocks: 1,
			runtimes: [
				{ id: "js-bun", language: "js", jsRuntime: "bun" },
				{ id: "js-node", language: "js", jsRuntime: "node" },
			],
			log,
			settle: async () => {},
		};
		// When the scheduler measures.
		const run = await runBlocks(twoRuntimes);
		// Then the block was retried and each runtime has exactly one attempt's reports, not the discarded ones too.
		expect(run.retriedBlocks.map(({ block }) => block)).toEqual([0]);
		expect(run.reports["js-bun"]).toHaveLength(4);
		expect(run.reports["js-node"]).toHaveLength(4);
		expect(run.failures).toEqual([]);
	}, 90_000);

	it("marks a block contaminated when load exceeds the core count during measurement", async () => {
		// Given an eight-core host whose load reads 9 for a short stretch inside the first block, far below 80.
		host.loadAfter = (call) => (call > 150 && call < 170 ? 9 : 1);
		// When the scheduler measures all blocks.
		const run = await runBlocks(plan);
		// Then measurement completes, the over-subscribed block is named, and the run is inconclusive.
		expect(run.blocks).toHaveLength(3);
		const contaminated = run.failures.filter((line) => line.startsWith("host contaminated in block"));
		expect(contaminated).toHaveLength(1);
		expect(contaminated[0]).toMatch(/^host contaminated in block 1: \d+ of \d+ measurements/u);
		expect(contaminated[0]).toContain("above 1-minute load 8 (peak 9.00)");
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(3);
	}, 30_000);

	it("keeps a block clean when load stays at the core count", async () => {
		// Given a host fully but not over-subscribed.
		host.loadAfter = () => 8;
		// When the scheduler measures.
		const run = await runBlocks(plan);
		// Then no block is reported contaminated.
		expect(run.failures).toEqual([]);
	}, 30_000);

	it("invalidates a run when a runtime exits before its requested sample", async () => {
		// Given a runtime that exits cleanly without its promised reply.
		const broken = { ...plan, env: { ...process.env, BENCH_FIXTURE_FAILURE: "exit" } };
		// When the scheduler requests the first sample.
		const run = await runBlocks(broken);
		// Then completion without measurement cannot silently pass or hang.
		expect(run.failures.length).toBeGreaterThan(0);
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).toBe(3);
	}, 30_000);
});
