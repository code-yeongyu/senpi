/**
 * `attach_session { takeover: true, holder }` on a machine-owned host (R21; S37): opening a session elsewhere takes it
 * over. The takeover is recorded durably first; then the caller attaches and every other connection's holds on the
 * session are released with one `session_released { reason: "taken_over" }` record and no error. The session and its
 * running turn go on untouched, and the host's other sessions are not touched at all.
 *
 * Only the ledger commit is awaited before the host's shared state is read. Everything after it (the re-checks, the
 * caller's attach, the removal of every other connection's holds) runs without a gap, so a disconnect, a
 * `release_attachment`, a drain or a second takeover that lands during the notices and the deferred releases finds
 * those holds already gone and cannot release one twice.
 */
import type { RpcAttachmentCommand } from "./attachment-types.ts";
import type { AttachHolder } from "./attach-ledger.ts";
import type { RpcResponse, RpcSessionReleasedEvent } from "./rpc-types.ts";
import { releaseDisconnectAttachment, releaseOwnerAttachment } from "./session-router-attachments.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";

type TakeoverCommand = Extract<RpcAttachmentCommand, { type: "attach_session" }>;

function afterCommitRefusal(host: RouterContext, command: TakeoverCommand, owner: string): RpcResponse | undefined {
	if (host.draining || host.drainExitRequested)
		return error(command.id, command.type, "session_busy_lifecycle", { reason: "host_draining" });
	if (!host.writer.hasConnection(owner) || host.releasedConnections.has(owner))
		return error(command.id, command.type, "session_not_attached", { reason: "no_connection" });
	if (host.registry.peek(command.sessionId)?.state !== "open" || !host.bindings.has(command.sessionId))
		return error(command.id, command.type, "unknown_session", {});
	return undefined;
}

function takeOtherHolds(host: RouterContext, sessionId: string, owner: string): readonly [string, number][] {
	const taken: [string, number][] = [];
	for (const [connection, owned] of [...host.sessionsByConnection]) {
		const holds = connection === owner ? 0 : (owned.get(sessionId) ?? 0);
		for (let hold = 0; hold < holds; hold++) releaseOwnerAttachment(host, connection, sessionId);
		if (holds > 0) taken.push([connection, holds]);
	}
	return taken;
}

/** Refuses on any other host; else records the takeover, runs `attach` for the caller, and lets the others go. */
export async function takeOver(
	host: RouterContext,
	command: TakeoverCommand,
	owner: string,
	attach: () => void,
): Promise<RpcResponse> {
	const ledger = host.defaults.sessionTakeover;
	if (host.defaults.sessionOwner !== "machine" || ledger === undefined)
		return error(command.id, command.type, "takeover_unsupported", {
			reason: "only a headless engine with a takeover ledger takes sessions over",
		});
	if (typeof command.holder !== "string" || command.holder.length === 0)
		return error(command.id, command.type, "takeover_holder_required", {});
	let record: AttachHolder;
	try {
		record = await ledger.takeOver(command.durableSessionId, command.holder);
	} catch (cause) {
		return error(command.id, command.type, "takeover_failed", {
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
	const refused = afterCommitRefusal(host, command, owner);
	if (refused !== undefined) return refused;
	try {
		attach();
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause) ?? {});
	}
	const taken = takeOtherHolds(host, command.sessionId, owner);
	const released: RpcSessionReleasedEvent = {
		type: "session_released",
		sessionId: command.sessionId,
		reason: "taken_over",
	};
	for (const [connection, holds] of taken) {
		if (host.writer.hasConnection(connection)) await host.writer.enqueueControl(released, connection);
		for (let hold = 0; hold < holds; hold++) await releaseDisconnectAttachment(host, command.sessionId);
	}
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: true,
		data: {
			sessionId: command.sessionId,
			attached: true,
			holder: record.holder,
			generation: record.generation,
			released: taken.length,
		},
	};
}
