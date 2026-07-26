import { describe, expect, it } from "vitest";
import {
	configureModeEnv,
	scratchRoot,
	startWsAppServerMode,
	stopWsAppServerMode,
	threadIdFromResponse,
} from "./app-server-mode-harness.ts";
import { BufferedSocketReader, initializeRequest, openSocket } from "./app-server-mode-socket.ts";

describe("app-server mode entry", () => {
	it("boots a websocket loopback mode and shuts down cleanly after thread lifecycle requests", async () => {
		const root = await scratchRoot();
		configureModeEnv(root);
		const running = await startWsAppServerMode(18990);
		const socket = await openSocket(running.port);
		const reader = new BufferedSocketReader(socket);
		try {
			socket.send(JSON.stringify(initializeRequest(1)));
			await expect(reader.read()).resolves.toMatchObject({ id: 1, result: { userAgent: expect.any(String) } });
			socket.send(JSON.stringify({ method: "initialized", params: {} }));
			socket.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root } }));
			const started = await reader.readUntilResponse(2);
			const threadId = threadIdFromResponse(started);

			socket.send(JSON.stringify({ id: 3, method: "thread/loaded/list", params: {} }));
			expect(await reader.readUntilResponse(3)).toMatchObject({
				id: 3,
				result: {
					data: [threadId],
				},
			});
			socket.send(JSON.stringify({ id: 4, method: "thread/unsubscribe", params: { threadId } }));
			expect(await reader.readUntilResponse(4)).toEqual({ id: 4, result: { status: "unsubscribed" } });
			socket.send(JSON.stringify({ id: 5, method: "thread/delete", params: { threadId } }));
			expect(await reader.readUntilResponse(5)).toEqual({ id: 5, result: {} });
		} finally {
			reader.dispose();
			socket.close();
		}
		await stopWsAppServerMode(running);

		await expect(fetch(`http://127.0.0.1:${running.port}/readyz`)).rejects.toThrow();
	});
});
