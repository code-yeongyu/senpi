import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { KernelMemoryHost } from "../src/kernels/shared/kernel-memory-host.ts";
import { SubprocessMemoryGlobals } from "../src/kernels/shared/subprocess-memory-globals.ts";
import { createPendingRun } from "../src/kernels/shared/subprocess-run.ts";

const MIB = 1024 * 1024;
const thresholds = {
	gcWatermarkBytes: 32 * MIB,
	noticeBytes: 64 * MIB,
	ceilingBytes: 512 * MIB,
};

function fixture(liveBytes = 128 * MIB, limits = thresholds) {
	const read = vi.fn(() => ({ bytes: liveBytes }));
	const memory = new KernelMemoryHost("jl", limits, { readFootprint: read });
	const diagnostics = new SubprocessMemoryGlobals();
	diagnostics.reset(true);
	const run = createPendingRun({ cellId: "owned", code: "1 + 1" }, () => {});
	const process = { child: { pid: 123 }, send: vi.fn(() => true) };
	const result = {
		type: "result",
		cellId: "owned",
		ok: true,
		durationMs: 1,
	} as const;
	const finish = vi.fn();
	return { read, memory, diagnostics, run, process, result, finish };
}

describe("owned memory globals request", () => {
	afterEach(() => vi.useRealTimers());

	it("retains ownership until a matching reply and reads the footprint once", () => {
		vi.useFakeTimers();
		const f = fixture();
		const process = f.process;
		f.diagnostics.request({ process, run: f.run, result: f.result }, f.memory, f.finish);
		expect(f.finish).not.toHaveBeenCalled();
		expect(f.process.send).toHaveBeenCalledWith('{"type":"memory-globals","cellId":"owned"}\n');
		f.diagnostics.reply(
			{ process, run: f.run },
			{
				type: "memory-globals-result",
				cellId: "owned",
				globals: [{ name: "data", bytes: 4 * MIB }],
			},
			f.memory,
		);
		expect(f.finish).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				memory: expect.objectContaining({
					globals: [{ name: "data", bytes: 4 * MIB }],
					notice: expect.any(String),
				}),
			}),
		);
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores replies from a different process cell or pending run", () => {
		vi.useFakeTimers();
		const f = fixture();
		const process = f.process;
		const other = { child: { pid: 124 }, send: vi.fn(() => true) };
		f.diagnostics.request({ process, run: f.run, result: f.result }, f.memory, f.finish);
		const reply = {
			type: "memory-globals-result",
			cellId: "owned",
			globals: [],
		} satisfies Extract<KernelToHostMessage, { type: "memory-globals-result" }>;
		f.diagnostics.reply({ process: other, run: f.run }, reply, f.memory);
		f.diagnostics.reply({ process, run: createPendingRun(f.run.input, () => {}) }, reply, f.memory);
		f.diagnostics.reply({ process, run: f.run }, { ...reply, cellId: "stale" }, f.memory);
		expect(f.finish).not.toHaveBeenCalled();
		f.diagnostics.reset();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds a missing reply without skipping the footprint notice", () => {
		vi.useFakeTimers();
		const f = fixture();
		f.diagnostics.request({ process: f.process, run: f.run, result: f.result }, f.memory, f.finish);
		vi.advanceTimersToNextTimer();
		expect(f.finish).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				memory: expect.objectContaining({
					liveBytes: 128 * MIB,
					notice: expect.any(String),
				}),
			}),
		);
		expect(f.read).toHaveBeenCalledTimes(1);
	});

	it("retires the pending deadline on reset without formatting a stale notice", () => {
		vi.useFakeTimers();
		const f = fixture();
		f.diagnostics.request({ process: f.process, run: f.run, result: f.result }, f.memory, f.finish);
		f.diagnostics.reset();
		vi.runAllTimers();
		expect(f.finish).not.toHaveBeenCalled();
	});

	it("requests globals at an enabled ceiling even when the notice threshold is disabled", () => {
		vi.useFakeTimers();
		const f = fixture(128 * MIB, {
			...thresholds,
			noticeBytes: 0,
			ceilingBytes: 128 * MIB,
		});
		f.diagnostics.request({ process: f.process, run: f.run, result: f.result }, f.memory, f.finish);
		expect(f.process.send).toHaveBeenCalledOnce();
		expect(f.finish).not.toHaveBeenCalled();
		f.diagnostics.reset();
	});
});
