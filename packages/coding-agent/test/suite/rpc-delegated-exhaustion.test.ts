/**
 * omo-relay-daemon#307 L4 over a real socket: the `detach_connection` that exhausts a delegated connection's
 * incarnations is answered first, and only then does the host end the socket (`endExhaustedConnections`). The client
 * stops reading behind a flood of answers, so the exhausting answer is still queued on the host when the end is decided.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DelegatedHost, declare, startHost } from "./rpc-delegated-host-support.ts";
import { BOTH, GRANT, VIEWER } from "./rpc-delegated-roles-support.ts";

/** Enough answers (about 1.5 MB) to fill both kernel socket buffers on Linux and macOS. */
const FLOOD = 12_000;

let host: DelegatedHost;

beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
});
beforeAll(async () => {
	host = await startHost({ incarnationMax: 2 });
});
afterAll(async () => {
	await host.dispose();
}, 60_000);

describe("omo-relay-daemon#307: incarnation exhaustion over the socket host", () => {
	it("L4: the exhausting detach answer reaches the client before the socket ends", async () => {
		const peer = await host.proven();
		expect(await declare(peer, GRANT, VIEWER, { roles: BOTH })).toMatchObject({ success: true });
		expect(await peer.send({ type: "detach_connection" })).toMatchObject({ success: true });
		const seen: string[] = [];
		const closed = new Promise<void>((resolve) =>
			peer.socket.once("close", () => {
				seen.push("close");
				resolve();
			}),
		);
		const ending = host.ending(peer.connectionId);
		peer.socket.pause();
		const flood = Array.from({ length: FLOOD }, () => ({ type: "classify_record", record: { type: "prompt" } }));
		const answers = peer.sendTogether([...flood, { type: "detach_connection", id: "l4-exhausting" }]);
		const detach = answers.at(-1);
		await ending;
		expect(peer.pending("l4-exhausting")).toBe(true);
		peer.socket.resume();
		const answer = await detach;
		seen.push("answer");
		expect(answer).toMatchObject({ type: "response", command: "detach_connection", success: true });
		await closed;
		expect(seen).toEqual(["answer", "close"]);
		expect(await Promise.all(answers.slice(0, 3))).toEqual(
			expect.arrayContaining([expect.objectContaining({ success: true })]),
		);
	}, 60_000);
});
