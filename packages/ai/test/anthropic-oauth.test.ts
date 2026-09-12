import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAnthropicOAuthNodeApisForTests, anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;
const PREFERRED_CALLBACK_PORT = 53692;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe.sequential("Anthropic OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		__setAnthropicOAuthNodeApisForTests(null);
	});

	function installFailingListen(code: string): { close: ReturnType<typeof vi.fn> } {
		const error = Object.assign(new Error(`listen ${code}: 127.0.0.1:53692`), { code });
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const close = vi.fn();
		__setAnthropicOAuthNodeApisForTests({
			createServer: (() => {
				const server = {
					on: (event: string, listener: (...args: unknown[]) => void) => {
						listeners.set(event, listener);
						return server;
					},
					listen: () => {
						queueMicrotask(() => listeners.get("error")?.(error));
						return server;
					},
					close,
				};
				return server;
			}) as never,
		});
		return { close };
	}

	for (const code of ["EACCES", "EADDRINUSE", "EPERM"]) {
		it(`falls back to manual redirect URL entry when the callback port fails with ${code}`, async () => {
			const { close } = installFailingListen(code);
			const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
				const body = getJsonBody(init);
				expect(body.redirect_uri).toBe("http://localhost:53692/callback");
				expect(body.code).toBe("manual-code");
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			});
			vi.stubGlobal("fetch", fetchMock);
			const events: AuthEvent[] = [];
			const credential = await anthropicOAuth.login({
				signal: neverAbortedSignal,
				notify: (event) => events.push(event),
				prompt: async (prompt) => {
					if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
					const authUrl = events.find((event) => event.type === "auth_url");
					if (authUrl?.type !== "auth_url") throw new Error("Missing auth URL");
					const url = new URL(authUrl.url);
					return `http://localhost:53692/callback?code=manual-code&state=${url.searchParams.get("state")}`;
				},
			});
			const authUrl = events.find((event) => event.type === "auth_url");
			expect(authUrl?.type).toBe("auth_url");
			const instructions = authUrl?.type === "auth_url" ? authUrl.instructions : "";
			expect(instructions).toContain("53692");
			expect(instructions).toContain(code);
			expect(instructions).toMatch(/redirect URL/i);
			expect(credential.access).toBe("access");
			expect(close).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
		});
	}

	it("aborts a manual-only login while the manual prompt is still open", async () => {
		installFailingListen("EADDRINUSE");
		const controller = new AbortController();
		let promptSignal: AbortSignal | undefined;
		// Resolve the moment the login opens its manual prompt, so the abort below is
		// ordered after the prompt exists instead of racing a macrotask tick.
		let promptOpened!: () => void;
		const opened = new Promise<void>((resolve) => {
			promptOpened = resolve;
		});
		const login = anthropicOAuth.login({
			signal: controller.signal,
			notify: vi.fn(),
			prompt: (prompt) =>
				new Promise<string>((_resolve, reject) => {
					promptSignal = prompt.signal;
					prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
					promptOpened();
				}),
		});
		const settled = login.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await opened;
		controller.abort();
		expect(await settled).toBe("prompt aborted");
		expect(promptSignal?.aborted).toBe(true);
	});

	it("rejects non-bind callback errors with the callback host and port", async () => {
		installFailingListen("EUNKNOWN");
		await expect(
			anthropicOAuth.login({
				signal: neverAbortedSignal,
				notify: vi.fn(),
				prompt: vi.fn(),
			}),
		).rejects.toThrow(/127\.0\.0\.1:53692/);
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("authorization_code");
			expect(body.code).toBe("manual-code");
			expect(body.redirect_uri).toBe("http://localhost:53692/callback");
			return jsonResponse({
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) throw new Error("Missing OAuth state or redirect_uri in auth URL");
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("omits scope from refresh token requests", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			const body = getJsonBody(init);
			expect(body.grant_type).toBe("refresh_token");
			expect(body.client_id).toBeTruthy();
			expect(body.refresh_token).toBe("refresh-token");
			expect(body).not.toHaveProperty("scope");
			return jsonResponse({
				access_token: "new-access-token",
				refresh_token: "new-refresh-token",
				expires_in: 3600,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const credentials = await anthropicOAuth.refresh(
			{
				type: "oauth",
				access: "old-access-token",
				refresh: "refresh-token",
				expires: 0,
			},
			neverAbortedSignal,
		);

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("anthropicOAuth.login resolves through the manual_code prompt and aborts it after settling", async () => {
		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = typeof input === "string" ? input : String(input);
			if (url.includes("/oauth/token")) {
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const events: AuthEvent[] = [];
		const prompts: AuthPrompt[] = [];
		let manualSignal: AbortSignal | undefined;

		const credential = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => events.push(event),
			prompt: async (prompt) => {
				prompts.push(prompt);
				if (prompt.type === "manual_code") {
					manualSignal = prompt.signal;
					return "the-code";
				}
				throw new Error(`Unexpected prompt: ${prompt.type}`);
			},
		});

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("access");
		expect(events.some((e) => e.type === "auth_url")).toBe(true);
		expect(prompts.some((p) => p.type === "manual_code")).toBe(true);
		// the prompt's signal is aborted once login settles, so UIs can dismiss it
		expect(manualSignal?.aborted).toBe(true);
	});
});

type PortHold = { bound: boolean; close: () => Promise<void> };

/** Holds a loopback port with a real listener; `bound` is false when something else already owns it. */
function occupyPort(port: number): Promise<PortHold> {
	return new Promise((resolve) => {
		const server: Server = createServer((_req, res) => {
			res.writeHead(503);
			res.end("occupied");
		});
		server.once("error", () => resolve({ bound: false, close: async () => {} }));
		server.listen(port, "127.0.0.1", () =>
			resolve({
				bound: true,
				close: () => new Promise<void>((done) => server.close(() => done())),
			}),
		);
	});
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A manual-code prompt that stays open until the login aborts it. */
function pendingPrompt(prompt: AuthPrompt): Promise<string> {
	return new Promise<string>((_resolve, reject) => {
		prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
	});
}

type StartedLogin = { login: Promise<{ access: string }>; authUrl: Promise<URL> };

function startLogin(signal: AbortSignal = neverAbortedSignal): StartedLogin {
	const authUrl = deferred<URL>();
	const login = anthropicOAuth.login({
		signal,
		notify: (event) => {
			if (event.type === "auth_url") authUrl.resolve(new URL(event.url));
		},
		prompt: pendingPrompt,
	});
	return { login, authUrl: authUrl.promise };
}

function redirectOf(authUrl: URL): URL {
	const redirect = authUrl.searchParams.get("redirect_uri");
	if (!redirect) throw new Error("auth URL carries no redirect_uri");
	return new URL(redirect);
}

/** Token-exchange fake that lets loopback callback requests through to the real listener. */
function stubTokenExchange(): { exchanges: Record<string, string>[]; loopbackFetch: typeof fetch } {
	const realFetch = globalThis.fetch;
	const exchanges: Record<string, string>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);
			if (url.startsWith("http://127.0.0.1:")) return realFetch(url, init);
			exchanges.push(getJsonBody(init));
			return jsonResponse({
				access_token: `access-${exchanges.length}`,
				refresh_token: "refresh",
				expires_in: 3600,
			});
		}),
	);
	return { exchanges, loopbackFetch: realFetch };
}

