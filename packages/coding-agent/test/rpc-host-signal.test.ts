import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { signalGeneration } from "../src/modes/rpc/host-stop.ts";

/**
 * The race an ownership proof cannot close: a generation may exit between the moment its identity
 * is proven and the moment the signal is sent. A drained host reaches its empty-exit within
 * milliseconds of being asked to drain, so this is ordinary on a loaded machine - and every caller
 * of this helper is asking the host to LEAVE, which a host that already left has done.
 */
describe("signalGeneration", () => {
	it("reports delivery and ends the process when the generation is alive", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const exited = once(child, "exit");

		expect(signalGeneration(child.pid ?? 0, "SIGTERM")).toBe(true);

		const [code, signal] = await exited;
		expect({ code, signal }).toEqual({ code: null, signal: "SIGTERM" });
	}, 20_000);

	it("reports a generation that was already gone instead of throwing ESRCH", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await once(child, "exit");

		expect(signalGeneration(child.pid ?? 0, "SIGKILL")).toBe(false);
	}, 20_000);
});
