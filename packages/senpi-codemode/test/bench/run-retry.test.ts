import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockAttempt } from "../../scripts/bench-block.ts";
import { decide } from "../../scripts/bench-compare.ts";
import { type RunPlan, runBlocks, SPIKE_RETRIES, settleTarget } from "../../scripts/bench-run.ts";
import type { RuntimeReport } from "../../scripts/bench-worker.ts";

type AttemptsSlot = { queue: BlockAttempt[] };
const attempts: AttemptsSlot = vi.hoisted((): AttemptsSlot => ({ queue: [] }));
const host = vi.hoisted(() => ({ cores: 14 }));

vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	availableParallelism: () => host.cores,
}));

vi.mock("../../scripts/bench-block.ts", async (original) => ({
	...(await original<typeof import("../../scripts/bench-block.ts")>()),
	runBlockAttempt: async () => {
		const next = attempts.queue.shift();
		if (!next) throw new Error("no attempt queued");
		return next;
	},
}));

afterEach(() => {
	attempts.queue = [];
	host.cores = 14;
});

const report = (marker: number): RuntimeReport => ({
	runtimeVersion: "v",
	hostRuntime: "bun",
	hostVersion: "1",
	loadavg: [marker, 0, 0],
	scenarios: { "cold-start": [{ cpuMs: marker, wallMs: marker, hostCpuMs: marker, kernelCpuMs: marker }] },
});

function attempt(index: number, marker: number, extra: Partial<BlockAttempt> = {}): BlockAttempt {
	return {
		record: {
			index,
			loadavg: [marker, 0, 0],
			loadavgEnd: [marker, 0, 0],
			power: "AC",
			idleSeconds: null,
			startedAt: new Date(0).toISOString(),
			endedAt: new Date(0).toISOString(),
			hostSamples: [],
			measurements: [
				{
					runtimeId: "js-bun",
					scenario: "cold-start",
					rep: 0,
					role: "comparison",
					side: "base",
					loadStart: marker,
					loadEnd: marker,
				},
			],
		},
		reports: [{ runtimeId: "js-bun", block: index, role: "comparison", side: "base", report: report(marker) }],
		loads: [marker, marker],
		failures: [],
		spikePeak: undefined,
		...extra,
	};
}

const plan = (settle: (target: number) => Promise<void>): RunPlan => ({
	targets: { base: "base", head: "head" },
	runtimes: [{ id: "js-bun", language: "js", jsRuntime: "bun" }],
	blocks: 1,
	reps: 1,
	scriptRoot: "/nonexistent",
	env: process.env,
	log: () => {},
	settle,
});

describe("per-block spike retry (senpi#2909)", () => {
	it("keeps nothing from a discarded attempt that had already collected data", async () => {
		// Given a first attempt that measured and reported before its spike, then a clean one.
		attempts.queue = [attempt(0, 40, { spikePeak: 95 }), attempt(0, 3)];
		const settle = vi.fn(async (_target: number) => {});
		// When the block runs.
		const run = await runBlocks(plan(settle));
		// Then only the clean attempt's record, reports and loads reach the result.
		expect(run.blocks.map((block) => block.loadavg[0])).toEqual([3]);
		expect(run.admissionLoads).toEqual([3, 3]);
		expect((run.reports["js-bun"] ?? []).map((entry) => entry.report.loadavg[0])).toEqual([3]);
		expect(run.retriedBlocks).toEqual([{ block: 0, attempts: 2 }]);
		// And the retry waited once.
		expect(settle).toHaveBeenCalledTimes(1);
	});

	it("waits for the load from before a spike that was already under way when the block started", async () => {
		// Given block 1 kept at start load 30, and block 2 whose first attempt began inside a spike (start load 95).
		attempts.queue = [attempt(0, 30), attempt(1, 95, { spikePeak: 95 }), attempt(1, 31)];
		const settle = vi.fn(async (_target: number) => {});
		// When both blocks run.
		const run = await runBlocks({ ...plan(settle), blocks: 2 });
		// Then the retry waited for block 1's calm start load (30 + 5), not the spiking start load (95 + 5).
		expect(settle).toHaveBeenCalledWith(35);
		expect(run.blocks.map((block) => block.loadavg[0])).toEqual([30, 31]);
	});

	it("never discards a worker failure together with a spike", async () => {
		// Given an attempt where a runtime crashed and the host also spiked.
		attempts.queue = [
			attempt(0, 5, { spikePeak: 95, failures: ["js-bun block 1: runtime exited before its sample"] }),
		];
		// When the block runs.
		const run = await runBlocks(plan(async () => {}));
		// Then the crash is reported and the run cannot pass.
		expect(run.failures).toContain("js-bun block 1: runtime exited before its sample");
		expect(run.retriedBlocks).toEqual([]);
		expect(decide({ ...run, blockLoads: run.admissionLoads }).exitCode).not.toBe(0);
	});

	it("settles between every retry and labels the block once retries run out", async () => {
		// Given four spiking attempts.
		attempts.queue = [95, 94, 93, 92].map((peak) => attempt(0, 9, { spikePeak: peak }));
		const settle = vi.fn(async (_target: number) => {});
		// When the block runs.
		const run = await runBlocks(plan(settle));
		// Then it waited before each of the three retries and labelled the block with every peak.
		expect(settle).toHaveBeenCalledTimes(3);
		expect(run.blocks).toEqual([]);
		expect(run.failures).toEqual([
			`host load spike in block 1: discarded after ${SPIKE_RETRIES + 1} attempts (peaks 95.00, 94.00, 93.00, 92.00 > 80)`,
		]);
	});

	it("never waits for a load at or above the refusal ceiling (senpi#2922)", () => {
		// Given a calm level near the ceiling (a kept block that started at load 76.6).
		// Then the retry waits for a load under 80 with margin, not 76.6 + 5 = 81.6, which a retry would start into.
		expect(settleTarget(76.6)).toBe(70);
		expect(settleTarget(120)).toBe(70);
		// And a calm level well under the cap keeps its own target.
		expect(settleTarget(30)).toBe(35);
	});

	it("caps the target even when the host has more cores than the cap (senpi#2922)", () => {
		// Given a 128-core host, whose contamination ceiling alone (128) is far above the refusal line.
		host.cores = 128;
		// Then the cap still wins: a target of 128 would end the wait at once, the #2922 no-op.
		expect(settleTarget(30)).toBe(70);
		// And under the cap the core-count floor still applies.
		host.cores = 40;
		expect(settleTarget(10)).toBe(40);
	});
});
