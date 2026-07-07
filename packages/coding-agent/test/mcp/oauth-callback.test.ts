import { connect, createServer as createNetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CallbackChannel,
	LoopbackCallbackServer,
	openCallbackChannel,
} from "../../src/core/extensions/builtin/mcp/auth/callback.ts";

const openServers: LoopbackCallbackServer[] = [];
const openChannels: CallbackChannel[] = [];
afterEach(async () => {
	await Promise.all(openServers.splice(0).map((server) => server.close()));
	await Promise.all(openChannels.splice(0).map((channel) => channel.close()));
});

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const socket: Socket = connect({ host, port }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
	});
}

async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("LoopbackCallbackServer", () => {
	it("has no listener before the flow starts and binds only during it", async () => {
		const port = await freePort();
		expect(await portOpen(port)).toBe(false);
		const server = new LoopbackCallbackServer({ serverName: "s", port, validateState: () => true });
		openServers.push(server);
		const redirectUrl = await server.start();
		expect(redirectUrl).toBe(`http://127.0.0.1:${port}/callback`);
		expect(await portOpen(port)).toBe(true);
		await server.close();
		expect(await portOpen(port)).toBe(false);
	});

	it("completes when a valid code+state redirect arrives", async () => {
		const server = new LoopbackCallbackServer({ serverName: "s", validateState: (s) => s === "good" });
		openServers.push(server);
		const redirectUrl = await server.start();
		const waiter = server.waitForCode();
		await fetch(`${redirectUrl}?code=abc123&state=good`);
		const result = await waiter;
		expect(result).toEqual({ code: "abc123", state: "good" });
	});

	it("rejects a wrong/replayed state with 400 and does NOT complete the flow", async () => {
		const server = new LoopbackCallbackServer({ serverName: "s", validateState: () => false });
		openServers.push(server);
		const redirectUrl = await server.start();
		let settled = false;
		void server.waitForCode().then(() => {
			settled = true;
		});
		const response = await fetch(`${redirectUrl}?code=abc&state=replayed`);
		expect(response.status).toBe(400);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(settled).toBe(false);
	});

	it("tears down the listener on timeout (handle returns to baseline)", async () => {
		const port = await freePort();
		const server = new LoopbackCallbackServer({ serverName: "s", port, timeoutMs: 60, validateState: () => true });
		openServers.push(server);
		await server.start();
		expect(await portOpen(port)).toBe(true);
		await expect(server.waitForCode()).rejects.toMatchObject({ oauthKind: "needs_auth" });
		expect(await portOpen(port)).toBe(false);
	});

	it("fails fast with a clear message when a fixed port is already in use", async () => {
		const port = await freePort();
		const first = new LoopbackCallbackServer({ serverName: "s", port, validateState: () => true });
		openServers.push(first);
		await first.start();
		const second = new LoopbackCallbackServer({ serverName: "s", port, validateState: () => true });
		await expect(second.start()).rejects.toThrow(/already in use/);
	});

	it("opens zero local listeners when a callback URL override is set", async () => {
		const port = await freePort();
		const channel = await openCallbackChannel({
			serverName: "s",
			overrideUrl: "https://proxy.example/callback",
			port,
			validateState: () => true,
		});
		openChannels.push(channel);
		expect(channel.usesLoopback).toBe(false);
		expect(channel.redirectUrl).toBe("https://proxy.example/callback");
		expect(await portOpen(port)).toBe(false);
		await expect(channel.waitForCode()).rejects.toMatchObject({ oauthKind: "headless" });
	});
});
