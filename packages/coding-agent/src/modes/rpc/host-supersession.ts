/**
 * Noticing that this generation stopped owning its endpoint.
 *
 * A handoff ASKS the predecessor to drain (SIGUSR1), and that request can simply not arrive: an
 * owner whose registration cannot be proven is never signalled, a client that binds its own entry
 * over the path sends nothing at all, and a wedged process can miss the signal it was sent. The
 * generation is then unreachable - the public name resolves to somebody else's socket - while it
 * still holds every retained session and every session-path claim it ever published. That is how
 * one machine ended up with three supervisors on one endpoint, the superseded pair holding
 * gigabytes of sessions no client could reach (#1893).
 *
 * The evidence needs no cooperation from whoever replaced it: the entry at the public path is no
 * longer the socket this generation bound. That is checked here, on a slow unref'd timer, and it
 * fires exactly once - the caller's drain is not idempotent bookkeeping, it is a lifecycle
 * transition.
 *
 * A name that is GONE rather than taken over ends in the same place: a deleted workspace, a swept
 * temp directory or a stray `rm` leaves a generation that no client can resolve, holding its
 * sessions and path claims until the machine reboots (#1961, measured at 23h45m). Absence is
 * therefore a loss too, but a weaker observation than supersession - nobody is serving that name
 * to prove it - so it must be seen on several consecutive polls before it counts, and a stat that
 * cannot answer resets the count instead of adding to it.
 */
import { classifyEndpointOwnership, type SocketFileIdentity } from "./socket-ownership.ts";

/** How often a generation re-checks that the public path still holds the socket it bound. */
export const SUPERSESSION_POLL_MS = 1_000;

/** Consecutive absent observations before a missing entry counts as gone rather than as a race. */
export const ABSENT_CONFIRMATIONS = 3;

/** How a generation stopped owning its endpoint: somebody took the name, or the name is gone. */
export type EndpointLoss = "replaced" | "absent";

export interface SupersededEndpoint {
	/** The public path this generation serves: the supervisor's, not a private internal hop. */
	readonly path: string;
	/** The entry it bound there. Without one, supersession can never be proven and is never claimed. */
	readonly identity: SocketFileIdentity | undefined;
	/** Consulted every tick; a host already draining or shutting down has nothing left to notice. */
	readonly settled?: () => boolean;
}

/** Runs `onLost` once this endpoint stops being served by the entry this generation bound. */
export function watchForSupersession(endpoint: SupersededEndpoint, onLost: (loss: EndpointLoss) => void): () => void {
	if (endpoint.identity === undefined || process.platform === "win32") return () => {};
	let absentPolls = 0;
	let lost = false;
	// Clearing the interval cannot unsend the classifications already in flight, so the transition
	// latches here: several pending observations of one loss still deliver a single drain request.
	const lose = (loss: EndpointLoss): void => {
		if (lost) return;
		lost = true;
		stop();
		onLost(loss);
	};
	const timer = setInterval(() => {
		if (endpoint.settled?.() === true) return;
		void classifyEndpointOwnership(endpoint.path, endpoint.identity).then((ownership) => {
			if (endpoint.settled?.() === true) return;
			switch (ownership) {
				case "replaced":
					lose("replaced");
					return;
				case "absent":
					absentPolls += 1;
					if (absentPolls < ABSENT_CONFIRMATIONS) return;
					lose("absent");
					return;
				case "held":
				case "unknown":
					absentPolls = 0;
					return;
			}
		}, ignore);
	}, SUPERSESSION_POLL_MS);
	// Unref'd: noticing a supersession must never be the reason a process stays up.
	timer.unref?.();
	const stop = (): void => clearInterval(timer);
	return stop;
}

function ignore(): void {}
