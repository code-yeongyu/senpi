import { VERSION } from "../../config.ts";
import { sharedPathIdentityResolver } from "../../core/extensions/builtin/permission-system/path-identity-host.ts";

import { subscriptionLimits } from "../../core/subscription-limits/limit-store.ts";
import { detachConnection } from "./connection-detach.ts";
import { CONNECTION_ROLE_FIXED, roleConnection } from "./connection-roles.ts";

import { answerEffectFromTranscript } from "./effect-commands.ts";

import { multiSessionHostCapabilities } from "./host-capabilities.ts";

import { answerWarm } from "./host-warm.ts";
import { pathIdentityResolverStatus } from "./path-identity-status.ts";
import { protocolIdentity } from "./protocol-identity.ts";

import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_MISSING_SESSION_ID } from "./rpc-types.ts";
import { attachSession, reclaimSession, releaseAttachment } from "./session-attachment-commands.ts";
import { attachmentGate } from "./session-attachment-gate.ts";
import { runWithSessionAttribution } from "./session-attribution.ts";
import { dispatchSessionBinding } from "./session-held.ts";
import { moveSession } from "./session-move-commands.ts";
import { releaseSession } from "./session-release.ts";
import { releaseConnection } from "./session-router-attachments.ts";
import { close, tearDownUnloaded } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, detail, error } from "./session-router-errors.ts";
import { acknowledgePrompt, otherRequestsSettled, sessionMemory } from "./session-router-observation.ts";
import { sweepDrain } from "./session-router-occupancy.ts";
import { openWithBarrier } from "./session-router-open.ts";
import {
	answerSetSessionContext,
	answerSubscribeSessions,
	answerUnsubscribeSessions,
	notAttachedRefusal,
} from "./session-status-commands.ts";
import { unloadSession } from "./session-unload.ts";

/**
 * Every routed command runs inside its session's attribution scope, so a stall the
 * loop-lag watchdog observes right after this dispatch can name the session that
 * caused it - and anything the command starts inherits the attribution.
 */
export function handle(host: RouterContext, command: RpcCommand): Promise<RpcResponse | undefined> {
	const refusal = attachmentGate(host, command);
	if (refusal) return Promise.resolve(refusal);
	const sessionId = "sessionId" in command ? command.sessionId : undefined;
	// A parked handle is answered by its terminal record and connection close, never unknown_session.
	if (host.draining && sessionId !== undefined && host.handoffClosed.has(sessionId)) return Promise.resolve(undefined);
	if (host.draining && command.type === "open_session")
		return Promise.resolve(error(command.id, command.type, "host_draining"));
	// A warm holds no session and no path, so it stays out of the accounting a drain waits on (senpi#2314).
	if (command.type === "warm")
		return answerWarm(command, {
			draining: host.draining,
			warm: host.registry.warm,
			cwd: host.defaults.cwd,
			hostContext: host.defaults.hostContext,
		});
	host.activeRequests.set(sessionId, (host.activeRequests.get(sessionId) ?? 0) + 1);
	return runWithSessionAttribution({ sessionId }, () => dispatch(host, command)).finally(() => {
		const remaining = (host.activeRequests.get(sessionId) ?? 1) - 1;
		if (remaining > 0) host.activeRequests.set(sessionId, remaining);
		else host.activeRequests.delete(sessionId);
		if (sessionId !== undefined) for (const listener of host.requestSettledListeners.get(sessionId) ?? []) listener();
		if (host.draining) sweepDrain(host);
	});
}

/** Attachments held by connections other than the caller: every one of the caller's own holds is excluded. */
function otherAttachments(host: RouterContext, caller: string | undefined, sessionId: string): number {
	const own = caller === undefined ? 0 : (host.sessionsByConnection.get(caller)?.get(sessionId) ?? 0);
	return Math.max(0, (host.registry.peek(sessionId)?.attachments ?? 0) - own);
}

