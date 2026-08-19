import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	configureModeEnv,
	scratchRoot,
	seedFauxConfig,
	startWsAppServerMode,
	stopWsAppServerMode,
	threadIdFromResponse,
} from "./app-server-mode-harness.ts";
import { BufferedSocketReader, initializeSocket, openSocket } from "./app-server-mode-socket.ts";

describe("app-server thread rollback mode", () => {
	it("reduces completed faux-provider turns through the real RPC surface", async () => {
		// Given: an initialized app-server with two deterministic faux-provider responses.
		const root = await scratchRoot();
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await seedFauxConfig(root, faux);
		configureModeEnv(root);
		const running = await startWsAppServerMode(18997);
		const socket = await openSocket(running.port);
		const reader = new BufferedSocketReader(socket);
		try {
			await initializeSocket(socket, reader);
			socket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const threadId = threadIdFromResponse(await reader.readUntilResponse(2));
			const rpc = { socket, reader };
			await completeTurn(rpc, { threadId, requestId: 3, text: "first turn" });
			await completeTurn(rpc, { threadId, requestId: 4, text: "second turn" });
			socket.send(JSON.stringify({ id: 5, method: "thread/read", params: { threadId, includeTurns: true } }));
			const beforeRollback = await reader.readUntilResponse(5);

			// When: the client rolls back the latest turn.
			socket.send(JSON.stringify({ id: 6, method: "thread/rollback", params: { threadId, numTurns: 1 } }));
			const rollback = await reader.readUntilResponse(6);
			socket.send(JSON.stringify({ id: 7, method: "thread/read", params: { threadId, includeTurns: true } }));
			const afterRollback = await reader.readUntilResponse(7);

			// Then: the two-turn history is reduced to exactly the retained first turn.
			expect(turnCount(beforeRollback)).toBe(2);
			expect(turnCount(rollback)).toBe(1);
			expect(turnCount(afterRollback)).toBe(1);
		} finally {
			reader.dispose();
			socket.close();
			faux.unregister();
			await stopWsAppServerMode(running);
		}
	});
});

type RollbackRpc = {
	readonly socket: { send(data: string): void };
	readonly reader: BufferedSocketReader;
};

type TurnRequest = {
	readonly threadId: string;
	readonly requestId: number;
	readonly text: string;
};

async function completeTurn(rpc: RollbackRpc, request: TurnRequest): Promise<void> {
	rpc.socket.send(
		JSON.stringify({
			id: request.requestId,
			method: "turn/start",
			params: { threadId: request.threadId, input: [{ type: "text", text: request.text }] },
		}),
	);
	await rpc.reader.readUntilResponse(request.requestId);
	for (let index = 0; index < 128; index += 1) {
		const message = await rpc.reader.read();
		if (message.method === "turn/completed") return;
	}
	throw new Error("turn/completed not observed");
}

function turnCount(response: Record<string, unknown>): number {
	const result = response.result;
	if (typeof result !== "object" || result === null || !("thread" in result)) throw new Error("missing thread");
	const thread = result.thread;
	if (typeof thread !== "object" || thread === null || !("turns" in thread) || !Array.isArray(thread.turns)) {
		throw new Error("missing turns");
	}
	return thread.turns.length;
}
