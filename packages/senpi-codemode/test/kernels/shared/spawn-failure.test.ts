import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JuliaKernel } from "../../../src/kernels/jl/kernel.ts";
import { RubyKernel } from "../../../src/kernels/rb/kernel.ts";
import type { SubprocessKernel } from "../../../src/kernels/shared/subprocess-kernel.ts";

type Start = (command: string) => SubprocessKernel;

const options = { cwd: process.cwd(), sessionId: "spawn-failure", connection: { port: 1, token: "unused" } };

describe.each<[string, Start]>([
	["Ruby", (command) => RubyKernel.start({ ...options, command })],
	["Julia", (command) => JuliaKernel.start({ ...options, command })],
])("%s kernel whose interpreter cannot be spawned (senpi#3500)", (_label, start) => {
	it("settles the queued cell with the spawn error and closes without a retirement failure", async () => {
		// Given: an interpreter path that does not exist, so the spawn fails before any process starts.
		const missing = join(tmpdir(), `senpi-3500-missing-${crypto.randomUUID()}`);
		const kernel = start(missing);

		// When: a cell is queued before the spawn failure is reported.
		const result = await kernel.run({ cellId: "first", code: "1" });

		// Then: closing has no process left to wait for, and the cell carries the spawn error.
		await expect(kernel.close()).resolves.toBeUndefined();
		expect(result).toMatchObject({
			ok: false,
			error: { message: `Kernel startup failed: spawn ${missing} ENOENT` },
		});
	});
});
