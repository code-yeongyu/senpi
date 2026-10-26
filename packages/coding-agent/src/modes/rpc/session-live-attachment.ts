import type { SessionPathReservations } from "./host-reservations.ts";
import { type RpcSessionEntry, RpcSessionRegistryError } from "./session-registry-types.ts";

/** Synchronous refcount change: never opens a path and never applies a launch profile. */
export function attachLiveSession(
	entry: RpcSessionEntry | undefined,
	now: number,
	markAttached: () => void,
): RpcSessionEntry {
	if (entry?.state !== "open") throw new RpcSessionRegistryError("unknown_session");
	const wasParked = entry.retainOnDisconnect === true && entry.attachments === 0;
	entry.attachments++;
	entry.detachedAt = undefined;
	entry.lastCommandAt = now;
	markAttached();
	if (wasParked && entry.runtime)
		entry.lifecycleMutex = entry.lifecycleMutex.then(() => entry.runtime?.emitAttachmentEvent("session_resumed"));
	return entry;
}

/** Publish the live-only attachment in the same claim store as open_session. */
export function markPathAttached(
	entry: RpcSessionEntry | undefined,
	claims: SessionPathReservations | undefined,
): void {
	if (entry?.reservationKey) claims?.setAttached(entry.reservationKey, true);
}
