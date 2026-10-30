import { clearHandoverParkedSession } from "./host-handover-parked.ts";

import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_UNKNOWN_SESSION } from "./rpc-types.ts";

import type { RpcSessionBinding } from "./session-binding.ts";

import { forgetSessionOwnership, releaseOwnerAttachment } from "./session-router-attachments.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, error } from "./session-router-errors.ts";
import { stopSweep } from "./session-router-occupancy.ts";
import type { CloseClaimOptions } from "./session-router-types.ts";

/**
 * Releases one attachment (or every attachment when draining) and reports
 * whether this caller became the finalizer. The join token is installed inside
 * the registry callback, before any await, so a close that lands between the
 * claim and finalizeClose() always finds a token to wait on instead of
 * answering ahead of the terminal records.
 */
export function claimClose(host: RouterContext, sessionId: string, options: CloseClaimOptions): { finalizer: boolean } {
	let finalizer = true;
	const onRole = (isFinalizer: boolean): void => {
		finalizer = isFinalizer;
		if (isFinalizer && !host.finalizations.has(sessionId)) host.finalizations.set(sessionId, createFinalization());
	};
	let entry = host.registry.beginClose(sessionId, onRole, { detach: options.detach });
	while (options.drainAttachments && entry.state === "open") entry = host.registry.beginClose(sessionId, onRole);
	return { finalizer: finalizer && entry.state === "closing" };
}

/** claimClose() for lifecycle paths that treat a lost race as "nothing to do". */
export function tryClaimClose(
	host: RouterContext,
	sessionId: string,
	options: CloseClaimOptions,
): { finalizer: boolean } | undefined {
	try {
		return claimClose(host, sessionId, options);
	} catch {
		return undefined;
	}
}

export async function close(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "close_session" }>,
): Promise<RpcResponse | undefined> {
	const response = {
		id: command.id,
		type: "response" as const,
		command: "close_session" as const,
		success: true as const,
		data: {},
	};
	// A close releases the CALLER's attachment, and routing handles are public on a
	// shared host (`list_sessions` publishes every one of them), so ownership - not
	// knowledge of the handle - authorizes it: a connection that never attached holds
	// no attachment, and answering it would release another client's claim and could
	// tear down a session it never opened. A host with no per-connection identity
	// (stdio) has no ownership to check and keeps answering every close as before.
	const owner = host.writer.currentConnection();
	if (owner !== undefined && host.sessionsByConnection.get(owner)?.has(command.sessionId) !== true)
		return error(command.id, "close_session", RPC_ERROR_UNKNOWN_SESSION);
	const reply = host.writer.reserveCloseResponse(command.sessionId, response);
	if (!reply) return undefined;
	// Admission and claiming are synchronous, before any teardown await. A
	// saturated requester neither releases an attachment nor joins a promise.
	let claim: { finalizer: boolean };
	try {
		claim = claimClose(host, command.sessionId, { drainAttachments: false });
	} catch (cause) {
		reply.release();
		return error(command.id, "close_session", code(cause));
	}
	try {
		if (owner !== undefined) releaseOwnerAttachment(host, owner, command.sessionId);
		if (claim.finalizer) {
			// An explicit close ends the session for good: drop any handover-parked record entry, or
			// the session would come back on the next host start (MEDIUM-1, senpi#3282 review).
			const entry = host.registry.peek(command.sessionId);
			if (host.handoverParkedDir !== undefined && entry?.sessionPath !== undefined)
				await clearHandoverParkedSession(host.handoverParkedDir, entry.sessionPath).catch(() => {});
			await finalizeClose(host, command.sessionId, host.bindings.get(command.sessionId), () =>
				reply.complete(true, "client_close"),
			);
		} else {
			host.writer.status.publish(command.sessionId, "detach", "client");
			await host.finalizations.get(command.sessionId)?.promise;
			reply.complete(false);
		}
		return undefined;
	} finally {
		reply.release();
	}
}

