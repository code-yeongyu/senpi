import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { CONNECTION_ROLE_FIXED, roleConnection } from "./connection-roles.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** Validate the full declaration before committing role, media, recovery or pending state. */
export function declareSocketClient(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "set_client_info" }>,
): RpcResponse {
	const peer = host.writer.currentConnection();
	const selection = peer === undefined ? undefined : host.writer.compactSelection(peer);
	const role = (caps: readonly string[]) => host.connectionRoles.declare(roleConnection(peer), caps);
	const reason = selection
		? selection.declare(command.capabilities, host.registry.supportsCompact?.() === true, role)
		: command.capabilities !== undefined && !role(command.capabilities)
			? "connection_role_fixed"
			: undefined;
	if (reason)
		return error(command.id, command.type, reason === "connection_role_fixed" ? CONNECTION_ROLE_FIXED : reason);
	if (peer !== undefined) {
		const caps = selection?.capabilities ?? command.capabilities ?? host.pendingCapabilities.get(peer) ?? [];
		host.pendingCapabilities.set(peer, [...caps]);
		host.writer.setConnectionCapabilities(peer, caps);
	}
	return {
		id: command.id,
		type: "response",
		command: "set_client_info",
		success: true,
		...(selection?.ack() ? { data: selection.ack() } : {}),
	};
}

/** Format freezes before record-producing admission; status-only observation does not select a format. */
export function compactAdmissionGate(host: RouterContext, command: RpcCommand): RpcResponse | undefined {
	if (!compactUpdatesEnabled()) return undefined;
	const peer = host.writer.currentConnection();
	const selection = peer === undefined ? undefined : host.writer.compactSelection(peer);
	const content =
		command.type === "open_session" ||
		command.type === "attach_session" ||
		command.type === "reclaim_session" ||
		command.type === "reset_stream" ||
		(command.type === "subscribe_sessions" &&
			(command.admissionId !== undefined || (command.mirror !== undefined && command.mirror !== "none")));
	if (!content) return undefined;
	const refuse = (reason: string) => error(command.id, command.type, reason);
	if (selection?.refused) return refuse("compact_selection_refused");
	if (command.admissionId !== undefined && !selection?.selected) return refuse("compact_not_negotiated");
	if (selection?.selected) {
		if (
			(command.type === "open_session" ||
				command.type === "attach_session" ||
				command.type === "subscribe_sessions") &&
			command.admissionId === undefined
		)
			return refuse("compact_admission_required");
		if (command.type === "open_session" && host.registry.supportsCompact?.({ ...host.defaults, ...command }) !== true)
			return refuse("compact_endpoint_unsupported");
		if (command.type === "attach_session" && !host.writer.recoveryLane(command.sessionId))
			return refuse("compact_endpoint_unsupported");
		if (
			command.type === "subscribe_sessions" &&
			host.registry.list().some((row) => row.status === "open" && !host.writer.recoveryLane(row.sessionId))
		)
			return refuse("compact_endpoint_unsupported");
	}
	if (selection) selection.admitted = true;
	return undefined;
}
