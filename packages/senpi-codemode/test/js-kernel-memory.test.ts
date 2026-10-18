import { describe, expect, it } from "vitest";
import type { KernelMemoryThresholds } from "../src/bridge/memory-protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

const MIB = 1024 * 1024;
const lowered: KernelMemoryThresholds = {
	gcWatermarkBytes: 32 * MIB,
	noticeBytes: 64 * MIB,
	ceilingBytes: 128 * MIB,
};
const EVENT_BOUND_MS = 15_000;

/** Node workers and Bun before 1.4.3 get the kernel's idle collection; newer Bun collects idle threads itself. */
function workerOwnsIdleCollection(bunVersion: string | undefined): boolean {
	if (bunVersion === undefined) return true;
	const [major = 0, minor = 0, patch = 0] = bunVersion.split(".").map((part) => Number.parseInt(part, 10));
	return major * 1_000_000 + minor * 1_000 + patch < 1_004_003;
}

function float64Global(name: string, mebibytes: number): string {
	return `globalThis.${name} = new Float64Array(${(mebibytes * MIB) / 8}).fill(1); undefined`;
}

async function withKernel<T>(
	memory: KernelMemoryThresholds,
	fn: (kernel: JavaScriptKernel, nextCollection: () => Promise<number>) => Promise<T>,
): Promise<T> {
	const waiters: Array<(liveBytes: number) => void> = [];
	const kernel = new JavaScriptKernel({
		sessionId: `memory-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		parallelPoolWidth: 1,
		memory,
		onMemoryCollected: (liveBytes) => waiters.shift()?.(liveBytes),
	});
	const nextCollection = (): Promise<number> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no idle collection within the bound")), EVENT_BOUND_MS);
			waiters.push((liveBytes) => {
				clearTimeout(timer);
				resolve(liveBytes);
			});
		});
	try {
		return await fn(kernel, nextCollection);
	} finally {
		await kernel.close();
	}
}

function run(kernel: JavaScriptKernel, code: string) {
	return kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 30_000 });
}

describe("JavaScriptKernel memory management", () => {
	it("Given a small session when cells settle then results report memory without collections or notices", async () => {
		await withKernel(lowered, async (kernel) => {
			const result = await run(kernel, "globalThis.small = Array.from({ length: 1000 }, (_, i) => i); small.length");

			expect(result).toMatchObject({ ok: true, valueRepr: "1000", memory: { measure: "heap" } });
			expect(result.memory?.gcRan).toBeUndefined();
			expect(result.memory?.notice).toBeUndefined();
		});
	});

	it.runIf(workerOwnsIdleCollection(process.versions.bun))(
		"Given a dropped large global when the kernel goes idle then an idle collection reclaims it and other globals survive",
		async () => {
			await withKernel({ ...lowered, ceilingBytes: 0 }, async (kernel, nextCollection) => {
				const allocated = await run(kernel, `const keep = { n: 1 }; ${float64Global("big", 150)}`);
				expect(allocated.memory?.gcRan).toBe(true);
				const before = allocated.memory?.liveBytes ?? 0;
				expect(before).toBeGreaterThanOrEqual(140 * MIB);

				const dropped = await run(kernel, "delete globalThis.big; 'dropped'");
				expect(dropped.ok).toBe(true);
				const idleLive = await nextCollection();

				const probe = await run(kernel, "keep.n === 1");
				expect(idleLive).toBeLessThan(before * 0.25);
				expect(probe).toMatchObject({ ok: true, valueRepr: "true" });
				expect(probe.memory?.liveBytes ?? before).toBeLessThan(before * 0.25);
			});
		},
	);

	it("Given a global over the notice threshold when it is created then the result names it once and an unchanged next cell does not repeat it", async () => {
		await withKernel({ ...lowered, ceilingBytes: 0 }, async (kernel) => {
			const created = await run(kernel, float64Global("rows", 96));
			const unchanged = await run(kernel, "1 + 1");

			expect(created.memory).toMatchObject({ gcRan: true, globals: [{ name: "rows" }] });
			expect(created.memory?.liveBytes).toBeGreaterThanOrEqual(64 * MIB);
			expect(created.memory?.notice).toBeDefined();
			expect(unchanged.memory?.notice).toBeUndefined();
		});
	});

	it("Given a cell over the ceiling with a cell queued behind it when both settle then the queued cell keeps the globals and the next cell runs on a recycled kernel", async () => {
		await withKernel(lowered, async (kernel) => {
			const offending = run(kernel, float64Global("huge", 160));
			const queued = run(kernel, "typeof huge");

			const offendingResult = await offending;
			const queuedResult = await queued;
			const next = await run(kernel, "typeof huge");

			expect(offendingResult.memory).toMatchObject({ overCeiling: true, globals: [{ name: "huge" }] });
			expect(offendingResult.memory?.notice).toBeDefined();
			expect(queuedResult).toMatchObject({ ok: true, valueRepr: JSON.stringify("object") });
			expect(next).toMatchObject({ ok: true, valueRepr: JSON.stringify("undefined"), memory: { recycled: true } });
			expect(next.memory?.notice).toBeDefined();
		});
	});

	it("Given three settled cells when the kernel is read between them then it keeps the last frame's heap and a memory query answers without a cell", async () => {
		await withKernel({ ...lowered, ceilingBytes: 0 }, async (kernel) => {
			expect(kernel.lastLiveBytes).toBeUndefined();
			for (const mebibytes of [8, 24, 40]) {
				const result = await run(kernel, float64Global(`step${mebibytes}`, mebibytes));
				const frameBytes = result.memory?.liveBytes ?? 0;
				expect(kernel.lastLiveBytes).toBe(frameBytes);

				const reading = await kernel.queryMemory();

				expect(reading?.measure).toBe("heap");
				expect(reading?.liveBytes ?? 0).toBeGreaterThan(frameBytes / 10);
				expect(reading?.liveBytes ?? 0).toBeLessThan(frameBytes * 10);
				expect(kernel.lastLiveBytes).toBe(reading?.liveBytes);
			}
			expect(kernel.queueSnapshot().activeCellId).toBeNull();
		});
	});

	it.runIf(workerOwnsIdleCollection(process.versions.bun))(
		"Given a dropped large global when the idle collection runs then the kernel's last-known heap is the collected size",
		async () => {
			await withKernel({ ...lowered, ceilingBytes: 0 }, async (kernel, nextCollection) => {
				await run(kernel, float64Global("transient", 120));
				await run(kernel, "delete globalThis.transient; 0");

				const idleLive = await nextCollection();

				expect(kernel.lastLiveBytes).toBe(idleLive);
			});
		},
	);

	it("Given a kernel whose worker never started when its memory is queried then it answers nothing instead of starting one", async () => {
		await withKernel(lowered, async (kernel) => {
			await expect(kernel.queryMemory()).resolves.toBeUndefined();
			expect(kernel.lastLiveBytes).toBeUndefined();
		});
	});
});
