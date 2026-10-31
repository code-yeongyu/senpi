import { buildRpcSessionState } from "./connection-handler.ts";

import { clearHandoverParkedSession, type HandoverParkedEntry } from "./host-handover-parked.ts";
import { parkedOpenCommand } from "./host-handover-parked-open.ts";

import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

import { sessionHeldCheck } from "./session-held.ts";
import type { OpenRpcSession } from "./session-registry.ts";
import { forgetSessionOwnership, releaseOwnedSession, releaseOwnerAttachment } from "./session-router-attachments.ts";
import { close } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";
import { sweepDrain } from "./session-router-occupancy.ts";
import { invalidSpawnedBy, validatedOpenProfile } from "./session-router-open-profile.ts";
import { relocationConnection } from "./session-router-relocation.ts";
import { liveToolMediaScope, toolMediaPersister } from "./tool-media-store.ts";

export function openWithBarrier(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "open_session" }>,
): Promise<RpcResponse | undefined> {
	const owner = host.writer.currentConnection();
	if (owner === undefined) return open(host, command);
	let resolveBarrier!: () => void;
	const barrier = new Promise<void>((resolve) => {
		resolveBarrier = resolve;
	});
	const opens = host.opensByConnection.get(owner) ?? new Set<Promise<void>>();
	// Every open already accepted anywhere on this host, not just on this connection: the
	// in-process runtime serves them on ONE loop, so the wait this caller faces is the total.
	let inFlight = 0;
	for (const pending of host.opensByConnection.values()) inFlight += pending.size;
	opens.add(barrier);
	host.opensByConnection.set(owner, opens);
	// Before the open reaches the loop: a client that later hits its deadline can then say
	// where it was queued instead of reporting a bare timeout (senpi#1844).
	if (command.id !== undefined)
		host.writer.sendOpenQueued(owner, {
			type: "queued",
			for_request: command.id,
			position: inFlight + 1,
			in_flight: inFlight,
		});
	const opened = open(host, command, owner);
	// A manual reopen-by-path supersedes the handover auto-reopen for that session: clear its
	// record entry, or a later generation would reopen a second copy (MEDIUM-1, senpi#3282 review).
	// Cleared only after the open SUCCEEDS (MEDIUM-A): if the open fails - a session_path_in_use
	// during a handover, or a bad profile - the entry must stay so a later generation can still
	// reopen the session. open() resolves `undefined` on success (the response is written through
	// the writer) and an RpcResponse only on failure, so success is `response === undefined`.
	if (command.sessionPath !== undefined && host.handoverParkedDir !== undefined) {
		const dir = host.handoverParkedDir;
		const sessionPath = command.sessionPath;
		void opened.then(
			(response) => {
				if (response === undefined) void clearHandoverParkedSession(dir, sessionPath).catch(() => {});
			},
			() => {
				// A rejection means the open failed before producing a response; the entry stays.
			},
		);
	}
	return opened.finally(() => {
		resolveBarrier();
		opens.delete(barrier);
		if (opens.size === 0) host.opensByConnection.delete(owner);
	});
}

/**
 * The successor's reopen of a handoff-parked session: the same open as an `open_session`, with no
 * requesting connection and nothing to reply to (senpi#3368). Resolves `undefined` on success and
 * the failure response otherwise, exactly as an open does.
 */
export function reopenParked(host: RouterContext, entry: HandoverParkedEntry): Promise<RpcResponse | undefined> {
	return open(host, { ...parkedOpenCommand(entry), attended: false }, undefined, {
		reply: false,
		defaults: false,
		contextOverlay: entry.contextOverlay,
	});
}

