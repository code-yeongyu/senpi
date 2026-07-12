import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { xaiProvider } from "../src/providers/xai.ts";
import {
	discoverXaiOAuthEndpoints,
	exchangeXaiAuthorizationCode,
	getOAuthProvider,
	refreshXaiToken,
} from "../src/utils/oauth/index.ts";
import { loginXai, parseXaiAuthorizationInput, xaiOAuth } from "../src/utils/oauth/xai.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe.sequential("xAI OAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("does not statically import node:http from the registry-loaded xAI module", async () => {
		const source = await readFile(new URL("../src/utils/oauth/xai.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/^import .*node:http/m);
	});

	it("aborts the manual prompt after login settles", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes("openid-configuration")
					? jsonResponse({
							authorization_endpoint: "https://auth.x.ai/authorize",
							token_endpoint: "https://auth.x.ai/token",
						})
					: jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
			),
		);
		let manualSignal: AbortSignal | undefined;
		await xaiOAuth.login({
			notify: () => {},
			prompt: async (prompt) => {
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				manualSignal = prompt.signal;
				return "manual-code";
			},
		});
		expect(manualSignal).toBeDefined();
		expect(manualSignal?.aborted).toBe(true);
	});

	it("cancels callback waiting from the caller signal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					authorization_endpoint: "https://auth.x.ai/authorize",
					token_endpoint: "https://auth.x.ai/token",
				}),
			),
		);
		const controller = new AbortController();
		const login = loginXai({
			onAuth: () => controller.abort(new DOMException("cancelled", "AbortError")),
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
			signal: controller.signal,
		});
		await expect(login).rejects.toMatchObject({ name: "AbortError" });
	});

	it("falls back to manual paste when callback port is occupied", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(56121, "127.0.0.1", resolve);
		});
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) =>
					String(input).includes("openid-configuration")
						? jsonResponse({
								authorization_endpoint: "https://auth.x.ai/authorize",
								token_endpoint: "https://auth.x.ai/token",
							})
						: jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
				),
			);
			let state = "";
			const credentials = await loginXai({
				onAuth: (info) => {
					state = new URL(info.url).searchParams.get("state") ?? "";
				},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
				onManualCodeInput: async () => `code=manual-code&state=${state}`,
			});
			expect(credentials.access).toBe("access");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("parses supported manual callback formats and validates state during login", async () => {
		expect(parseXaiAuthorizationInput("https://127.0.0.1/callback?code=a&state=s")).toEqual({
			code: "a",
			state: "s",
		});
		expect(parseXaiAuthorizationInput("?code=b&state=s")).toEqual({ code: "b", state: "s" });
		expect(parseXaiAuthorizationInput("c#s")).toEqual({ code: "c", state: "s" });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					authorization_endpoint: "https://auth.x.ai/authorize",
					token_endpoint: "https://auth.x.ai/token",
				}),
			),
		);
		await expect(
			loginXai({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
				onManualCodeInput: async () => "code#wrong-state",
			}),
		).rejects.toThrow("state mismatch");
	});

	it("combines caller cancellation with a request timeout", async () => {
		const controller = new AbortController();
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requestSignal = init?.signal ?? undefined;
				return await new Promise<Response>((_resolve, reject) =>
					requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true }),
				);
			}),
		);
		const discovery = discoverXaiOAuthEndpoints(controller.signal);
		expect(requestSignal).not.toBe(controller.signal);
		controller.abort(new DOMException("cancelled", "AbortError"));
		await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
	});

	it("is registered and advertised by the xAI model provider", () => {
		expect(getOAuthProvider("xai")?.id).toBe("xai");
		expect(xaiProvider().auth.oauth?.name).toBe("xAI (Grok account)");
	});

	it("rejects discovery endpoints outside HTTPS x.ai", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					authorization_endpoint: "https://evil.example/authorize",
					token_endpoint: "https://auth.x.ai/token",
				}),
			),
		);
		await expect(discoverXaiOAuthEndpoints()).rejects.toThrow("unexpected endpoint");
	});

	it("exchanges and refreshes tokens with PKCE form requests", async () => {
		const bodies: URLSearchParams[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("openid-configuration"))
					return jsonResponse({
						authorization_endpoint: "https://auth.x.ai/authorize",
						token_endpoint: "https://auth.x.ai/token",
					});
				bodies.push(new URLSearchParams(String(init?.body)));
				return jsonResponse(
					bodies.length === 1
						? { access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 }
						: { access_token: "new-access", expires_in: 3600 },
				);
			}),
		);
		const exchanged = await exchangeXaiAuthorizationCode("code-secret", "pkce-verifier");
		const refreshed = await refreshXaiToken(exchanged.refresh);
		expect(bodies[0]?.get("code_verifier")).toBe("pkce-verifier");
		expect(bodies[0]?.get("grant_type")).toBe("authorization_code");
		expect(bodies[1]?.get("refresh_token")).toBe("refresh-secret");
		expect(refreshed).toMatchObject({ access: "new-access", refresh: "refresh-secret" });
	});

	it("does not expose tokens from failed endpoint responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes("openid-configuration")
					? jsonResponse({
							authorization_endpoint: "https://auth.x.ai/authorize",
							token_endpoint: "https://auth.x.ai/token",
						})
					: jsonResponse({ error: "invalid_grant", access_token: "leaked-token" }, 400),
			),
		);
		const error = await refreshXaiToken("refresh-secret").catch((value: unknown) => value);
		expect(String(error)).not.toContain("refresh-secret");
		expect(String(error)).not.toContain("leaked-token");
	});
});
