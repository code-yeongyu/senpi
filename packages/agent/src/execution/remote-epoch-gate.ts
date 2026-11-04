import type { RemoteFloor, RemoteFloorAck, RemoteFloorRefused } from "./remote-protocol.ts";

/**
 * A session's side of the epoch floor (brain/hand S35): an owner at `epoch` dispatches a scope lane's calls only after
 * the hand acked exactly that epoch on the lane. An ack above it means a newer owner holds the session, and a refusal
 * means this sender may not own it; either way the lane never dispatches again.
 */
export interface EpochGate {
	/** Resolves `undefined` once `lane` may dispatch, or the reason it never will. The first ask sends the floor. */
	open(lane: string): Promise<string | undefined>;
	answer(lane: string, message: RemoteFloorAck | RemoteFloorRefused): void;
	/** The hand restarted: sends the floor again on every lane asked so far, before anything else is re-sent there. */
	resend(): void;
}

interface Lane {
	readonly decided: PromiseWithResolvers<string | undefined>;
	verdict: { readonly refusal: string | undefined } | undefined;
}

export function createEpochGate(epoch: number, send: (lane: string, floor: RemoteFloor) => Promise<void>): EpochGate {
	const lanes = new Map<string, Lane>();
	const decide = (state: Lane, refusal: string | undefined): void => {
		state.verdict = { refusal };
		state.decided.resolve(refusal);
	};
	const sendFloor = (lane: string, state: Lane): void => {
		send(lane, { kind: "floor", epoch }).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			if (state.verdict === undefined) decide(state, `hand_unreachable: ${reason}`);
		});
	};
	return {
		open(lane) {
			const known = lanes.get(lane);
			if (known !== undefined)
				return known.verdict === undefined ? known.decided.promise : Promise.resolve(known.verdict.refusal);
			const state: Lane = { decided: Promise.withResolvers(), verdict: undefined };
			lanes.set(lane, state);
			sendFloor(lane, state);
			return state.decided.promise;
		},
		answer(lane, message) {
			const state = lanes.get(lane);
			if (state === undefined) return;
			if (message.kind === "floor_refused") return decide(state, message.reason);
			if (message.floor === epoch) return decide(state, undefined);
			decide(state, message.floor > epoch ? "epoch_superseded" : "epoch_floor_mismatch");
		},
		resend() {
			for (const [lane, state] of lanes) if (state.verdict?.refusal === undefined) sendFloor(lane, state);
		},
	};
}
