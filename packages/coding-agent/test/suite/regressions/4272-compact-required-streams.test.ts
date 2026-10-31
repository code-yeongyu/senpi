import { afterEach, expect, it, vi } from "vitest";
import { MATERIALIZER_ENVELOPE_MAX_BYTES } from "../../../src/modes/rpc/compact-materializer-line.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { heldPeer } from "./4272-legacy-view-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

afterEach(() => vi.unstubAllEnvs());

it("T2/T5 update-only mirrors freeze initial and later required streams without attachment holds", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const first = await owner.request({ type: "open_session", cwd: host.cwd });
	await peer.request({ type: "subscribe_sessions", admissionId: "mirror", mirror: ["message_update"] });
	const later = await owner.request({ type: "open_session", cwd: host.cwd });
	for (const opened of [first, later]) {
		const sessionId = String(dataOf(opened).sessionId);
		expect(host.writer.ordinaryRoute("peer", sessionId)?.routes).toContain("mirror");
		expect(host.writer.recoveryCheckpoints.tokens().some((t) => t.admission.sessionId === sessionId)).toBe(true);
	}
	expect(dataOf(await owner.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ attachments: 1 }),
		expect.objectContaining({ attachments: 1 }),
	]);
}, 120_000);

it("T2/T5 N overlapping selected admissions share one bounded atomic payload", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const opened = await owner.request({ type: "open_session", cwd: host.cwd });
	const sessionId = String(dataOf(opened).sessionId);
	for (let i = 0; i < 8; i++)
		await peer.request({ type: "subscribe_sessions", admissionId: `mirror-${i}`, mirror: ["message_update"] });
	const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable();
	const record = {
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: "x".repeat(20_000) }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
	};
	lane.accept(record, undefined);
	const from = peer.inbox.length;
	const before = host.writer.recoveryEvents?.status().contentBytes ?? 0;
	host.writer.enqueue(sessionId, record);
	await host.writer.flush();
	const frames = peer.inbox.slice(from).filter((f) => f.type === "message_update");
	expect(frames).toHaveLength(8);
	const units = frames.map((frame) => frame.materializer as Record<string, unknown>);
	expect(units.every(Boolean)).toBe(true);
	expect(new Set(units.map((unit) => JSON.stringify(unit.payload))).size).toBe(1);
	expect(units.every((unit) => unit.sequence === lane.acceptedSequence)).toBe(true);
	expect(
		frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) + 1 <= MATERIALIZER_ENVELOPE_MAX_BYTES),
	).toBe(true);
	expect((host.writer.recoveryEvents?.status().contentBytes ?? 0) - before).toBeLessThan(100_000);
	expect(frames.every((frame) => !("message" in frame) && !("admissions" in frame))).toBe(true);
}, 120_000);

it("T5/T6 omitted starts and block controls seed the pre-record cut inside the dependent unit", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const opened = await owner.request({ type: "open_session", cwd: host.cwd });
	const sessionId = String(dataOf(opened).sessionId);
	await peer.request({ type: "subscribe_sessions", admissionId: "updates", mirror: ["message_update"] });
	const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable();
	const start = { type: "message_start", message: { role: "assistant", content: [] } };
	lane.accept(start, undefined);
	host.writer.enqueue(sessionId, start);
	// Canonical-only native block controls use the same pre-accept observer.
	lane.beforeAccept?.({ type: "materializer_control" });
	const cut = lane.acceptedSequence;
	const delta = {
		type: "message_update",
		message: null,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next" },
	};
	lane.accept(delta, undefined);
	host.writer.enqueue(sessionId, delta);
	await host.writer.flush();
	expect(peer.inbox.some((f) => f.type === "message_start")).toBe(false);
	const frame = peer.inbox.find((f) => f.type === "message_update") ?? expect.unreachable();
	expect(frame.materializer).toMatchObject({
		sequence: lane.acceptedSequence,
		controls: [{ kind: "seed", token: expect.any(String), sequence: cut }],
	});
	expect(peer.inbox.some((f) => f.type === "tool_execution_start" || f.type === "tool_execution_end")).toBe(false);
	const reset = await peer.request({ type: "reset_stream", sessionId, admissionId: "updates" });
	expect(reset).toMatchObject({ success: true, admissionId: "updates", generation: expect.any(Number) });
}, 120_000);

it("T5 required state survives sibling unsubscribe and retires with the final mirror", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const opened = await owner.request({ type: "open_session", cwd: host.cwd });
	const sessionId = String(dataOf(opened).sessionId);
	const a = await peer.request({ type: "subscribe_sessions", admissionId: "a", mirror: ["message_update"] });
	const b = await peer.request({ type: "subscribe_sessions", admissionId: "b", mirror: ["message_update"] });
	await peer.request({ type: "unsubscribe_sessions", subscriptionId: dataOf(a).subscriptionId });
	expect(host.writer.ordinaryRoute("peer", sessionId)?.routes).toEqual(["b"]);
	const tokens = () => host.writer.recoveryCheckpoints.tokens().filter((t) => t.admission.peer === "peer");
	expect(tokens()).toHaveLength(1);
	await peer.request({ type: "unsubscribe_sessions", subscriptionId: dataOf(b).subscriptionId });
	expect(tokens()).toHaveLength(0);
}, 120_000);

it("T5 mirror-only overflow freezes the required union before actor drain", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const { writer, lane, producer, checkpoints } = recoveryRig();
	const entry = { state: "open" as const, kind: "interactive" as const, cwd: ".", attachments: 0, context: {} };
	writer.status.setSource({ sessionIds: () => ["s"], entryView: () => entry, view: () => ({ entry }) });
	const peer = heldPeer(writer, "mirror", ["compact_events", "event_resync"]);
	const subscription = writer.status.subscribe("mirror", {
		admissionId: "mirror-route",
		selector: { kind: "all" },
		includeWorkers: true,
		includeContext: false,
		mirror: { kind: "types", types: new Set(["message_update"]) },
		effects: false,
	});
	writer.registerSubscription("mirror", "mirror-route", subscription.subscriptionId);
	writer.status.activate(subscription.subscriptionId);
	const before = checkpoints.status().frozen;
	peer.hold();
	try {
		for (let index = 0; index < 200 && checkpoints.status().frozen === before; index++)
			producer().blockDelta("text", 0, "x", index);
		expect(checkpoints.status().frozen).toBeGreaterThan(before);
		expect(checkpoints.tokens().some((t) => t.admission.routeKind === "mirror")).toBe(true);
	} finally {
		peer.release();
	}
	await writer.flush();
	const frame = peer.lines
		.map((line) => JSON.parse(line))
		.find((f) => f.type === "resync_required" && f.sessionId === "s");
	expect(frame).toMatchObject({ message: { role: "assistant", content: [{ type: "text" }] } });
	expect(frame).not.toHaveProperty("closed");
	writer.setSessionKind("s", "worker");
	writer.closeSession("s", { type: "response", command: "close_session", success: true });
	await writer.flush();
	expect(peer.lines.map((line) => JSON.parse(line)).find((f) => f.type === "session_closed")).toMatchObject({
		sessionId: "s",
		admissionId: "mirror-route",
		generation: expect.any(Number),
	});
	writer.status.unsubscribe("mirror", subscription.subscriptionId);
	writer.unregisterConnection("mirror");
	lane.retire("close");
	await lane.idle();
});
