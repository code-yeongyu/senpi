import { expect } from "vitest";
import type { RecoveryCheckpoints } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryAdmission } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { type HeldPeer, LaneProducer, usage } from "./4272-legacy-view-support.ts";

export const start = { role: "assistant", content: [], api: "faux", provider: "faux", model: "fixture", usage };

/** A producer streaming one assistant message with an open text block on `sessionId` (`s` by default). */
export function streaming(writer: SessionEventWriter, lane: SessionAcceptanceLane, sessionId = "s"): LaneProducer {
	const producer = new LaneProducer(writer, lane, sessionId);
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	return producer;
}

export interface RecoveryRig {
	readonly writer: SessionEventWriter;
	readonly lane: SessionAcceptanceLane;
	readonly checkpoints: RecoveryCheckpoints;
	readonly producer: () => LaneProducer;
	/** A held peer's attach of `sessionId` (`s` by default): the one cut it freezes, released once the peer drains. */
	readonly attach: (peer: HeldPeer, id?: string, sessionId?: string) => Promise<RecoveryAdmission>;
	/** Streams until the held peer sheds: the one cut the shed freezes, released once the recovery is delivered. */
	readonly shed: (peer: HeldPeer, id?: string) => Promise<RecoveryAdmission>;
	/** The next session incarnation (a replacement's bootstrap), streaming again from its start. */
	readonly replace: () => void;
}

/** One lane-owned session `s` on a real writer, and the fanout's two real admission producers driven through held peers. */
export function recoveryRig(): RecoveryRig {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	let producer = streaming(writer, lane);
	let offset = 0;
	const checkpoints = writer.recoveryCheckpoints;
	const frozenBy = async (peer: HeldPeer, step: () => void): Promise<RecoveryAdmission> => {
		peer.hold();
		step();
		const tokens = checkpoints.tokens();
		expect(tokens, "the step froze exactly one cut").toHaveLength(1);
		peer.release();
		await writer.flush();
		expect(checkpoints.open).toBe(0);
		return tokens[0]?.admission ?? expect.unreachable();
	};
	return {
		writer,
		lane,
		checkpoints,
		producer: () => producer,
		attach: (peer, id = "held", sessionId = "s") =>
			frozenBy(peer, () => writer.attachConnectionToSession(id, sessionId)),
		shed: (peer) =>
			frozenBy(peer, () => {
				for (let index = 0; index < 200 && checkpoints.open === 0; index++)
					producer.blockDelta("text", 0, "x", offset++);
			}),
		replace: () => {
			lane.bootstrap({ transcript: [] });
			producer = streaming(writer, lane);
			offset = 0;
		},
	};
}
