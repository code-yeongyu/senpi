import assert from "node:assert/strict";
import test from "node:test";
import {
	bandOf,
	barrierClock,
	compareToBand,
	iterationSamples,
	machineClass,
	minOfRuns,
	percentile,
	runMetrics,
} from "./latency-measure.mjs";

test("percentile is nearest-rank over the sorted samples and refuses an empty list", () => {
	const samples = [9, 1, 5, 3, 7, 2, 8, 4, 6, 10];
	assert.equal(percentile(samples, 0.5), 5);
	assert.equal(percentile(samples, 0.95), 10);
	assert.equal(percentile([4], 0.95), 4);
	assert.throws(() => percentile([], 0.5), /empty/);
	assert.throws(() => percentile([1], 0), /q must be/);
});

test("an iteration yields one dispatch sample per body (from its ready time) and one tail sample (from the last end)", () => {
	const samples = iterationSamples({
		callAt: 100,
		nextAt: 190,
		bodies: [
			{ id: "a", readyAt: 100, startAt: 104, endAt: 150 },
			{ id: "b", readyAt: 150, startAt: 152, endAt: 170 },
		],
	});
	assert.deepEqual(samples, { dispatch_to_body_ms: [4, 2], body_to_next_request_ms: [20] });
});

test("an iteration with a body that never started, or with no body, is an error, never a zero sample", () => {
	assert.throws(() => iterationSamples({ callAt: 0, nextAt: 9, bodies: [] }), /at least one body/);
	assert.throws(
		() => iterationSamples({ callAt: 0, nextAt: 9, bodies: [{ id: "x", readyAt: 0, endAt: 3 }] }),
		/body x has no startAt/,
	);
	assert.throws(
		() => iterationSamples({ callAt: 0, bodies: [{ id: "x", readyAt: 0, startAt: 1, endAt: 3 }] }),
		/callAt\/nextAt/,
	);
});

const iteration = (start, tail) => ({
	callAt: 0,
	nextAt: 10 + tail,
	bodies: [{ id: "a", readyAt: 0, startAt: start, endAt: 10 }],
});

test("run metrics pool every workload and keep a per-workload copy of each metric", () => {
	const metrics = runMetrics({
		E01: [iteration(1, 5), iteration(3, 7)],
		E02: [iteration(2, 6)],
	});
	assert.deepEqual(Object.keys(metrics).sort(), [
		"E01.body_to_next_request_ms",
		"E01.dispatch_to_body_ms",
		"E02.body_to_next_request_ms",
		"E02.dispatch_to_body_ms",
		"body_to_next_request_ms",
		"dispatch_to_body_ms",
	]);
	assert.deepEqual(metrics.dispatch_to_body_ms, { p50: 2, p95: 3, n: 3 });
	assert.deepEqual(metrics["E01.dispatch_to_body_ms"], { p50: 1, p95: 3, n: 2 });
	assert.deepEqual(metrics["E02.body_to_next_request_ms"], { p50: 6, p95: 6, n: 1 });
});

const run = (p50, p95) => ({ metrics: { dispatch_to_body_ms: { p50, p95, n: 9 } } });

test("the band is the min and max of each quantile over the runs", () => {
	assert.deepEqual(bandOf([run(2, 9), run(4, 5), run(3, 7)]), {
		dispatch_to_body_ms: { p50: { min: 2, max: 4 }, p95: { min: 5, max: 9 } },
	});
	assert.throws(() => bandOf([run(2, 9), { metrics: {} }]), /run 2 has no dispatch_to_body_ms.p50/);
});

test("the candidate takes the minimum of each quantile over its runs", () => {
	assert.deepEqual(minOfRuns([run(6, 9), run(4, 12)]), { dispatch_to_body_ms: { p50: 4, p95: 9 } });
});

const band = {
	machine_class: "M5Max-18c",
	child_runtime: "bun@1.4.4",
	metrics: { dispatch_to_body_ms: { p50: { min: 2, max: 4 }, p95: { min: 5, max: 9 } } },
};
const candidate = (metrics, overrides = {}) => ({
	machine_class: "M5Max-18c",
	child_runtime: "bun@1.4.4",
	metrics,
	...overrides,
});

test("a candidate at the band's max passes; one above it on either quantile is PERF_ABOVE_BAND", () => {
	assert.deepEqual(compareToBand(candidate({ dispatch_to_body_ms: { p50: 4, p95: 9 } }), band), []);
	assert.deepEqual(compareToBand(candidate({ dispatch_to_body_ms: { p50: 4.01, p95: 9 } }), band), [
		{ code: "PERF_ABOVE_BAND", detail: "dispatch_to_body_ms.p50=4.01 > B0 max 4" },
	]);
	assert.deepEqual(compareToBand(candidate({ dispatch_to_body_ms: { p50: 1, p95: 12 } }), band), [
		{ code: "PERF_ABOVE_BAND", detail: "dispatch_to_body_ms.p95=12 > B0 max 9" },
	]);
});

test("a different machine class or child runtime, or a missing band metric, is a finding, never a pass", () => {
	const findings = compareToBand(
		candidate({}, { machine_class: "M4Pro-14c", child_runtime: "node@24.22.1" }),
		band,
	).map((finding) => finding.code);
	assert.deepEqual(findings, ["PERF_MACHINE_CLASS", "PERF_CHILD_RUNTIME", "PERF_METRIC_MISSING"]);
});

test("the machine class drops the vendor prefix and spaces and names the core count", () => {
	assert.equal(machineClass("Apple M5 Max", 18), "M5Max-18c");
	assert.equal(machineClass("AMD EPYC 7763 64-Core Processor", 4), "AMDEPYC776364CoreProcessor-4c");
	assert.equal(machineClass(undefined, 2), "unknown-2c");
});

test("the barrier clock releases a barrier the moment it is reached and refuses a read of one never reached", async () => {
	const arrivals = new Map();
	const released = [];
	const server = {
		barrierArrived: (name) => new Promise((resolve) => arrivals.set(name, resolve)),
		releaseBarrier: (name) => released.push(name),
	};
	const clock = barrierClock({ server });
	clock.arm(["reached", "never"]);
	arrivals.get("reached")();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(released, ["reached"]);
	assert.equal(typeof clock.read("reached"), "number");
	assert.throws(() => clock.read("never"), /barrier never was never reached/);
});
