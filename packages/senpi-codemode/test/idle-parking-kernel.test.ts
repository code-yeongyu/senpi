import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleParkingKernel, parkWhenIdle } from "../src/extension/idle-parking-kernel.ts";
import type { EvalKernel, EvalKernelResult, EvalKernelRunInput } from "../src/tool/types.ts";

interface FakeKernel extends EvalKernel {
	readonly id: number;
	readonly ran: string[];
	closed: boolean;
	queued: string[];
	releaseClose: (() => void) | null;
}

function fakeKernel(id: number, options: { holdClose?: boolean } = {}): FakeKernel {
	const kernel: FakeKernel = {
		id,
		ran: [],
		closed: false,
		queued: [],
		releaseClose: null,
		run: async (input: EvalKernelRunInput): Promise<EvalKernelResult> => {
			if (kernel.closed) throw new Error(`kernel ${id} is closed`);
			kernel.ran.push(input.cellId);
			return { type: "result", cellId: input.cellId, ok: true, valueRepr: `kernel ${id}`, durationMs: 1 };
		},
		cancelQueued: () => false,
		interrupt: async () => ({ stateRetained: Promise.resolve(true) }),
		queueSnapshot: () => ({ activeCellId: null, queuedCellIds: kernel.queued }),
		deliverToolReply: () => {},
		reset: async () => {},
		close: () => {
			if (!options.holdClose) {
				kernel.closed = true;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				kernel.releaseClose = () => {
					kernel.closed = true;
					resolve();
				};
			});
		},
	};
	return kernel;
}

const MINUTE = 60_000;

