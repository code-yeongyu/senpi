import { takeOver } from "./attach-takeover.ts";
import { compactOpen } from "./compact-open-admission.ts";
import { attachAnswerer } from "./prompt-answerer-gate.ts";
import { EXTENSION_EVENTS_CAPABILITY } from "./custom-capability.ts";
import type { RpcAttachmentCommand } from "./attachment-types.ts";
import { clearRetainedRecord } from "./session-router-residency.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";
import { recordAttachment, releaseDisconnectAttachment, releaseOwnerAttachment } from "./session-router-attachments.ts";
import { claimClose, finalizeClose } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";
import { connectionLeft } from "./session-router-relocation.ts";
import {
	declareTelemetry,
	RPC_ERROR_INVALID_TELEMETRY_CONSENT,
	telemetryUnconfirmed,
} from "./session-router-telemetry.ts";
import { sessionTelemetryError } from "./rpc-input-validation.ts";
import { RpcSessionRegistryError } from "./session-registry-types.ts";

function identityMatches(
	host: RouterContext,
	entry: RpcSessionEntry,
	durableSessionId: string,
	expectedHostInstance?: string,
): boolean {
	const durable =
		entry.runtime?.session.sessionId ?? entry.worker?.snapshot?.state.sessionId ?? entry.durableSessionId;
	return (
		typeof durableSessionId === "string" &&
		durableSessionId.length > 0 &&
		durableSessionId === durable &&
		(expectedHostInstance === undefined ||
			expectedHostInstance === (host.defaults.hostContext?.host_instance ?? hostInstanceId()))
	);
}

/** One test for every attachment command: a host that drains or is stopping owns every outstanding hold. */
function hostStopping(host: RouterContext): boolean {
	return host.draining || host.drainExitRequested;
}

/** Wire contract v1.1: a draining or stopping host refuses attachment before admission with a v1 code. */
function drainingRefusal(
	host: RouterContext,
	command: Extract<RpcAttachmentCommand, { type: "attach_session" | "reclaim_session" }>,
): RpcResponse | undefined {
	if (
		!hostStopping(host) ||
		(command.type === "attach_session" &&
			host.writer.currentConnection()?.startsWith("generation-route-") &&
			command.expectedHostInstance !== undefined)
	)
		return undefined;
	return error(command.id, command.type, "session_busy_lifecycle", { reason: "host_draining" });
}

/** Synchronous ownership admission shared by ordinary attach and atomic reclaim. */
function attach(host: RouterContext, owner: string, sessionId: string): void {
	if (!host.registry.attachSession) throw new Error("live attachment is unavailable");
	host.registry.attachSession(sessionId);
	recordAttachment(host, owner, sessionId);
	host.writer.status.publish(sessionId, "attach", "client");
}

/**
 * An attach joins a running session, so no subscription replay reaches it: a connection that takes extension events
 * gets the session's current extension state for itself. Called once its attach baseline is on its queue.
 */
function replayState(host: RouterContext, owner: string, sessionId: string): void {
	if (!host.writer.getConnectionCapabilities(owner)?.includes(EXTENSION_EVENTS_CAPABILITY)) return;
	host.bindings
		.get(sessionId)
		?.replayExtensionEvents?.((record) => host.writer.enqueueForAttachment(sessionId, owner, record));
}

function attachWithState(host: RouterContext, owner: string, sessionId: string): void {
	attach(host, owner, sessionId);
	replayState(host, owner, sessionId);
}

/**
 * The attaching caller's telemetry answer (senpi#7446), confirmed by the session before the attach is reported. An
 * answer the session did not confirm undoes the attach: the caller never holds a session whose policy it cannot prove.
 */
async function confirmAttachTelemetry(
	host: RouterContext,
	owner: string,
	command: Extract<RpcAttachmentCommand, { type: "attach_session" }>,
): Promise<RpcResponse | undefined> {
	const outcome = await declareTelemetry(host, command.sessionId, owner, command.telemetry?.consent, "attach");
	if (outcome === "confirmed") return undefined;
	releaseOwnerAttachment(host, owner, command.sessionId);
	await releaseDisconnectAttachment(host, command.sessionId);
	return telemetryUnconfirmed(command.id, command.type, command.sessionId, outcome);
}

