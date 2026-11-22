// senpi#3706: on Node < 24.22 / 26.10, kill() on a child whose spawn failed signals the caller's own process group.
// The spy is mocked, so a regression shows up as a recorded call instead of killing the test runner.
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childConnection } from "../../../src/experimental/mini/shared/transport.ts";
import { signalSpawnedChild } from "../../../src/utils/child-signal.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("signalSpawnedChild", () => {
	it("sends nothing to a child whose spawn failed", async () => {
		const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(() => false);
		const child = spawn("/nonexistent/senpi-3706", []);
		const failed = once(child, "error");
		expect(child.pid).toBeUndefined();

		expect(signalSpawnedChild(child, "SIGKILL")).toBe(false);
		await failed;
		expect(signalSpawnedChild(child, "SIGKILL")).toBe(false);
		expect(kill).not.toHaveBeenCalled();
	});

	it("closing the connection of a worker whose spawn failed sends nothing", async () => {
		// #3708 review MEDIUM: the mini server's liveness timer closes a connection whose worker never answered.
		const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(() => false);
		const child = spawn("/nonexistent/senpi-3706-worker", [], { stdio: ["pipe", "pipe", "inherit"] });
		const failed = once(child, "error");
		const connection = childConnection(child);
		await failed;
		connection.close();
		expect(kill).not.toHaveBeenCalled();
	});

	it("signals a child that started", async () => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
		const exited = once(child, "exit");

		expect(signalSpawnedChild(child, "SIGKILL")).toBe(true);
		const [, signal] = await exited;
		expect(signal).toBe("SIGKILL");
	});
});
