import type { HoldKind, SessionHold } from "./engine-turn-hold.ts";

/**
 * The holds that keep a message another session sent from starting a turn (senpi#6490), sorted; empty when it may start.
 * An `unattended` hold only stands in for an absent person, so a peer's message releases it as a person's would. A
 * person's Stop, the hold after an interrupted run (`interruptedRun`, recorded or not yet) and a parent's run hold
 * each wait on a person's decision, so they keep the delivery, and the sender is told so. A run fence alone holds
 * only its own run's wakes, never a delivery.
 */
export function holdsKeepingPeerDelivery(holds: readonly SessionHold[], interruptedRun: boolean): HoldKind[] {
	const kinds = new Set(holds.map((hold) => hold.kind).filter((kind) => kind !== "run_fence"));
	if (interruptedRun) kinds.add("session_hold");
	return [...kinds].some((kind) => kind !== "unattended") ? [...kinds].sort() : [];
}
