import { describe, expect, it } from "vitest";
import { hasPython3, liveKernel, runCell } from "./py-kernel/fixtures.ts";

describe.skipIf(!(await hasPython3()))("PythonKernel live interrupt", () => {
	it("interrupts a real infinite loop and reuses the same kernel", async () => {
		const started = Promise.withResolvers<void>();
		const startedTimeout = setTimeout(
			() => started.reject(new Error("Python loop did not emit its started phase")),
			3_000,
		);
		const kernel = await liveKernel({
			onMessage: (message) => {
				if (message.type !== "phase" || message.title !== "started") return;
				clearTimeout(startedTimeout);
				started.resolve();
			},
		});
		try {
			const identity = await runCell(kernel, "import os\nstate_marker = 'preserved'\nos.getpid()");
			expect(identity).toMatchObject({ ok: true, valueRepr: expect.stringMatching(/^\d+$/) });
			if (!identity.ok || identity.valueRepr === undefined) throw new Error("Python PID was not returned");
			const pending = kernel.run({
				cellId: "live-interrupt-loop",
				code: "phase('started')\nwhile True:\n    pass",
				timeoutMs: 10_000,
			});
			await started.promise;

			await kernel.interrupt("Eval interrupted");
			const interrupted = await pending;

			expect(interrupted.ok).toBe(false);
			if (!interrupted.ok) expect(interrupted.error.message).toBe("Eval interrupted");
			expect(interrupted.durationMs).toBeGreaterThan(0);
			await expect(runCell(kernel, "(os.getpid(), state_marker)")).resolves.toMatchObject({
				ok: true,
				valueRepr: `(${identity.valueRepr}, 'preserved')`,
			});
		} finally {
			clearTimeout(startedTimeout);
			await kernel.close();
		}
	});
});
