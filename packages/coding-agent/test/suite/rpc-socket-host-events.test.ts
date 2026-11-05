import { mkdirSync } from "node:fs";

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import type { RecordValue } from "../helpers/rpc-jsonl-peer.ts";
import { connectPeer, openedSessionId, scratch, spawnRpc, waitForStderr } from "../helpers/rpc-socket-host-support.ts";

describe("RPC Unix-socket multi-connection host", () => {
	it("isolates a mid-turn session from attached and unattached raw sockets", async () => {
		const qa = scratch("mid-turn-isolation");
		const secondCwd = join(qa.root, "second-work");
		mkdirSync(secondCwd, { recursive: true });
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			const openedA = await a.peer.request({ id: "open-p1", type: "open_session", cwd: qa.cwd });
			const openedB = await b.peer.request({ id: "open-p2", type: "open_session", cwd: secondCwd });
			const sessionB = openedSessionId(openedB);
			const turnStarted = b.peer.waitFor((value) => value.type === "message_start" && value.sessionId === sessionB);
			const turn = b.peer.request({
				id: "prompt-p2",
				type: "prompt",
				sessionId: sessionB,
				message: "isolation-turn",
			});
			await turnStarted;
			const third = await connectPeer(qa.socketPath);
			try {
				await turn;
				const lifecycle = new Set([
					"agent_start",
					"agent_settled",
					"agent_idle",
					"session_lifecycle",
					"session_opened",
					"session_closed",
				]);
				const foreign = (value: RecordValue) =>
					value.sessionId === sessionB && typeof value.type === "string" && !lifecycle.has(value.type);
				expect(a.peer.messages.some(foreign)).toBe(false);
				expect(third.peer.messages.some(foreign)).toBe(false);
			} finally {
				third.peer.close();
				third.socket.destroy();
			}
			expect(openedSessionId(openedA)).not.toBe(sessionB);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
		}
	});

	it("broadcasts session closure to observers while targeting the close response", async () => {
		const qa = scratch("close-observer");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			const opened = await a.peer.request({
				id: "close-open",
				type: "open_session",
				cwd: qa.cwd,
			});
			const sessionId = openedSessionId(opened);
			const observerClosed = b.peer.waitFor(
				(value) => value.type === "session_closed" && value.sessionId === sessionId,
			);
			const requesterResponse = a.peer.request({
				id: "close-request",
				type: "close_session",
				sessionId,
			});
			await expect(requesterResponse).resolves.toMatchObject({
				type: "response",
				command: "close_session",
				success: true,
				sessionId,
			});
			await expect(observerClosed).resolves.toMatchObject({
				type: "session_closed",
				sessionId,
			});
			expect(b.peer.messages.some((value) => value.id === "close-request")).toBe(false);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
		}
	});
});
