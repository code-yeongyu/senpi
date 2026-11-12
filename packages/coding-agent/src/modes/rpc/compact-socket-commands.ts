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

type SetClientInfo = Extract<RpcCommand, { type: "set_client_info" }>;

/**
 * senpi#6443: a client that names itself is one client on every connection it opens, for the holds a refusal counts.
 * The name is kept only once its declaration was accepted, never before: a refused one changes nothing. A declaration
 * that ends at the host is kept here; one that goes on to its session is kept by that session, through its
 * client-info port, when it accepts it. A later declaration without a name keeps the one this incarnation declared.
 */
function keepClientId(host: RouterContext, command: SetClientInfo): void {
	const peer = host.writer.currentConnection();
	if (peer !== undefined && command.client_id !== undefined) host.clientIds.set(peer, command.client_id);
}

/** Validate the full declaration before committing role, media, recovery or pending state. */
function declareSocketClient(
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

/** A declaration with no `sessionId` ends at the host: it is answered here, and its name is kept only when accepted. */
export function declareSessionless(host: RouterContext, command: SetClientInfo): RpcResponse | undefined {
	// Flag on and no id: `preDeclare` already accepted this declaration, and nothing is answered.
	const reply = command.id === undefined && compactUpdatesEnabled() ? undefined : declareSocketClient(host, command);
	if (reply === undefined || reply.success) keepClientId(host, command);
	return reply;
}

/**
 * Flag on: the host-side pre-declaration of every `set_client_info` (RULING-111). Answers the refusal, `"done"` when the
 * declaration ends here with nothing to answer (no id and no capabilities; its name is kept), or the command to route on.
 */
export function preDeclare(host: RouterContext, command: SetClientInfo): RpcResponse | SetClientInfo | "done" {
	const reply = declareSocketClient(host, command);
	if (!reply.success) return reply;
	const peer = host.writer.currentConnection();
	const next =
		command.capabilities !== undefined && peer !== undefined
			? { ...command, capabilities: [...(host.pendingCapabilities.get(peer) ?? [])] }
			: command;
	if (next.id !== undefined || next.capabilities !== undefined) return next;
	keepClientId(host, next);
	return "done";
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
