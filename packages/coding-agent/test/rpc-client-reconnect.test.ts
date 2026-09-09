import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RpcClient, RpcClientOpenInFlightError, RpcTransportGoneError } from "../src/modes/rpc/rpc-client.ts";

describe("RpcClient disconnect lifecycle", () => {
	test("fails sends with a classified transport error before start", async () => {
		const client = new RpcClient();

		await expect(client.getState()).rejects.toBeInstanceOf(RpcTransportGoneError);
		await expect(client.getState()).rejects.toMatchObject({ code: "rpc_transport_gone" });
	});

	test("notifies once when an established socket disconnects", async () => {
		const directory = mkdtempSync(join(tmpdir(), "rpc-client-reconnect-"));
		const socketPath = join(directory, "rpc.sock");
		let peer: import("node:net").Socket | undefined;
		const server = createServer((socket) => {
			peer = socket;
		});
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			const onDisconnect = vi.fn();
			const client = new RpcClient({ socketPath, onDisconnect });
			await client.start();
			const disconnected = new Promise<void>((resolve) => {
				const check = () => onDisconnect.mock.calls.length > 0 && resolve();
				const original = onDisconnect.getMockImplementation();
				onDisconnect.mockImplementation((...args) => {
					original?.(...args);
					check();
				});
			});
			peer?.destroy();
			await disconnected;
			await expect(client.getState()).rejects.toBeInstanceOf(RpcTransportGoneError);
			expect(onDisconnect).toHaveBeenCalledTimes(1);
		} finally {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("drops session events without a lease and delivers its leased session events", () => {
		const client = new RpcClient();
		let events = 0;
		client.onEvent((event) => {
			if (event.type === "agent_settled") events++;
		});
		// biome-ignore lint/complexity/useLiteralKeys: access the private parser seam for a focused unit test
		client["handleLine"](`${JSON.stringify({ type: "agent_settled", sessionId: "foreign" })}\n`);
		expect(events).toBe(0);
		// biome-ignore lint/complexity/useLiteralKeys: access the private client lease for a focused unit test
		client["sessionId"] = "owned";
		// biome-ignore lint/complexity/useLiteralKeys: access the private parser seam for a focused unit test
		client["handleLine"](`${JSON.stringify({ type: "agent_settled", sessionId: "owned" })}\n`);
		expect(events).toBe(1);
	});

	test("rejects a concurrent open_session before sending it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "rpc-client-open-in-flight-"));
		const socketPath = join(directory, "rpc.sock");
		let peer: import("node:net").Socket | undefined;
		let received = "";
		let firstRequestId: string | undefined;
		let resolveFirstRequest: (() => void) | undefined;
		const firstRequest = new Promise<void>((resolve) => {
			resolveFirstRequest = resolve;
		});
		try {
			const server = createServer((socket) => {
				peer = socket;
				socket.on("data", (chunk) => {
					received += chunk.toString();
					const newline = received.indexOf("\n");
					if (newline === -1) return;
					const request = JSON.parse(received.slice(0, newline)) as { id: string };
					received = received.slice(newline + 1);
					firstRequestId = request.id;
					resolveFirstRequest?.();
				});
			});
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			const client = new RpcClient({ socketPath });
			await client.start();
			const first = client.openSession({ cwd: "/tmp" });
			await firstRequest;
			const second = client.openSession({ cwd: "/tmp" });
			await expect(second).rejects.toBeInstanceOf(RpcClientOpenInFlightError);
			await expect(second).rejects.toMatchObject({ code: "open_session_in_flight" });
			peer?.write(
				`${JSON.stringify({ type: "response", id: firstRequestId, success: true, data: { sessionId: "owned", state: {} } })}\n`,
			);
			await expect(first).resolves.toMatchObject({ sessionId: "owned" });
			expect(peer).toBeDefined();
			server.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("bounds buffered pre-lease events by count and preserves newest FIFO records", () => {
		const client = new RpcClient();
		const sequences: number[] = [];
		client.onEvent((event) => {
			const sequence: unknown = Reflect.get(event, "sequence");
			if (event.type === "agent_settled" && typeof sequence === "number") sequences.push(sequence);
		});
		// biome-ignore lint/complexity/useLiteralKeys: drive the private pending-open seam for a focused unit test
		client["pendingOpenSession"] = true;
		for (let sequence = 0; sequence < 520; sequence++)
			// biome-ignore lint/complexity/useLiteralKeys: access the private parser seam for a focused unit test
			client["handleLine"](`${JSON.stringify({ type: "agent_settled", sessionId: "owned", sequence })}\n`);
		// biome-ignore lint/complexity/useLiteralKeys: access the private client lease for a focused unit test
		client["sessionId"] = "owned";
		// biome-ignore lint/complexity/useLiteralKeys: drive the private pending-open seam for a focused unit test
		client["pendingOpenSession"] = false;
		// biome-ignore lint/complexity/useLiteralKeys: drive the private flush seam for a focused unit test
		client["flushPendingSessionEvents"]();

		expect(sequences).toEqual(Array.from({ length: 512 }, (_, index) => index + 8));
	});

	test("buffers own startup events during open and drops foreign events", () => {
		const client = new RpcClient();
		let events = 0;
		client.onEvent((event) => {
			if (event.type === "agent_settled") events++;
		});
		// biome-ignore lint/complexity/useLiteralKeys: access the private open state for a focused unit test
		client["pendingOpenSession"] = true;
		// biome-ignore lint/complexity/useLiteralKeys: access the private parser seam for a focused unit test
		client["handleLine"](`${JSON.stringify({ type: "agent_settled", sessionId: "owned" })}\n`);
		// biome-ignore lint/complexity/useLiteralKeys: access the private parser seam for a focused unit test
		client["handleLine"](`${JSON.stringify({ type: "agent_settled", sessionId: "foreign" })}\n`);
		expect(events).toBe(0);
		// biome-ignore lint/complexity/useLiteralKeys: access the private client lease for a focused unit test
		client["sessionId"] = "owned";
		// biome-ignore lint/complexity/useLiteralKeys: access the private open state for a focused unit test
		client["pendingOpenSession"] = false;
		// biome-ignore lint/complexity/useLiteralKeys: access the private drain seam for a focused unit test
		client["flushPendingSessionEvents"]();
		expect(events).toBe(1);
	});
});
