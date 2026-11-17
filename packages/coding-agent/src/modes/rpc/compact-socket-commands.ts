import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { commandAuthority } from "./command-authority.ts";
import { CONNECTION_ROLE_FIXED, DELEGATION_INCARNATION_STALE, roleConnection } from "./connection-roles.ts";
import { remoteOriginDeclaration } from "./remote-origin.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

function staleError(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message, errorCode: "delegation_incarnation_stale" };
}

/** Validate the full declaration before committing role, media, recovery or pending state. */
export function declareSocketClient(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "set_client_info" }>,
): RpcResponse {
	const peer = host.writer.currentConnection();
	const selection = peer === undefined ? undefined : host.writer.compactSelection(peer);
	const connection = roleConnection(peer);
	// omo-relay-daemon#307 (v5 review H1): the stale check runs first and touches nothing, so a declaration captured before
	// a `detach_connection` can never reach `CompactSelection.declare`, whose role refusal can mark the selection refused.
	const incarnation = commandAuthority.getStore()?.incarnation;
	if (host.connectionRoles.isStale(connection, incarnation))
		return staleError(command.id, command.type, DELEGATION_INCARNATION_STALE);
	const role = (caps: readonly string[]) => host.connectionRoles.declare(connection, caps, incarnation) === "declared";
	const origin = remoteOriginDeclaration(command.remoteOrigin, (declared) =>
		host.connectionRoles.acceptsOrigin(roleConnection(peer), declared),
	);
	if ("refusal" in origin) return error(command.id, command.type, origin.refusal);
	const reason = selection
		? selection.declare(command.capabilities, host.registry.supportsCompact?.() === true, role)
		: command.capabilities !== undefined && !role(command.capabilities)
			? "connection_role_fixed"
			: undefined;
	if (reason)
		return error(command.id, command.type, reason === "connection_role_fixed" ? CONNECTION_ROLE_FIXED : reason);
	// Before the capability commit: its recheck must already see a background presenter that now speaks for a remote device.
	if (origin.origin !== undefined) host.connectionRoles.declareOrigin(roleConnection(peer), origin.origin);
	if (peer !== undefined) {
		// RULING-111 (LEAK-B): with the flag off a declaration without capabilities resets them, exactly as on main.
		const caps = compactUpdatesEnabled()
			? (selection?.capabilities ?? command.capabilities ?? host.pendingCapabilities.get(peer) ?? [])
			: (command.capabilities ?? []);
		host.pendingCapabilities.set(peer, [...caps]);
		host.writer.setConnectionCapabilities(peer, caps);
	} else if (command.capabilities !== undefined) host.writer.setSoleSecretCapabilities(command.capabilities);
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
