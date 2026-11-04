/**
 * `attach_session { takeover: true, holder }` on a machine-owned host (R21; S37): opening a session elsewhere takes it
 * over. The takeover is recorded durably first; then the caller attaches and every other connection's holds on the
 * session are released with one `session_released { reason: "taken_over" }` record and no error. The session and its
 * running turn go on untouched, and the host's other sessions are not touched at all.
 */
import type { RpcAttachmentCommand, RpcSessionReleasedRecord } from "./attachment-types.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { releaseDisconnectAttachment, releaseOwnerAttachment } from "./session-router-attachments.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";

type TakeoverCommand = Extract<RpcAttachmentCommand, { type: "attach_session" }>;

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
	const record = await ledger.takeOver(command.durableSessionId, command.holder);
	if (host.registry.peek(command.sessionId)?.state !== "open" || !host.bindings.has(command.sessionId))
		return error(command.id, command.type, "unknown_session", {});
	try {
		attach();
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause) ?? {});
	}
	const others = [...host.sessionsByConnection]
		.filter(([connection, owned]) => connection !== owner && owned.has(command.sessionId))
		.map(([connection, owned]) => [connection, owned.get(command.sessionId) ?? 0] as const);
	const released: RpcSessionReleasedRecord = {
		type: "session_released",
		sessionId: command.sessionId,
		reason: "taken_over",
	};
	for (const [connection, holds] of others) {
		await host.writer.enqueueControl(released, connection);
		for (let hold = 0; hold < holds; hold++) {
			releaseOwnerAttachment(host, connection, command.sessionId);
			await releaseDisconnectAttachment(host, command.sessionId);
		}
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
			released: others.length,
		},
	};
}
