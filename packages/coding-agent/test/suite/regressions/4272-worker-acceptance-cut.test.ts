import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { WORKER_CREDIT_CODES } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { type OutputFrame, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function recordType(frame: OutputFrame): unknown {
	return "type" in frame.record ? frame.record.type : undefined;
}

// Part of #4272, T5/X03 + ruling 10 Q2: a worker's disk write ahead of host acceptance stays beyond the cut.
it("T5/X03 holds worker acceptance while its fork is on disk: the cut keeps the old epoch until credit", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	const admitted: Array<{ sessionEpoch: string; sequence: number } | undefined> = [];
	const attach = SessionEventWriter.prototype.attachConnectionToSession;
	vi.spyOn(SessionEventWriter.prototype, "attachConnectionToSession").mockImplementation(function (
		this: SessionEventWriter,
		id: string,
		sessionId: string,
	) {
		const lane = host.registry.peek(sessionId)?.worker?.acceptance;
		const root = lane?.freeze();
		if (lane && root) lane.release(root);
		admitted.push(root && { sessionEpoch: root.sessionEpoch, sequence: root.sequence });
		attach.call(this, id, sessionId);
	});
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const opening = lane.freeze();
		lane.release(opening);
		expect(admitted[0], "bootstrap accepted before the router admitted the connection").toEqual({
			sessionEpoch: opening.sessionEpoch,
			sequence: 0,
		});
		expect(opening.sessionEpoch).toMatch(UUID);

		const settled = host.next("agent_settled", (record) => record.type === "agent_settled");
		expect((await host.request({ type: "prompt", sessionId, message: "question" })).success).toBe(true);
		await settled;
		const beforeFork = lane.freeze();
		lane.release(beforeFork);
		expect(beforeFork.sequence).toBeGreaterThan(0);
		const onDisk = readFileSync(String(host.registry.peek(sessionId)?.sessionPath), "utf8")
			.trim()
			.split("\n");
		const lastEntry: { id?: string } = JSON.parse(onDisk.at(-1) ?? "{}");
		expect(beforeFork.transcript.count, "every entry appended since bootstrap was accepted").toBeGreaterThanOrEqual(
			2,
		);
		expect(beforeFork.transcript.leafId).toBe(lastEntry.id);

		const assistantFrames = host.frames.filter(
			({ frame }) =>
				(recordType(frame) === "message_start" || recordType(frame) === "message_update") &&
				"message" in frame.record &&
				(frame.record.message as { role?: unknown }).role === "assistant",
		);
		const messageId = assistantFrames[0]?.frame.recovery?.messageId;
		expect(messageId, "the worker frame carries the producer's id").toMatch(UUID);
		expect(assistantFrames.every(({ frame }) => frame.recovery?.messageId === messageId)).toBe(true);
		expect(assistantFrames[1]?.atArrival?.activeMessageId, "the lane captured it at acceptance").toBe(messageId);
		for (const [index, observed] of host.frames.entries()) {
			if (index === 0) continue;
			expect(observed.previousCredit, `frame ${index} arrived only after the previous frame's credit`).toBe(
				WORKER_CREDIT_CODES.granted,
			);
			const previous = host.frames[index - 1];
			if (previous && recordType(previous.frame) === "message_update")
				expect(observed.atArrival?.sequence, "the previous frame was applied before its credit").toBeGreaterThan(
					previous.atArrival?.sequence ?? 0,
				);
		}

		const original = String(host.registry.peek(sessionId)?.sessionPath);
		const held = host.holdReconcile(
			(message) => message?.type === "output" && recordType(message) === "session_replaced",
		);
		const replaced = host.next("session_replaced", (record) => record.type === "session_replaced");
		const cloned = host.request({ type: "clone", sessionId });
		const forkPaths = await held.reached;
		const fork = forkPaths.find((path) => path !== original) ?? "";
		expect(existsSync(fork) && readFileSync(fork, "utf8").includes('"type":"message"'), "fork is on disk").toBe(true);
		const heldCut = lane.freeze();
		const heldObserved = host.frames.at(-1);
		const heldFrame = heldObserved?.frame;
		expect(heldFrame && recordType(heldFrame), "the worker is blocked on the replacement frame").toBe(
			"session_replaced",
		);
		expect(heldCut.sessionEpoch, "the held cut stays in the old epoch").toBe(beforeFork.sessionEpoch);
		expect(heldCut.sequence, "nothing past the held frame is accepted").toBe(heldObserved?.atArrival?.sequence);
		expect(heldCut.transcript).toEqual(heldObserved?.atArrival?.transcript);
		const credit = heldFrame ? Atomics.load(new Int32Array(heldFrame.signal), 0) : -1;
		expect(credit, "no credit while acceptance is held").toBe(0);

		held.release();
		await replaced;
		expect((await cloned).success).toBe(true);
		const after = lane.freeze();
		lane.release(after);
		expect(after.sessionEpoch, "replacement mints a new epoch").not.toBe(beforeFork.sessionEpoch);
		const nextFrame = host.frames[host.frames.indexOf(heldObserved ?? host.frames[0]) + 1];
		expect(nextFrame?.atArrival, "the bootstrap was accepted before the held frame's credit").toMatchObject({
			sessionEpoch: after.sessionEpoch,
			sequence: 0,
			transcript: { count: 0 },
		});
		expect(nextFrame?.atArrival?.transcript.leafId).not.toBeNull();
		expect(heldCut.transcript.count, "the held cut is unchanged after the disk and lane moved on").toBe(
			heldObserved?.atArrival?.transcript.count,
		);
		expect(heldCut.sessionEpoch).toBe(beforeFork.sessionEpoch);
		lane.release(heldCut);
		expect(lane.liveRoots).toBe(0);
	} finally {
		await host.dispose();
	}
}, 120_000);

it("flag off: the worker client owns no lane and frames carry no ordinal", async () => {
	const host = await workerAcceptanceHost();
	try {
		const { worker } = await host.open();
		expect(worker.acceptance).toBeUndefined();
		expect(host.frames.every(({ frame }) => frame.ordinal === undefined && frame.recovery === undefined)).toBe(true);
	} finally {
		await host.dispose();
	}
}, 60_000);
