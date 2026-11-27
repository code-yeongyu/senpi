import type { RpcSessionClosedReason } from "./rpc-types.ts";

import { readDrainVerdicts } from "./session-drain.ts";
import { holdDrainedTurns } from "./session-drain-hold.ts";
import { forgetSessionOwnership } from "./session-router-attachments.ts";
import { finalizeClose, tryClaimClose } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { recordRetainedSession } from "./session-router-residency.ts";
import { removedSessionDirectories, sessionDirectoryRemovedIn } from "./session-path-key.ts";
import { selectSweepEvictions } from "./session-sweep.ts";

const DRAIN_SWEEP_MS = 50;

/**
 * Park attached and detached sessions once turns and requests settle. Durable wake sources
 * resume on reopen, unlike active work. Repeated requests (including grace expiry) rescan
 * without announcing again or aborting a turn.
 */
export function beginDrain(host: RouterContext): Promise<void> {
	host.draining = true;
	void host.parks
		.stop()
		.catch((cause: unknown) => {
			process.stderr.write(`senpi rpc park close failed during drain: ${String(cause)}\n`);
		})
		.then(() => sweepDrain(host))
		.catch((cause: unknown) => {
			process.stderr.write(`senpi rpc drain sweep failed after park close: ${String(cause)}\n`);
		});
	stopSweep(host);
	// Armed BEFORE the first pass, so a pass that fails is retried instead of ending the drain
	// (senpi#2285). Unref'd: a draining host must never be the reason the event loop stays open.
	if (host.drainTimer === undefined && !host.drainExitRequested) {
		host.drainTimer = setInterval(() => void sweepDrain(host), DRAIN_SWEEP_MS);
		host.drainTimer.unref?.();
	}
	return sweepDrain(host);
}

/** One drain pass: park what has settled, and exit once the host holds nothing. */
export function sweepDrain(host: RouterContext): Promise<void> {
	// One pass at a time; a pass asked for while one runs follows it, so the pass that finds the host empty is never lost.
	if (host.drainPass) {
		host.drainPassAgain = true;
		return host.drainPass;
	}
	const pass = (async () => {
		do {
			host.drainPassAgain = false;
			await drainOnce(host);
		} while (host.drainPassAgain);
	})().finally(() => {
		host.drainPass = undefined;
	});
	host.drainPass = pass;
	return pass;
}

async function drainOnce(host: RouterContext): Promise<void> {
	// An accepted open can still be constructing a runtime or binding.
	if (host.activeRequests.has(undefined)) return;
	// Whether a transcript directory is gone is checked off the host thread (senpi#4565). A pass that cannot list the
	// sessions failed as a whole, exactly like one whose verdicts throw: the drain timer retries it (senpi#2285).
	let removed: ReadonlySet<string>;
	try {
		removed = await removedSessionDirectories(openSessionFiles(host));
	} catch (cause) {
		process.stderr.write(`senpi rpc handoff drain pass failed, retrying: ${String(cause)}\n`);
		return;
	}
	if (host.activeRequests.has(undefined)) return;
	// A pass that failed as a whole is retried by the drain timer armed before it (senpi#2285).
	const verdicts = readDrainVerdicts(
		host.registry,
		(sessionId) => host.activeRequests.has(sessionId),
		sessionDirectoryRemovedIn(removed),
	);
	if (!verdicts) return;
	holdDrainedTurns(host);
	for (const sessionId of verdicts.gone) parkForHandoff(host, sessionId, "session_dir_removed");
	for (const sessionId of verdicts.park) parkForHandoff(host, sessionId, "handoff_parked");
	if (host.registry.size > 0 || host.parks.size > 0 || host.handoffParks > 0 || host.finalizations.size > 0) return;
	if (host.drainTimer !== undefined) {
		clearInterval(host.drainTimer);
		host.drainTimer = undefined;
	}
	stopSweep(host);
	if (host.drainExitRequested) return;
	host.drainExitRequested = true;
	host.onEmptyExit?.();
}

export function parkForHandoff(
	host: RouterContext,
	sessionId: string,
	reason: "handoff_parked" | "session_dir_removed",
): void {
	host.handoffClosed.add(sessionId);
	host.handoffParks++;
	void evictIdleSession(host, sessionId, reason)
		.catch((cause: unknown) => {
			process.stderr.write(`senpi rpc handoff park ${sessionId} failed: ${String(cause)}\n`);
		})
		.finally(() => {
			host.handoffParks--;
			void sweepDrain(host);
		});
}

/**
 * One occupancy sweep. Evicts what `selectSweepEvictions` decides: open sessions idle
 * longer than idleEvictionMs, and unattached sessions whose transcript directory is
 * gone. While the host reports memory pressure the window is HALVED, so an
 * idle session's memory returns to the process sooner. Fires onEmptyExit once the
 * registry has STAYED empty for emptyExitMs with the exit permitted; any live session
 * or connected client resets that window. Runs on an unref'd interval and is safe to
 * call directly.
 */
export function sweepIdleSessions(host: RouterContext): Promise<void> {
	if (host.idleSweep) return host.idleSweep;
	const sweep = (async () => {
		// Whether a transcript directory is gone is checked off the host thread (senpi#4565).
		const removed = await removedSessionDirectories(openSessionFiles(host));
		sweepIdleSessionsWith(host, sessionDirectoryRemovedIn(removed));
	})().finally(() => {
		host.idleSweep = undefined;
	});
	host.idleSweep = sweep;
	return sweep;
}

