import { afterEach, expect, it, vi } from "vitest";
import { workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";

afterEach(() => {
	vi.unstubAllEnvs();
});

// Part of #4272, ruling 10 Q6: correlation is sequenced with its content when the content crosses the worker.
it("Q6 worker: a correlation transition carried in worker frames is sequenced just before its content", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const settled = host.next("agent_settled", (record) => record.type === "agent_settled");
		const prompted = await host.request({ type: "prompt", sessionId, message: "question", clientMessageId: "c-1" });
		expect(prompted.success).toBe(true);
		await settled;

		const frames = host.frames;
		const ordinals = frames.map(({ frame }) => frame.ordinal);
		expect(ordinals, "one ordinal per physical frame, contiguous").toEqual(
			ordinals.map((_, index) => (ordinals[0] ?? 0) + index),
		);
		// A frame arrives only after the previous frame's credit, which follows its apply: the root a frame
		// meets is the root its predecessor left.
		const after = (index: number) => frames[index + 1]?.atArrival;
		// Transcript transitions a frame carries are accepted before its record, one sequence each (C1.1).
		const carried = (index: number) => frames[index]?.frame.transitions?.length ?? 0;
		const correlatedAt = frames.findIndex(
			({ frame }) => "clientMessageId" in frame.record && frame.record.clientMessageId === "c-1",
		);
		expect(correlatedAt, "the correlated record crossed the worker boundary").toBeGreaterThan(0);
		const first = frames[correlatedAt];
		expect(first && "type" in first.frame.record && first.frame.record.type).toBe("turn_start");
		expect(frames.slice(0, correlatedAt + 1).every(({ atArrival }) => atArrival?.correlation === null)).toBe(true);

		const leftByFirst = after(correlatedAt);
		const beforeFirst = after(correlatedAt - 1);
		if (!leftByFirst || !beforeFirst) throw new Error("frames around the correlated record");
		expect(leftByFirst.correlation, "the correlation transition was accepted with that frame").toMatchObject({
			clientMessageId: "c-1",
		});
		expect(
			leftByFirst.sequence - beforeFirst.sequence,
			"the frame's transcript transitions, the correlation and its record, nothing else",
		).toBe(2 + carried(correlatedAt));
		expect(leftByFirst.correlation?.sequence, "sequenced just before its record").toBe(leftByFirst.sequence - 1);

		expect(after(correlatedAt + 1)?.sequence, "the next content takes the sequence after it").toBe(
			leftByFirst.sequence + 1 + carried(correlatedAt + 1),
		);
		const userStart = frames.findIndex(
			({ frame }) =>
				"type" in frame.record &&
				frame.record.type === "message_start" &&
				"message" in frame.record &&
				(frame.record.message as { role?: unknown }).role === "user",
		);
		expect(userStart, "the correlated user message follows the flushed prefix").toBeGreaterThan(correlatedAt);
		expect(after(userStart)?.correlation).toBe(leftByFirst.correlation);
		for (let index = correlatedAt + 1; index < frames.length - 1; index++) {
			const left = after(index);
			const previous = after(index - 1);
			expect(left?.correlation, `frame ${index} keeps the same correlation transition`).toBe(
				leftByFirst.correlation,
			);
			expect(
				(left?.sequence ?? 0) - (previous?.sequence ?? 0),
				`frame ${index} takes at most one sequence besides its transcript transitions`,
			).toBeLessThanOrEqual(1 + carried(index));
		}
	} finally {
		await host.dispose();
	}
}, 120_000);

// Part of #4272, review MEDIUM-1: a turn that answers no client message ends the correlation in the accepted root.
it("Q6 worker: a trigger turn after a client turn sequences the end of the correlation, so the cut attributes it to no client message", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const clientSettled = host.next("agent_settled", (record) => record.type === "agent_settled");
		const prompted = await host.request({ type: "prompt", sessionId, message: "question", clientMessageId: "c-1" });
		expect(prompted.success).toBe(true);
		await clientSettled;
		const afterClient = lane.freeze();
		lane.release(afterClient);
		expect(afterClient.correlation).toMatchObject({ clientMessageId: "c-1" });

		const firstTriggerFrame = host.frames.length;
		const triggerSettled = host.next("agent_settled", (record) => record.type === "agent_settled");
		const wake = { type: "send_custom_message", sessionId, customType: "wake", content: "wake", triggerTurn: true };
		expect((await host.request(wake)).success).toBe(true);
		await triggerSettled;
		const cut = lane.freeze();
		lane.release(cut);
		expect(cut.correlation?.clientMessageId, "the cut attributes the trigger turn to no client message").toBe(
			undefined,
		);
		expect(cut.correlation?.clientTurnId).toBe(undefined);

		const trigger = host.frames.slice(firstTriggerFrame);
		const turnAt = trigger.findIndex(({ frame }) => "type" in frame.record && frame.record.type === "turn_start");
		const turn = trigger[turnAt];
		const leftByTurn = trigger[turnAt + 1]?.atArrival;
		if (!turn?.atArrival || !leftByTurn) throw new Error("the trigger turn crossed the worker boundary");
		expect("clientMessageId" in turn.frame.record, "the trigger turn carries no client identity").toBe(false);
		expect(turn.atArrival.correlation, "until then the client correlation stood").toBe(afterClient.correlation);
		expect(leftByTurn.sequence - turn.atArrival.sequence, "the end of the correlation and its record").toBe(
			2 + (turn.frame.transitions?.length ?? 0),
		);
		expect(leftByTurn.correlation?.sequence, "sequenced just before the first uncorrelated record").toBe(
			leftByTurn.sequence - 1,
		);
		expect(cut.correlation, "no further transition for the rest of the uncorrelated turn").toBe(
			leftByTurn.correlation,
		);
	} finally {
		await host.dispose();
	}
}, 120_000);
