import { describe, expect, it, vi } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { revokeSessionKernels } from "../src/kernels/js/permission-sessions.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

const rule = { permission: "edit", pattern: "*", layer: "user" };

describe("Python permission retirement", () => {
	it.each([false, true])("observed exit, not a kill request, gates replacement: abandoned=%s", async (abandoned) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const original = new FakeChild({ remainAliveOnSigkill: true });
		const replacement = new FakeChild();
		const spawned: FakeChild[] = [];
		const failed = vi.fn();
		const sessionId = crypto.randomUUID();
		const kernel = await PythonKernel.start({
			sessionId,
			cwd: process.cwd(),
			interpreterPath: "python3",
			connection: { port: 1, token: "unused" },
			permissions: { state: () => ({ epoch: 1, active: true, rules: [rule] }) },
			onRevocationFailed: failed,
			onDeath: () => {},
			spawnProcess: () => {
				const child = spawned.length === 0 ? original : replacement;
				spawned.push(child);
				return child;
			},
		});
		try {
			const retirement = revokeSessionKernels(sessionId);
			const queued = kernel.run({ cellId: "next", code: "42" });
			// Subscribe before advancing the deterministic retirement deadline.
			const outcome = queued.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			expect(original.killSignals).toContain("SIGKILL");
			expect(spawned).toHaveLength(1);
			if (abandoned) {
				await vi.advanceTimersByTimeAsync(501);
				await retirement;
				expect(failed).toHaveBeenCalledOnce();
				expect(await outcome).toHaveProperty("error");
				expect(spawned).toHaveLength(1);
				original.finish(null, "SIGKILL");
				await Promise.resolve();
				await expect(kernel.run({ cellId: "still-dead", code: "42" })).rejects.toThrow();
			} else {
				original.finish(null, "SIGKILL");
				await retirement;
				expect(await outcome).toMatchObject({ value: { ok: true } });
				expect(spawned).toHaveLength(2);
				expect(failed).not.toHaveBeenCalled();
			}
		} finally {
			await kernel.close();
			vi.useRealTimers();
		}
	});
	it("rejects an unknown permission token even with the owner bridge bearer", async () => {
		const server = await startBridgeServer({
			onCall: async () => null,
			onCompletion: async () => null,
			onEmit: async () => {},
		});
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/permission_check`, {
				method: "POST",
				headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
				body: JSON.stringify({
					token: "unknown",
					nonce: "probe",
					call: { tool: "write", input: { path: "subject" } },
				}),
			});
			expect(await response.json()).toMatchObject({ ok: false });
		} finally {
			await server.close();
		}
	});
});
