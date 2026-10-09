import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient, RpcTransportGoneError } from "../src/modes/rpc/rpc-client.ts";
import { OPEN_AFTER_QUEUED_DEADLINE_MS, REQUEST_DEADLINE_MS } from "../src/modes/rpc/rpc-request-deadline.ts";

interface FakeHost {
	readonly client: RpcClient;
	readonly request: Promise<{ id: string; type: string }>;
	send(record: object): void;
	drop(): void;
	close(): void;
}

async function fakeHost(): Promise<FakeHost> {
	const directory = mkdtempSync(join(tmpdir(), "rpc-client-open-deadline-"));
	const socketPath = join(directory, "rpc.sock");
	let peer: Socket | undefined;
	let resolveRequest!: (request: { id: string; type: string }) => void;
	const request = new Promise<{ id: string; type: string }>((resolve) => {
		resolveRequest = resolve;
	});
	const server: Server = createServer((socket) => {
		peer = socket;
		let received = "";
		socket.on("data", (chunk) => {
			received += chunk.toString();
			const newline = received.indexOf("\n");
			if (newline !== -1) resolveRequest(JSON.parse(received.slice(0, newline)));
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	return {
		client,
		request,
		send: (record) => peer?.write(`${JSON.stringify(record)}\n`),
		drop: () => peer?.destroy(),
		close: () => {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function queuedSeen(client: RpcClient): Promise<void> {
	return new Promise((resolve) => {
		client.onEvent((event) => {
			if (event.type === "queued") resolve();
		});
	});
}

describe("RpcClient open_session deadline (senpi#2209)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("an open the host acknowledged is answered after the request deadline", async () => {
		const host = await fakeHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const open = host.client.openSession({ cwd: "/tmp" });
			const { id } = await host.request;
			const acknowledged = queuedSeen(host.client);
			host.send({ type: "queued", for_request: id, position: 1, in_flight: 0 });
			await acknowledged;
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 27_000);
			host.send({
				type: "response",
				id,
				command: "open_session",
				success: true,
				data: { sessionId: "s", state: {} },
			});
			await expect(open).resolves.toMatchObject({ sessionId: "s" });
		} finally {
			host.close();
		}
	});

	test("an open the host never acknowledged still fails at the request deadline", async () => {
		const host = await fakeHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const open = host.client.openSession({ cwd: "/tmp" });
			const failed = expect(open).rejects.toThrow("Timeout waiting for response to open_session");
			await host.request;
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
			await failed;
		} finally {
			host.close();
		}
	});

	test("an acknowledged open that never answers fails naming where it was queued", async () => {
		const host = await fakeHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const open = host.client.openSession({ cwd: "/tmp" });
			const failed = expect(open).rejects.toThrow("accepted by the host at queue position 3");
			const { id } = await host.request;
			const acknowledged = queuedSeen(host.client);
			host.send({ type: "queued", for_request: id, position: 3, in_flight: 2 });
			await acknowledged;
			await vi.advanceTimersByTimeAsync(OPEN_AFTER_QUEUED_DEADLINE_MS);
			await failed;
		} finally {
			host.close();
		}
	});

	test("a transport lost after the acknowledgement rejects at once", async () => {
		const host = await fakeHost();
		try {
			const open = host.client.openSession({ cwd: "/tmp" });
			const { id } = await host.request;
			const acknowledged = queuedSeen(host.client);
			host.send({ type: "queued", for_request: id, position: 1, in_flight: 0 });
			await acknowledged;
			host.drop();
			await expect(open).rejects.toBeInstanceOf(RpcTransportGoneError);
		} finally {
			host.close();
		}
	});
});
