import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAnthropicOAuthNodeApisForTests, anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;

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
		const login = anthropicOAuth.login({
			signal: controller.signal,
			notify: vi.fn(),
			prompt: (prompt) =>
				new Promise<string>((_resolve, reject) => {
					promptSignal = prompt.signal;
					prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
				}),
		});
		const settled = login.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		// Give the login a turn to open the manual prompt, then cancel from the outside.
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const outcome = await Promise.race([
			settled,
			new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 500)),
		]);
		expect(promptSignal?.aborted).toBe(true);
		expect(outcome).toBe("prompt aborted");
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
