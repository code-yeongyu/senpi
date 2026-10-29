import type { RpcSessionClosedReason } from "./rpc-types.ts";

import { readDrainVerdicts } from "./session-drain.ts";
import { forgetSessionOwnership } from "./session-router-attachments.ts";
import { finalizeClose, tryClaimClose } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { selectSweepEvictions } from "./session-sweep.ts";
import { type ParkIntent, parkDue, stillQuiet, withdrawParkIntent, writeParkIntent } from "./session-transfer-park.ts";
import { reportHeldTransfers } from "./session-transfer-seal.ts";

const DRAIN_SWEEP_MS = 50;

/**
 * Park attached and detached sessions once turns and requests settle. Durable wake sources
 * resume on reopen, unlike active work. Repeated requests (including grace expiry) rescan
 * without announcing again or aborting a turn.
 */
export function beginDrain(host: RouterContext): void {
	host.draining = true;
	stopSweep(host);
	// Armed BEFORE the first pass, so a pass that fails is retried instead of ending the drain
	// (senpi#2285). Unref'd: a draining host must never be the reason the event loop stays open.
	if (host.drainTimer === undefined && !host.drainExitRequested) {
		host.drainTimer = setInterval(() => sweepDrain(host), DRAIN_SWEEP_MS);
		host.drainTimer.unref?.();
	}
	sweepDrain(host);
}

/** One drain pass: park what has settled, and exit once the host holds nothing. */
export function sweepDrain(host: RouterContext): void {
	// An accepted open can still be constructing a runtime or binding.
	if (host.activeRequests.has(undefined)) return;
	// A pass that failed as a whole is retried by the drain timer armed before it (senpi#2285).
	const verdicts = readDrainVerdicts(
		host.registry,
		(sessionId) => host.activeRequests.has(sessionId),
		(sessionId) => host.bindings.get(sessionId)?.pendingPrompts?.().length ?? 0,
	);
	if (!verdicts) return;
	reportHeldTransfers(host, verdicts.held);
	// A session whose transfer is already in flight is that transfer's to finish.
	const startable = (sessionId: string) => !host.transferSeals.has(sessionId) && parkDue(host, sessionId);
	for (const sessionId of verdicts.gone.filter(startable)) parkForHandoff(host, sessionId, "session_dir_removed");
	for (const sessionId of verdicts.park.filter(startable)) parkForHandoff(host, sessionId, "handoff_parked");
	if (host.registry.size > 0 || host.handoffParks > 0 || host.finalizations.size > 0) return;
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
	host.handoffParks++;
	void evictIdleSession(host, sessionId, reason)
		.catch((cause: unknown) => {
			process.stderr.write(`senpi rpc handoff park ${sessionId} failed: ${String(cause)}\n`);
		})
		.finally(() => {
			host.handoffParks--;
			sweepDrain(host);
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
export function sweepIdleSessions(host: RouterContext): void {
	const now = host.idleNow();
	const idleEvictionMs = host.memoryPressure ? host.idleEvictionMs / 2 : host.idleEvictionMs;
	const verdicts = selectSweepEvictions(
		host.registry,
		now,
		idleEvictionMs,
		(sessionId) =>
			host.activeRequests.has(sessionId) || (host.bindings.get(sessionId)?.pendingPrompts?.().length ?? 0) > 0,
	);
	for (const sessionId of verdicts.orphaned) void evictIdleSession(host, sessionId, "session_dir_removed");
	for (const sessionId of verdicts.idle)
		if (parkDue(host, sessionId) && !host.transferSeals.has(sessionId)) void evictIdleSession(host, sessionId);
	if (Number.isFinite(host.emptyExitMs)) {
		if (host.registry.size === 0 && (host.canExitWhenEmpty?.() ?? true)) {
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
	// A retain_on_disconnect session survives EVERY generation, whether the park came from the handoff
	// drain or the idle sweep: it is sealed and its record written durably BEFORE anything is torn down
	// (#10091), so a record that cannot be written leaves the session here instead of losing it.
	let intent: ParkIntent | undefined;
	if (host.handoverParkedDir !== undefined && parkedPath !== undefined && retained?.retainOnDisconnect === true) {
		intent = await writeParkIntent(host, sessionId, retained, parkedPath, host.handoverParkedDir);
		if (intent === undefined) return;
		// Work that started while the record was written (an in-session timer, a passing control command)
		// keeps the session here; the check and the claim below run in one synchronous step.
		if (!intent.seal.closed && !stillQuiet(host, sessionId)) {
			await withdrawParkIntent(host, sessionId, intent, false);
			return;
		}
	}
	const owners = handoff
		? [...host.sessionsByConnection].filter(([, owned]) => owned.has(sessionId)).map(([connection]) => connection)
		: [];
	// A failed claim, or one that joined an explicit close of a sealed session, means that close owns the
	// entry now: the close wins and the record is withdrawn, or a closed session would come back on the next
	// host start (MEDIUM-1, senpi#3282).
	const claim = tryClaimClose(host, sessionId, { drainAttachments: true });
	if (!claim || intent?.seal.closed === true) {
		if (intent !== undefined) await withdrawParkIntent(host, sessionId, intent, true);
		return;
	}
	if (handoff) host.handoffClosed.add(sessionId);
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
	if (intent !== undefined) host.transferSeals.delete(sessionId);
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
