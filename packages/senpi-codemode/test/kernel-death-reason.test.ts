import { describe, expect, it } from "vitest";
import { pythonDeathReason } from "../src/kernels/py/death-reason.ts";
import { describeDarwin, describeLinux } from "../src/kernels/shared/host-memory-state.ts";

describe("pythonDeathReason", () => {
	it("names the prelude's parent watch when it stopped the kernel itself", () => {
		const stderr = "warning: x\n[senpi] parent watch: its host process 41 is gone; stopping the kernel\n";
		expect(pythonDeathReason(stderr, { code: null, signal: "SIGKILL" })).toBe(
			"senpi's parent watch stopped it (its host process 41 is gone; stopping the kernel)",
		);
	});

	it("is the exit status with the last memory reading otherwise", () => {
		expect(
			pythonDeathReason("", { code: null, signal: "SIGKILL" }, { liveBytes: 3 * 1024 ** 3, measure: "heap" }),
		).toBe("signal 9 (its last reading was 3 GB live after GC)");
		expect(pythonDeathReason("", { code: 1, signal: null })).toBe("exit code 1");
	});
});

describe("host memory state", () => {
	it("reads the macOS pressure level and swap in use", () => {
		const sysctl = "4\ntotal = 73728.00M  used = 70041.25M  free = 3686.75M  (encrypted)\n";
		expect(describeDarwin(sysctl)).toBe("system memory pressure critical, swap used 68.4 GB");
		expect(describeDarwin("1\ntotal = 0.00M  used = 0.00M  free = 0.00M\n")).toBe(
			"system memory pressure normal, swap used 1 MB",
		);
		expect(describeDarwin("")).toBeUndefined();
	});

	it("reads Linux available memory and swap in use", () => {
		const meminfo = [
			"MemTotal:       16384000 kB",
			"MemAvailable:     409600 kB",
			"SwapTotal:       2097152 kB",
			"SwapFree:         524288 kB",
		].join("\n");
		expect(describeLinux(meminfo)).toBe("400 MB of 15.6 GB memory available, swap used 1.5 GB");
		expect(describeLinux("MemTotal: 1 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB")).toBeUndefined();
	});
});