describe("IdleParkingKernel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given a kernel idle for the configured minutes when the next cell arrives then it runs on a fresh kernel whose result says every earlier global is gone", async () => {
		const first = fakeKernel(1);
		const second = fakeKernel(2);
		const restart = vi.fn(async () => second);
		const parked = new IdleParkingKernel("py", 1, first, restart);

		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(first.closed).toBe(true);
		expect(restart).not.toHaveBeenCalled();

		const result = await parked.run({ cellId: "after-park", code: "x" });
		expect(restart).toHaveBeenCalledTimes(1);
		expect(second.ran).toEqual(["after-park"]);
		expect(result).toMatchObject({ ok: true, kernelState: "restarted" });
		expect(result.notice).toContain("every global is lost");
		expect(result.notice).toContain("memory.idleParkMinutes");

		const next = await parked.run({ cellId: "later", code: "y" });
		expect(next.notice).toBeUndefined();
		expect(next.kernelState).toBeUndefined();
		await parked.close();
	});

	it("Given a cell still running when the idle time elapses when it settles then the kernel is kept and the idle clock starts over", async () => {
		const first = fakeKernel(1);
		let finish: ((result: EvalKernelResult) => void) | undefined;
		first.run = (input) =>
			new Promise((resolve) => {
				first.ran.push(input.cellId);
				finish = resolve;
			});
		const parked = new IdleParkingKernel("rb", 1, first, async () => fakeKernel(2));

		const running = parked.run({ cellId: "long", code: "sleep" });
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(first.closed).toBe(false);

		finish?.({ type: "result", cellId: "long", ok: true, valueRepr: "done", durationMs: 1 });
		await running;
		await vi.advanceTimersByTimeAsync(MINUTE - 1);
		expect(first.closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(first.closed).toBe(true);
		await parked.close();
	});

	it("Given the kernel reports a queued cell when the idle time elapses then it is not parked", async () => {
		const first = fakeKernel(1);
		first.queued = ["detached"];
		const parked = new IdleParkingKernel("jl", 1, first, async () => fakeKernel(2));

		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		expect(first.closed).toBe(false);

		first.queued = [];
		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(first.closed).toBe(true);
		await parked.close();
	});

	it("Given a cell submitted while the parked kernel is still closing when the close finishes then the cell runs on the fresh kernel, never on the closed one", async () => {
		const first = fakeKernel(1, { holdClose: true });
		const second = fakeKernel(2);
		const parked = new IdleParkingKernel("py", 1, first, async () => second);

		await vi.advanceTimersByTimeAsync(MINUTE);
		const submitted = parked.run({ cellId: "during-close", code: "x" });
		await vi.advanceTimersByTimeAsync(0);
		expect(second.ran).toEqual([]);
		expect(parked.queueSnapshot().queuedCellIds).toEqual(["during-close"]);

		first.releaseClose?.();
		const result = await submitted;
		expect(first.ran).toEqual([]);
		expect(second.ran).toEqual(["during-close"]);
		expect(result.kernelState).toBe("restarted");
		await parked.close();
	});

	it("Given the restart fails when a cell arrives after the park then that cell gets the reason and the next cell retries the restart", async () => {
		const first = fakeKernel(1);
		const second = fakeKernel(2);
		const restart = vi
			.fn<() => Promise<EvalKernel>>()
			.mockRejectedValueOnce(new Error("interpreter not found"))
			.mockResolvedValueOnce(second);
		const parked = new IdleParkingKernel("rb", 1, first, restart);

		await vi.advanceTimersByTimeAsync(MINUTE);
		const failed = await parked.run({ cellId: "first-try", code: "x" });
		expect(failed).toMatchObject({ ok: false, kernelState: "not-run" });
		if (!failed.ok) {
			expect(failed.error.message).toContain("interpreter not found");
			expect(failed.error.message).toContain("run the cell again");
		}

		const retried = await parked.run({ cellId: "second-try", code: "x" });
		expect(restart).toHaveBeenCalledTimes(2);
		expect(retried).toMatchObject({ ok: true, kernelState: "restarted" });
		expect(second.ran).toEqual(["second-try"]);
		await parked.close();
	});

	it("Given a parking kernel when it is closed then no idle timer stays behind and nothing restarts", async () => {
		const first = fakeKernel(1);
		const restart = vi.fn(async () => fakeKernel(2));
		const parked = new IdleParkingKernel("js", 1, first, restart);

		await parked.close();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(first.closed).toBe(true);
		expect(restart).not.toHaveBeenCalled();
		await expect(parked.run({ cellId: "late", code: "x" })).rejects.toThrow("Kernel closed");
	});

	it("Given a JavaScript kernel with kernel tools when it is wrapped then the tools stay reachable and a tool call keeps it from being parked", async () => {
		const first = fakeKernel(1);
		let release: (() => void) | undefined;
		const describe = vi.fn(async () => ({ results: [] }));
		const invoke = vi.fn(
			() =>
				new Promise<unknown>((resolve) => {
					release = () => resolve("done");
				}),
		);
		const withTools = Object.assign(first, { describeKernelTools: describe, invokeKernelTool: invoke });
		const parked = new IdleParkingKernel("js", 1, withTools, async () => fakeKernel(2));

		expect("describeKernelTools" in parked).toBe(true);
		await parked.describeKernelTools?.(["add"]);
		expect(describe).toHaveBeenCalledWith(["add"]);
		const calling = parked.invokeKernelTool?.({ name: "add", args: {} } as never);
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(first.closed).toBe(false);

		release?.();
		await expect(calling).resolves.toBe("done");
		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(first.closed).toBe(true);
		await expect(parked.describeKernelTools?.(["add"])).rejects.toMatchObject({ code: "tools_unavailable" });
		await parked.close();
	});

	it("Given a kernel whose cells defined tools when it stays idle then it is never parked, and it parks once the tools are gone", async () => {
		const first = fakeKernel(1);
		let names = ["add"];
		first.listKernelToolNames = () => names;
		const onParked = vi.fn();
		const parked = new IdleParkingKernel("js", 1, first, async () => fakeKernel(2), onParked);

		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		expect(first.closed).toBe(false);
		expect(onParked).not.toHaveBeenCalled();

		names = [];
		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(first.closed).toBe(true);
		expect(onParked).toHaveBeenCalledTimes(1);
		await parked.close();
	});

	it("Given a kernel without kernel tools when it is wrapped then the wrapper does not claim to have them", async () => {
		const parked = new IdleParkingKernel("py", 1, fakeKernel(1), async () => fakeKernel(2));

		expect("describeKernelTools" in parked).toBe(false);
		expect("invokeKernelTool" in parked).toBe(false);
		await parked.close();
	});

	it("Given the default of zero minutes when a kernel is wrapped then the same kernel comes back and no timer is armed", () => {
		const kernel = fakeKernel(1);

		const wrapped = parkWhenIdle("py", 0, kernel, async () => fakeKernel(2));

		expect(wrapped).toBe(kernel);
		expect(vi.getTimerCount()).toBe(0);
	});
});
