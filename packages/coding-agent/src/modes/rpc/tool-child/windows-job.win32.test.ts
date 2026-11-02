// senpi#3566 todo 4: the real kernel32 Job Object on Windows (runs in the Windows CI job, skipped with a reason elsewhere).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { loadKernel32Job, WindowsJob } from "./windows-job.ts";

const kernel = loadKernel32Job();
const reason = process.platform !== "win32" ? "not win32" : kernel === undefined ? "bun:ffi unavailable" : undefined;

describe.skipIf(reason !== undefined)(`WindowsJob on kernel32${reason ? ` (skipped: ${reason})` : ""}`, () => {
	it("contains an assigned process and its child, and terminating the job ends both", async () => {
		if (kernel === undefined) throw new Error("unreachable");
		const job = WindowsJob.create(kernel);
		const child = spawn(
			process.execPath,
			[
				"-e",
				"require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
			],
			{ stdio: "ignore" },
		);
		try {
			const pid = child.pid ?? -1;
			job.assign(pid);
			expect(job.memberPids()).toContain(pid);
			const exited = once(child, "exit");
			job.terminate(7);
			const [code] = await exited;
			expect(code).toBe(7);
		} finally {
			job.close();
		}
	}, 30_000);
});
