import type { startOpenTimer } from "../../core/open-timing.ts";
import type { OpenRpcSession, RpcSessionEntry } from "./session-registry.ts";
import { forgetSessionOwnership } from "./session-router-attachments.ts";
import { close } from "./session-router-close.ts";
import type { RouterContext } from "./session-router-context.ts";
import { sweepDrain } from "./session-router-occupancy.ts";
import { closePark } from "./session-router-park.ts";
import { relocationConnection } from "./session-router-relocation.ts";

export async function installOpenBinding(
	host: RouterContext,
	openedSession: OpenRpcSession,
	entry: RpcSessionEntry,
	owner: string | undefined,
	timer: ReturnType<typeof startOpenTimer>,
): Promise<void> {
	host.bindings.set(
		openedSession.sessionId,
		await host.createBinding(
			openedSession.sessionId,
			entry,
			host.writer,
			() =>
				void (entry.speculative
					? closePark(host, openedSession)
					: close(host, { type: "close_session", sessionId: openedSession.sessionId })),
			{
				...host.connectionOptions,
				capabilities:
					owner !== undefined
						? (host.pendingCapabilities.get(owner) ?? host.connectionOptions?.capabilities ?? [])
						: host.connectionOptions?.capabilities,
				connectionRoles: host.connectionRoles,
				clientInfo: {
					setCapabilities: (connectionId, capabilities) => {
						if (connectionId !== undefined) {
							host.writer.setConnectionCapabilities(connectionId, capabilities);
							host.pendingCapabilities.set(connectionId, [...capabilities]);
						}
					},
					connectionId: () => host.writer.currentConnection(),
					relocationConnection: () => relocationConnection(host, openedSession.sessionId),
					deliverTo: (connection, deliver) => host.writer.withConnection(connection, deliver),
				},
			},
		),
	);
	timer.mark("binding");
	if (entry.worker) entry.worker.bindingReady = true;
	// Wake the drain sweep the moment a session settles, so a handoff parks it
	// without waiting for the next timer tick. Both hooks are OPTIONAL: an
	// embedder's runtime and the suite's fakes implement the session surface
	// they need and nothing more, and an open must never fail because a
	// settle notification is unavailable - the periodic sweep still parks it.
	const settled = () => {
		if (host.draining) queueMicrotask(() => sweepDrain(host));
	};
	if (typeof entry.worker?.subscribeSettled === "function") entry.worker.subscribeSettled(settled);
	else if (typeof entry.runtime?.session.subscribe === "function")
		entry.runtime.session.subscribe((event) => {
			// agent_idle, not agent_settled: settle-time extension handlers may still be writing (omo#11419).
			if (event.type === "agent_idle") settled();
		});
	if (entry.worker)
		void entry.worker.exited.then(async () => {
			await host.finalizations.get(openedSession.sessionId)?.promise;
			host.bindings.delete(openedSession.sessionId);
			forgetSessionOwnership(host, openedSession.sessionId);
			host.writer.forgetSession(openedSession.sessionId);
		});
}
