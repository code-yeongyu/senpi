import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JuliaKernel } from "../src/kernels/jl/kernel.ts";

function hasJulia(): boolean {
	try {
		execFileSync("julia", ["--version"], { stdio: "ignore", timeout: 3_000 });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!hasJulia())("Julia error parity", () => {
	it("Given an undefined variable when a cell runs then the exception type and name reach the result", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-jl-error-parity-"));
		const kernel = JuliaKernel.start({
			cwd: root,
			sessionId: "julia-error-parity",
			connection: { port: 1, token: "unused" },
		});
		try {
			// When
			const result = await kernel.run({
				cellId: "undefined-variable",
				code: 'println("========")\nmissing_var_xyz + 1',
				timeoutMs: 30_000,
			});

			// Then
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Julia undefined-variable cell unexpectedly succeeded");
			expect(result.error.message).toContain("UndefVarError");
			expect(result.error.message).toContain("missing_var_xyz");
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 40_000);
});
