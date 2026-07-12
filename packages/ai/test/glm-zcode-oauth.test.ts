import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.ts";

const UPSTREAM = "upstream-private-value";
const BUSINESS = "business-private-value";
const ORG = "org-default";
const PROJECT = "project-default";
const KEY_ID = "key-id";
const SECRET = "key-secret";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function provider(): OAuthProviderInterface {
	const value = getOAuthProvider("glm-zcode");
	expect(value).toBeDefined();
	if (!value) throw new Error("glm-zcode OAuth provider is not registered");
	return value;
}

function provisioningFetch() {
	const keysUrl = `https://api.z.ai/api/biz/v1/organization/${ORG}/projects/${PROJECT}/api_keys`;
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://zcode.z.ai/api/v1/oauth/token") {
			return jsonResponse({ data: { token: "zcode-identity-token", zai: { access_token: UPSTREAM } } });
		}
		if (url === "https://api.z.ai/api/auth/z/login") {
			return jsonResponse({ data: { access_token: BUSINESS } });
		}
		if (url === "https://api.z.ai/api/biz/customer/getCustomerInfo") {
			return jsonResponse({
				data: {
					id: "account-id",
					email: "Member@Example.com",
					organizations: [
						{ organizationId: ORG, isDefault: true, projects: [{ projectId: PROJECT, isDefault: true }] },
					],
				},
			});
		}
		if (url === keysUrl && (init?.method ?? "GET") === "GET") {
			return jsonResponse({ data: [{ name: "zcode-api-key", apiKey: KEY_ID }] });
		}
		if (url === `${keysUrl}/copy/${encodeURIComponent(KEY_ID)}`) {
			return jsonResponse({ data: { secretKey: SECRET } });
		}
		throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
	});
}

describe.sequential("GLM ZCode OAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("is registered and advertised as an unofficial opt-in model provider", () => {
		expect(getOAuthProvider("glm-zcode")?.name).toMatch(/unofficial.*opt-in/i);
		expect(builtinProviders().map((entry) => entry.id)).toContain("glm-zcode");
	});

	it("exchanges a manual ZCode callback, provisions an API key, and refreshes it", async () => {
		const fetchMock = provisioningFetch();
		vi.stubGlobal("fetch", fetchMock);
		let state = "";
		const credentials = await provider().login({
			onAuth: (info) => {
				const url = new URL(info.url);
				state = url.searchParams.get("state") ?? "";
				expect(url.searchParams.get("redirect_uri")).toBe("zcode://oauth/callback");
				expect(info.instructions).toMatch(/unofficial/i);
			},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=manual-code&state=${state}`,
			onSelect: async () => undefined,
		});
		expect(credentials).toMatchObject({
			access: `${KEY_ID}.${SECRET}`,
			refresh: UPSTREAM,
			email: "member@example.com",
			accountId: "account-id",
		});
		const brokerBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(brokerBody).toMatchObject({ code: "manual-code", redirect_uri: "zcode://oauth/callback", state });

		const refreshed = await provider().refreshToken({ ...credentials, access: "old-key", expires: 0 });
		expect(refreshed).toMatchObject({ access: `${KEY_ID}.${SECRET}`, refresh: UPSTREAM });
	});

	it("redacts stored and response secrets when refresh provisioning fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "glm-response-private-value" }, 401)),
		);
		const error = await provider()
			.refreshToken({ access: "old-private-key", refresh: UPSTREAM, expires: 0 })
			.catch((value: unknown) => value);
		expect(String(error)).toMatch(/re-login/i);
		expect(String(error)).toContain("401");
		expect(String(error)).not.toContain(UPSTREAM);
		expect(String(error)).not.toContain("glm-response-private-value");
	});
});
