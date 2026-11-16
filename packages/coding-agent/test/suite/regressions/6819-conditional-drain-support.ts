import { expect } from "vitest";
import { z } from "zod";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { openSession, startHost, type Peer } from "../rpc-delegated-host-support.ts";

/** Real authenticated sockets, host core and AgentSessions; only the provider is faux (senpi#6819). */
export async function drainRig(extensionFactories: readonly ExtensionFactory[] = []) {
	const exited = Promise.withResolvers<void>();
	const host = await startHost({ extensionFactories, idle: { onEmptyExit: exited.resolve } });
	const operator = await host.proven();
	const identity = z
		.object({ instanceId: z.string() })
		.parse((await operator.send({ type: "get_protocol_info" })).data);
	const opener = await host.proven();
	const opened = await openSession(opener, { retain_on_disconnect: true });
	const session = host.core.peekSession(opened.sessionId)?.runtime?.session;
	if (session === undefined) throw new Error("fixture session missing");
	return {
		...host,
		operator,
		opener,
		opened,
		session,
		exited: exited.promise,
		command: { type: "drain_if_idle", instanceId: identity.instanceId },
		async detach() {
			expect(await opener.send({ type: "release_attachment", sessionId: opened.sessionId })).toMatchObject({
				success: true,
			});
		},
		async [Symbol.asyncDispose]() {
			await host.dispose();
		},
	};
}

export async function expectAdmitting(rig: Awaited<ReturnType<typeof drainRig>>) {
	const newcomer = await rig.proven();
	expect(await newcomer.send({ type: "open_session" })).toMatchObject({ success: true });
	expect(await rig.operator.send({ type: "get_protocol_info" })).toMatchObject({ success: true });
}

export async function expectRefused(peer: Peer, command: Record<string, unknown>, reason: string) {
	expect(await peer.send(command)).toMatchObject({ success: true, data: { action: "refuse", reason } });
}
