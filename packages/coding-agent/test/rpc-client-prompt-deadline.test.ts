import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient, RpcTransportGoneError } from "../src/modes/rpc/rpc-client.ts";
import { PROMPT_AFTER_QUEUED_DEADLINE_MS, REQUEST_DEADLINE_MS } from "../src/modes/rpc/rpc-request-deadline.ts";

interface FakeHost {
	readonly client: RpcClient;
	readonly request: Promise<{ id: string; type: string }>;
	send(record: object): void;
	drop(): void;
	close(): void;
}

async function fakeHost(): Promise<FakeHost> {
	const directory = mkdtempSync(join(tmpdir(), "rpc-client-prompt-deadline-"));
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
			void client.stop();
			server.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function receivedSeen(client: RpcClient): Promise<void> {
	return new Promise((resolve) => {
		client.onEvent((event) => {
			if (event.type === "queued") resolve();
		});
	});
}

describe("RpcClient prompt deadline after the host received it (senpi#2871)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a prompt the host acknowledged is accepted after the request deadline", async () => {
		const host = await fakeHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("first prompt of a child");
			const { id } = await host.request;
			const received = receivedSeen(host.client);
			host.send({ type: "queued", for_request: id, position: 1, in_flight: 0 });
			await received;
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + 15_000);
			host.send({ type: "response", id, command: "prompt", success: true, data: { disposition: "started" } });
			await expect(prompt).resolves.toBe("started");
		} finally {
			host.close();
		}
	});

	test("a prompt the host never acknowledged still fails at the request deadline", async () => {
		const host = await fakeHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("first prompt of a child");
			const failed = expect(prompt).rejects.toThrow("Timeout waiting for response to prompt");
			await host.request;
			await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
			await failed;
		} finally {
			host.close();
		}
	});

	test("an acknowledged prompt that is never accepted fails at its own ceiling, saying the host received it", async () => {
		const host = await fakeHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("first prompt of a child");
			const failed = expect(prompt).rejects.toThrow("prompt was received by the host but not accepted");
			const { id } = await host.request;
			const received = receivedSeen(host.client);
			host.send({ type: "queued", for_request: id, position: 1, in_flight: 0 });
			await received;
			await vi.advanceTimersByTimeAsync(PROMPT_AFTER_QUEUED_DEADLINE_MS);
			await failed;
		} finally {
			host.close();
		}
	});

	test("a transport lost after the acknowledgement rejects at once", async () => {
		const host = await fakeHost();
		try {
			const prompt = host.client.prompt("first prompt of a child");
			const { id } = await host.request;
			const received = receivedSeen(host.client);
			host.send({ type: "queued", for_request: id, position: 1, in_flight: 0 });
			await received;
			host.drop();
			await expect(prompt).rejects.toBeInstanceOf(RpcTransportGoneError);
		} finally {
			host.close();
		}
	});
});
