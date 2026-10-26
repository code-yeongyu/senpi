import { describe, expect, it } from "vitest";

import { startFakeModelServer } from "../helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { JsonlPeer, type RecordValue } from "../helpers/rpc-jsonl-peer.ts";
import { connectPeer, openedSessionId, scratch, spawnRpc, waitForStderr } from "../helpers/rpc-socket-host-support.ts";

function normalizeResponse(value: RecordValue): RecordValue {
	const clone = structuredClone(value);
	delete clone.sessionId;
	if (clone.data && typeof clone.data === "object") {
		const data = clone.data as RecordValue;
		delete data.sessionId;
		delete data.sessionFile;
		delete data.cwd;
		if (data.lifecycle && typeof data.lifecycle === "object") {
			// These are generated session identity/time, like sessionId and message timestamps above.
			const lifecycle = { ...(data.lifecycle as RecordValue) };
			delete lifecycle.rootSessionId;
			delete lifecycle.since;
			data.lifecycle = lifecycle;
		}
		if (Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) => {
				if (typeof message !== "object" || message === null) return message;
				const normalized = { ...(message as RecordValue) };
				delete normalized.id;
				delete normalized.timestamp;
				return normalized;
			});
		}
		if (Array.isArray(data.entries)) {
			data.entries = data.entries.map((entry) => {
				if (typeof entry !== "object" || entry === null) return entry;
				const normalized = { ...(entry as RecordValue) };
				delete normalized.id;
				delete normalized.parentId;
				delete normalized.timestamp;
				if (normalized.data && typeof normalized.data === "object") {
					const entryData = { ...(normalized.data as RecordValue) };
					delete entryData.cwd;
					normalized.data = entryData;
				}
				return normalized;
			});
		}
	}
	return clone;
}
describe("RPC Unix-socket multi-connection host", () => {
	it("matches classic stdio JSONL for an identical command sequence modulo generated ids and routing tags", async () => {
		const socketQa = scratch("diff-socket");
		const stdioQa = scratch("diff-stdio");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(socketQa.agentDir, fake.origin);
		writeRpcModelsJson(stdioQa.agentDir, fake.origin);
		const socketChild = spawnRpc(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${socketQa.socketPath}`,
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
			],
			socketQa,
		);
		await waitForStderr(socketChild, `senpi rpc listening on unix://${socketQa.socketPath}`);
		const socket = await connectPeer(socketQa.socketPath);
		const stdioChild = spawnRpc(["--mode", "rpc", "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL], stdioQa);
		const stdio = new JsonlPeer(stdioChild.stdout, (line) => stdioChild.stdin.write(line));
		try {
			const opened = await socket.peer.request({
				id: "setup-open",
				type: "open_session",
				cwd: socketQa.cwd,
			});
			const sessionId = openedSessionId(opened);
			const commands = [
				{ id: "same-state", type: "get_state" },
				{ id: "same-messages", type: "get_messages" },
			] as const;
			const socketResponses: RecordValue[] = [];
			const stdioResponses: RecordValue[] = [];
			for (const command of commands) {
				socketResponses.push(await socket.peer.request({ ...command, sessionId }));
				stdioResponses.push(await stdio.request({ ...command }));
			}
			expect(socketResponses.map(normalizeResponse)).toEqual(stdioResponses.map(normalizeResponse));
		} finally {
			socket.peer.close();
			socket.socket.destroy();
			stdio.close();
			await fake.close();
		}
	});
});
