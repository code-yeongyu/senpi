import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatgptSubscriptionOAuth } from "../src/auth/oauth/chatgpt-subscription.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";

// senpi#3623: a retried ChatGPT browser login must receive its own browser redirect, whatever an
// earlier attempt (failed, abandoned, or in another process) left listening.

const PORTS_ENV = "PI_CHATGPT_OAUTH_CALLBACK_PORTS";
let ports: [number, number];

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

function accessToken(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	return `h.${payload.toString("base64")}.s`;
}

function stubTokenExchange(): void {
	const passThrough = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== "https://auth.openai.com/oauth/token") return passThrough(input, init);
			return new Response(JSON.stringify({ access_token: accessToken(), refresh_token: "r", expires_in: 3600 }), {
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

function startLoginWithSilentPrompt(signal: AbortSignal): { authUrl: Promise<URL>; done: Promise<unknown> } {
	let resolveUrl: (url: URL) => void = () => {};
	const authUrl = new Promise<URL>((resolve) => {
		resolveUrl = resolve;
	});
	const interaction: ProviderAuthInteraction = {
		signal,
		notify: (event) => {
			if (event.type === "auth_url") resolveUrl(new URL(event.url));
		},
		prompt: async (prompt) => {
			if (prompt.type === "select") return "browser";
			return new Promise<string>((_resolve, reject) => {
				prompt.signal?.addEventListener("abort", () => reject(new Error("prompt closed")), { once: true });
			});
		},
	};
	const done = chatgptSubscriptionOAuth.login(interaction).then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	return { authUrl, done };
}

async function redirect(authUrl: URL): Promise<number> {
	const target = new URL(authUrl.searchParams.get("redirect_uri") ?? "");
	target.hostname = "127.0.0.1";
	target.searchParams.set("code", "the-code");
	target.searchParams.set("state", authUrl.searchParams.get("state") ?? "");
	return (await fetch(target)).status;
}

describe("ChatGPT browser login retry (#3623)", () => {
	beforeEach(async () => {
		ports = [await freePort(), await freePort()];
		vi.stubEnv(PORTS_ENV, ports.join(","));
		stubTokenExchange();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("frees the port when a login is cancelled, so the retry binds fresh", async () => {
		const cancelled = new AbortController();
		const first = startLoginWithSilentPrompt(cancelled.signal);
		await first.authUrl;
		cancelled.abort();
		await first.done;

		const retry = startLoginWithSilentPrompt(new AbortController().signal);
		const url = await retry.authUrl;
		expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${ports[0]}/auth/callback`);
		expect(await redirect(url)).toBe(200);
		await expect(retry.done).resolves.toMatchObject({ value: { accountId: "acct" } });
	});

	it("takes the port over from an abandoned attempt in the same process", async () => {
		const abandoned = startLoginWithSilentPrompt(new AbortController().signal);
		const stale = await abandoned.authUrl;

		const retry = startLoginWithSilentPrompt(new AbortController().signal);
		const url = await retry.authUrl;
		expect(url.searchParams.get("state")).not.toBe(stale.searchParams.get("state"));
		expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${ports[0]}/auth/callback`);
		expect(await redirect(url)).toBe(200);
		await expect(retry.done).resolves.toMatchObject({ value: { accountId: "acct" } });
	});

	it("takes the port over from a login left waiting in another process", async () => {
		const holder = spawn(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/chatgpt-callback-holder.ts", import.meta.url)), String(ports[0])],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			await new Promise<void>((resolve, reject) => {
				holder.stdout.once("data", () => resolve());
				holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
			});

			const retry = startLoginWithSilentPrompt(new AbortController().signal);
			const url = await retry.authUrl;
			expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${ports[0]}/auth/callback`);
			expect(await redirect(url)).toBe(200);
			await expect(retry.done).resolves.toMatchObject({ value: { accountId: "acct" } });
		} finally {
			holder.kill();
		}
	});
});
