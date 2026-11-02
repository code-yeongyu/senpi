import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { kernelCpuMs } from "../../scripts/bench-measure.ts";
import { crashQueue100 } from "../../scripts/bench-scenarios-crash.ts";
import { createBenchSession, loadTarget } from "../../scripts/bench-session.ts";

it.skipIf(process.platform === "win32")(
	"retains real interpreter CPU when a cell kills it",
	async () => {
		// Given a real Python kernel and the benchmark-owned exit waiter.
		const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
		const fresh = () => createBenchSession(modules, "py");
		const session = await fresh();
		try {
			// When a cell exits its interpreter with 100 entries queued.
			const result = await crashQueue100.run({ language: "py", session, fresh, rep: 0 });
			// Then dead-process CPU is measured and every queued entry settles.
			expect(result.kernelCpuMs).toBeGreaterThan(0);
			expect(Number(result.observations?.queuedOk) + Number(result.observations?.queuedFailed)).toBe(100);
			expect(result.observations?.remainingProcesses).toBe(0);
		} finally {
			await session.dispose();
		}
	},
	120_000,
);

it.skipIf(process.platform === "win32")(
	"retains CPU when forced retirement kills the entire kernel group",
	async () => {
		// Given a warmed real interpreter and a subscribed exit-usage collector.
		const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
		const session = await createBenchSession(modules, "py");
		try {
			const kernel = await session.kernel();
			const groupResult = await kernel.run({
				cellId: "group",
				code: '__import__("os").getpgrp()',
				timeoutMs: 60_000,
			});
			if (!groupResult.ok) throw new Error(groupResult.error.message);
			const group = Number(groupResult.valueRepr);
			expect(group).toBeGreaterThan(0);
			expect(group).not.toBe(process.pid);
			const before = await session.cpu();
			const started = Promise.withResolvers<void>();
			const running = kernel.run({
				cellId: "killed-group",
				code: '__import__("time").sleep(30)',
				timeoutMs: 60_000,
				onStarted: started.resolve,
			});
			await started.promise;
			// When the host uses the same group kill as forced kernel retirement.
			process.kill(-group, "SIGKILL");
			await running;
			// Then the collector survives and supplies final usage rather than zero.
			const after = await session.cpu(false);
			expect(after.some((entry) => before.some((prior) => prior.pid === entry.pid))).toBe(true);
			expect(kernelCpuMs(before, after)).toBeGreaterThanOrEqual(0);
		} finally {
			await session.dispose();
		}
	},
	120_000,
);
