import { afterEach, expect, it, vi } from "vitest";
import { materializerReconnect, MemoryMaterializerAdapter } from "../../../../client/src/materializer-test-kit.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { negotiationSockets } from "./4272-negotiation-socket-support.ts";

afterEach(() => vi.unstubAllEnvs());

// #4272 RULING-99: real TCP sockets, host core, faux-provider runtime and exported adapter conformance case.
it("socket B accepts a new generation after socket A commits and disconnects, while old replay stays stale", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	await using net = await negotiationSockets(host.writer, host.core.router);
	const first = await net.connect();
	const capabilities = ["compact_message_updates_v1", "event_resync"];
	await first.request({ type: "set_client_info", capabilities });
	const opened = await first.request({
		type: "open_session",
		cwd: host.cwd,
		admissionId: "a",
		retain_on_disconnect: true,
	});
	expect(opened.success).toBe(true);
	const sessionId = String(opened.sessionId);
	const sessionEpoch = host.writer.recoveryLane(sessionId)?.sessionEpoch ?? "";
	const listed = dataOf(await first.request({ type: "list_sessions" })).sessions;
	if (!Array.isArray(listed)) throw new Error("missing session list");
	const durableSessionId: unknown = listed.find((row) => row.sessionId === sessionId)?.durableSessionId;
	let generation = Number(opened.generation);
	for (let index = 0; index < 3; index++) {
		const reset = await first.request({ type: "reset_stream", sessionId, admissionId: "a" });
		expect(reset.success).toBe(true);
		generation = Number(reset.generation);
	}
	let connected = false;
	await materializerReconnect(new MemoryMaterializerAdapter<string>(), async () => {
		if (!connected) {
			connected = true;
			return { sessionId, sessionEpoch, generation };
		}
		await first.close();
		const second = await net.connect();
		await second.request({ type: "set_client_info", capabilities });
		const next = await second.request({ type: "attach_session", sessionId, durableSessionId, admissionId: "b" });
		expect(next.success).toBe(true);
		return { sessionId, sessionEpoch, generation: Number(next.generation) };
	});
	expect(net.failures).toEqual([]);
}, 600_000);
