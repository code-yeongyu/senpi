/**
 * senpi#6677: a session in a worker isolate (`createHostCore` with `workerConfiguration`) publishes the `archive` cause
 * and lists `archived: true` from the worker's snapshot, as an in-process session does.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type DelegatedHost, type Peer, startHost, type WireRecord } from "./rpc-delegated-host-support.ts";

let host: DelegatedHost;
let peer: Peer;

beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
});
beforeAll(async () => {
	host = await startHost({ workers: true });
	peer = await host.proven();
});
afterAll(async () => {
	await host.dispose();
});

async function listedArchived(sessionId: string): Promise<unknown> {
	const { sessions } = (await peer.send({ type: "list_sessions" })).data as {
		sessions: Array<{ sessionId: string; archived?: unknown }>;
	};
	return sessions.find((row) => row.sessionId === sessionId)?.archived;
}

function archiveStatus(subscriptionId: unknown, sessionId: string, archived: boolean) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		(record.lastChange as { cause?: unknown } | undefined)?.cause === "archive" &&
		record.archived === archived;
}

it("a worker session publishes the archive cause and lists archived:true, then clears it", async () => {
	const subscribed = await peer.send({ type: "subscribe_sessions" });
	const subscriptionId = (subscribed.data as { subscriptionId?: unknown } | undefined)?.subscriptionId;
	const opened = await peer.send({ type: "open_session" });
	expect(opened).toMatchObject({ success: true });
	const sessionId = String((opened.data as { sessionId?: unknown }).sessionId);
	expect(await listedArchived(sessionId)).toBe(false);

	expect(await peer.send({ type: "set_session_archived", sessionId, archived: true })).toMatchObject({
		success: true,
	});
	await peer.frame(archiveStatus(subscriptionId, sessionId, true));
	expect(await listedArchived(sessionId)).toBe(true);

	expect(await peer.send({ type: "set_session_archived", sessionId, archived: false })).toMatchObject({
		success: true,
	});
	await peer.frame(archiveStatus(subscriptionId, sessionId, false));
	expect(await listedArchived(sessionId)).toBe(false);
}, 120_000);
