import { describe, expect, it } from "vitest";
import type { KernelMemoryReport, KernelMemoryThresholds } from "../src/bridge/memory-protocol.ts";
import { KernelMemoryPolicy } from "../src/kernels/shared/kernel-memory.ts";

const MIB = 1024 * 1024;
const thresholds: KernelMemoryThresholds = {
	gcWatermarkBytes: 32 * MIB,
	noticeBytes: 64 * MIB,
	ceilingBytes: 128 * MIB,
};

function measured(liveMb: number, name = "rows"): KernelMemoryReport {
	return { liveBytes: liveMb * MIB, measure: "heap", gcRan: true, globals: [{ name, bytes: liveMb * MIB }] };
}

describe("KernelMemoryPolicy", () => {
	it("Given live memory below the notice threshold when a collected result arrives then it carries no notice", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);

		expect(policy.annotate(measured(40)).notice).toBeUndefined();
	});

	it("Given live memory over the notice threshold when the size stays the same then only the first result notifies", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);

		expect(policy.annotate(measured(80)).notice).toBeDefined();
		expect(policy.annotate(measured(80)).notice).toBeUndefined();
		expect(policy.annotate(measured(99)).notice).toBeUndefined();
		expect(policy.annotate(measured(100)).notice).toBeDefined();
	});

	it("Given a notified kernel that dropped below the notice threshold when live memory crosses it upward again then it notifies", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);
		policy.annotate(measured(90));

		policy.observeLive(40 * MIB);

		expect(policy.annotate(measured(70)).notice).toBeDefined();
	});

	it("Given an estimate that was not measured after a collection when it is over the notice threshold then it never notifies", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);

		expect(policy.annotate({ liveBytes: 100 * MIB, measure: "heap" }).notice).toBeUndefined();
	});

	it("Given a notified kernel when a collection measures under half the notice threshold then a later large global notifies again", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);
		policy.annotate(measured(90));

		policy.observeLive(10 * MIB);

		expect(policy.annotate(measured(90)).notice).toBeDefined();
	});

	it("Given live memory over the ceiling when results keep arriving then the first announces the restart and a recycle is pending", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);

		const offending = policy.annotate(measured(160));
		const queued = policy.annotate(measured(160));

		expect(offending).toMatchObject({ overCeiling: true, liveBytes: 160 * MIB });
		expect(offending.notice).toBeDefined();
		expect(queued.overCeiling).toBe(true);
		expect(queued.notice).toBeUndefined();
		expect(policy.recyclePending).toBe(true);
	});

	it("Given a recycle started when the fresh kernel reports then exactly its first result says it was recycled", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);
		policy.annotate(measured(160));

		policy.recycleStarted();
		policy.kernelRetired();
		const first = policy.annotate({ liveBytes: MIB, measure: "heap" });
		const second = policy.annotate({ liveBytes: MIB, measure: "heap" });

		expect(policy.recyclePending).toBe(false);
		expect(first.recycled).toBe(true);
		expect(first.notice).toBeDefined();
		expect(second.recycled).toBeUndefined();
	});

	it("Given a kernel retired by reset while over the ceiling when it reports again then no recycle is pending or announced", () => {
		const policy = new KernelMemoryPolicy("js", thresholds);
		policy.annotate(measured(160));

		policy.kernelRetired();

		expect(policy.recyclePending).toBe(false);
		expect(policy.annotate({ liveBytes: MIB, measure: "heap" }).recycled).toBeUndefined();
	});

	it("Given notice and ceiling disabled with 0 when a huge collected result arrives then it is passed through", () => {
		const policy = new KernelMemoryPolicy("py", { gcWatermarkBytes: 0, noticeBytes: 0, ceilingBytes: 0 });

		const report = policy.annotate(measured(4096));

		expect(report.notice).toBeUndefined();
		expect(report.overCeiling).toBeUndefined();
		expect(policy.recyclePending).toBe(false);
	});
});
