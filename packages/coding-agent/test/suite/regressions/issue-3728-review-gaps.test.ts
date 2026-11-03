import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { SessionExtensionUiRequests } from "../../../src/modes/rpc/session-extension-ui-requests.ts";
import { SocketEventSinkActor } from "../../../src/modes/rpc/socket-event-fanout.ts";

afterEach(() => vi.restoreAllMocks());

it("announces every gap to an unattached lifecycle observer", async () => {
	const records: Record<string, unknown>[] = [];
	const drain = Promise.withResolvers<void>();
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection(
		"observer",
		{ writeRaw: (line) => records.push(JSON.parse(line)), waitForBackpressure: () => drain.promise },
		{ maxQueueBytes: 400 },
	);
	writer.setConnectionCapabilities("observer", ["event_resync"]);

	for (let index = 0; index < 20; index++) {
		writer.enqueue(`rpc-${index}`, { type: "agent_start" });
		writer.enqueue(`rpc-${index}`, { type: "agent_idle" });
	}
	drain.resolve();
	await writer.flush();

	expect(records).toContainEqual({ type: "resync_required", reason: "overflow", replyLost: false });
	writer.unregisterConnection("observer");
});

function actorFixture() {
	const drain = Promise.withResolvers<void>();
	const writes: string[] = [];
	const failure = vi.fn();
	const actor = new SocketEventSinkActor(
		{ writeRaw: (line) => writes.push(line), waitForBackpressure: () => drain.promise },
		failure,
		400,
	);
	actor.enableRecovery(() => ({ empty: true, sessions: [], next: async () => undefined, release: () => {} }));
	actor.enqueue('{"type":"agent_start"}\n');
	return { actor, drain, writes, failure };
}

it("does not JSON parse ordinary events during shed or pending enqueue", async () => {
	const { actor, drain } = actorFixture();
	const line = `${JSON.stringify({ type: "message_update", message: { content: "x".repeat(100) } })}\n`;
	const parse = vi.spyOn(JSON, "parse");

	for (let index = 0; index < 20; index++) actor.enqueue(line);
	expect(parse).not.toHaveBeenCalled();

	drain.resolve();
	await actor.flush();
	actor.close();
});

it("releases callbacks for queued and incoming shed notices exactly once", async () => {
	const { actor, drain } = actorFixture();
	const queued = vi.fn();
	const incoming = vi.fn();
	actor.enqueue('{"type":"close_overflow","ids":["a"]}\n', undefined, queued);
	actor.enqueue(`${JSON.stringify({ type: "message_update", message: "x".repeat(500) })}\n`);
	actor.enqueue('{"type":"close_overflow","ids":["b"]}\n', undefined, incoming);

	expect(queued).toHaveBeenCalledTimes(1);
	expect(incoming).toHaveBeenCalledTimes(1);
	drain.resolve();
	await actor.flush();
	expect(queued).toHaveBeenCalledTimes(1);
	expect(incoming).toHaveBeenCalledTimes(1);
	actor.close();
});

it("revokes recovery when the next capability advertisement omits it", async () => {
	const drain = Promise.withResolvers<void>();
	const closed = vi.fn();
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection(
		"peer",
		{ writeRaw: () => {}, waitForBackpressure: () => drain.promise, close: closed },
		{ maxQueueBytes: 400 },
	);
	writer.setConnectionCapabilities("peer", ["event_resync"]);
	writer.setConnectionCapabilities("peer", []);
	writer.enqueue("rpc-1", { type: "agent_start" });

	for (let index = 0; index < 30; index++) writer.enqueue(`rpc-${index}`, { type: "agent_idle" });

	expect(closed).toHaveBeenCalledTimes(1);
	drain.resolve();
	await writer.flush();
	writer.unregisterConnection("peer");
});

it("returns only still-pending dialogs for a get_state recovery snapshot", () => {
	const requests = new SessionExtensionUiRequests();
	const frame = { type: "extension_ui_request", id: "dialog", method: "input", title: "Input" } as const;
	requests.set(frame.id, { frame, resolve: () => {}, reject: () => {} });
	expect(requests.snapshot()).toEqual([frame]);

	requests.resolve({ type: "extension_ui_response", id: frame.id, value: "done" });
	expect(requests.snapshot()).toEqual([]);
});