export async function dispatch(
	host: RouterContext,
	command: Exclude<RpcCommand, { type: "warm" }>,
): Promise<RpcResponse | undefined> {
	if (command.type === "get_protocol_info") {
		const capabilities = multiSessionHostCapabilities({
			warm: host.registry.warm !== undefined,
			toolRuntime: host.defaults.toolRuntime ?? "in-process",
			negotiated: host.connectionOptions?.capabilities ?? [],
			mcpPresenters: host.writer.mcpPresenters !== undefined,
		});
		return {
			id: command.id,
			type: "response",
			command: "get_protocol_info",
			success: true,
			data: {
				protocolVersion: 1,
				serverVersion: VERSION,
				capabilities,
				mode: "multi",
				...protocolIdentity(host.defaults.agentDir),
				memory_pressure: host.memoryPressure,
				path_identity_resolver: pathIdentityResolverStatus(sharedPathIdentityResolver()),
			},
		};
	}
	if (command.type === "get_subscription_limits") {
		return {
			id: command.id,
			type: "response",
			command: "get_subscription_limits",
			success: true,
			data: { accounts: subscriptionLimits.snapshot() },
		};
	}
	if (command.type === "list_sessions") {
		// Worker sessions are machine-driven work: a client sees them only by asking, and
		// the opaque context blob travels only on that listing, never to every connection.
		const rows = host.registry.list();
		const withMemory = rows.map((row) => ({ ...row, memory: sessionMemory(host, row.sessionId) }));
		const sessions =
			command.include_workers === true
				? withMemory
				: withMemory.filter((row) => row.kind !== "worker").map(({ context: _context, ...row }) => row);
		return {
			id: command.id,
			type: "response",
			command: "list_sessions",
			success: true,
			data: { sessions },
		};
	}
	if (command.type === "detach_connection")
		return detachConnection(command, host.writer.currentConnection(), (id) => releaseConnection(host, id));
	if (command.type === "open_session") return openWithBarrier(host, command);
	if (command.type === "attach_session") return attachSession(host, command);
	if (command.type === "release_attachment") return releaseAttachment(host, command);
	if (command.type === "reclaim_session") return reclaimSession(host, command);
	if (command.type === "close_session") return close(host, command);
	if (command.type === "release_session")
		return releaseSession(
			{
				draining: () => host.draining,
				hostInstance: host.defaults.hostContext?.host_instance,
				otherAttachments: (sessionId) => otherAttachments(host, host.writer.currentConnection(), sessionId),
				lookup: (sessionId) => host.registry.getForCommand(sessionId, "release_session"),
				code: (cause) => code(cause),
				// The release is itself one of the session's in-flight requests.
				otherRequests: (sessionId) => Math.max(0, (host.activeRequests.get(sessionId) ?? 1) - 1),
				otherRequestsSettled: (sessionId) => otherRequestsSettled(host, sessionId),
				pendingPrompts: (sessionId) => host.bindings.get(sessionId)?.pendingPrompts?.() ?? [],
				tearDown: (sessionId, sessionPath) => host.releaseTeardown(sessionId, sessionPath),
			},
			command,
		);
	if (command.type === "move_session") {
		const agentDir = host.registry.agentDir;
		if (agentDir === undefined)
			return error(
				command.id,
				command.type,
				"move_unsupported: this host keeps no agent directory to move sessions in",
			);
		return moveSession(
			{
				agentDir,
				hostedPaths: () =>
					host.registry.list().flatMap((row) => (row.sessionPath === undefined ? [] : [row.sessionPath])),
			},
			command,
		);
	}
	if (command.type === "unload_session") {
		const caller = host.writer.currentConnection();
		return unloadSession(
			{
				draining: () => host.draining,
				by: { connectionId: caller ?? "host" },
				lookup: (sessionId) => host.registry.getForCommand(sessionId, "unload_session"),
				code: (cause) => code(cause),
				// The unload is itself one of the session's in-flight requests.
				otherRequests: (sessionId) => Math.max(0, (host.activeRequests.get(sessionId) ?? 1) - 1),
				otherRequestsSettled: (sessionId) => otherRequestsSettled(host, sessionId),
				pendingPrompts: (sessionId) => host.bindings.get(sessionId)?.pendingPrompts?.() ?? [],
				otherAttachments: (sessionId) => otherAttachments(host, caller, sessionId),
				openChildSessions: (durableSessionId) =>
					host.registry
						.list()
						.filter(
							(row) =>
								row.durableSessionId !== durableSessionId &&
								(row.context?.parent_session_id === durableSessionId ||
									row.context?.root_session_id === durableSessionId),
						).length,
				tearDown: (sessionId, sessionPath) => tearDownUnloaded(host, sessionId, sessionPath),
			},
			command,
		);
	}
	if (command.type === "set_client_info" && !command.sessionId) {
		const connection = host.writer.currentConnection();
		if (
			command.capabilities !== undefined &&
			!host.connectionRoles.declare(roleConnection(connection), command.capabilities)
		)
			return {
				id: command.id,
				type: "response",
				command: "set_client_info",
				success: false,
				error: CONNECTION_ROLE_FIXED,
			} as RpcResponse;
		if (connection !== undefined) {
			host.pendingCapabilities.set(connection, command.capabilities ?? []);
			host.writer.setConnectionCapabilities(connection, command.capabilities ?? []);
		}
		return { id: command.id, type: "response", command: "set_client_info", success: true } as RpcResponse;
	}
	if (command.type === "subscribe_sessions") {
		const connection = host.writer.currentConnection();
		const { answer, activate } = answerSubscribeSessions(command, connection, host.writer.status);
		// On a socket host the response is enqueued HERE, ahead of activation: a delta published
		// while this dispatch awaited the route queues behind the snapshot it belongs after.
		if (activate !== undefined && connection !== undefined) {
			const enqueue = async () => {
				// Two hops: the response must be enqueued onto the actor's FIFO before the
				// subscription goes live, so a delta published between registration and here
				// always lands behind the snapshot answer it follows.
				await host.writer.enqueueControl(answer, connection);
				await new Promise<void>((resolve) => queueMicrotask(resolve));
				try {
					// A connection that closed while this subscribe awaited dispatch already ran dropConnection,
					// before this pending entry existed; drop it here or it holds deltas for the life of the host.
					if (host.writer.hasConnection(connection)) host.writer.status.activate(activate);
					else host.writer.status.unsubscribe(connection, activate);
				} catch (cause) {
					process.stderr.write(`senpi rpc subscription activation failed: ${String(cause)}\n`);
				}
			};
			void enqueue().catch((cause: unknown) => {
				host.writer.status.unsubscribe(connection, activate);
				process.stderr.write(`senpi rpc subscribe answer could not be delivered: ${String(cause)}\n`);
			});
			return undefined;
		}
		return answer;
	}
	if (command.type === "unsubscribe_sessions")
		return answerUnsubscribeSessions(command, host.writer.currentConnection(), host.writer.status);
	// A receipt of a session this host has not loaded is read from its transcript, never by loading it.
	if (command.type === "get_effect_status" && !command.sessionId && command.sessionPath !== undefined)
		return answerEffectFromTranscript(command.id, command.sessionPath, command.effectId);
	if (!command.sessionId) return error(command.id, command.type, RPC_ERROR_MISSING_SESSION_ID);
	const sessionId = command.sessionId;
	if (host.writer.isSessionSealed(sessionId) && host.registry.peek(sessionId)?.state === "open")
		return error(command.id, command.type, "session_output_overflow", {
			sessionId,
			action: "unload_and_reopen",
		});
	if (command.type === "set_session_context") return setSessionContext(host, command);
	try {
		const entry = host.registry.getForCommand(sessionId, command.type);
		await dispatchSessionBinding(
			command,
			entry,
			host.bindings.get(sessionId),
			() => acknowledgePrompt(host, command.id, sessionId),
			(observedStarts) => host.registry.holderPids?.(observedStarts) ?? Promise.resolve([]),
		);
		return undefined;
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause));
	}
}

/** Any attached connection may patch; a host with no per-connection identity (stdio) owns every session. */
export function setSessionContext(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "set_session_context" }>,
): RpcResponse {
	const owner = host.writer.currentConnection();
	if (owner !== undefined && host.sessionsByConnection.get(owner)?.has(command.sessionId) !== true)
		return notAttachedRefusal(command);
	try {
		const entry = host.registry.getForCommand(command.sessionId, command.type);
		return answerSetSessionContext(command, entry, host.writer.status);
	} catch (cause) {
		return error(command.id, command.type, code(cause), detail(cause));
	}
}