export function attachSession(
	host: RouterContext,
	command: Extract<RpcAttachmentCommand, { type: "attach_session" }>,
): RpcResponse | Promise<RpcResponse | undefined> {
	const draining = drainingRefusal(host, command);
	if (draining) return draining;
	const telemetryError = sessionTelemetryError(command.telemetry);
	if (telemetryError)
		return error(command.id, command.type, RPC_ERROR_INVALID_TELEMETRY_CONSENT, { reason: telemetryError });
	const entry = host.registry.peek(command.sessionId);
	if (entry?.state !== "open" || !host.bindings.has(command.sessionId))
		return error(command.id, command.type, "unknown_session", {});
	if (!identityMatches(host, entry, command.durableSessionId, command.expectedHostInstance))
		return error(command.id, command.type, "session_identity_mismatch", {});
	const owner = host.writer.currentConnection();
	if (owner === undefined) return error(command.id, command.type, "session_not_attached", { reason: "no_connection" });
	const answerer = () => attachAnswerer(host, owner, command.sessionId, command.answerKey);
	if (command.takeover === true)
		return takeOver(host, command, owner, () => attachWithState(host, owner, command.sessionId)).then(
			async (reply) => {
				if (!reply.success) return reply;
				const unconfirmed = await confirmAttachTelemetry(host, owner, command);
				if (unconfirmed !== undefined) return unconfirmed;
				return reply.command === "attach_session" ? { ...reply, data: { ...reply.data, ...answerer() } } : reply;
			},
		);
	if (command.admissionId !== undefined && host.admissions) {
		let admitted = false;
		return compactOpen(host, command, async (accept, signal) => {
			signal.throwIfAborted();
			attach(host, owner, command.sessionId);
			const unconfirmed = await confirmAttachTelemetry(host, owner, command);
			if (unconfirmed !== undefined) throw new RpcSessionRegistryError("telemetry_update_unconfirmed");
			answerer();
			try {
				await accept({ sessionId: command.sessionId, durableSessionId: command.durableSessionId, attached: true });
			} catch (cause) {
				releaseOwnerAttachment(host, owner, command.sessionId);
				await releaseDisconnectAttachment(host, command.sessionId);
				throw cause;
			}
			admitted = true;
			return undefined;
		}).then((response) => {
			// The admission's baseline and answer are on the queue only once compactOpen returns.
			if (admitted && host.sessionsByConnection.get(owner)?.has(command.sessionId))
				replayState(host, owner, command.sessionId);
			return response;
		});
	}
	try {
		attachWithState(host, owner, command.sessionId);
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause) ?? {});
	}
	return confirmAttachTelemetry(host, owner, command).then(
		(unconfirmed): RpcResponse =>
			unconfirmed ?? {
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: { sessionId: command.sessionId, attached: true, ...answerer() },
			},
	);
}

export async function releaseAttachment(
	host: RouterContext,
	command: Extract<RpcAttachmentCommand, { type: "release_attachment" }>,
): Promise<RpcResponse> {
	const owner = host.writer.currentConnection();
	if (owner === undefined || !host.sessionsByConnection.get(owner)?.has(command.sessionId))
		return error(command.id, command.type, "session_not_attached", { reason: "not_attached" });
	releaseOwnerAttachment(host, owner, command.sessionId);
	// The drain owns every outstanding physical hold until its park; never preempt it.
	const deferred = !hostStopping(host) && (await releaseDisconnectAttachment(host, command.sessionId));
	return { id: command.id, type: "response", command: command.type, success: true, data: { deferred } };
}

export async function reclaimSession(
	host: RouterContext,
	command: Extract<RpcAttachmentCommand, { type: "reclaim_session" }>,
): Promise<RpcResponse> {
	const draining = drainingRefusal(host, command);
	if (draining) return draining;
	if (typeof command.sessionPath !== "string" || command.sessionPath.length === 0)
		return error(command.id, command.type, "unknown_session", {});
	const key = canonicalSessionPath(command.sessionPath);
	const row = host.registry
		.list()
		.find((candidate) => candidate.sessionPath !== undefined && canonicalSessionPath(candidate.sessionPath) === key);
	const entry = row && host.registry.peek(row.sessionId);
	if (!row || !entry) return error(command.id, command.type, "unknown_session", {});
	if (entry.state !== "open" || !host.bindings.has(row.sessionId))
		return error(command.id, command.type, "session_busy_lifecycle", {});
	if (
		typeof command.expectedHostInstance !== "string" ||
		!identityMatches(host, entry, command.durableSessionId, command.expectedHostInstance)
	)
		return error(command.id, command.type, "session_identity_mismatch", {});
	const owner = host.writer.currentConnection();
	if (owner === undefined) return error(command.id, command.type, "session_not_attached", { reason: "no_connection" });
	const own = host.sessionsByConnection.get(owner)?.get(row.sessionId) ?? 0;
	const elsewhere = Math.max(0, entry.attachments - own);
	if (elsewhere > 0) return error(command.id, command.type, "attached_elsewhere", { attachments: elsewhere });
	// No await between admission, the visible attach, and the claim of ALL caller holds.
	attach(host, owner, row.sessionId);
	const claim = claimClose(host, row.sessionId, { drainAttachments: true });
	host.sessionsByConnection.get(owner)?.delete(row.sessionId);
	if (host.sessionsByConnection.get(owner)?.size === 0) host.sessionsByConnection.delete(owner);
	connectionLeft(host, row.sessionId, owner);
	if (host.handoverParkedDir !== undefined) await clearRetainedRecord(host, entry);
	if (claim.finalizer) {
		const binding = host.bindings.get(row.sessionId);
		binding?.cancelPendingExtensionUiRequests?.();
		await finalizeClose(host, row.sessionId, binding, () =>
			host.writer.sealLifecycle(
				row.sessionId,
				{ type: "session_closed", sessionId: row.sessionId, reason: "client_close" },
				true,
			),
		);
	}
	host.writer.detachConnectionFromSession(owner, row.sessionId);
	host.writer.forgetSession(row.sessionId);
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: true,
		data: { reclaimed: true, sessionId: row.sessionId },
	};
}
