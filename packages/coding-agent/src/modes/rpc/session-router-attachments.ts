import { finalizeClose, tryClaimClose } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { connectionLeft } from "./session-router-relocation.ts";
/** Disconnect semantics shared by socket loss and release_attachment. True means settlement owns the final release. */
export async function releaseDisconnectAttachment(host: RouterContext, sessionId: string): Promise<boolean> {
	// Headless completion contract: a turn survives its client's death and
	// runs to settlement (the host lifecycle keeps the process alive on
	// active turns even with zero connections). Releasing mid-turn aborts
	// the run and seals the session before agent_settled reaches the
	// lifecycle observer, leaking the busy counter so the host never
	// idle-exits. Defer - never skip - the release until the turn settles,
	// so the dropped owner's reservation still frees afterwards.
	//
	// A retained session is never closed by a drop, so it has nothing to defer:
	// release the attachment now - the client is already gone and must not keep
	// counting - and let the turn run to settlement on its own.
	//
	// Only the release that would end the session can abort its turn. While another
	// attachment remains, this one goes now, so the session stops counting the client
	// the moment it leaves (senpi#3238).
	const live = host.registry.peek(sessionId);
	const endsSession = live?.retainOnDisconnect !== true && (live?.attachments ?? 0) <= 1;
	const session = live?.state === "open" ? live.runtime?.session : undefined;
	if (endsSession && live?.state === "open" && live.worker?.snapshot?.streaming) {
		const unsubscribe = live.worker.subscribeSettled(() => {
			unsubscribe();
			void releaseOwnedSession(host, sessionId).catch((cause: unknown) => {
				process.stderr.write(`senpi rpc deferred worker release ${sessionId} failed: ${String(cause)}\n`);
			});
		});
		return true;
	}
	if (endsSession && session?.isStreaming) {
		let released = false;
		const unsubscribe = session.subscribe((event) => {
			// agent_idle, not agent_settled: settle-time extension handlers may still be writing (omo#11419).
			if (event.type !== "agent_idle") return;
			if (released) return;
			released = true;
			unsubscribe();
			void releaseOwnedSession(host, sessionId).catch((cause) => {
				process.stderr.write(`senpi rpc deferred release for session ${sessionId} failed: ${String(cause)}\n`);
			});
		});
		return true;
	}
	await releaseOwnedSession(host, sessionId);
	return false;
}

export function recordAttachment(host: RouterContext, owner: string, sessionId: string): void {
	host.writer.attachConnectionToSession(owner, sessionId);
	const owned = host.sessionsByConnection.get(owner) ?? new Map<string, number>();
	owned.set(sessionId, (owned.get(sessionId) ?? 0) + 1);
	host.sessionsByConnection.set(owner, owned);
	host.attachOrder.attached(sessionId, owner);
}

/**
 * Releases every session a dropped connection still owned. Each handle goes through
 * the same refcounted close as an explicit close_session, so a session another
 * connection is still attached to keeps running and only the last owner tears it down.
 * Resolves to the sessions whose attachment is still counted: the ones that release when
 * their running turn settles, or every owned one while the host drains.
 */
export async function releaseConnection(host: RouterContext, connectionId: string): Promise<string[]> {
	host.releasedConnections.add(connectionId);
	host.writer.clearConnectionCapabilities(connectionId);
	host.connectionRoles.release(connectionId);
	for (const sessionId of host.sessionsByConnection.get(connectionId)?.keys() ?? []) {
		host.writer.detachConnectionFromSession(connectionId, sessionId);
		connectionLeft(host, sessionId, connectionId);
	}
	// The socket is gone (dropped, not `detach_connection`): nothing will ever open with its capabilities again.
	if (!host.writer.hasConnection(connectionId)) host.pendingCapabilities.delete(connectionId);
	const opens = host.opensByConnection.get(connectionId);
	const owned = host.sessionsByConnection.get(connectionId);
	host.sessionsByConnection.delete(connectionId);
	if (host.draining) {
		// Drain owns teardown now, even when a client reacts to the announcement early.
		// Its attachment-draining claim releases these counts once work settles.
		if (opens) await Promise.all([...opens]);
		host.releasedConnections.delete(connectionId);
		return [...(owned?.keys() ?? [])];
	}
	if (owned === undefined) {
		if (opens) await Promise.all([...opens]);
		host.releasedConnections.delete(connectionId);
		return [];
	}
	const deferred = new Set<string>();
	await Promise.all(
		[...owned].map(async ([sessionId, count]) => {
			for (let attachment = 0; attachment < count; attachment++) {
				if (await releaseDisconnectAttachment(host, sessionId)) deferred.add(sessionId);
			}
		}),
	);
	if (opens) await Promise.all([...opens]);
	host.releasedConnections.delete(connectionId);
	return [...deferred];
}

/**
 * One owned handle's refcounted close: the same sequence as an explicit
 * close_session, tolerant of races with other lifecycle paths (an entry
 * already closed or claimed elsewhere is simply skipped), except that it claims
 * a DETACH: a retained entry keeps running at zero attachments instead of
 * closing, so this path releases the client's claim without ending the session.
 * Disposal, pending
 * extension-UI cancellation and binding removal happen only when this was the
 * LAST attachment (the entry transitioned to "closing"): surviving
 * attachments keep the shared binding and their event stream.
 */
export async function releaseOwnedSession(host: RouterContext, sessionId: string): Promise<void> {
	const live = host.registry.peek(sessionId);
	const parks = live?.state === "open" && live.retainOnDisconnect === true && live.attachments === 1;
	// A failed claim means the entry is already closed or owned by another path.
	// A retained entry answers the detach by staying open: no finalizer, nothing to join.
	const claim = tryClaimClose(host, sessionId, { drainAttachments: false, detach: true });
	if (!claim) return;
	if (!claim.finalizer) {
		host.writer.status.publish(sessionId, "detach", "client");
		if (parks && live.runtime) {
			live.lifecycleMutex = live.lifecycleMutex.then(() => live.runtime?.emitAttachmentEvent("session_parked"));
			await live.lifecycleMutex;
		}
		await host.finalizations.get(sessionId)?.promise;
		return;
	}
	const binding = host.bindings.get(sessionId);
	// Pending UI requests are session-owned, not connection-owned: a question
	// asked through one connection stays answerable by every other attachment.
	// Cancel them only here, where the refcount has already decided the session
	// is being torn down, never on any owner drop.
	binding?.cancelPendingExtensionUiRequests?.();
	await finalizeClose(host, sessionId, binding);
}

/** Detaches the closing connection from the session's record fanout. */
export function releaseOwnerAttachment(host: RouterContext, owner: string, sessionId: string): void {
	const owned = host.sessionsByConnection.get(owner);
	const count = owned?.get(sessionId);
	if (!owned || count === undefined) return;
	if (count === 1) {
		host.writer.detachConnectionFromSession(owner, sessionId);
		owned.delete(sessionId);
		connectionLeft(host, sessionId, owner);
	} else owned.set(sessionId, count - 1);
	if (owned.size === 0) host.sessionsByConnection.delete(owner);
}

/** Drops per-connection records for a handle the host closed on its own. */
export function forgetSessionOwnership(host: RouterContext, sessionId: string): void {
	host.attachOrder.forgetSession(sessionId);
	for (const [connection, owned] of host.sessionsByConnection) {
		owned.delete(sessionId);
		if (owned.size === 0) host.sessionsByConnection.delete(connection);
	}
}
