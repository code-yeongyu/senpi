/**
 * Attach-on-open: a live session outlives individual client attachments, so a resume (or a second
 * surface) for an already-hosted path joins the existing runtime instead of failing. An entry
 * still opening holds the reservation, and an explicit open for that path waits on the entry's
 * openCompletion (bounded on the waiter only, default 45s) and attaches once it opens; on that
 * wait expiring, only the one waiting reopen fails with a retryable session_path_in_use
 * {reason: "open_in_progress", retry_after_ms} naming an attached current owner, and the in-flight
 * open keeps running untouched.
 */
import type { SessionPathOwner, SessionPathReservations } from "./host-reservations.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
} from "./session-registry-types.ts";

/** How long ONE explicit reopen waits on an in-flight open before giving up (the open keeps going). */
const DEFAULT_OPEN_IN_PROGRESS_WAIT_MS = 45_000;
/** How long the caller is told to wait before retrying after an open_in_progress rejection. */
const OPEN_IN_PROGRESS_WAIT_RETRY_MS = 2_000;

// The wait is read at call time so a test can shorten it via SENPI_OPEN_IN_PROGRESS_WAIT_MS.
function openInProgressWaitMs(): number {
	const override = Number(process.env.SENPI_OPEN_IN_PROGRESS_WAIT_MS);
	return Number.isFinite(override) && override > 0 ? override : DEFAULT_OPEN_IN_PROGRESS_WAIT_MS;
}

class OpenInProgressWaitError extends Error {}

// The owner a still-opening path's rejection names: the current host, attached (the session is
// being served, not stranded). This is a signal, not a protection: a client may still treat a
// current owner as locally reclaimable. What keeps the opening session alive is that this host
// refuses abort and close on an "opening" entry (getForCommand, beginSessionClose).
function openingOwner(sessionPath: string): SessionPathOwner {
	return {
		instanceId: hostInstanceId(),
		pid: process.pid,
		processStartTime: null,
		sessionPath,
		attached: true,
		current: true,
	};
}

function waitWithDeadline(openCompletion: Promise<void>, waitMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		openCompletion,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new OpenInProgressWaitError()), waitMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export async function attachToOpenSession(
	entries: ReadonlyMap<string, RpcSessionEntry>,
	sessionPath: string,
	profile: RpcSessionLaunchProfile,
	options: RpcSessionOpenOptions | undefined,
	pathReservations: SessionPathReservations | undefined,
	now: number,
): Promise<OpenRpcSession> {
	const existing = [...entries].find(([, entry]) => entry.reservationKey === sessionPath && entry.state === "open");
	if (!existing) {
		// An in-flight open for the same path holds the reservation. An explicit reopen WAITS for it
		// to finish and attaches, rather than failing on a healthy in-flight open (senpi#3282
		// review: the explicit reopen waits for, or attaches to, the in-flight open of the path).
		const inFlight = [...entries].find(
			([, entry]) => entry.reservationKey === sessionPath && entry.state === "opening",
		);
		if (inFlight?.[1].openCompletion !== undefined) {
			try {
				// The deadline is on THIS waiter only, never on the open: a slow-but-healthy open still
				// completes (observed shared-host opens run ~10s with 20s outliers, so the bound sits just
				// under the interactive client's 60s open timeout), and a later retry attaches to it. The
				// entry, its runtime and its reservation are left untouched (senpi#3282 review M1/M2).
				await waitWithDeadline(inFlight[1].openCompletion, openInProgressWaitMs());
			} catch (cause) {
				if (cause instanceof OpenInProgressWaitError)
					throw new RpcSessionRegistryError("session_path_in_use", "the session is still opening", {
						reason: "open_in_progress",
						retry_after_ms: OPEN_IN_PROGRESS_WAIT_RETRY_MS,
						// The rejection names the current host as an attached owner. A client that reclaims the
						// path anyway cannot close the opening session: abort and close on an "opening" entry are
						// refused with unknown_session (senpi#3282 review round 9).
						owner: openingOwner(sessionPath),
					});
				// The in-flight open FAILED: its rollback released the reservation, so the path is now
				// free and the caller's retry opens it fresh. This open reports session_path_in_use so
				// the caller retries, not the failed opener's own error (senpi#3282 review M1).
				throw new RpcSessionRegistryError("session_path_in_use", "the in-flight open failed", {
					reason: "open_failed",
					retry_after_ms: OPEN_IN_PROGRESS_WAIT_RETRY_MS,
				});
			}
			return attachToOpenSession(entries, sessionPath, profile, options, pathReservations, now);
		}
		// The path is still reserved by a session that is not serving (a teardown past its grace
		// window): never a bare refusal, so the caller knows to retry (senpi#3485).
		throw new RpcSessionRegistryError("session_path_in_use", "the session is still being released", {
			reason: "path_still_held",
			retry_after_ms: OPEN_IN_PROGRESS_WAIT_RETRY_MS,
		});
	}
	const [handle, entry] = existing;
	const wasParked = entry.retainOnDisconnect === true && entry.attachments === 0;
	entry.attachments += 1;
	entry.detachedAt = undefined;
	// The claim carries the attachment state another generation decides on: a path this host is
	// actively serving a client on is never reclaimable from it.
	pathReservations?.setAttached(sessionPath, true);
	// Retention is a property of the live session: any attach may ask for it, and
	// no attach may revoke it for the clients that already rely on it.
	if (options?.retainOnDisconnect) entry.retainOnDisconnect = true;
	if (!entry.durableSessionId) throw new RpcSessionRegistryError("session_path_in_use");
	// The surface, browser engine and permission preset follow the client: an attach that names one
	// moves the live session to it; an attach without one keeps what the session has.
	if (profile.promptSurface !== undefined && profile.promptSurface !== entry.profile.promptSurface) {
		entry.profile = frozenProfile({ ...entry.profile, promptSurface: profile.promptSurface });
		entry.runtime?.setPromptSurface(profile.promptSurface);
	}
	if (profile.browserEngine !== undefined && profile.browserEngine !== entry.profile.browserEngine) {
		entry.profile = frozenProfile({ ...entry.profile, browserEngine: profile.browserEngine });
		entry.runtime?.setBrowserEngine(profile.browserEngine);
	}
	// The preset is applied even when the record already names it: the record is not the live session,
	// so a resent attach also repairs a session that drifted from it (senpi#2842).
	if (profile.permissionPreset !== undefined) {
		entry.profile = frozenProfile({ ...entry.profile, permissionPreset: profile.permissionPreset });
		entry.runtime?.setPermissionPreset(profile.permissionPreset);
	}
	entry.lastCommandAt = now;
	if (wasParked) {
		entry.lifecycleMutex = entry.lifecycleMutex.then(() => entry.runtime?.emitAttachmentEvent("session_resumed"));
		await entry.lifecycleMutex;
	}
	return {
		sessionId: handle,
		durableSessionId: entry.durableSessionId,
		sessionPath: entry.sessionPath,
		attached: true,
	};
}
