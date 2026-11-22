import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { negotiationSockets } from "./4272-negotiation-socket-support.ts";
const PAIR = ["compact_message_updates_v1", "event_resync"];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
it("RULING-66/T7: mixed factory refuses an unsupported open before any physical work", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost({ supportsCompact: (profile) => profile === undefined });
	await using net = await negotiationSockets(host.writer, host.core.router);
	const peer = await net.connect();
	expect(dataOf(await peer.request({ type: "get_protocol_info" })).capabilities).toContain(PAIR[0]);
	expect((await peer.request({ type: "set_client_info", capabilities: PAIR })).success).toBe(true);
	const open = vi.spyOn(RpcSessionRegistry.prototype, "openSession");
	expect(await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "unsupported" })).toMatchObject({
		success: false,
		error: "compact_endpoint_unsupported",
	});
	expect(open).not.toHaveBeenCalled();
	await peer.close();
}, 120000);
it("T7/T2: compact attach, reset, and required mirror reuse the selected socket pair", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	await using net = await negotiationSockets(host.writer, host.core.router);
	const owner = await net.connect();
	await owner.request({ type: "set_client_info", capabilities: PAIR });
	const opened = await owner.request({ type: "open_session", cwd: host.cwd, admissionId: "owner" });
	expect(opened.success).toBe(true);
	const sid = opened.sessionId;
	const listed = dataOf(await owner.request({ type: "list_sessions" })).sessions as {
		sessionId: string;
		durableSessionId: string;
	}[];
	const state = listed.find((row) => row.sessionId === sid);
	if (!state) throw new Error("missing live session row");
	const peer = await net.connect();
	await peer.request({ type: "set_client_info", capabilities: PAIR });
	const attached = await peer.request({
		type: "attach_session",
		sessionId: sid,
		durableSessionId: state.durableSessionId,
		admissionId: "attach",
	});
	expect(attached, JSON.stringify(attached)).toMatchObject({
		success: true,
		command: "attach_session",
		admissionId: "attach",
		data: { attached: true },
	});
	expect(await peer.request({ type: "subscribe_sessions", mirror: "all", admissionId: "mirror" })).toMatchObject({
		success: true,
	});
	expect(await peer.request({ type: "set_client_info", capabilities: [] })).toMatchObject({
		success: false,
		error: "compact_selection_fixed",
	});
	const reset = await peer.request({ type: "reset_stream", sessionId: sid, admissionId: "attach" });
	expect(reset.success).toBe(true);
	await owner.close();
	await peer.close();
}, 120000);
it("T7: incomplete factories never advertise or accept inherited compact tokens", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost({ supportsCompact: () => false });
	await using net = await negotiationSockets(host.writer, host.core.router);
	const peer = await net.connect();
	expect(dataOf(await peer.request({ type: "get_protocol_info" })).capabilities).not.toContain(PAIR[0]);
	expect(await peer.request({ type: "set_client_info", capabilities: PAIR })).toMatchObject({
		success: false,
		error: "compact_endpoint_unsupported",
	});
	await peer.close();
}, 120000);

it("T7: role refusal cannot turn a failed compact selection into implicit legacy admission", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	await using net = await negotiationSockets(host.writer, host.core.router);
	const peer = await net.connect();
	expect((await peer.request({ type: "set_client_info", capabilities: ["interactive_user"] })).success).toBe(true);
	expect((await peer.request({ type: "set_client_info", capabilities: [...PAIR, "task_parent"] })).success).toBe(
		false,
	);
	const open = vi.spyOn(RpcSessionRegistry.prototype, "openSession");
	expect(await peer.request({ type: "open_session", cwd: host.cwd })).toMatchObject({
		success: false,
		error: "compact_selection_refused",
	});
	expect(open).not.toHaveBeenCalled();
	await peer.close();
}, 120000);

it("T7: private or inherited compact tokens cannot select socket transport", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost({ capabilities: ["compact_events", PAIR[0]] });
	await using net = await negotiationSockets(host.writer, host.core.router);
	const peer = await net.connect();
	const opened = await peer.request({ type: "open_session", cwd: host.cwd });
	expect(opened.success).toBe(true);
	expect(host.writer.getConnectionCapabilities("socket-1")).not.toContain("compact_events");
	expect(host.writer.getConnectionCapabilities("socket-1")).not.toContain(PAIR[0]);
	const declared = await peer.request({ type: "set_client_info", capabilities: ["compact_events"] });
	expect(declared.success).toBe(true);
	expect(declared).not.toHaveProperty("data");
	const session = await peer.request({
		type: "set_client_info",
		sessionId: opened.sessionId,
		capabilities: ["compact_events"],
	});
	expect(session.success).toBe(true);
	expect(session).not.toHaveProperty("data");
	expect(host.writer.getConnectionCapabilities("socket-1")).not.toContain("compact_events");
	await peer.close();
}, 120000);
