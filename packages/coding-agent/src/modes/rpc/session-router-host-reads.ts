import { VERSION } from "../../config.ts";
import { readSessionRetirement, RetirementFault } from "../../core/session-retirement.ts";
import { sharedPathIdentityResolver } from "../../core/extensions/builtin/permission-system/path-identity-host.ts";
import { subscriptionLimits } from "../../core/subscription-limits/limit-store.ts";
import { HAND_SELECTION_CAPABILITY } from "./custom-capability.ts";
import { multiSessionHostCapabilities } from "./host-capabilities.ts";
import { advertisedCompactCapabilities } from "./compact-negotiation.ts";
import { pathIdentityResolverStatus } from "./path-identity-status.ts";
import { hostGeneration, hostInstanceId, protocolIdentity } from "./protocol-identity.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { sessionMemory } from "./session-router-observation.ts";

/**
 * Host-level read routes: answered from host state alone, before any session lookup or worker forwarding.
 * Moved verbatim out of session-router-routing.ts `dispatch` (senpi#4272 SR1, RULING-70 (4)).
 */
export function answerProtocolInfo(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "get_protocol_info" }>,
): RpcResponse {
	const hostCapabilities = multiSessionHostCapabilities({
		warm: host.registry.warm !== undefined,
		parkClaim: host.registry.supportsParkClaim === true,
		toolRuntime: host.defaults.toolRuntime ?? "in-process",
		negotiated: host.connectionOptions?.capabilities ?? [],
		mcpPresenters: host.writer.mcpPresenters !== undefined,
	});
	const capabilities =
		host.defaults.handSelection === undefined ? hostCapabilities : [...hostCapabilities, HAND_SELECTION_CAPABILITY];
	return {
		id: command.id,
		type: "response",
		command: "get_protocol_info",
		success: true,
		data: {
			protocolVersion: 1,
			serverVersion: VERSION,
			capabilities: advertisedCompactCapabilities(
				capabilities,
				host.writer.currentConnection() !== undefined && host.compactAvailable(),
			),
			mode: "multi",
			...protocolIdentity(host.defaults.agentDir),
			memory_pressure: host.memoryPressure,
			path_identity_resolver: pathIdentityResolverStatus(sharedPathIdentityResolver()),
		},
	};
}

export function answerSubscriptionLimits(
	command: Extract<RpcCommand, { type: "get_subscription_limits" }>,
): RpcResponse {
	return {
		id: command.id,
		type: "response",
		command: "get_subscription_limits",
		success: true,
		data: { accounts: subscriptionLimits.snapshot() },
	};
}

export async function answerListSessions(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "list_sessions" }>,
): Promise<RpcResponse> {
	// Worker sessions are machine-driven work: a client sees them only by asking, and
	// the opaque context blob travels only on that listing, never to every connection.
	const rows = host.registry.list();
	const presence = host.defaults.sessionPresence;
	const withMemory = [
		...rows.map((row) => ({
			...row,
			generation: hostGeneration(process.env),
			hostInstanceId: host.defaults.hostContext?.host_instance ?? hostInstanceId(),
			memory: sessionMemory(host, row.sessionId),
			...(presence && row.durableSessionId !== undefined ? { presence: presence.view(row.durableSessionId) } : {}),
		})),
		...host.routes.rows().filter((r) => !rows.some((row) => row.sessionId === r.sessionId)),
	];
	const sessions =
		command.include_workers === true
			? withMemory
			: withMemory.filter((row) => row.kind !== "worker").map(({ context: _context, ...row }) => row);
	const agentDir = host.registry.agentDir ?? host.defaults.agentDir;
	let listed: typeof sessions;
	try {
		listed = await Promise.all(
			sessions.map(async (row) => {
				const retirement =
					agentDir && row.sessionPath && row.durableSessionId
						? await readSessionRetirement(agentDir, row.durableSessionId)
						: undefined;
				return retirement ? { ...row, retirement } : row;
			}),
		);
	} catch (cause) {
		if (!(cause instanceof RetirementFault)) throw cause;
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			error: cause.code,
			errorCode: cause.code,
			errorData: cause.detail,
		};
	}
	return {
		id: command.id,
		type: "response",
		command: "list_sessions",
		success: true,
		data: {
			sessions: listed,
			// senpi#7020: a successor still taking over its predecessor's sessions lists only part of them so far.
			...(host.inheritedHandover === undefined
				? {}
				: {
						handover: {
							pending: host.inheritedHandover.pending,
							predecessor_draining: host.inheritedHandover.predecessorDraining,
						},
					}),
		},
	};
}