export async function open(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "open_session" }>,
	owner?: string,
	options?: {
		readonly reply?: boolean;
		readonly defaults?: boolean;
		readonly contextOverlay?: HandoverParkedEntry["contextOverlay"];
	},
): Promise<RpcResponse | undefined> {
	const profile = validatedOpenProfile(host, command, options);
	if ("type" in profile) return profile;
	let opened: OpenRpcSession | undefined;
	const assertSessionNotHeld = sessionHeldCheck(
		(observedStarts) => host.registry.holderPids?.(observedStarts) ?? Promise.resolve([]),
	);
	try {
		await assertSessionNotHeld(command.sessionPath);
		if (invalidSpawnedBy(command)) return error(command.id, "open_session", "invalid_spawned_by");
		const ancestry = command.spawnedBy;
		opened = await host.registry.openSession(
			ancestry ? { ...profile, spawnedBy: ancestry } : profile,
			// Host lifecycle policy, deliberately outside the immutable launch profile.
			{
				retainOnDisconnect: command.retain_on_disconnect === true,
				attachOnly: command.expectedHostInstance !== undefined,
			},
		);
		const openedSession = opened;
		if (host.writer.isSessionSealed(openedSession.sessionId)) {
			// Lost output cannot be replayed. Undo only this attachment; keep the runtime and
			// seal intact until an explicit unload safely parks it for a fresh open by path.
			await releaseOwnedSession(host, openedSession.sessionId);
			opened = undefined;
			return error(command.id, "open_session", "session_output_overflow", {
				sessionId: openedSession.sessionId,
				sessionPath: openedSession.sessionPath,
				action: "unload_and_reopen",
			});
		}
		const entry = host.registry.getForCommand(openedSession.sessionId, "open_session");
		if (!opened.attached && options?.contextOverlay !== undefined) entry.contextOverlay = options.contextOverlay;
		const state = entry.worker?.snapshot?.state;
		// The runtime has now published its own lease. Recheck before attaching or replying,
		// so an opener racing the initial lookup is rolled back rather than admitted.
		await assertSessionNotHeld(
			entry.runtime?.session.sessionFile ?? state?.sessionFile ?? entry.sessionPath,
			entry.runtime?.session.sessionId ?? state?.sessionId ?? entry.durableSessionId,
		);
		host.writer.setSessionKind(openedSession.sessionId, entry.kind);
		host.writer.setSessionMedia(
			openedSession.sessionId,
			toolMediaPersister(() => liveToolMediaScope(entry)),
		);
		// The lane is bootstrapped before admission (R3.C1.1); the fanout knows it before the opener's attach freezes a cut,
		// so a lane-owned session's baseline is never read from the replay store (RULING-52).
		const lane = entry.acceptance ?? entry.worker?.acceptance;
		if (lane) host.writer.registerAcceptance(openedSession.sessionId, lane);
		if (owner !== undefined) {
			if (!host.writer.hasRegisteredConnectionCapabilities(owner))
				host.writer.setConnectionCapabilities(
					owner,
					host.pendingCapabilities.get(owner) ?? host.connectionOptions?.capabilities ?? [],
				);
			host.writer.attachConnectionToSession(owner, openedSession.sessionId);
		}
		// A client that dies without close_session (terminal closed, SIGKILL, dropped
		// SSH) still holds this handle's attachment and its path reservation. Remember
		// which connection owns it so releaseConnection() can close exactly that.
		if (owner !== undefined) {
			const owned = host.sessionsByConnection.get(owner) ?? new Map<string, number>();
			owned.set(openedSession.sessionId, (owned.get(openedSession.sessionId) ?? 0) + 1);
			host.sessionsByConnection.set(owner, owned);
			host.attachOrder.attached(openedSession.sessionId, owner);
		}
		if (!host.bindings.has(openedSession.sessionId)) {
			host.bindings.set(
				openedSession.sessionId,
				await host.createBinding(
					openedSession.sessionId,
					entry,
					host.writer,
					() => void close(host, { type: "close_session", sessionId: openedSession.sessionId }),
					{
						...host.connectionOptions,
						capabilities:
							owner !== undefined
								? (host.pendingCapabilities.get(owner) ?? host.connectionOptions?.capabilities ?? [])
								: host.connectionOptions?.capabilities,
						connectionRoles: host.connectionRoles,
						clientInfo: {
							setCapabilities: (connectionId, capabilities) => {
								if (connectionId !== undefined) {
									host.writer.setConnectionCapabilities(connectionId, capabilities);
									host.pendingCapabilities.set(connectionId, [...capabilities]);
								}
							},
							connectionId: () => host.writer.currentConnection(),
							relocationConnection: () => relocationConnection(host, openedSession.sessionId),
							deliverTo: (connection, deliver) => host.writer.withConnection(connection, deliver),
						},
					},
				),
			);
			if (entry.worker) entry.worker.bindingReady = true;
			// Wake the drain sweep the moment a session settles, so a handoff parks it
			// without waiting for the next timer tick. Both hooks are OPTIONAL: an
			// embedder's runtime and the suite's fakes implement the session surface
			// they need and nothing more, and an open must never fail because a
			// settle notification is unavailable - the periodic sweep still parks it.
			const settled = () => {
				if (host.draining) queueMicrotask(() => sweepDrain(host));
			};
			if (typeof entry.worker?.subscribeSettled === "function") entry.worker.subscribeSettled(settled);
			else if (typeof entry.runtime?.session.subscribe === "function")
				entry.runtime.session.subscribe((event) => {
					// agent_idle, not agent_settled: settle-time extension handlers may still be writing (omo#11419).
					if (event.type === "agent_idle") settled();
				});
			if (entry.worker)
				void entry.worker.exited.then(async () => {
					await host.finalizations.get(openedSession.sessionId)?.promise;
					host.bindings.delete(openedSession.sessionId);
					forgetSessionOwnership(host, openedSession.sessionId);
					host.writer.forgetSession(openedSession.sessionId);
				});
		}
		if (opened.attached) host.writer.status.publish(openedSession.sessionId, "attach", "client");
		else {
			host.writer.publishSessionOpened({
				type: "session_opened",
				sessionId: openedSession.sessionId,
				durableSessionId: openedSession.durableSessionId,
				...(openedSession.sessionPath !== undefined ? { sessionPath: openedSession.sessionPath } : {}),
				kind: entry.kind,
				cwd: entry.cwd,
				context: entry.context,
			});
			host.writer.status.publish(openedSession.sessionId, "open", "client");
		}
		if (!host.draining && owner !== undefined && host.releasedConnections.has(owner)) {
			releaseOwnerAttachment(host, owner, openedSession.sessionId);
			await releaseOwnedSession(host, openedSession.sessionId);
		}
		const replyState =
			entry.worker?.snapshot?.state ?? (entry.runtime ? buildRpcSessionState(entry.runtime.session) : undefined);
		if (!replyState) throw new Error("Session state was not created");
		if (options?.reply !== false)
			host.writer.enqueue(opened.sessionId, {
				id: command.id,
				type: "response",
				command: "open_session",
				success: true,
				data: {
					sessionId: opened.sessionId,
					state: replyState,
					...(opened.attached ? { attached: true } : {}),
				},
			});
		return undefined;
	} catch (cause) {
		if (opened) {
			// Only a non-attached open published session_opened and an open status before this
			// rollback, and only while the registry still holds the live entry, so only that
			// rollback owes its subscribers the terminal record; an attach rollback, or one whose
			// entry is already gone, never announced the session in the first place (#3198 review, L1).
			if (!opened.attached) {
				const entry = host.registry.peek(opened.sessionId);
				if (entry?.runtime !== undefined || entry?.worker !== undefined)
					host.writer.sealRolledBackOpen(opened.sessionId, entry.sessionPath);
			}
			try {
				if (opened.attached) await releaseOwnedSession(host, opened.sessionId);
				else await host.registry.close(opened.sessionId);
			} catch {
				/* The open rollback has already removed the entry. */
			}
			host.writer.forgetSession(opened.sessionId);
		}
		return error(command.id, "open_session", code(cause), detail(cause));
	}
}
