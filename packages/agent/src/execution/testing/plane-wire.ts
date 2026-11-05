import type { Transport } from "../../transport/transport.ts";
import { decodePlaneMessage, type PlaneMessage } from "../plane.ts";

/**
 * Plane traffic on the wire between a session and its hand, for cases that must observe the plane itself rather than a
 * stand-in (S26b): every plane message the session sends, and on request each hand plane request sent a second time as
 * its own transport frame. The transport delivers each frame exactly once, so only the plane's own dedup can absorb that
 * second frame.
 */
export interface PlaneWire {
	/** Plane messages the session sent to its hands, in send order. */
	readonly sessionSent: readonly PlaneMessage[];
}

const forwarding = (inner: Transport, send: Transport["send"]): Transport => ({
	send,
	onFrame: (handler) => inner.onFrame(handler),
	inFlight: (lane) => inner.inFlight(lane),
	close: () => inner.close(),
});

export function tapPlaneWire(options: { readonly duplicateHandRequests: boolean }) {
	const sessionSent: PlaneMessage[] = [];
	return {
		wire: { sessionSent } satisfies PlaneWire,
		session: (inner: Transport): Transport =>
			forwarding(inner, (lane, payload) => {
				const message = decodePlaneMessage(payload);
				if (message !== undefined) sessionSent.push(message);
				return inner.send(lane, payload);
			}),
		hand: (inner: Transport): Transport =>
			forwarding(inner, (lane, payload) => {
				const sent = inner.send(lane, payload);
				if (!options.duplicateHandRequests || decodePlaneMessage(payload)?.kind !== "plane.request") return sent;
				return sent.then(() => inner.send(lane, payload));
			}),
	};
}
