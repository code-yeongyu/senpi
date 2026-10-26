import type { RpcAttachmentCommand } from "./attachment-types.ts";
import { clearHandoverParkedSession } from "./host-handover-parked.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";
import { recordAttachment, releaseDisconnectAttachment, releaseOwnerAttachment } from "./session-router-attachments.ts";
import { claimClose, finalizeClose } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";
import { connectionLeft } from "./session-router-relocation.ts";

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
	if (!hostStopping(host)) return undefined;
	return error(command.id, command.type, "session_busy_lifecycle", { reason: "host_draining" });
}

/** Synchronous ownership admission shared by ordinary attach and atomic reclaim. */
function attach(host: RouterContext, owner: string, sessionId: string): void {
	if (!host.registry.attachSession) throw new Error("live attachment is unavailable");
	host.registry.attachSession(sessionId);
	recordAttachment(host, owner, sessionId);
	host.writer.status.publish(sessionId, "attach", "client");
}

export function attachSession(
	host: RouterContext,
	command: Extract<RpcAttachmentCommand, { type: "attach_session" }>,
): RpcResponse {
	const draining = drainingRefusal(host, command);
	if (draining) return draining;
	const entry = host.registry.peek(command.sessionId);
	if (entry?.state !== "open" || !host.bindings.has(command.sessionId))
		return error(command.id, command.type, "unknown_session", {});
	if (!identityMatches(host, entry, command.durableSessionId, command.expectedHostInstance))
		return error(command.id, command.type, "session_identity_mismatch", {});
	const owner = host.writer.currentConnection();
	if (owner === undefined) return error(command.id, command.type, "session_not_attached", { reason: "no_connection" });
	try {
		attach(host, owner, command.sessionId);
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data: { sessionId: command.sessionId, attached: true },
		};
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause) ?? {});
	}
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
	if (host.handoverParkedDir !== undefined && entry.sessionPath !== undefined)
		await clearHandoverParkedSession(host.handoverParkedDir, entry.sessionPath).catch(() => {});
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
