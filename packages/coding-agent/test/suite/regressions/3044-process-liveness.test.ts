import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAlive } from "../../helpers/spawned-host-reaper.ts";

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

// #3044: an exit notification can race the kernel reaping the last zombie.
describe.skipIf(process.platform === "win32")("owner exit liveness assertion", () => {
	it("does not report a reaped process alive after a successful signal-zero check", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
		const pid = child.pid;
		if (pid === undefined) throw new Error("child did not start");
		const kill = process.kill.bind(process);
		// Replay the successful check immediately before reaping; ps observes the real, absent PID.
		vi.spyOn(process, "kill").mockImplementation((target, signal) =>
			target === pid && signal === 0 ? true : kill(target, signal),
		);
		expect(processAlive(pid)).toBe(false);
	});

	it("still reports a live process alive", () => {
		expect(processAlive(process.pid)).toBe(true);
	});

	it("treats an unreaped zombie as exited", () => {
		vi.spyOn(childProcess, "execFileSync").mockReturnValue("Z\n");
		syncBuiltinESMExports();
		expect(processAlive(process.pid)).toBe(false);
	});

	it("does not turn an observation failure into proof of exit", () => {
		const failure = Object.assign(new Error("ps unavailable"), { code: "ENOENT" });
		vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
			throw failure;
		});
		syncBuiltinESMExports();
		expect(() => processAlive(process.pid)).toThrow(failure);
	});
});
