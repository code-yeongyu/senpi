import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function provider(): OAuthProviderInterface {
	const value = getOAuthProvider("cursor");
	expect(value).toBeDefined();
	if (!value) throw new Error("cursor OAuth provider is not registered");
	return value;
}

describe.sequential("Cursor OAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is registered and advertised by a model provider", () => {
		expect(getOAuthProvider("cursor")?.id).toBe("cursor");
		expect(builtinProviders().map((entry) => entry.id)).toContain("cursor");
	});

	it("logs in with PKCE polling and performs a real refresh-token exchange", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				requests.push({ url, init });
				if (url.includes("/auth/poll")) {
					return jsonResponse({ accessToken: "cursor-access", refreshToken: "cursor-refresh" });
				}
				if (url.endsWith("/auth/exchange_user_api_key")) {
					return jsonResponse({ accessToken: "cursor-access-2", refreshToken: "cursor-refresh-2" });
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		let authUrl = "";
		const credentials = await provider().login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		const parsed = new URL(authUrl);
		expect(parsed.searchParams.get("challenge")).toBeTruthy();
		expect(parsed.searchParams.get("uuid")).toBeTruthy();
		expect(requests[0]?.url).toContain(`uuid=${encodeURIComponent(parsed.searchParams.get("uuid") ?? "")}`);
		expect(credentials).toMatchObject({ access: "cursor-access", refresh: "cursor-refresh" });

		const refreshed = await provider().refreshToken(credentials);
		expect(refreshed).toMatchObject({ access: "cursor-access-2", refresh: "cursor-refresh-2" });
		expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer cursor-refresh");
	});

	it("keeps refresh credentials and endpoint bodies out of errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ token: "response-private-value" }, 401)),
		);
		const error = await provider()
			.refreshToken({ access: "cursor-old-private", refresh: "cursor-refresh-private", expires: 0 })
			.catch((value: unknown) => value);
		expect(String(error)).toContain("401");
		expect(String(error)).not.toContain("cursor-refresh-private");
		expect(String(error)).not.toContain("response-private-value");
	});
});
