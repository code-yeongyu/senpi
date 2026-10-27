import { afterEach, expect, it, vi } from "vitest";
import { WORKER_CREDIT_CODES } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { creditOf, type OutputFrame, within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function frame(ordinal: number): OutputFrame {
	return {
		type: "output",
		ordinal,
		record: { type: "agent_start" },
		signal: new SharedArrayBuffer(4),
		activity: { busy: false, streaming: false },
	};
}

/**
 * Opens one real worker session, then hands the host the frames `build` returns for the next expected ordinal,
 * as if the isolate had sent them. Every wait is bounded, so a hang fails the test instead of stalling it.
 */
async function deliver(build: (expected: number) => readonly OutputFrame[]) {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	try {
		const { worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const before = lane.freeze();
		lane.release(before);
		const expected = host.frames.length;
		expect(expected, "the isolate already sent ordered frames, so a duplicate ordinal exists").toBeGreaterThan(0);
		const sent = build(expected);
		for (const message of sent) worker.worker.emit("message", message);
		const credits = await within("credits", Promise.all(sent.map((message) => creditOf(message.signal))));
		await within("worker incarnation exits", worker.exited);
		const after = lane.freeze();
		return { credits, failures: [...host.failures], retired: lane.retired, before, after };
	} finally {
		await host.dispose();
	}
}

// Part of #4272, ruling 10 Q4: a broken frame order denies credit and ends the worker incarnation, never hangs.
it("Q4 gap: a skipped worker frame ordinal is denied credit and fails the incarnation with session_worker_frame_gap", async () => {
	const result = await deliver((expected) => [frame(expected + 1)]);
	expect(result.credits).toEqual([WORKER_CREDIT_CODES.conflict]);
	expect(result.failures).toEqual(["session_worker_frame_gap"]);
	expect(result.retired, "the incarnation's lane is retired").toBe(true);
	expect(result.after.sequence, "nothing was accepted from the frame").toBe(result.before.sequence);
	expect(result.after.sessionEpoch).toBe(result.before.sessionEpoch);
}, 60_000);

it("Q4 duplicate: a repeated worker frame ordinal is denied credit and fails the incarnation with session_worker_frame_duplicate", async () => {
	const result = await deliver((expected) => [frame(expected - 1)]);
	expect(result.credits).toEqual([WORKER_CREDIT_CODES.conflict]);
	expect(result.failures).toEqual(["session_worker_frame_duplicate"]);
	expect(result.retired, "the incarnation's lane is retired").toBe(true);
	expect(result.after.sequence, "nothing was accepted from the frame").toBe(result.before.sequence);
	expect(result.after.sessionEpoch).toBe(result.before.sessionEpoch);
}, 60_000);

// A reorder reaches the host as the later frame first, so the gap is its typed kind; the late frame finds a
// failed incarnation and is refused too, with no second failure and no acceptance.
it("Q4 reorder: frames arriving out of order are both denied credit and fail the incarnation with session_worker_frame_gap", async () => {
	const result = await deliver((expected) => [frame(expected + 1), frame(expected)]);
	expect(result.credits).toEqual([WORKER_CREDIT_CODES.conflict, WORKER_CREDIT_CODES.conflict]);
	expect(result.failures).toEqual(["session_worker_frame_gap"]);
	expect(result.retired, "the incarnation's lane is retired").toBe(true);
	expect(result.after.sequence, "neither frame was accepted").toBe(result.before.sequence);
	expect(result.after.sessionEpoch).toBe(result.before.sessionEpoch);
}, 60_000);

// The session stays open: the frame is accepted first, then the writer refuses it (the real order).
it("Q4 writer refusal: an in-order frame the writer refuses gets no credit, retires the lane and publishes no root past it", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	try {
		const { worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const held = lane.freeze();
		const sent = frame(host.frames.length);
		const enqueue = host.writer.enqueue.bind(host.writer);
		let atRefusal: { sequence: number; retired: boolean } | undefined;
		vi.spyOn(host.writer, "enqueue").mockImplementation((sessionId, record) => {
			if (record !== sent.record) return enqueue(sessionId, record);
			const root = lane.freeze();
			lane.release(root);
			atRefusal = { sequence: root.sequence, retired: lane.retired };
			return false;
		});
		worker.worker.emit("message", sent);
		const credit = await within("credit", creditOf(sent.signal));
		expect(atRefusal, "the lane accepted the frame before the writer refused it").toEqual({
			sequence: held.sequence + 1,
			retired: false,
		});
		expect(credit, "a refused frame gets no credit").toBe(WORKER_CREDIT_CODES.conflict);
		await within("worker incarnation exits", worker.exited);
		expect(host.failures).toEqual(["session_output_overflow_or_closed"]);
		expect(lane.retired, "the refusal retires the incarnation's lane").toBe(true);
		expect(lane.liveRoots, "the root published before the refused frame was released").toBe(0);
		expect(lane.accept({ type: "agent_start" }, undefined), "the retired lane accepts nothing more").toBe(undefined);
	} finally {
		await host.dispose();
	}
}, 60_000);
