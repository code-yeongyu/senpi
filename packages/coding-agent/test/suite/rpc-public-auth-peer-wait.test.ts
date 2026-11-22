import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Peer } from "./rpc-public-auth-harness.ts";

// #4252: a loaded runner can take longer than a fixed 5 s to produce a record; a closed peer must fail at once.
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connected(deadlineMs: number) {
	const dir = await mkdtemp(join(tmpdir(), "pw-"));
	const path = join(dir, "s");
	const listener: Server = createServer();
	listener.listen(path);
	await once(listener, "listening");
	const accepted = once(listener, "connection");
	const peer = await Peer.connect(path, { deadlineMs });
	const [server] = await accepted;
	if (!(server instanceof Socket)) throw new Error("listener accepted no socket");
	cleanups.push(async () => {
		peer.socket.destroy();
		server.destroy();
		listener.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { peer, server };
}

describe("Peer.waitFor", () => {
	it("waits past the former fixed window for a record that arrives within the caller's budget", async () => {
		const { peer, server } = await connected(60_000);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const received = peer.waitFor((record) => record.type === "agent_end");
		let outcome: string | undefined;
		void received.then(
			() => {
				outcome = "resolved";
			},
			(error: unknown) => {
				outcome = String(error);
			},
		);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(outcome).toBeUndefined();
		const delivered = once(peer.socket, "data");
		server.write(`${JSON.stringify({ type: "agent_end" })}\n`);
		await delivered;
		await expect(received).resolves.toMatchObject({ type: "agent_end" });
	});

	it("rejects as soon as the connection closes, without waiting for the deadline", async () => {
		const { peer, server } = await connected(60_000);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const received = peer.waitFor((record) => record.type === "agent_end");
		let outcome: string | undefined;
		void received.then(
			() => {
				outcome = "resolved";
			},
			(error: unknown) => {
				outcome = String(error);
			},
		);
		server.destroy();
		await peer.closed;
		await new Promise((resolve) => setImmediate(resolve));
		expect(outcome).toMatch(/connection closed before the expected record/);
	});
});
