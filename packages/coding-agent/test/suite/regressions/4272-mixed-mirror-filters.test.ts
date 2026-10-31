import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => vi.unstubAllEnvs());

it("R3.C4.3/C5.1 mixed mirrors share one seeded physical stream without losing selected records", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	await peer.request({
		type: "subscribe_sessions",
		admissionId: "a",
		mirror: ["message_start", "message_update"],
	});
	await peer.request({ type: "subscribe_sessions", admissionId: "b", mirror: ["message_update"] });
	const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable();
	const start = { type: "message_start", message: { role: "assistant", content: [] } };
	const delta = {
		type: "message_update",
		message: null,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next" },
	};
	const from = peer.inbox.length;
	for (const record of [start, delta]) {
		lane.accept(record, undefined);
		host.writer.enqueue(sessionId, record);
	}
	await host.writer.flush();
	const frames = peer.inbox.slice(from).filter((f) => f.materializer !== undefined);
	expect(frames.map((f) => [f.type, f.admissionId])).toEqual([
		["message_start", "a"],
		["message_update", "a"],
		["message_update", "b"],
	]);
	const units = frames.map((f) => f.materializer as Record<string, unknown>);
	expect(units[0]).toMatchObject({
		controls: [{ kind: "seed", token: expect.any(String), sequence: expect.any(Number) }],
	});
	expect(units[1]).toMatchObject({ sequence: lane.acceptedSequence, controls: [] });
	expect(units[2]).toEqual(units[1]);
	expect(new Set(frames.map((f) => f.generation)).size).toBe(1);
	// C4.3 installs this union once; B observes the shared state, not an admission-local reducer missing A's start.
	expect(host.writer.ordinaryRoute("peer", sessionId)?.routes).toEqual(["a", "b"]);
}, 600_000);
