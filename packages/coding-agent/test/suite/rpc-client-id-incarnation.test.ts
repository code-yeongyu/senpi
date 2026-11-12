/**
 * senpi#6443: who may unload a session without `force` depends on which connections count as the asking client's
 * own, so a name must never reach a connection through a refused declaration, nor stay on a socket whose viewer
 * changed. Real sessions on a real multi-session host; each case starts its own host.
 */
import { describe, expect, it } from "vitest";
import { CommandAuthority, commandAuthority } from "../../src/modes/rpc/command-authority.ts";
import { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import {
	attach,
	type DelegatedHost,
	declare,
	openSession,
	type Peer,
	startHost,
} from "./rpc-delegated-host-support.ts";

const VIEWER = { deviceId: "x6443-device", deviceName: "Viewer" };
const REFUSED_FOR_ANOTHER_CLIENT = {
	data: { dry_run: true, outcome: "refused", reason: "attached", detail: "1 other client(s) attached" },
};

function names(host: DelegatedHost): Map<string, string> {
	const context: unknown = Reflect.get(host.core.router, "context");
	if (!(context instanceof RouterContext)) throw new Error("SessionCommandRouter.context is gone; update this test");
	return context.clientIds;
}

async function dryUnloadOnceAttached(client: Peer, session: Awaited<ReturnType<typeof openSession>>) {
	expect(await client.send(attach(session))).toMatchObject({ success: true });
	return client.send({ type: "unload_session", sessionId: session.sessionId, dryRun: true });
}

/** A delegated socket after its `detach_connection`, with the authority of a command made before that detach. */
async function viewerChanged(host: DelegatedHost) {
	const socket = await host.proven();
	const granted = await declare(socket, ["observe", "drive", "thread"], VIEWER, {
		roles: ["interactive_user", "task_parent"],
	});
	expect(granted).toMatchObject({ success: true });
	const beforeDetach = host.writer.withConnection(socket.connectionId, () => host.writer.connectionContext.delegation);
	if (beforeDetach?.mode !== "host") throw new Error("the socket is not a host-mode delegated connection");
	const madeBeforeDetach = new CommandAuthority(socket.connectionId, { ...beforeDetach }, undefined);
	expect(await socket.send({ type: "detach_connection" })).toMatchObject({ success: true });
	return { socket, madeBeforeDetach };
}

describe("a client name does not outlive its declaration's authority (senpi#6443)", () => {
	it("#given a delegated socket whose viewer changed #when a declaration made before the detach arrives with the old viewer's name #then it is refused stale, no name is kept, and the old viewer's unload of the new viewer's session is refused", async () => {
		const host = await startHost();
		try {
			const { socket, madeBeforeDetach } = await viewerChanged(host);
			const session = await openSession(socket, { retain_on_disconnect: true });
			const oldViewer = await host.proven();
			expect(await oldViewer.send({ type: "set_client_info", client_id: "old-viewer" })).toMatchObject({
				success: true,
			});

			const late = await commandAuthority.run(madeBeforeDetach, () =>
				host.writer.withConnection(socket.connectionId, () =>
					host.core.router.handle({ type: "set_client_info", id: "late", width: 80, client_id: "old-viewer" }),
				),
			);

			expect(late).toMatchObject({ success: false, errorCode: "delegation_incarnation_stale" });
			expect(await dryUnloadOnceAttached(oldViewer, session)).toMatchObject(REFUSED_FOR_ANOTHER_CLIENT);
			expect(names(host).has(socket.connectionId)).toBe(false);
		} finally {
			await host.dispose();
		}
	}, 120_000);

	it("#given two connections of one client #when one sends detach_connection and a new viewer opens a session on it #then the name is gone and the old client's unload of that session is refused", async () => {
		const host = await startHost();
		try {
			const main = await host.proven();
			const second = await host.proven();
			for (const connection of [main, second])
				expect(await connection.send({ type: "set_client_info", client_id: "one-client" })).toMatchObject({
					success: true,
				});
			expect(await second.send({ type: "detach_connection" })).toMatchObject({ success: true });
			const session = await openSession(second, { retain_on_disconnect: true });

			const dry = await dryUnloadOnceAttached(main, session);

			expect(dry).toMatchObject(REFUSED_FOR_ANOTHER_CLIENT);
			expect(names(host).has(second.connectionId)).toBe(false);
		} finally {
			await host.dispose();
		}
	}, 120_000);

	it("#given a session-scoped declaration that changes a fixed role and carries a name #then the session refuses it and no name is kept; the same declaration without the role change is kept", async () => {
		const host = await startHost();
		try {
			const client = await host.proven();
			const session = await openSession(client, { retain_on_disconnect: true });
			const scoped = { type: "set_client_info", sessionId: session.sessionId };
			expect(await client.send({ ...scoped, capabilities: ["interactive_user"] })).toMatchObject({ success: true });

			const refused = await client.send({ ...scoped, capabilities: ["task_parent"], client_id: "one-client" });

			expect(refused).toMatchObject({ success: false });
			expect(names(host).has(client.connectionId)).toBe(false);
			expect(await client.send({ ...scoped, client_id: "one-client" })).toMatchObject({ success: true });
			expect(names(host).get(client.connectionId)).toBe("one-client");
		} finally {
			await host.dispose();
		}
	}, 120_000);

	it("#given a delegated socket whose viewer changed and a session the new viewer named itself on #when a session-scoped declaration made before the detach carries only the old viewer's name #then the session refuses it and the new viewer's name stays", async () => {
		const host = await startHost();
		try {
			const { socket, madeBeforeDetach } = await viewerChanged(host);
			const session = await openSession(socket, { retain_on_disconnect: true });
			const scoped = { type: "set_client_info", sessionId: session.sessionId, width: 80 } as const;
			expect(await socket.send({ ...scoped, client_id: "new-viewer" })).toMatchObject({ success: true });
			expect(names(host).get(socket.connectionId)).toBe("new-viewer");

			await commandAuthority.run(madeBeforeDetach, () =>
				host.writer.withConnection(socket.connectionId, () =>
					host.core.router.handle({ ...scoped, id: "late", client_id: "old-viewer" }),
				),
			);

			expect(names(host).get(socket.connectionId)).toBe("new-viewer");
		} finally {
			await host.dispose();
		}
	}, 120_000);
});
