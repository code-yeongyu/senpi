import { afterEach, describe, expect, test, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionFactory, ProviderConfig } from "../../src/core/extensions/types.ts";

function providerFrom(factory: ExtensionFactory): { name: string; config: ProviderConfig } {
	let result: { name: string; config: ProviderConfig } | undefined;
	const pi = new Proxy({}, { get: (_target, property) => property === "registerProvider"
		? (name: string, config: ProviderConfig) => { result = { name, config }; }
		: () => undefined }) as unknown as ExtensionAPI;
	factory(pi);
	if (!result) throw new Error("GLM ZCode extension did not register a provider");
	return result;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function fetchMock(): ReturnType<typeof vi.fn> {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://zcode.z.ai/api/v1/oauth/token") return json({ data: { zai: { access_token: "upstream-token" } } });
		if (url.endsWith("/auth/z/login")) return json({ data: { access_token: "business-token" } });
		if (url.endsWith("/getCustomerInfo")) return json({ data: { email: "User@Example.com", id: 42, organizations: [{ organizationId: "organization-id", isDefault: true, projects: [{ projectId: "project-id", isDefault: true }] }] } });
		if (url.endsWith("/api_keys") && init?.method !== "POST") return json({ data: [] });
		if (url.endsWith("/api_keys") && init?.method === "POST") return json({ data: { apiKey: "key-id" } });
		if (url.endsWith("/api_keys/copy/key-id")) return json({ data: { secretKey: "api-secret" } });
		throw new Error(`unexpected request: ${url}`);
	});
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("GLM ZCode builtin extension", () => {
	test("provisions and refreshes a Z.AI key through the registered provider", async () => {
		const entry = builtinExtensions.find((extension) => extension.id === "glm-zcode");
		if (!entry) throw new Error("missing glm-zcode builtin extension");
		const fetch = fetchMock();
		vi.stubGlobal("fetch", fetch);
		vi.stubEnv("ZCODE_OAUTH_BROKER_TOKEN_URL", "https://attacker.invalid/token");
		const provider = providerFrom(entry.factory);
		const oauth = provider.config.oauth;
		if (!oauth) throw new Error("GLM ZCode provider did not register OAuth");
		const startedAt = Date.now();
		let authUrl = "";
		const credentials = await oauth.login({
			onAuth: ({ url }) => { authUrl = url; },
			onDeviceCode: () => undefined,
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=auth-code&state=${new URL(authUrl).searchParams.get("state")}`,
			onSelect: async () => undefined,
		});
		expect(provider).toMatchObject({ name: "glm-zcode", config: { api: "anthropic-messages", authHeader: true, baseUrl: "https://api.z.ai/api/anthropic", headers: { "X-ZCode-Agent": "glm" }, models: [expect.objectContaining({ id: "glm-5.2", contextWindow: 1_000_000 })] } });
		expect(credentials).toMatchObject({ access: "key-id.api-secret", refresh: "upstream-token", email: "user@example.com" });
		expect(credentials.expires).toBeGreaterThan(startedAt + 50 * 60 * 1000);
		expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain("https://attacker.invalid/token");
		await expect(oauth.refreshToken(credentials)).resolves.toMatchObject({ access: "key-id.api-secret" });
	});

	test("rejects malformed callbacks before exchange and omits response secrets", async () => {
		const entry = builtinExtensions.find((extension) => extension.id === "glm-zcode");
		if (!entry) throw new Error("missing glm-zcode builtin extension");
		const fetch = vi.fn(() => Promise.reject(new Error("broker must not receive malformed callbacks")));
		vi.stubGlobal("fetch", fetch);
		const oauth = providerFrom(entry.factory).config.oauth;
		if (!oauth) throw new Error("GLM ZCode provider did not register OAuth");
		let authUrl = "";
		const login = (callback: string) => oauth.login({
			onAuth: ({ url }) => { authUrl = url; },
			onDeviceCode: () => undefined,
			onPrompt: async () => "",
			onManualCodeInput: async () => callback.replace("{state}", new URL(authUrl).searchParams.get("state") ?? ""),
			onSelect: async () => undefined,
		});
		await expect(login("auth-code")).rejects.toThrow("callback URL");
		await expect(login("zcode://oauth:431/callback?code=auth-code&state={state}")).rejects.toThrow("callback URL is invalid");
		expect(fetch).not.toHaveBeenCalled();
		vi.stubGlobal("fetch", vi.fn(() => json({ access_token: "opaque:short-secret" }, 500)));
		await expect(login("zcode://oauth/callback?code=auth-code&state={state}")).rejects.not.toThrow("opaque:short-secret");
	});
});