/** The transcript files of the sessions the registry lists. */
function openSessionFiles(host: RouterContext): string[] {
	return host.registry.list().flatMap(({ sessionPath }) => (sessionPath === undefined ? [] : [sessionPath]));
}

function sweepIdleSessionsWith(host: RouterContext, directoryRemoved: (sessionFile: string) => boolean): void {
	const now = host.idleNow();
	const idleEvictionMs = host.memoryPressure ? host.idleEvictionMs / 2 : host.idleEvictionMs;
	const verdicts = selectSweepEvictions(
		host.registry,
		now,
		idleEvictionMs,
		(sessionId) =>
			host.activeRequests.has(sessionId) || (host.bindings.get(sessionId)?.pendingPrompts?.().length ?? 0) > 0,
		directoryRemoved,
	);
	for (const sessionId of verdicts.orphaned) void evictIdleSession(host, sessionId, "session_dir_removed");
	for (const sessionId of verdicts.idle) void evictIdleSession(host, sessionId);
	if (Number.isFinite(host.emptyExitMs)) {
		if (
			host.registry.size === 0 &&
			!host.inheritedHandover?.predecessorDraining &&
			(host.canExitWhenEmpty?.() ?? true)
		) {
			if (host.emptySince === undefined) host.emptySince = now;
			else if (now - host.emptySince >= host.emptyExitMs) {
				stopSweep(host);
				host.onEmptyExit?.();
			}
		} else {
			host.emptySince = undefined;
		}
	}
}

/**
 * Idle-session eviction: the same refcounted close sequence as an explicit
 * close_session, draining every attachment because eviction ends the shared
 * session, not one client's claim. Races with concurrent lifecycle paths are
 * tolerated the same way releaseOwnedSession tolerates them.
 *
 * Evicting a RETAINED session is a PARK, not a close: that session was opened to
 * outlive its clients, so the terminal record names the file it reopens by
 * (`session_parked`) instead of reporting a close nobody requested. The teardown
 * itself is identical - retention never outlives the idle window.
 */
export async function evictIdleSession(
	host: RouterContext,
	sessionId: string,
	reason?: RpcSessionClosedReason,
): Promise<void> {
	// Read before the claim: the entry is gone once the teardown completes, and a park
	// record without the session's path would not be actionable (so a retained session
	// with no file to reopen by ends as an ordinary close).
	const retained = host.registry.peek(sessionId);
	const parkedPath =
		retained?.retainOnDisconnect === true || reason === "handoff_parked" ? retained?.sessionPath : undefined;
	// A drain releases every session's connections the same way, parked or gone (senpi#2285).
	const handoff = reason === "handoff_parked" || (reason === "session_dir_removed" && host.draining);
	const owners = handoff
		? [...host.sessionsByConnection].filter(([, owned]) => owned.has(sessionId)).map(([connection]) => connection)
		: [];
	// A failed claim means an explicit close raced us and owns the entry now; nothing is recorded,
	// or a closed session would come back on the next host start (MEDIUM-1, senpi#3282 review).
	const claim = tryClaimClose(host, sessionId, { drainAttachments: true });
	if (!claim) return;
	// A retain_on_disconnect session survives EVERY generation: park it to disk AND into the
	// handover record, whether the park came from the handoff drain or the idle sweep, so the
	// successor reopens it. Recorded only after the claim wins, and only when the teardown parks
	// (parkedPath set) - never for an explicit close. The write is awaited before the drain
	// proceeds, or the generation can hand over and exit before it lands and the park is lost.
	if (
		host.handoverParkedDir !== undefined &&
		parkedPath !== undefined &&
		retained?.retainOnDisconnect === true &&
		retained.sessionPath !== undefined
	) {
		// A drain park is live: the session was running here and the successor picks it up. An idle-sweep park is not.
		await recordRetainedSession(host, retained, retained.sessionPath, false, reason === "handoff_parked").catch(
			(cause: unknown) => {
				process.stderr.write(`senpi rpc handover park record ${sessionId} failed: ${String(cause)}\n`);
			},
		);
	}
	const binding = host.bindings.get(sessionId);
	binding?.cancelPendingExtensionUiRequests?.();
	if (!handoff) forgetSessionOwnership(host, sessionId);
	if (claim.finalizer) {
		await finalizeClose(host, sessionId, binding, () =>
			// A drain names ITS reason on the close record. An idle sweep of a RETAINED
			// session parks instead: the file reopens by path. Anything else is a close.
			parkedPath !== undefined && reason === undefined
				? host.writer.parkSession(sessionId, parkedPath, "idle")
				: host.writer.closeSession(
						sessionId,
						{ type: "response", command: "close_session", success: true, data: {} },
						reason ?? "idle_evicted",
						reason === "handoff_parked" ? parkedPath : undefined,
					),
		);
	} else {
		await host.finalizations.get(sessionId)?.promise;
	}
	if (handoff) {
		forgetSessionOwnership(host, sessionId);
		await host.onHandoffParked?.(owners.filter((connection) => !host.sessionsByConnection.has(connection)));
	}
	// The runtime is disposed and routing handles are unique per process
	// epoch, so nothing can emit under this id again: drop the writer's
	// per-session bookkeeping instead of retaining it for the host's life.
	host.writer.forgetSession(sessionId);
}

export function stopSweep(host: RouterContext): void {
	if (host.sweepTimer === undefined) return;
	clearInterval(host.sweepTimer);
	host.sweepTimer = undefined;
}
