import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function provider(): OAuthProviderInterface {
	const value = getOAuthProvider("kilo");
	expect(value).toBeDefined();
	if (!value) throw new Error("kilo OAuth provider is not registered");
	return value;
}

describe.sequential("Kilo OAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is registered and advertised by a model provider", () => {
		expect(getOAuthProvider("kilo")?.id).toBe("kilo");
		expect(builtinProviders().map((entry) => entry.id)).toContain("kilo");
	});

	it("completes mocked device authorization and returns static credentials on refresh", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/device-auth/codes")) {
					expect(init?.method).toBe("POST");
					return jsonResponse({ code: "KILO-CODE", verificationUrl: "https://kilo.ai/verify", expiresIn: 300 });
				}
				if (url.endsWith("/device-auth/codes/KILO-CODE")) {
					return jsonResponse({ status: "approved", token: "kilo-access" });
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		let authUrl = "";
		const credentials = await provider().login({
			onAuth: (info) => {
				authUrl = info.url;
				expect(info.instructions).toContain("KILO-CODE");
			},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		expect(authUrl).toBe("https://kilo.ai/verify");
		expect(credentials).toMatchObject({ access: "kilo-access", refresh: "" });
		expect(await provider().refreshToken(credentials)).toBe(credentials);
	});

	it("does not include endpoint response bodies in device-auth errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ token: "kilo-response-private" }, 500)),
		);
		const error = await provider()
			.login({
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			})
			.catch((value: unknown) => value);
		expect(String(error)).toContain("500");
		expect(String(error)).not.toContain("kilo-response-private");
	});
});
