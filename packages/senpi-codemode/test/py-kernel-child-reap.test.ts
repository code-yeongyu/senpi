import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PythonKernel } from "../src/kernels/py/kernel.ts";
import { hasPython3, liveKernel, type ResultMessage, runCell } from "./py-kernel/fixtures.ts";

const python = process.platform !== "win32" && (await hasPython3());
const kernels: PythonKernel[] = [];
const dirs: string[] = [];
const STATE_WAIT = { timeout: 15_000, interval: 50 };

afterEach(async () => {
	await Promise.allSettled(kernels.splice(0).map((kernel) => kernel.close()));
	await Promise.allSettled(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// `ps` exits non-zero once the pid is reaped; a defunct (zombie) child reports a stat starting with Z.
function processStat(pid: number): string | null {
	try {
		return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

function cellValue(result: ResultMessage): string {
	if (!result.ok) throw new Error(`cell failed: ${result.error.message}`);
	return result.valueRepr ?? "";
}

describe.skipIf(!python)("the Python kernel reaps children whose Popen handle the cell discarded (senpi#7246)", () => {
	it("collects a discarded child that exits while the kernel is idle", async () => {
		const kernel = await liveKernel();
		kernels.push(kernel);
		const dir = await mkdtemp(join(tmpdir(), "senpi-py-reap-"));
		dirs.push(dir);
		const fifo = join(dir, "release");

		// The child blocks on a FIFO the test controls: it is still running when the cell drops its
		// handle, and exits only after the kernel has gone idle.
		const started = await runCell(
			kernel,
			[
				"import os, subprocess, sys",
				`os.mkfifo(${JSON.stringify(fifo)})`,
				`child = subprocess.Popen([sys.executable, '-c', 'import sys; open(sys.argv[1]).read()', ${JSON.stringify(fifo)}])`,
				"pid = child.pid",
				"del child",
				"pid",
			].join("\n"),
		);
		const pid = Number(cellValue(started));
		expect(processStat(pid)).not.toBeNull();

		await writeFile(fifo, "");

		await vi.waitFor(() => expect(processStat(pid)).toBeNull(), STATE_WAIT);
	}, 30_000);

	it("leaves a handle the cell still holds to report its own exit status", async () => {
		const kernel = await liveKernel();
		kernels.push(kernel);

		const started = await runCell(
			kernel,
			"import subprocess, sys\nowned = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'])\nowned.pid",
		);
		const pid = Number(cellValue(started));
		// A retained child stays defunct until its owner waits, as in plain CPython.
		await vi.waitFor(() => expect(processStat(pid)).toMatch(/^Z/), STATE_WAIT);

		// The kernel's reap pass after this cell runs with the owned child already exited.
		await runCell(kernel, "pass");
		const waited = await runCell(kernel, "owned.wait()");

		expect(cellValue(waited)).toBe("7");
	}, 30_000);
});
