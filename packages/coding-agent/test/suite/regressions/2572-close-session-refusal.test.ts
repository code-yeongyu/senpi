import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RpcClient, RpcCommandError } from "../../../src/modes/rpc/rpc-client.ts";

type Request = { id: string; type: string; sessionId?: string };
type Reply = (request: Request, peer: Socket) => void;

interface FakeHost {
	readonly client: RpcClient;
	close(): void;
}

async function fakeHost(onClose: Reply): Promise<FakeHost> {
	const directory = mkdtempSync(join(tmpdir(), "rpc-close-session-refusal-"));
	const socketPath = join(directory, "rpc.sock");
	const server: Server = createServer((peer) => {
		let buffered = "";
		peer.on("data", (chunk) => {
			buffered += chunk.toString();
			for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
				const request = JSON.parse(buffered.slice(0, newline)) as Request;
				buffered = buffered.slice(newline + 1);
				if (request.type === "open_session") {
					peer.write(
						`${JSON.stringify({ type: "response", id: request.id, command: "open_session", success: true, data: { sessionId: "s", state: {} } })}\n`,
					);
				} else if (request.type === "close_session") {
					onClose(request, peer);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	await client.openSession({ cwd: directory });
	return {
		client,
		close: () => {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function sessionIdOf(client: RpcClient): string | undefined {
	return (client as unknown as { sessionId?: string }).sessionId;
}

describe("RpcClient.closeSession honours the host's answer (senpi#2572)", () => {
	test("a refused close_session rejects with the host's error and keeps the session", async () => {
		const host = await fakeHost((request, peer) => {
			peer.write(
				`${JSON.stringify({ type: "response", id: request.id, command: "close_session", success: false, error: "close refused", errorCode: "session_busy" })}\n`,
			);
		});
		try {
			const closing = host.client.closeSession();
			await expect(closing).rejects.toBeInstanceOf(RpcCommandError);
			await expect(closing).rejects.toMatchObject({ message: "close refused", errorCode: "session_busy" });
			expect(sessionIdOf(host.client)).toBe("s");
		} finally {
			await host.client.stop();
			host.close();
		}
	});

	test("a confirmed close_session resolves and forgets the session", async () => {
		const host = await fakeHost((request, peer) => {
			peer.write(
				`${JSON.stringify({ type: "response", id: request.id, command: "close_session", success: true, data: {} })}\n`,
			);
		});
		try {
			await expect(host.client.closeSession()).resolves.toBeUndefined();
			expect(sessionIdOf(host.client)).toBeUndefined();
		} finally {
			await host.client.stop();
			host.close();
		}
	});

	test("a transport that goes away during close_session still counts as closed", async () => {
		const host = await fakeHost((_request, peer) => {
			peer.destroy();
		});
		try {
			await expect(host.client.closeSession()).resolves.toBeUndefined();
			expect(sessionIdOf(host.client)).toBeUndefined();
		} finally {
			await host.client.stop();
			host.close();
		}
	});
});
