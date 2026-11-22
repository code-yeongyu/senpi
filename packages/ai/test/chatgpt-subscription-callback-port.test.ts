import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startChatGptCallback } from "../src/auth/oauth/chatgpt-subscription-callback.ts";

// senpi#3623: a second ChatGPT login must not leave the browser on another process's listener,
// which answers every redirect with "State mismatch.".

const signal = new AbortController().signal;
const opened: Array<{ close(): void }> = [];

afterEach(() => {
	for (const item of opened.splice(0)) item.close();
});

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

async function callback(port: number, state: string): Promise<{ status: number; body: string }> {
	const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${state}`);
	return { status: response.status, body: await response.text() };
}

describe("ChatGPT login callback port (#3623)", () => {
	it("takes the port over from an earlier login, so the browser reaches the login that sent it", async () => {
		const [primary, fallback] = [await freePort(), await freePort()];
		const first = await startChatGptCallback({
			host: "127.0.0.1",
			state: "first-state",
			signal,
			ports: [primary, fallback],
		});
		const second = await startChatGptCallback({
			host: "127.0.0.1",
			state: "second-state",
			signal,
			ports: [primary, fallback],
		});
		if (first) opened.push(first.server);
		if (second) opened.push(second.server);

		expect(second?.redirectUri).toBe(`http://localhost:${primary}/auth/callback`);
		await expect(first?.server.wait()).resolves.toBeUndefined();
		const page = await callback(primary, "second-state");
		expect(page.status).toBe(200);
		await expect(second?.server.wait()).resolves.toBe("the-code");
	});

	it("falls back to the second registered port when the holder will not let go", async () => {
		const [primary, fallback] = [await freePort(), await freePort()];
		const stubborn: Server = createServer((_request, response) => response.end("not a login listener"));
		await new Promise<void>((resolve) => stubborn.listen(primary, "127.0.0.1", resolve));
		opened.push(stubborn);

		const login = await startChatGptCallback({ host: "127.0.0.1", state: "s", signal, ports: [primary, fallback] });
		if (login) opened.push(login.server);

		expect(login?.redirectUri).toBe(`http://localhost:${fallback}/auth/callback`);
		expect((await callback(fallback, "s")).status).toBe(200);
	});

	it("reports no listener when every registered port is held", async () => {
		const ports = [await freePort(), await freePort()];
		for (const port of ports) {
			const holder = createServer((_request, response) => response.end("busy"));
			await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
			opened.push(holder);
		}

		await expect(startChatGptCallback({ host: "127.0.0.1", state: "s", signal, ports })).resolves.toBeUndefined();
	});

	it.each([
		["a plain GET, as an <img> tag sends", { method: "GET" }],
		["a POST without the takeover header, as a form sends", { method: "POST" }],
		[
			"a page's POST that carries the header and an Origin",
			{ method: "POST", headers: { "x-oauth-callback-cancel": "1", origin: "https://example.com" } },
		],
	])("refuses %s to /cancel and keeps waiting for the browser", async (_label, init) => {
		const [primary, fallback] = [await freePort(), await freePort()];
		const login = await startChatGptCallback({
			host: "127.0.0.1",
			state: "mine",
			signal,
			ports: [primary, fallback],
		});
		if (login) opened.push(login.server);

		const refused = await fetch(`http://127.0.0.1:${primary}/cancel`, init);
		expect(refused.status).toBe(403);
		expect((await callback(primary, "mine")).status).toBe(200);
		await expect(login?.server.wait()).resolves.toBe("the-code");
	});

	it("tells a browser that carries another login's state to paste the address into the waiting session", async () => {
		const [primary, fallback] = [await freePort(), await freePort()];
		const login = await startChatGptCallback({
			host: "127.0.0.1",
			state: "mine",
			signal,
			ports: [primary, fallback],
		});
		if (login) opened.push(login.server);

		const page = await callback(primary, "someone-else");
		expect(page.status).toBe(400);
		expect(page.body).toContain("belongs to a different sign-in");
	});
});
