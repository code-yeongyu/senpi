import { stat } from "node:fs/promises";
import { RETRY_ROUTED_OPEN } from "./predecessor-routes.ts";
import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { startOpenTimer } from "../../core/open-timing.ts";
import { compactOpen, type OpenAcceptance } from "./compact-open-admission.ts";
import { CompactAdmissionError } from "./compact-admission-error.ts";
import { runAdmissionProducer } from "./compact-admission-producer.ts";

import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import { parkedOpenCommand } from "./host-handover-parked-open.ts";

import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

import { sessionHeldCheck } from "./session-held.ts";
import type { OpenRpcSession } from "./session-registry.ts";
import { releaseOwnedSession, releaseOwnerAttachment } from "./session-router-attachments.ts";
import { installOpenBinding } from "./session-router-open-binding.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";
import { openSessionFolder } from "./open-session-folder.ts";
import { invalidSpawnedBy, validatedOpenProfile } from "./session-router-open-profile.ts";
import { holdOpenConnection, type OpenReplyAs, ownOpen, publishOpen, replyOpen } from "./session-router-open-result.ts";
import { syncRetainedRecord } from "./session-router-residency.ts";
import { declareTelemetry } from "./session-router-telemetry.ts";
import { liveToolMediaScope, toolMediaPersister } from "./tool-media-store.ts";
import { RpcSessionRegistryError } from "./session-registry-types.ts";

export function openWithBarrier(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "open_session" }>,
	replyAs?: OpenReplyAs,
): Promise<RpcResponse | undefined> {
	if (compactUpdatesEnabled() && command.admissionId !== undefined)
		return compactOpen(host, command, (accept, signal) => openPhysicalWithBarrier(host, command, accept, signal));
	return openPhysicalWithBarrier(host, command, undefined, undefined, replyAs);
}

function openPhysicalWithBarrier(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "open_session" }>,
	accept?: OpenAcceptance,
	signal?: AbortSignal,
	replyAs?: OpenReplyAs,
): Promise<RpcResponse | undefined> {
	const owner = host.writer.currentConnection();
	if (owner === undefined) return open(host, command, undefined, { replyAs });
	// Every open already accepted anywhere on this host, not just on this connection: the
	// in-process runtime serves them on ONE loop, so the wait this caller faces is the total.
	let inFlight = 0;
	for (const pending of host.opensByConnection.values()) inFlight += pending.size;
	const releaseBarrier = holdOpenConnection(host, owner);
	// Before the open reaches the loop: a client that later hits its deadline can then say
	// where it was queued instead of reporting a bare timeout (senpi#1844).
	if (command.id !== undefined)
		host.writer.sendOpenQueued(owner, {
			type: "queued",
			for_request: command.id,
			position: inFlight + 1,
			in_flight: inFlight,
		});
	const start = () => open(host, command, owner, accept === undefined ? { replyAs } : { accept, signal });
	// A late open's physical session is released by its admission (the accept/rollback path, 4272-admission-
	// abandonment), so the late response itself owns nothing to release here.
	const opened = signal === undefined ? start() : runAdmissionProducer(signal, start, async () => {});
	return opened.finally(releaseBarrier);
}

/**
 * The successor's reopen of a handoff-parked session: the same open as an `open_session`, with no
 * requesting connection and nothing to reply to (senpi#3368). Resolves `undefined` on success and
 * the failure response otherwise, exactly as an open does. A session that was live when its host ended
 * continues as that host left it (senpi#7020); any other park reopens unattended, holding automatic turns.
 */
export function reopenParked(host: RouterContext, entry: HandoverParkedEntry): Promise<RpcResponse | undefined> {
	const command = parkedOpenCommand(entry);
	return open(host, entry.live === true ? command : { ...command, attended: false }, undefined, {
		reply: false,
		defaults: false,
		contextOverlay: entry.contextOverlay,
		unattached: true,
		...(entry.live === true ? { continued: true } : {}),
	});
}

