import { CONNECTION_ROLE_FIXED, roleConnection } from "./connection-roles.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";

/**
 * Per-connection client capabilities on a shared host (omo-desktop-app#4042). A connection that never declared
 * counts as the host default. A session's binding answers with the union of the declarations of the
 * connections attached to it now, recomputed on open, attach, release, disconnect and every declaration; the
 * writer then filters each capability-gated record only for connections that declared a set: those receive it
 * when they declared that capability, and a connection that never declared receives it as before.
 */
export const CLIENT_CAPABILITIES_NOT_APPLIED =
	"client_capabilities_not_applied: a session this connection is attached to could not take the declared capabilities";

function declaredBy(host: RouterContext, connection: string): readonly string[] {
	return host.pendingCapabilities.get(connection) ?? host.connectionOptions?.capabilities ?? [];
}

function attachedConnections(host: RouterContext, sessionId: string): readonly string[] {
	return [...host.sessionsByConnection].filter(([, owned]) => owned.has(sessionId)).map(([connection]) => connection);
}

/** The union of the attached connections' declarations; the host default while nobody is attached. */
export function effectiveSessionCapabilities(host: RouterContext, sessionId: string): readonly string[] {
	const attached = attachedConnections(host, sessionId);
	if (attached.length === 0) return host.connectionOptions?.capabilities ?? [];
	return [...new Set(attached.flatMap((connection) => declaredBy(host, connection)))];
}

function sameSet(left: readonly string[] | undefined, right: readonly string[]): boolean {
	return left?.length === right.length && right.every((capability) => left.includes(capability));
}

/** Gives a session's binding exactly `capabilities`; false when the binding could not take them. */
export async function applySessionCapabilities(
	host: RouterContext,
	sessionId: string,
	capabilities: readonly string[],
): Promise<boolean> {
	const binding = host.bindings.get(sessionId);
	if (binding === undefined || host.registry.peek(sessionId)?.state !== "open") return true;
	if (sameSet(host.bindingCapabilities.get(binding), capabilities)) return true;
	host.bindingCapabilities.set(binding, [...capabilities]);
	try {
		await binding.setCapabilities?.(capabilities);
		return true;
	} catch (cause) {
		host.bindingCapabilities.delete(binding);
		process.stderr.write(`senpi rpc host: client capabilities not applied to ${sessionId}: ${String(cause)}\n`);
		return false;
	}
}

/**
 * Recomputes one session. The binding call starts synchronously, so a command the client sends after this
 * returns reaches the session after its new capabilities on both runtimes; callers on a path that must not
 * wait may drop the promise, which never rejects. A session with nobody attached keeps its set.
 */
export function recomputeSessionCapabilities(host: RouterContext, sessionId: string): Promise<boolean> {
	// With nobody attached the set stays: a retained session keeps its pending questions for the client that
	// reattaches, which the writer replays to it.
	if (attachedConnections(host, sessionId).length === 0) return Promise.resolve(true);
	return applySessionCapabilities(host, sessionId, effectiveSessionCapabilities(host, sessionId));
}

async function recomputeAttachedSessions(host: RouterContext, connection: string): Promise<boolean> {
	const sessions = [...(host.sessionsByConnection.get(connection)?.keys() ?? [])];
	const applied = await Promise.all(sessions.map((sessionId) => recomputeSessionCapabilities(host, sessionId)));
	return applied.every(Boolean);
}

/**
 * Records a connection's own declaration and recomputes every session it is attached to. While they change, a
 * connection that had declared admits both sets, so no record either set allows is lost; the new set becomes its
 * filter only once every session took it. A refusal restores the earlier declaration, filter and sessions.
 */
export async function declareConnectionCapabilities(
	host: RouterContext,
	connection: string,
	capabilities: readonly string[],
): Promise<boolean> {
	const previous = host.pendingCapabilities.get(connection);
	host.pendingCapabilities.set(connection, [...capabilities]);
	if (previous !== undefined)
		host.writer.setConnectionCapabilities(connection, [...new Set([...previous, ...capabilities])], true);
	if (await recomputeAttachedSessions(host, connection)) {
		host.writer.setConnectionCapabilities(connection, capabilities, true);
		return true;
	}
	if (previous === undefined) host.pendingCapabilities.delete(connection);
	else host.pendingCapabilities.set(connection, previous);
	await recomputeAttachedSessions(host, connection);
	if (previous !== undefined) host.writer.setConnectionCapabilities(connection, previous, true);
	return false;
}

/**
 * Every `set_client_info` on a shared host, connection-level or session-scoped, is answered here: the senpi#3811
 * role check first, then the declaration. A session-scoped call is answered by the host rather than its binding,
 * because a worker isolate cannot wait for a capability change it would itself have to apply.
 */
export async function answerSetClientInfo(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "set_client_info" }>,
): Promise<RpcResponse> {
	const scope = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
	const answered = { id: command.id, type: "response", command: "set_client_info", success: true } as RpcResponse;
	if (command.sessionId !== undefined) {
		try {
			host.registry.getForCommand(command.sessionId, command.type);
		} catch (cause) {
			return error(command.id, command.type, code(cause), detail(cause));
		}
	}
	const connection = host.writer.currentConnection();
	// A width-only call (a resize) keeps the declaration it does not carry.
	if (command.capabilities === undefined) return { ...answered, ...scope };
	if (!host.connectionRoles.declare(roleConnection(connection), command.capabilities))
		return { ...error(command.id, command.type, CONNECTION_ROLE_FIXED), ...scope };
	// A stdio host has one client and no connection id, so its session-scoped declaration is that session's set.
	const applied =
		connection !== undefined
			? await declareConnectionCapabilities(host, connection, command.capabilities)
			: command.sessionId === undefined ||
				(await applySessionCapabilities(host, command.sessionId, command.capabilities));
	return applied
		? { ...answered, ...scope }
		: { ...error(command.id, command.type, CLIENT_CAPABILITIES_NOT_APPLIED), ...scope };
}
