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

/** Fails by name instead of hanging until the test-level timeout reports nothing. */
function withDeadline<T>(work: Promise<T>, timeoutMs: number, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${description} within ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Interpreter startup plus runner/prelude evaluation, before any cell is dispatched. */
const READY_TIMEOUT_MS = 60_000;
/** Julia compiles the parse/eval/showerror path on first use, inside the first cell. */
const COLD_START_TIMEOUT_MS = 60_000;
/** Only has to exceed the two deadlines above, which report which phase overran. */
const TEST_TIMEOUT_MS = 150_000;

describe.skipIf(!hasJulia())("Julia error parity", () => {
	it(
		"Given an undefined variable when a cell runs then the exception type and name reach the result",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-jl-error-parity-"));
			// The kernel arms a cell's timeoutMs only once the interpreter reports
			// `ready`, so a cold boot sits outside every budget except the test-level
			// timeout. Several Julia kernels boot concurrently across this package's
			// suites, and on a loaded CI runner that boot has overrun the old 40s
			// ceiling — reported as a bare "Test timed out in 40000ms". Subscribing to
			// `ready` before start and awaiting it under its own deadline keeps the
			// boot out of the cell budget and names whichever phase overran.
			let markReady: (() => void) | undefined;
			const ready = new Promise<void>((resolve) => {
				markReady = resolve;
			});
			const kernel = JuliaKernel.start({
				cwd: root,
				sessionId: "julia-error-parity",
				connection: { port: 1, token: "unused" },
				onMessage: (message) => {
					if (message.type === "ready") markReady?.();
				},
			});
			try {
				await withDeadline(ready, READY_TIMEOUT_MS, "Julia kernel did not report ready");

				// When
				const result = await kernel.run({
					cellId: "undefined-variable",
					code: 'println("========")\nmissing_var_xyz + 1',
					timeoutMs: COLD_START_TIMEOUT_MS,
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
		},
		TEST_TIMEOUT_MS,
	);
});
