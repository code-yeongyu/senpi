import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RpcClient, RpcTransportGoneError } from "../src/modes/rpc/rpc-client.ts";

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
});