export async function open(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "open_session" }>,
	owner?: string,
	options?: {
		readonly reply?: boolean;
		readonly accept?: OpenAcceptance;
		readonly signal?: AbortSignal;
		readonly defaults?: boolean;
		readonly contextOverlay?: HandoverParkedEntry["contextOverlay"];
		/** The reply is another command's answer: see `OpenReplyAs`. */
		readonly replyAs?: OpenReplyAs;
		/** An invisible speculative open, published only when its ledger hands it to a caller. */
		readonly park?: (opened: OpenRpcSession) => void;
		/** A successor's reopen of a session that was live on its predecessor; never set from the wire. */
		readonly continued?: boolean;
		/** No connection asked for this open: it counts no attachment (the successor's restore). */
		readonly unattached?: boolean;
		/** When this open first waited for a routed session to change generations (senpi#7098). */
		readonly routedSince?: number;
	},
): Promise<RpcResponse | undefined> {
	const validated = validatedOpenProfile(host, command, options);
	if ("type" in validated) return validated;
	let opened: OpenRpcSession | undefined;
	const timer = startOpenTimer(`host-open:${command.id ?? "-"}`);
	const assertSessionNotHeld = sessionHeldCheck(
		(observedStarts) => host.registry.holderPids?.(observedStarts) ?? Promise.resolve([]),
	);
	try {
		// An open that names no folder resumes a session file where its header says, not where this host runs
		// (senpi#6427). Inside the try: a file it cannot read refuses the open, and that refusal is this open's answer.
		const profile = {
			...validated,
			cwd: await openSessionFolder(command, validated.cwd),
			...(options?.continued === true ? { continued: true as const } : {}),
		};
		// A folder that exists but is a file (or a socket) is refused, typed, before anything is opened or created. A missing
		// folder, or one this host cannot stat, keeps today's answer from the registry.
		if ((await stat(profile.cwd).catch(() => undefined))?.isDirectory() === false)
			return error(command.id, "open_session", "session_cwd_not_directory", { cwd: profile.cwd });
		await assertSessionNotHeld(command.sessionPath);
		timer.mark("held_check");
		options?.signal?.throwIfAborted();
		if (invalidSpawnedBy(command)) return error(command.id, "open_session", "invalid_spawned_by");
		const ancestry = command.spawnedBy;
		opened = await host.registry.openSession(
			ancestry ? { ...profile, spawnedBy: ancestry } : profile,
			// Host lifecycle policy, deliberately outside the immutable launch profile.
			{
				routedHandle: host.routes.handleFor(command.sessionPath),
				retainOnDisconnect: command.retain_on_disconnect === true,
				attachOnly: command.expectedHostInstance !== undefined,
				...(options?.park ? { speculative: true } : {}),
				// The successor's restore has no requesting connection to own an attachment (senpi#7020).
				...(options?.unattached === true ? { unattached: true } : {}),
			},
		);
		timer.mark("registry_open");
		options?.signal?.throwIfAborted();
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
		timer.mark("held_recheck");
		host.writer.setSessionKind(openedSession.sessionId, entry.kind);
		host.writer.setSessionMedia(
			openedSession.sessionId,
			toolMediaPersister(() => liveToolMediaScope(entry)),
		);
		// The lane is bootstrapped before admission (R3.C1.1); the fanout knows it before the opener's attach freezes a cut,
		// so a lane-owned session's baseline is never read from the replay store (RULING-52).
		const lane = entry.acceptance ?? entry.worker?.acceptance;
		if (lane) host.writer.registerAcceptance(openedSession.sessionId, lane);
		if (options?.accept) await options.accept(openedSession);
		ownOpen(host, openedSession, owner, options?.accept !== undefined);
		const telemetryKind = openedSession.attached ? "attach" : "answer";
		const telemetry = await declareTelemetry(
			host,
			openedSession.sessionId,
			owner,
			command.telemetry?.consent,
			telemetryKind,
		);
		if (telemetry !== "confirmed") throw new RpcSessionRegistryError("telemetry_update_unconfirmed");
		if (!host.bindings.has(openedSession.sessionId))
			await installOpenBinding(host, openedSession, entry, owner, timer);
		options?.signal?.throwIfAborted();
		if (options?.park) {
			options.park(openedSession);
			return undefined;
		}
		publishOpen(host, openedSession, entry);
		host.routes.adopt(openedSession.sessionId);
		if (!options?.accept && !host.draining && owner !== undefined && host.releasedConnections.has(owner)) {
			releaseOwnerAttachment(host, owner, openedSession.sessionId);
			await releaseOwnedSession(host, openedSession.sessionId);
		}
		// After the open SUCCEEDS (MEDIUM-A): a failed open keeps any record entry, so a later start
		// still reopens that session.
		await syncRetainedRecord(host, openedSession.sessionId, command.sessionPath);
		if (options?.accept) {
			return undefined;
		}
		timer.mark("reply");
		replyOpen(
			host,
			opened,
			entry,
			options?.replyAs?.command ?? command,
			options?.reply !== false,
			options?.replyAs?.data,
		);
		return undefined;
	} catch (cause) {
		if (opened) {
			// Only a non-attached open published session_opened and an open status before this
			// rollback, and only while the registry still holds the live entry, so only that
			// rollback owes its subscribers the terminal record; an attach rollback, or one whose
			// entry is already gone, never announced the session in the first place (#3198 review, L1).
			if (!options?.park && !opened.attached && !options?.signal?.aborted) {
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
			if (!opened.attached || !compactUpdatesEnabled()) host.writer.forgetSession(opened.sessionId);
		}
		if (cause instanceof CompactAdmissionError) throw cause;
		if (
			!opened &&
			owner &&
			command.expectedHostInstance &&
			!host.draining &&
			!options?.accept &&
			code(cause) === "session_not_held" &&
			!owner.startsWith("generation-route-")
		) {
			const attached = await host.routes.attachPath(command, owner);
			if (attached) return attached;
		}
		if (
			!opened &&
			owner &&
			!host.draining &&
			!options?.park &&
			!options?.accept &&
			code(cause) === "session_path_in_use"
		) {
			const routed = await host.routes.open(command, owner, detail(cause));
			if (routed === RETRY_ROUTED_OPEN && host.writer.hasConnection(owner) && !host.draining) {
				// The handover between generations is bounded like a close: past the grace window the caller gets the
				// retryable refusal instead of an open that never answers.
				const routedSince = options?.routedSince ?? Date.now();
				if (Date.now() - routedSince <= host.registry.closeGraceMs)
					return open(host, command, owner, { ...options, routedSince });
				return error(command.id, "open_session", code(cause), detail(cause));
			}
			if (routed === RETRY_ROUTED_OPEN) return error(command.id, command.type, "host_draining");
			if (routed) return routed;
		}
		return error(command.id, "open_session", code(cause), detail(cause));
	}
}