/**
 * Runs the finalizer side of a close for a handle whose beginClose() made this
 * caller the owner: dispose the binding, complete the registry teardown, emit
 * the terminal records, then release joiners. Every step is guarded so the join
 * token always resolves and a failing binding yields one logged line, never a
 * second response or an escaped rejection.
 */
export async function finalizeClose(
	host: RouterContext,
	sessionId: string,
	binding: RpcSessionBinding | undefined,
	terminal?: () => void,
): Promise<void> {
	const finalization = host.finalizations.get(sessionId) ?? createFinalization();
	host.finalizations.set(sessionId, finalization);
	try {
		try {
			await binding?.dispose();
		} catch (cause) {
			process.stderr.write(`senpi rpc binding dispose for session ${sessionId} failed: ${String(cause)}\n`);
		}
		host.bindings.delete(sessionId);
		try {
			await host.registry.closeMarked(sessionId);
		} catch (cause) {
			process.stderr.write(`senpi rpc close for session ${sessionId} failed: ${String(cause)}\n`);
		}
		// closeMarked may return at the grace deadline while ownership remains;
		// terminal records must still observe the exit callback's registry removal.
		await host.registry.peek(sessionId)?.closeCompletion;
		terminal?.();
	} finally {
		finalization.resolve();
		host.finalizations.delete(sessionId);
	}
}

export function createFinalization(): { promise: Promise<void>; resolve: () => void } {
	let resolveFinalization: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolveFinalization = resolve;
	});
	return { promise, resolve: () => resolveFinalization?.() };
}

/**
 * The park teardown of `evictIdleSession`, claimed synchronously and sealed as released: every
 * attachment is drained, the runtime disposed and the path reservation freed before this resolves.
 */
export async function tearDownReleased(host: RouterContext, sessionId: string, sessionPath: string): Promise<boolean> {
	const claim = tryClaimClose(host, sessionId, { drainAttachments: true });
	if (!claim) return false;
	const binding = host.bindings.get(sessionId);
	binding?.cancelPendingExtensionUiRequests?.();
	forgetSessionOwnership(host, sessionId);
	if (claim.finalizer)
		await finalizeClose(host, sessionId, binding, () => host.writer.releaseSession(sessionId, sessionPath));
	else await host.finalizations.get(sessionId)?.promise;
	host.writer.forgetSession(sessionId);
	return true;
}

/** The idle park on request: every attachment drained, sealed `session_parked { reason: "unloaded" }`. */
export async function tearDownUnloaded(host: RouterContext, sessionId: string, sessionPath: string): Promise<boolean> {
	const claim = tryClaimClose(host, sessionId, { drainAttachments: true });
	if (!claim) return false;
	const binding = host.bindings.get(sessionId);
	binding?.cancelPendingExtensionUiRequests?.();
	forgetSessionOwnership(host, sessionId);
	if (claim.finalizer)
		await finalizeClose(host, sessionId, binding, () => host.writer.parkSession(sessionId, sessionPath, "unloaded"));
	else await host.finalizations.get(sessionId)?.promise;
	host.writer.forgetSession(sessionId);
	return true;
}

export async function dispose(host: RouterContext): Promise<void> {
	host.stopLimitBroadcast();
	host.drainExitRequested = true;
	stopSweep(host);
	if (host.drainTimer !== undefined) clearInterval(host.drainTimer);
	await Promise.all(
		[...host.bindings.entries()].map(async ([sessionId, binding]) => {
			const claim = tryClaimClose(host, sessionId, { drainAttachments: true });
			if (!claim) return;
			if (claim.finalizer) {
				await finalizeClose(host, sessionId, binding, () =>
					host.writer.closeSession(
						sessionId,
						{ type: "response", command: "close_session", success: true, data: {} },
						"host_shutdown",
					),
				);
			} else await host.finalizations.get(sessionId)?.promise;
			host.writer.forgetSession(sessionId);
		}),
	);
	host.bindings.clear();
	host.uninstallEffectSink?.();
	host.uninstallEffectSink = undefined;
}
