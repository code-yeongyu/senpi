/**
 * Who a terminal control connection speaks for, and what it delivers (senpi#6294). `set_client_info` declares the
 * connection's roles and, as on the RPC host, the remote device it speaks for (`remoteOrigin`, fixed once declared);
 * `admit_external_message` runs the RPC host's one implementation (`admit-external-message-command.ts`) on this
 * terminal's session, with the device taken from the connection, never from the record.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { admitExternalMessage } from "../rpc/admit-external-message-command.ts";
import type { RpcAdmitExternalMessageCommand } from "../rpc/admit-external-message-wire.ts";
import { CONNECTION_ROLE_FIXED } from "../rpc/connection-roles.ts";
import { remoteOriginDeclaration } from "../rpc/remote-origin.ts";
import { type ControlAttachments, keyOf } from "./session-control-attach.ts";
import { type ControlCommand, type ControlConnection, failure, success } from "./session-control-server.ts";

export function setClientInfo(
	attachments: ControlAttachments,
	connection: ControlConnection,
	command: ControlCommand,
): object {
	const key = keyOf(connection);
	const origin = remoteOriginDeclaration(command.remoteOrigin, (declared) =>
		attachments.roles.acceptsOrigin(key, declared),
	);
	if ("refusal" in origin) return failure(command.id, "set_client_info", origin.refusal);
	const capabilities = command.capabilities;
	if (capabilities !== undefined) {
		if (!Array.isArray(capabilities) || !capabilities.every((entry): entry is string => typeof entry === "string"))
			return failure(command.id, "set_client_info", "capabilities must be an array of strings");
		if (attachments.roles.declare(key, capabilities) !== "declared")
			return failure(command.id, "set_client_info", CONNECTION_ROLE_FIXED);
		attachments.presenters?.declare(key, capabilities);
	}
	if (origin.origin !== undefined) attachments.roles.declareOrigin(key, origin.origin);
	return success(command.id, "set_client_info");
}

export function admitTerminalDelivery(
	session: AgentSession,
	attachments: ControlAttachments,
	connection: ControlConnection,
	command: RpcAdmitExternalMessageCommand,
): object {
	const key = keyOf(connection);
	const answer = admitExternalMessage(session, command, {
		origin: attachments.roles.originOf(key),
		connectionOrigin: attachments.roles.isDelegated(key) ? "delegated" : "local",
	});
	const { id } = command;
	if (answer.ok) return success(id, command.type, answer.data);
	const { refusal } = answer;
	return {
		...failure(id, command.type, refusal.message),
		errorCode: refusal.errorCode,
		...("errorData" in refusal && refusal.errorData !== undefined ? { errorData: refusal.errorData } : {}),
	};
}
