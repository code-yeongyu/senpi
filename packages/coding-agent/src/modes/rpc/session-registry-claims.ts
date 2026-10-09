/**
 * The registry's path claims: the in-process reservation set and the cross-generation claim
 * (`host-reservations.ts`) follow whatever file each entry's runtime is actually writing.
 */
import type { SessionPathReservations } from "./host-reservations.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";

/** Reconcile path and durable identity after runtime replacement. */
export function syncRuntimeMetadata(
	entries: Iterable<RpcSessionEntry>,
	reservations: Set<string>,
	pathReservations: SessionPathReservations | undefined,
): void {
	for (const entry of entries) {
		const manager = entry.runtime?.session.sessionManager;
		if (!manager) continue;
		const currentPath = manager.getSessionFile();
		const currentKey = currentPath ? canonicalSessionPath(currentPath) : undefined;
		// Preserve the originally canonicalized key while the runtime still points at
		// the same path. SessionManager may expose a symlink-resolved spelling after
		// opening a file that did not exist yet; treating that as replacement would
		// break ordinary attach-on-open aliases.
		//
		// A moved path is not the only reason to reconcile: a session opened WITHOUT
		// `sessionPath` lands its created file straight into `sessionPath` and never
		// takes a reservation, so comparing paths alone leaves that file unclaimed
		// forever and a later open of it builds a SECOND runtime over the same
		// transcript. Reconcile whenever the canonical key we hold is not the key the
		// runtime is actually writing.
		if (currentPath !== entry.sessionPath || currentKey !== entry.reservationKey) {
			if (entry.reservationKey) {
				reservations.delete(entry.reservationKey);
				pathReservations?.release(entry.reservationKey);
			}
			if (currentKey) {
				reservations.add(currentKey);
				// A replacement moved this session to another file; the claim follows it, carrying the
				// attachment state it is now held at. A file a live foreign generation holds is left
				// alone by claim() itself.
				void pathReservations?.claim(currentKey, entry.attachments > 0);
			}
			entry.reservationKey = currentKey;
			entry.sessionPath = currentPath;
		}
		entry.durableSessionId = manager.getSessionId();
		entry.cwd = manager.getCwd();
	}
}

/**
 * Waits out a teardown already in flight for this path before the open decides.
 *
 * A close FREES the path, but the entry keeps its reservation until its runtime is
 * disposed, so an open landing inside that window used to be refused with
 * `session_path_in_use` for a session that no longer exists - making "reopen the
 * path I just closed" a race against disposal latency, which no client can time.
 * The open now waits for the teardown it would have been refused by and then opens
 * the file fresh. Bounded by the same grace window that bounds the teardown itself
 * (`closeMarkedSession` force-releases at that deadline), so a wedged disposal
 * still ends in the ordinary refusal instead of an open that never answers.
 */
export async function settleClosingReservation(
	entries: Iterable<RpcSessionEntry>,
	sessionPath: string,
	closeGraceMs: number,
): Promise<void> {
	const closing = [...entries].find((entry) => entry.reservationKey === sessionPath && entry.state === "closing");
	if (!closing?.closeCompletion) return;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			closing.closeCompletion,
			new Promise<void>((resolve) => {
				deadline = setTimeout(resolve, closeGraceMs);
			}),
		]);
	} finally {
		if (deadline) clearTimeout(deadline);
	}
}
