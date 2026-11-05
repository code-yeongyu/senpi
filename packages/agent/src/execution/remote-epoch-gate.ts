import type { RemoteFloor, RemoteFloorAck, RemoteFloorRefused } from "./remote-protocol.ts";

/**
 * A session's side of the epoch floor (brain/hand S35): an owner at `epoch` dispatches a scope lane's calls only after
 * the hand acked exactly that epoch on the lane. An ack above it means a newer owner holds the session, and a refusal
 * means this sender may not own it; either way the lane never dispatches again.
 */
export interface EpochGate {
	/** Resolves `undefined` once `lane` may dispatch, or the reason it never will. The first ask sends the floor. */
	open(lane: string): Promise<string | undefined>;
	/** Counts only while the lane waits for an answer; a late or duplicate answer changes nothing. */
	answer(lane: string, message: RemoteFloorAck | RemoteFloorRefused): void;
	/**
	 * The hand restarted: sends the floor again on every lane not refused, and each of them waits for its new answer
	 * before anything dispatches there again, re-sent calls included.
	 */
	resend(): void;
}

interface Lane {
	decided: PromiseWithResolvers<string | undefined>;
	verdict: { readonly refusal: string | undefined } | undefined;
}

export function createEpochGate(epoch: number, send: (lane: string, floor: RemoteFloor) => Promise<void>): EpochGate {
	const lanes = new Map<string, Lane>();
	const decide = (state: Lane, refusal: string | undefined): void => {
		state.verdict = { refusal };
		state.decided.resolve(refusal);
	};
	const ask = (lane: string, state: Lane): void => {
		if (state.verdict !== undefined) {
			state.verdict = undefined;
			state.decided = Promise.withResolvers();
		}
		const asked = state.decided;
		send(lane, { kind: "floor", epoch }).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			if (state.decided === asked && state.verdict === undefined) decide(state, `hand_unreachable: ${reason}`);
		});
	};
	return {
		open(lane) {
			const known = lanes.get(lane);
			if (known !== undefined)
				return known.verdict === undefined ? known.decided.promise : Promise.resolve(known.verdict.refusal);
			const state: Lane = { decided: Promise.withResolvers(), verdict: undefined };
			lanes.set(lane, state);
			ask(lane, state);
			return state.decided.promise;
		},
		answer(lane, message) {
			const state = lanes.get(lane);
			if (state === undefined || state.verdict !== undefined) return;
			if (message.kind === "floor_refused") return decide(state, message.reason);
			if (message.floor === epoch) return decide(state, undefined);
			// Above: a newer owner holds the session. Below: the record names a later epoch than this owner's (senpi#5860).
			decide(state, "epoch_superseded");
		},
		resend() {
			for (const [lane, state] of lanes) if (state.verdict?.refusal === undefined) ask(lane, state);
		},
	};
}