describe.sequential("Anthropic OAuth callback listener", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("binds an ephemeral loopback port when 53692 is already taken", async () => {
		const occupied = await occupyPort(PREFERRED_CALLBACK_PORT);
		const { exchanges, loopbackFetch } = stubTokenExchange();
		try {
			const started = startLogin();
			const authUrl = await started.authUrl;
			const redirect = redirectOf(authUrl);
			expect(redirect.port).not.toBe(String(PREFERRED_CALLBACK_PORT));
			const callback = await loopbackFetch(
				`http://127.0.0.1:${redirect.port}/callback?code=browser-code&state=${authUrl.searchParams.get("state")}`,
			);
			expect(callback.status).toBe(200);
			const credential = await started.login;
			expect(credential.access).toBe("access-1");
			expect(exchanges).toHaveLength(1);
			expect(exchanges[0]?.code).toBe("browser-code");
			expect(exchanges[0]?.redirect_uri).toBe(`http://localhost:${redirect.port}/callback`);
		} finally {
			await occupied.close();
		}
	});

	it("keeps two concurrent logins in one process independent", async () => {
		const { exchanges, loopbackFetch } = stubTokenExchange();
		const first = startLogin();
		const second = startLogin();
		const [firstUrl, secondUrl] = await Promise.all([first.authUrl, second.authUrl]);
		const firstPort = redirectOf(firstUrl).port;
		const secondPort = redirectOf(secondUrl).port;
		expect(secondPort).not.toBe(firstPort);
		const secondCallback = await loopbackFetch(
			`http://127.0.0.1:${secondPort}/callback?code=code-second&state=${secondUrl.searchParams.get("state")}`,
		);
		expect(secondCallback.status).toBe(200);
		const firstCallback = await loopbackFetch(
			`http://127.0.0.1:${firstPort}/callback?code=code-first&state=${firstUrl.searchParams.get("state")}`,
		);
		expect(firstCallback.status).toBe(200);
		const [firstCredential, secondCredential] = await Promise.all([first.login, second.login]);
		expect(secondCredential.access).toBe("access-1");
		expect(firstCredential.access).toBe("access-2");
		expect(exchanges.map((exchange) => [exchange.code, exchange.redirect_uri])).toEqual([
			["code-second", `http://localhost:${secondPort}/callback`],
			["code-first", `http://localhost:${firstPort}/callback`],
		]);
	});

	it("times out an idle login after 10 minutes and releases its listener", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		const started = startLogin(controller.signal);
		let outcome: string | undefined;
		void started.login.then(
			() => {
				outcome = "resolved";
			},
			(error: unknown) => {
				outcome = error instanceof Error ? error.message : String(error);
			},
		);
		try {
			const port = Number(redirectOf(await started.authUrl).port);
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await vi.waitFor(() => expect(outcome).toMatch(/timed out/i), { timeout: 5000 });
			const released = await occupyPort(port);
			expect(released.bound).toBe(true);
			await released.close();
		} finally {
			controller.abort();
		}
	});
});
