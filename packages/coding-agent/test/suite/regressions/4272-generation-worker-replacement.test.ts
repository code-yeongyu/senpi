import { afterEach, expect, it, vi } from "vitest";
import { dataOf } from "../rpc-session-status-support.ts";
import { workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

afterEach(() => vi.unstubAllEnvs());

// #4272 RULING-99 gap 1b: the host owns the worker's counter, not the isolate doing the replacement.
it("worker replacement rebinds the durable counter before publication and survives reopen", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = await workerAcceptanceHost();
	try {
		const { sessionId, worker } = await host.open();
		const first = worker.acceptance?.generations.next();
		expect(first).toBeDefined();
		expect((await host.request({ type: "new_session", sessionId })).success).toBe(true);
		const next = worker.acceptance?.generations.next();
		expect(Number(next)).toBeGreaterThan(Number(first));
		const settled = host.next("settled", (record) => record.type === "agent_idle");
		expect((await host.request({ type: "prompt", sessionId, message: "persist replacement" })).success).toBe(true);
		await settled;
		const state = dataOf(await host.request({ type: "get_state", sessionId }));
		expect((await host.request({ type: "close_session", sessionId })).success).toBe(true);
		const reopened = await host.request({
			type: "open_session",
			cwd: host.dir,
			sessionPath: state.sessionFile,
		});
		expect(reopened.success).toBe(true);
		const reopenedId = String(dataOf(reopened).sessionId);
		const generation = host.registry.peek(reopenedId)?.worker?.acceptance?.generations.next();
		expect(Number(generation)).toBeGreaterThan(Number(next));
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 600_000);
