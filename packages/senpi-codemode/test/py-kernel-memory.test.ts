import { describe, expect, it } from "vitest";
import type { KernelMemoryThresholds } from "../src/bridge/memory-protocol.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";

const MIB = 1024 * 1024;
const lowered: KernelMemoryThresholds = {
	gcWatermarkBytes: 32 * MIB,
	noticeBytes: 64 * MIB,
	ceilingBytes: 128 * MIB,
};
const detected = await createInterpreterDetector().detect("py");

async function withKernel<T>(memory: KernelMemoryThresholds | undefined, fn: (kernel: PythonKernel) => Promise<T>) {
	if (!detected.ok) throw new Error("python unavailable");
	const kernel = await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: `py-memory-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		connection: { port: 1, token: "unused" },
		...(memory === undefined ? {} : { memory }),
	});
	try {
		return await fn(kernel);
	} finally {
		await kernel.close();
	}
}

function run(kernel: PythonKernel, code: string) {
	return kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 30_000 });
}

describe.runIf(detected.ok)("PythonKernel memory management", () => {
	it("Given no memory thresholds when a cell settles then the result carries no memory report", async () => {
		await withKernel(undefined, async (kernel) => {
			const result = await run(kernel, "big = b'x' * (96 * 1024 * 1024); len(big)");

			expect(result).toMatchObject({ ok: true, valueRepr: String(96 * MIB) });
			expect(result.memory).toBeUndefined();
		});
	});

	it("Given a global over the notice threshold when it is created then the result names the largest global once", async () => {
		await withKernel({ ...lowered, ceilingBytes: 0 }, async (kernel) => {
			const created = await run(kernel, "big = b'x' * (96 * 1024 * 1024); small = b'y' * (8 * 1024 * 1024)");
			const unchanged = await run(kernel, "1 + 1");

			expect(created.memory).toMatchObject({ measure: "footprint", gcRan: true });
			expect(created.memory?.liveBytes).toBeGreaterThanOrEqual(96 * MIB);
			expect(created.memory?.globals?.map((global) => global.name)).toEqual(["big", "small"]);
			expect(created.memory?.globals?.[0]?.bytes).toBeGreaterThanOrEqual(96 * MIB);
			expect(created.memory?.notice).toBeDefined();
			expect(unchanged).toMatchObject({ ok: true, valueRepr: "2", memory: { measure: "footprint" } });
			expect(unchanged.memory?.notice).toBeUndefined();
		});
	});

	it("Given a large list of dicts when a later cell deletes it then that cell reports a much smaller footprint", async () => {
		await withKernel({ ...lowered, ceilingBytes: 0 }, async (kernel) => {
			const allocated = await run(kernel, "rows = [dict(i=i) for i in range(400_000)]");
			const dropped = await run(kernel, "del rows");

			const before = allocated.memory?.liveBytes ?? 0;
			expect(before).toBeGreaterThanOrEqual(64 * MIB);
			expect(allocated.memory?.globals?.[0]).toMatchObject({ name: "rows" });
			expect(dropped.ok).toBe(true);
			expect(dropped.memory?.liveBytes ?? before).toBeLessThan(before * 0.5);
		});
	});

	it("Given a cell over the ceiling with a cell queued behind it when both settle then the queued cell keeps the globals and the next cell runs on a recycled kernel", async () => {
		await withKernel(lowered, async (kernel) => {
			const offending = run(kernel, "huge = b'x' * (160 * 1024 * 1024)");
			const queued = run(kernel, "type(huge).__name__");

			const offendingResult = await offending;
			const queuedResult = await queued;
			const next = await run(kernel, "'huge' in globals()");

			expect(offendingResult.memory).toMatchObject({ overCeiling: true, globals: [{ name: "huge" }] });
			expect(offendingResult.memory?.notice).toBeDefined();
			expect(queuedResult).toMatchObject({ ok: true, valueRepr: "'bytes'" });
			expect(next).toMatchObject({ ok: true, valueRepr: "False", memory: { recycled: true } });
			expect(next.memory?.notice).toBeDefined();
		});
	});
});
