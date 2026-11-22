import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

const CAPABILITY = "event_resync";

function fixture(capable = true, maxQueueBytes = 1024 * 1024) {
	const writer = new SessionEventWriter(() => {});
	const records: Record<string, unknown>[] = [];
	const closed = vi.fn();
	const drain = Promise.withResolvers<void>();
	let blocked = true;
	writer.registerConnection(
		"peer",
		{
			writeRaw: (line) => records.push(JSON.parse(line)),
			waitForBackpressure: () => (blocked ? drain.promise : Promise.resolve()),
			close: closed,
		},
		{ stallMs: 50, maxQueueBytes },
	);
	if (capable) writer.setConnectionCapabilities("peer", [CAPABILITY]);
	writer.attachConnectionToSession("peer", "rpc-1");
	return {
		writer,
		records,
		closed,
		answerPing: () => writer.setConnectionCapabilities("peer", [CAPABILITY]),
		drain: async () => {
			blocked = false;
			drain.resolve();
			await writer.flush();
		},
	};
}

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

afterEach(() => vi.useRealTimers());

// #3728: backpressure measures lag, not process liveness.
it("keeps a ping-answering stalled peer and resumes from its latest snapshot", async () => {
	vi.useFakeTimers();
	const peer = fixture();
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	peer.writer.enqueue("rpc-1", delta("hello", "hello"));

	await vi.advanceTimersByTimeAsync(50);
	expect(peer.closed).not.toHaveBeenCalled();
	expect(peer.records).toContainEqual({ type: "rpc_ping" });
	peer.answerPing();
	peer.writer.enqueue("rpc-1", delta(" world", "hello world"));
	for (let budget = 0; budget < 20; budget++) {
		await vi.advanceTimersByTimeAsync(50);
		peer.answerPing();
	}
	expect(peer.records.filter((record) => record.type === "rpc_ping")).toHaveLength(1);
	await peer.drain();

	expect(peer.closed).not.toHaveBeenCalled();
	expect(peer.records).toContainEqual({
		type: "resync_required",
		sessionId: "rpc-1",
		reason: "stall",
		message: message("hello world"),
	});
	peer.writer.enqueue("rpc-1", delta("!", "hello world!"));
	await peer.writer.flush();
	expect(peer.records.at(-1)).toMatchObject({ type: "message_update", message: message("hello world!") });
	peer.writer.unregisterConnection("peer");
});

it("cancels the stall deadline when a connection unregisters", async () => {
	vi.useFakeTimers();
	const peer = fixture();
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	const before = peer.records.length;

	peer.writer.unregisterConnection("peer");
	await vi.advanceTimersByTimeAsync(500);

	expect(peer.closed).not.toHaveBeenCalled();
	expect(peer.records).toHaveLength(before);
});

it("captures every attached session before resuming deltas and isolates other peers", async () => {
	vi.useFakeTimers();
	const peer = fixture(true, 512);
	const healthy: Record<string, unknown>[] = [];
	peer.writer.registerConnection("healthy", {
		writeRaw: (line) => healthy.push(JSON.parse(line)),
		waitForBackpressure: () => Promise.resolve(),
	});
	peer.writer.attachConnectionToSession("healthy", "rpc-1");
	peer.writer.attachConnectionToSession("peer", "rpc-2");
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	peer.writer.enqueue("rpc-2", { type: "message_start", message: message("") });

	for (let index = 1; index <= 10; index++) {
		peer.writer.enqueue("rpc-1", delta("a", "a".repeat(index)));
		peer.writer.enqueue("rpc-2", delta("b", "b".repeat(index)));
	}
	await peer.drain();

	expect(peer.records.filter((record) => record.type === "resync_required" && record.sessionId)).toEqual([
		{ type: "resync_required", reason: "overflow", sessionId: "rpc-1", message: message("a".repeat(10)) },
		{ type: "resync_required", reason: "overflow", sessionId: "rpc-2", message: message("b".repeat(10)) },
	]);
	expect(healthy.filter((record) => record.type === "message_update")).toHaveLength(10);
	expect(healthy.some((record) => record.type === "resync_required")).toBe(false);
	peer.writer.unregisterConnection("peer");
	peer.writer.unregisterConnection("healthy");
});

