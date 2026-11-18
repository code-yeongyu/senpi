import { openReplyPermissionMode } from "../../core/permission-mode.ts";
import { buildRpcSessionState } from "./connection-handler.ts";
import type { OpenRpcSession, RpcSessionEntry } from "./session-registry.ts";
import type { RouterContext } from "./session-router-context.ts";

/** A dropped opener waits until its open or claim has either transferred or released ownership. */
export function holdOpenConnection(host: RouterContext, owner: string): () => void {
	const barrier = Promise.withResolvers<void>();
	const opens = host.opensByConnection.get(owner) ?? new Set<Promise<void>>();
	opens.add(barrier.promise);
	host.opensByConnection.set(owner, opens);
	return () => {
		barrier.resolve();
		opens.delete(barrier.promise);
		if (opens.size === 0) host.opensByConnection.delete(owner);
	};
}

/** One ownership transition for both a freshly built open and a claimed speculative open. */
export function ownOpen(host: RouterContext, opened: OpenRpcSession, owner: string | undefined, compact = false): void {
	if (owner === undefined) return;
	if (!host.writer.hasRegisteredConnectionCapabilities(owner))
		host.writer.setConnectionCapabilities(
			owner,
			host.pendingCapabilities.get(owner) ?? host.connectionOptions?.capabilities ?? [],
		);
	host.writer.attachConnectionToSession(owner, opened.sessionId, compact);
	const owned = host.sessionsByConnection.get(owner) ?? new Map<string, number>();
	owned.set(opened.sessionId, (owned.get(opened.sessionId) ?? 0) + 1);
	host.sessionsByConnection.set(owner, owned);
	host.attachOrder.attached(opened.sessionId, owner);
}

export function publishOpen(host: RouterContext, opened: OpenRpcSession, entry: RpcSessionEntry): void {
	if (opened.attached) host.writer.status.publish(opened.sessionId, "attach", "client");
	else {
		host.writer.publishSessionOpened({
			type: "session_opened",
			sessionId: opened.sessionId,
			durableSessionId: opened.durableSessionId,
			...(opened.sessionPath !== undefined ? { sessionPath: opened.sessionPath } : {}),
			kind: entry.kind,
			cwd: entry.cwd,
			context: entry.context,
		});
		host.writer.status.publish(opened.sessionId, "open", "client");
	}
}

/**
 * An open whose reply is another command's answer (senpi#6267: a `move_session import` that opens what it landed): the
 * reply goes out under that command, with `data` beside the open's own.
 */
export interface OpenReplyAs {
	readonly command: { readonly type: "move_session"; readonly id?: string };
	readonly data: Readonly<Record<string, unknown>>;
}

export function replyOpen(
	host: RouterContext,
	opened: OpenRpcSession,
	entry: RpcSessionEntry,
	command: { readonly type: "open_session" | "claim_session" | "move_session"; readonly id?: string },
	reply = true,
	beside: Readonly<Record<string, unknown>> = {},
): void {
	const state =
		entry.worker?.snapshot?.state ?? (entry.runtime ? buildRpcSessionState(entry.runtime.session) : undefined);
	if (!state) throw new Error("Session state was not created");
	if (reply)
		host.writer.enqueue(opened.sessionId, {
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data: {
				...beside,
				sessionId: opened.sessionId,
				state,
				...openReplyPermissionMode(state),
				...(opened.attached ? { attached: true } : {}),
				...(host.defaults.sessionPresence ? { presence: host.defaults.sessionPresence.view(state.sessionId) } : {}),
			},
		});
}
