import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { SocketEventSinkActor } from "../../src/modes/rpc/socket-event-fanout.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../src/modes/rpc/socket-peer-recovery.ts";

// Part of #4272 (S07a, R3.C6.4, senpi#4530 fold): with the compact-updates flag on, a record captured behind
// a cut reaches the peer only while the peer still holds its session, and a session detached during the gap
// is reported closed with nothing to resume.

beforeEach(() => vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function message(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function delta(text: string, full: string) {
	return {
		type: "message_update",
		message: message(full),
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message(full) },
	};
}

function heldPeer(maxQueueBytes: number) {
	const writer = new SessionEventWriter(() => {});
	const records: Record<string, unknown>[] = [];
	const drain = Promise.withResolvers<void>();
	let blocked = true;
	writer.registerConnection(
		"peer",
		{
			writeRaw: (line) => records.push(JSON.parse(line)),
			waitForBackpressure: () => (blocked ? drain.promise : Promise.resolve()),
		},
		{ stallMs: 50, maxQueueBytes },
	);
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	return {
		writer,
		records,
		release: async () => {
			blocked = false;
			drain.resolve();
			await writer.flush();
		},
	};
}

it("drops the captured records of a session detached during the gap and reports it closed with message null", async () => {
	vi.useFakeTimers();
	const peer = heldPeer(512);
	peer.writer.attachConnectionToSession("peer", "rpc-1");
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	for (let index = 1; index <= 10; index++) peer.writer.enqueue("rpc-1", delta("x", "x".repeat(index)));

	peer.writer.detachConnectionFromSession("peer", "rpc-1");
	peer.writer.forgetSession("rpc-1");
	await peer.release();

	const closed = peer.records.findIndex((record) => record.type === "resync_required" && record.sessionId === "rpc-1");
	expect(peer.records[closed]).toEqual({
		type: "resync_required",
		reason: "overflow",
		sessionId: "rpc-1",
		message: null,
		closed: true,
	});
	expect(peer.records.slice(closed + 1).filter((record) => record.sessionId === "rpc-1")).toEqual([]);
	expect(peer.writer.openLegacyViews).toBe(0);
	peer.writer.unregisterConnection("peer");
});

it("drops the captured records of a session detached and re-attached during the gap; the new attachment gets its own baseline", async () => {
	vi.useFakeTimers();
	const peer = heldPeer(512);
	peer.writer.attachConnectionToSession("peer", "rpc-1");
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	// The deltas overflow the budget at a cut; the last ones are captured behind it for the attachment of that moment.
	for (let index = 1; index <= 5; index++) peer.writer.enqueue("rpc-1", delta(`${index}`, "x".repeat(index)));

	// The attach ordinal the captured suffix was held for ends here; the re-attach is a new attachment.
	peer.writer.detachConnectionFromSession("peer", "rpc-1");
	peer.writer.attachConnectionToSession("peer", "rpc-1");
	await peer.release();

	const gap = peer.records.findIndex((record) => record.type === "resync_required" && !record.sessionId);
	const after = peer.records.slice(gap + 1).filter((record) => record.sessionId === "rpc-1");
	const shape = after.map((record) =>
		record.type === "message_update"
			? (record.assistantMessageEvent as { delta: string }).delta
			: String(record.type),
	);
	expect(shape).toEqual(["resync_required", "message_start", "1", "2", "3", "4", "5"]);
	expect(peer.writer.openLegacyViews).toBe(0);
	peer.writer.unregisterConnection("peer");
});

it("keeps the captured records of a session the peer still holds and of a lifecycle broadcast", async () => {
	vi.useFakeTimers();
	const peer = heldPeer(512);
	peer.writer.attachConnectionToSession("peer", "rpc-1");
	peer.writer.attachConnectionToSession("peer", "rpc-2");
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	// Four deltas overflow the budget at the cut; the captured suffix (rpc-2's update, the broadcast) fits behind it.
	for (let index = 1; index <= 4; index++) peer.writer.enqueue("rpc-1", delta("x", "x".repeat(index)));
	peer.writer.enqueue("rpc-2", delta("y", "y"));
	peer.writer.enqueue("rpc-1", { type: "agent_idle" });

	peer.writer.detachConnectionFromSession("peer", "rpc-1");
	await peer.release();

	const gap = peer.records.findIndex((record) => record.type === "resync_required" && !record.sessionId);
	const after = peer.records.slice(gap + 1);
	expect(after.filter((record) => record.type === "resync_required").map((record) => record.sessionId)).toEqual([
		"rpc-1",
		"rpc-2",
	]);
	expect(after.filter((record) => record.type === "message_update").map((record) => record.sessionId)).toEqual([
		"rpc-2",
	]);
	expect(after.filter((record) => record.type === "agent_idle")).toHaveLength(1);
	peer.writer.unregisterConnection("peer");
});

it("writes a captured notice's callback when the notice is written, exactly once", async () => {
	const drain = Promise.withResolvers<void>();
	const writes: string[] = [];
	const actor = new SocketEventSinkActor(
		{ writeRaw: (line) => writes.push(line), waitForBackpressure: () => drain.promise },
		() => {},
		400,
		undefined,
		"capture",
	);
	actor.enableRecovery(() => ({ empty: true, sessions: [], next: async () => undefined, release: () => {} }));
	actor.enqueue('{"type":"agent_start"}\n');
	const queued = vi.fn();
	const incoming = vi.fn();
	actor.enqueue('{"type":"close_overflow","ids":["a"]}\n', undefined, queued);
	actor.enqueue(`${JSON.stringify({ type: "message_update", message: "x".repeat(500) })}\n`);
	actor.enqueue('{"type":"close_overflow","ids":["b"]}\n', undefined, incoming);

	// The shed released the queued notice; the incoming one is captured behind the cut and written after it.
	expect(queued).toHaveBeenCalledTimes(1);
	expect(incoming).toHaveBeenCalledTimes(0);
	drain.resolve();
	await actor.flush();
	expect(queued).toHaveBeenCalledTimes(1);
	expect(incoming).toHaveBeenCalledTimes(1);
	expect(writes.at(-1)).toBe('{"type":"close_overflow","ids":["b"]}\n');
	actor.close();
});