it("closes a stalled peer only after its liveness ping goes unanswered", async () => {
	vi.useFakeTimers();
	const peer = fixture();
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });

	await vi.advanceTimersByTimeAsync(50);
	expect(peer.closed).not.toHaveBeenCalled();
	expect(peer.records).toContainEqual({ type: "rpc_ping" });
	await vi.advanceTimersByTimeAsync(50);

	expect(peer.closed).toHaveBeenCalledTimes(1);
	await peer.drain();
});

it("retains the existing stall cut for a client without the capability", async () => {
	vi.useFakeTimers();
	const peer = fixture(false);
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });

	await vi.advanceTimersByTimeAsync(50);

	expect(peer.closed).toHaveBeenCalledTimes(1);
	expect(peer.records.at(-1)).toMatchObject({ type: "overflow" });
	expect(peer.records.some((record) => record.type === "rpc_ping")).toBe(false);
	await peer.drain();
});

it("sheds a byte overflow without closing and recovers the latest message", async () => {
	vi.useFakeTimers();
	const peer = fixture(true, 512);
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });

	for (let index = 1; index <= 40; index++) peer.writer.enqueue("rpc-1", delta("x", "x".repeat(index)));
	expect(peer.closed).not.toHaveBeenCalled();
	peer.answerPing();
	await peer.drain();

	expect(peer.closed).not.toHaveBeenCalled();
	expect(peer.records).toContainEqual({
		type: "resync_required",
		sessionId: "rpc-1",
		reason: "overflow",
		message: message("x".repeat(40)),
	});
	expect(peer.records.filter((record) => record.type === "resync_required")).toHaveLength(2);
	peer.writer.unregisterConnection("peer");
});

it("delivers retained replies before announcing uncertain requests", async () => {
	vi.useFakeTimers();
	const peer = fixture(true, 512);
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	await peer.writer.withConnection("peer", () =>
		peer.writer.enqueueControl({ type: "response", command: "get_state", id: "read-1", success: true }),
	);

	for (let index = 1; index <= 10; index++) peer.writer.enqueue("rpc-1", delta("x", "x".repeat(index)));
	await peer.drain();

	const reply = peer.records.findIndex((record) => record.id === "read-1");
	const gap = peer.records.findIndex((record) => record.type === "resync_required");
	expect(reply).toBeGreaterThan(0);
	expect(reply).toBeLessThan(gap);
	expect(peer.closed).not.toHaveBeenCalled();
	peer.writer.unregisterConnection("peer");
});

it("reports a session detached during the gap instead of silently forgetting it", async () => {
	vi.useFakeTimers();
	const peer = fixture(true, 512);
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	for (let index = 1; index <= 10; index++) peer.writer.enqueue("rpc-1", delta("x", "x".repeat(index)));

	peer.writer.detachConnectionFromSession("peer", "rpc-1");
	peer.writer.forgetSession("rpc-1");
	await peer.drain();

	expect(peer.records).toContainEqual({
		type: "resync_required",
		reason: "overflow",
		sessionId: "rpc-1",
		message: null,
		closed: true,
	});
	peer.writer.unregisterConnection("peer");
});

it("announces unknown outcomes only when a correlated reply could not fit", async () => {
	vi.useFakeTimers();
	const peer = fixture(true, 512);
	peer.writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	await peer.writer.withConnection("peer", () =>
		peer.writer.enqueueControl({
			type: "response",
			command: "get_state",
			id: "large-read",
			success: true,
			data: "x".repeat(1024),
		}),
	);

	await peer.drain();

	const gap = peer.records.findIndex((record) => record.type === "resync_required" && !record.sessionId);
	const snapshot = peer.records.findIndex((record) => record.type === "resync_required" && record.sessionId);
	expect(gap).toBeGreaterThan(0);
	expect(gap).toBeLessThan(snapshot);
	expect(peer.closed).not.toHaveBeenCalled();
	peer.writer.unregisterConnection("peer");
});
