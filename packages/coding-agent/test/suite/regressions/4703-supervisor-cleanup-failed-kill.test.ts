import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { stopSupervisor } from "./1370-supervisor-cleanup-support.ts";

// senpi#4703: a supervisor whose exit-wait rejects (a failed signal on win32, a lost wait) still has a
// live pid; cleanup must fail by name instead of returning as if nothing was left to stop.
describe("stopSupervisor with a rejected exit-wait and a live pid (senpi#4703)", () => {
	it("fails by name and still signals the supervisor instead of returning silently", async () => {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		expect(child.pid).toBeDefined();
		const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const exited = Promise.reject(new Error("simulated kill failure"));

		await expect(stopSupervisor(child, exited, () => "last line\n")).rejects.toThrow(
			/supervisor did not exit within .* of cleanup/,
		);

		await gone;
		expect(child.signalCode ?? child.exitCode).not.toBeNull();
	}, 30_000);

	it("returns without signalling when the spawn itself failed (no pid)", async () => {
		const never = spawn("senpi-4703-no-such-binary", []);
		const spawnFailed = once(never, "error");
		expect(never.pid).toBeUndefined();
		await expect(
			stopSupervisor(never, Promise.reject(new Error("spawn failed")), () => ""),
		).resolves.toBeUndefined();
		await spawnFailed;
	}, 30_000);
});
