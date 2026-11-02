import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hasPython3 } from "./py-kernel/fixtures.ts";

const execute = promisify(execFile);
const harness = fileURLToPath(new URL("./py-kernel-bookkeeping.py", import.meta.url));
const prelude = fileURLToPath(new URL("../src/kernels/py/prelude.py", import.meta.url));

describe.skipIf(!(await hasPython3()))("Python per-cell bookkeeping", () => {
	it("uses two FIFO operations zero Python queue locks and one capture scope per cell", async () => {
		const { stdout } = await execute("python3", [harness, prelude], { timeout: 20_000 });
		const line = stdout.split("\n").find((entry) => entry.startsWith("WORK_COUNT "));
		if (line === undefined) throw new Error(`missing work count: ${stdout}`);
		console.log(line);
		const measured: unknown = JSON.parse(line.slice("WORK_COUNT ".length));
		expect(measured).toEqual({
			fifo: 2,
			queueLocks: 0,
			queueNotifications: 0,
			captureScopes: 1,
			acquires: 1,
			releases: 1,
		});
	});
});
