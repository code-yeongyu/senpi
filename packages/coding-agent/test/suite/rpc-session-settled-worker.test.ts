/**
 * A session in a worker isolate (`createHostCore` with `workerConfiguration`) publishes the `settle` cause and lists
 * `settled` with its `settledBy` from the worker's snapshot, as an in-process session does.
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

async function listedRow(sessionId: string): Promise<Record<string, unknown> | undefined> {
	const { sessions } = (await peer.send({ type: "list_sessions" })).data as {
		sessions: Array<Record<string, unknown>>;
	};
	return sessions.find((row) => row.sessionId === sessionId);
}

function settleStatus(subscriptionId: unknown, sessionId: string, settled: boolean) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		(record.lastChange as { cause?: unknown } | undefined)?.cause === "settle" &&
		record.settled === settled;
}

it("a worker session publishes the settle cause and lists settled with its by, then clears it", async () => {
	const subscribed = await peer.send({ type: "subscribe_sessions" });
	const subscriptionId = (subscribed.data as { subscriptionId?: unknown } | undefined)?.subscriptionId;
	const opened = await peer.send({ type: "open_session" });
	expect(opened).toMatchObject({ success: true });
	const sessionId = String((opened.data as { sessionId?: unknown }).sessionId);
	expect(await listedRow(sessionId)).toMatchObject({ settled: false });

	const by = { kind: "inactivity", days: 14 };
	expect(await peer.send({ type: "set_session_settled", sessionId, settled: true, by })).toMatchObject({
		success: true,
	});
	await peer.frame(settleStatus(subscriptionId, sessionId, true));
	expect(await listedRow(sessionId)).toMatchObject({ settled: true, settledBy: by });

	expect(await peer.send({ type: "set_session_settled", sessionId, settled: false })).toMatchObject({
		success: true,
	});
	await peer.frame(settleStatus(subscriptionId, sessionId, false));
	expect(await listedRow(sessionId)).not.toHaveProperty("settledBy");
	expect(await listedRow(sessionId)).toMatchObject({ settled: false });
}, 120_000);
