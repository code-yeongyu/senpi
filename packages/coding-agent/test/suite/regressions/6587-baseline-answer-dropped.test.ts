/**
 * senpi#6587: a compact `open_session`, `subscribe_sessions` or `reset_stream` hands its answer to its admission
 * baseline, and the connection's queue writes that baseline later. A baseline can end without having written the
 * answer: the queue does not take one while a recovery is dropping records, and an overflow drops every baseline
 * already queued. The answer inside was then written by nothing and the request got no response. A request whose
 * answer travelled in a baseline that did not write it must still be answered, once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admissionBaseline } from "../../../src/modes/rpc/compact-admission-baseline.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { statusHost } from "../rpc-session-status-support.ts";

beforeEach(() => vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1"));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const ANSWER = { id: "open-1", type: "response", command: "open_session", success: true, sessionId: "s-new" };
const IDENTITY = { sessionId: "s-new", admissionId: "a1", generation: 1 };
const THE_ANSWER = [expect.objectContaining({ command: "open_session", success: true })];
const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const update = (full: string) => ({
	type: "message_update",
	message: message(full),
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message(full) },
});

/** A connection of the real writer with a small queue, whose transport is held so that what is queued piles up. */
function heldPeer() {
	const writer = new SessionEventWriter(() => {});
	const records: Record<string, unknown>[] = [];
	const drain = Promise.withResolvers<void>();
	let held = true;
	writer.registerConnection(
		"peer",
		{
			writeRaw: (line) => {
				for (const text of line.split("\n"))
					if (text !== "") records.push(JSON.parse(text) as Record<string, unknown>);
			},
			waitForBackpressure: () => (held ? drain.promise : Promise.resolve()),
		},
		{ stallMs: 60_000, maxQueueBytes: 512 },
	);
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	writer.attachConnectionToSession("peer", "rpc-1");
	writer.enqueue("rpc-1", { type: "message_start", message: message("") });
	const reply = writer.baselineAnswer("peer");
	return {
		/** Queues updates until the queue overflowed; six are enough for a second overflow, which makes the recovery stale. */
		overflow: (updates: number) => {
			for (let index = 1; index <= updates; index++) writer.enqueue("rpc-1", update("x".repeat(40 * index)));
		},
		/** Offers the request's admission baseline to the queue; answers whether the queue took it. */
		install: () => {
			let taken = false;
			reply.install(() => {
				taken = writer.installAdmissionBaseline(
					"peer",
					admissionBaseline(reply.answer, IDENTITY, () => true),
					() => true,
				);
				return taken;
			});
			return taken;
		},
		hand: () => reply.hand(ANSWER),
		/** Releases the transport; returns what the connection received under the request's id, and the gap notices. */
		received: async () => {
			held = false;
			drain.resolve();
			await writer.flush();
			writer.unregisterConnection("peer");
			return {
				answers: records.filter((record) => record.type === "response" && record.id === "open-1"),
				gaps: records.filter((record) => record.type === "resync_required").length,
			};
		},
	};
}

describe("an answer handed to an admission baseline that does not write it, on the real queue (senpi#6587)", () => {
	it("#given a connection whose recovery is dropping records, so its queue takes no baseline #when a request's answer is handed to its admission baseline #then the connection still receives that answer, once", async () => {
		const peer = heldPeer();
		peer.overflow(6);

		const taken = peer.install();
		peer.hand();

		// The state this row is about was reached: the queue did not take the baseline.
		expect(taken).toBe(false);
		expect((await peer.received()).answers).toEqual(THE_ANSWER);
	});

	it("#given a baseline the queue took, with the answer handed to it #when the queue overflows before the baseline is written #then the connection still receives that answer, once", async () => {
		const peer = heldPeer();
		const taken = peer.install();
		peer.hand();

		peer.overflow(3);

		const { answers, gaps } = await peer.received();
		// The state this row is about was reached: the queue took the baseline, and then it overflowed.
		expect([taken, gaps > 0]).toEqual([true, true]);
		expect(answers).toEqual(THE_ANSWER);
	});

	it("#given a baseline the queue took before the answer exists, as a subscribe installs it #when the queue overflows and the answer is handed over afterwards #then the connection still receives that answer, once", async () => {
		const peer = heldPeer();
		const taken = peer.install();
		peer.overflow(3);

		peer.hand();

		const { answers, gaps } = await peer.received();
		expect([taken, gaps > 0]).toEqual([true, true]);
		expect(answers).toEqual(THE_ANSWER);
	});

	it("#given a connection with no recovery pending #when a request's answer is handed to its admission baseline #then the baseline writes it, and the connection receives it once", async () => {
		const peer = heldPeer();

		const taken = peer.install();
		peer.hand();

		expect(taken).toBe(true);
		expect((await peer.received()).answers).toEqual(THE_ANSWER);
	});
});

describe("through the real handlers, when the queue does not take their baseline (senpi#6587)", () => {
	type Host = Awaited<ReturnType<typeof statusHost>>;
	const PAIR = ["compact_message_updates_v1", "event_resync"];

	/** A compact client of the host, and a way to send it a request under a fixed id and read what came back under it. */
	async function compactPeer(host: Host) {
		const peer = host.client("peer");
		expect(await peer.request({ type: "get_protocol_info" })).toMatchObject({
			data: { capabilities: expect.arrayContaining(PAIR) },
		});
		expect(await peer.request({ type: "set_client_info", capabilities: PAIR })).toMatchObject({ success: true });
		return {
			peer,
			/** Sends `command` while the queue refuses every admission baseline, as it does while it drops records. */
			answersWhenRefused: async (command: Record<string, unknown> & { id: string }) => {
				vi.spyOn(host.writer, "installAdmissionBaseline").mockImplementation((_peer, cursor) => {
					cursor.release();
					return false;
				});
				await host.writer.withConnection("peer", () => host.core.handle(JSON.stringify(command)));
				// This answer is queued behind everything the line above queued for the connection.
				await peer.request({ type: "get_protocol_info" });
				return peer.inbox.filter((record) => record.type === "response" && record.id === command.id);
			},
		};
	}

	it("#given a compact open_session #then the connection receives its answer, once", async () => {
		await using host = await statusHost();
		const { answersWhenRefused } = await compactPeer(host);

		const answers = await answersWhenRefused({
			id: "open-1",
			type: "open_session",
			cwd: host.cwd,
			admissionId: "a1",
		});

		expect(answers).toEqual([expect.objectContaining({ command: "open_session", success: true, admissionId: "a1" })]);
	}, 120_000);

	it("#given a compact subscribe_sessions #then the connection receives its answer, once", async () => {
		await using host = await statusHost();
		const { answersWhenRefused } = await compactPeer(host);

		const answers = await answersWhenRefused({ id: "sub-1", type: "subscribe_sessions", admissionId: "s1" });

		expect(answers).toEqual([
			expect.objectContaining({ command: "subscribe_sessions", success: true, admissionId: "s1" }),
		]);
	}, 120_000);

	it("#given a reset_stream of a session the connection opened #then the connection receives its answer, once", async () => {
		await using host = await statusHost();
		const { peer, answersWhenRefused } = await compactPeer(host);
		const opened = await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "a0" });
		const sessionId = String(opened.sessionId);

		const answers = await answersWhenRefused({ id: "reset-1", type: "reset_stream", sessionId, admissionId: "a0" });

		expect(answers).toEqual([expect.objectContaining({ command: "reset_stream", success: true, admissionId: "a0" })]);
	}, 120_000);
});
