import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBlockAttempt } from "../../scripts/bench-block.ts";
import type { RunPlan } from "../../scripts/bench-run.ts";

const host = vi.hoisted(() => ({ calls: 0, loadAt: (_call: number): number => 1 }));

vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	loadavg: () => {
		host.calls += 1;
		return [host.loadAt(host.calls), 0, 0];
	},
}));

afterEach(() => {
	host.calls = 0;
	host.loadAt = () => 1;
});

const plan: RunPlan = {
	targets: { base: "base-fixture", head: "head-fixture" },
	runtimes: [{ id: "js-bun", language: "js", jsRuntime: "bun" }],
	blocks: 1,
	reps: 3,
	scriptRoot: fileURLToPath(new URL("./runtime-fixture", import.meta.url)),
	env: process.env,
	log: () => {},
};
const available = new Map([["js-bun", true]]);

/** Calls to loadavg() in one clean attempt, so a test can place a spike on exactly one of them. */
async function cleanAttemptCalls(): Promise<number> {
	const clean = await runBlockAttempt(plan, 0, available);
	expect(clean.failures).toEqual([]);
	expect(clean.spikePeak).toBeUndefined();
	expect(clean.reports).toHaveLength(4);
	const calls = host.calls;
	host.calls = 0;
	return calls;
}

describe("a block attempt's spike checks (senpi#2909)", () => {
	it("discards the attempt when the block's start load is over 80", async () => {
		// The host sampler reads first (call 1), then the block's start load (call 2).
		host.loadAt = (call) => (call === 2 ? 91 : 1);
		const attempt = await runBlockAttempt(plan, 0, available);
		expect(attempt.failures).toEqual([]);
		expect(attempt.spikePeak).toBe(91);
		expect(attempt.reports).toEqual([]);
		expect(attempt.record.measurements).toEqual([]);
	}, 30_000);

	it("discards the attempt when only the closing host sample is over 80", async () => {
		const calls = await cleanAttemptCalls();
		// The closing host sample is the second-to-last read; the last is the block's end load.
		host.loadAt = (call) => (call === calls - 1 ? 92 : 1);
		const attempt = await runBlockAttempt(plan, 0, available);
		expect(
			Math.max(...attempt.record.measurements.map(({ loadStart, loadEnd }) => Math.max(loadStart, loadEnd))),
		).toBe(1);
		expect(attempt.failures).toEqual([]);
		expect(attempt.spikePeak).toBe(92);
	}, 60_000);

	it("discards the attempt when a runtime's own report saw load over 80", async () => {
		const attempt = await runBlockAttempt(
			{ ...plan, env: { ...process.env, BENCH_FIXTURE_REPORT_LOAD: "93" } },
			0,
			available,
		);
		expect(attempt.failures).toEqual([]);
		expect(attempt.spikePeak).toBe(93);
		expect(attempt.reports).toEqual([]);
	}, 30_000);
});
