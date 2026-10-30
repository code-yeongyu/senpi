import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import {
	classifyOAuthRefreshFailure,
	isOAuthRefreshUnavailableError,
	OAuthClientConfigurationError,
	OAuthReauthorizationRequiredError,
	OAuthTokenEndpointError,
} from "../src/utils/oauth-refresh-error.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const neverAbortedSignal = new AbortController().signal;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenResponse(scope = REQUIRED_SCOPE) {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 3600,
		id_token: "id-token",
		scope,
	};
}

function stubTokenEndpoint(response: unknown, inspect?: (body: URLSearchParams) => void) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		expect(input instanceof Request ? input.url : String(input)).toBe(TOKEN_URL);
		inspect?.(new URLSearchParams(String(init?.body)));
		return jsonResponse(response);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function loginInteraction(options?: {
	callbackClientId?: string;
	onAuthorize?: (url: URL) => void;
}): ProviderAuthInteraction {
	let authorizeUrl: URL | undefined;
	return {
		signal: neverAbortedSignal,
		notify: (event) => {
			if (event.type !== "auth_url") return;
			authorizeUrl = new URL(event.url);
			options?.onAuthorize?.(authorizeUrl);
		},
		prompt: async (prompt) => {
			if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
			if (!authorizeUrl) throw new Error("Authorization URL was not emitted before the callback prompt");
			const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("code", "authorization-code");
			callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
			if (options?.callbackClientId) callback.searchParams.set("client_id", options.callbackClientId);
			return callback.toString();
		},
	};
}

function connectedCredential(): OAuthCredential {
	return {
		type: "oauth",
		access: "old-access",
		refresh: "old-refresh",
		expires: 0,
		clientId: "oaiapp_existing",
		scopes: REQUIRED_SCOPE.split(" "),
	};
}

describe("OpenAI ChatGPT OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("registers a user-owned client and stores its issued ID and granted scopes", async () => {
		let authorizeUrl: URL | undefined;
		let exchangeBody: URLSearchParams | undefined;
		stubTokenEndpoint(tokenResponse(), (body) => {
			exchangeBody = body;
		});

		const credential = await openaiChatGPTOAuth.login(
			loginInteraction({
				callbackClientId: "oaiapp_issued",
				onAuthorize: (url) => {
					authorizeUrl = url;
				},
			}),
			{ getDeviceId: () => DEVICE_ID },
		);

		expect(authorizeUrl?.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authorizeUrl?.searchParams.get("agent_name_hint")).toBe("Pi");
		expect(authorizeUrl?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE_ID}`);
		expect(authorizeUrl?.searchParams.get("scope")).toBe(REQUIRED_SCOPE);
		expect(authorizeUrl?.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(authorizeUrl?.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(exchangeBody?.get("client_id")).toBe("oaiapp_issued");
		expect(exchangeBody?.get("code")).toBe("authorization-code");
		expect(exchangeBody?.get("resource")).toBe("https://api.openai.com/v1");
		expect(exchangeBody?.get("code_verifier")).toBeTruthy();
		expect(credential).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			clientId: "oaiapp_issued",
			scopes: REQUIRED_SCOPE.split(" "),
		});
	});

	it("rejects registration without an issued client ID", async () => {
		const fetchMock = stubTokenEndpoint(tokenResponse());

		await expect(openaiChatGPTOAuth.login(loginInteraction(), { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"registration callback did not contain an issued client ID",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a token response that did not grant direct token use", async () => {
		stubTokenEndpoint(tokenResponse("openid profile email offline_access resource.invoke"));

		await expect(
			openaiChatGPTOAuth.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), {
				getDeviceId: () => DEVICE_ID,
			}),
		).rejects.toThrow("grant did not include chatgpt.tokens.use.direct");
	});

	it("requires a device ID before starting authorization", async () => {
		let authorizationStarted = false;
		const interaction = loginInteraction({
			onAuthorize: () => {
				authorizationStarted = true;
			},
		});

		await expect(openaiChatGPTOAuth.login(interaction)).rejects.toThrow("requires a device ID");
		await expect(openaiChatGPTOAuth.login(interaction, { getDeviceId: () => "not-a-uuid" })).rejects.toThrow(
			"requires a device ID",
		);
		expect(authorizationStarted).toBe(false);
	});

	it("requires refresh responses to rotate the refresh token", async () => {
		const { refresh_token: _refreshToken, ...responseWithoutRefresh } = tokenResponse();
		stubTokenEndpoint(responseWithoutRefresh);

		await expect(openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal)).rejects.toThrow(
			"token response has invalid refresh_token",
		);
	});

	it.each(["oaiapp_existing", "oaiapp_second"])(
		"refreshes and atomically persists the token set for %s",
		async (clientId) => {
			const now = 1_800_000_000_000;
			vi.spyOn(Date, "now").mockReturnValue(now);
			const store = new InMemoryCredentialStore();
			await store.modify("siwc-fixture", async () => ({ ...connectedCredential(), clientId }));
			let refreshBody: URLSearchParams | undefined;
			const scope = "resource.invoke chatgpt.tokens.use.direct";
			stubTokenEndpoint(
				{ ...tokenResponse(scope), access_token: "new-access", refresh_token: "new-refresh" },
				(body) => {
					refreshBody = body;
				},
			);

			const result = await resolveProviderAuth({ id: "siwc-fixture", auth: { oauth: openaiChatGPTOAuth } }, store, {
				env: async () => undefined,
				fileExists: async () => false,
			});
			expect(result?.auth.apiKey).toBe("new-access");

			expect(refreshBody?.get("grant_type")).toBe("refresh_token");
			expect(refreshBody?.get("client_id")).toBe(clientId);
			expect(refreshBody?.get("refresh_token")).toBe("old-refresh");
			expect(refreshBody?.get("resource")).toBe("https://api.openai.com/v1");
			expect(refreshBody?.has("scope")).toBe(false);
			expect(await store.read("siwc-fixture")).toEqual({
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				expires: now + (3600 - 180) * 1000,
				clientId,
				scopes: scope.split(" "),
			});
		},
	);

	// #5003: recovery is driven by the OAuth code, never diagnostic prose.
	it.each([
		{
			shape: "RFC 6749 error string",
			body: JSON.stringify({ error: "invalid_grant" }),
			status: 400,
			expected: OAuthReauthorizationRequiredError,
			classification: "permanent",
		},
		{
			shape: "error object code",
			body: JSON.stringify({ error: { code: "refresh_token_expired" } }),
			status: 400,
			expected: OAuthReauthorizationRequiredError,
			classification: "permanent",
		},
		{
			shape: "error object type",
			body: JSON.stringify({ error: { type: "invalid_client" } }),
			status: 400,
			expected: OAuthClientConfigurationError,
			classification: "permanent",
		},
		{
			shape: "error object code before type",
			body: JSON.stringify({ error: { code: "refresh_token_reused", type: "invalid_request_error" } }),
			status: 400,
			expected: OAuthReauthorizationRequiredError,
			classification: "permanent",
		},
		{
			shape: "nested error string",
			body: JSON.stringify({ error: { error: "invalid_client" } }),
			status: 400,
			expected: OAuthClientConfigurationError,
			classification: "permanent",
		},
		{
			shape: "nested error object",
			body: JSON.stringify({ error: { error: { code: "invalid_refresh_token" } } }),
			status: 400,
			expected: OAuthReauthorizationRequiredError,
			classification: "permanent",
		},
		{
			shape: "top-level code",
			body: JSON.stringify({ code: "invalid_client" }),
			status: 400,
			expected: OAuthClientConfigurationError,
			classification: "permanent",
		},
		{
			shape: "diagnostic-only code",
			body: JSON.stringify({ error_description: "invalid_grant" }),
			status: 400,
			expected: OAuthTokenEndpointError,
			classification: "permanent",
		},
		{
			shape: "non-JSON terminal response",
			body: "invalid_client",
			status: 400,
			expected: OAuthTokenEndpointError,
			classification: "permanent",
		},
		{
			shape: "empty terminal response",
			body: "",
			status: 400,
			expected: OAuthTokenEndpointError,
			classification: "permanent",
		},
		{
			shape: "nested code on transient server response",
			body: JSON.stringify({ error: { code: "invalid_grant" } }),
			status: 503,
			expected: OAuthTokenEndpointError,
			classification: "transient",
		},
		{
			shape: "non-JSON transient response",
			body: "<html>unavailable</html>",
			status: 500,
			expected: OAuthTokenEndpointError,
			classification: "transient",
		},
		{
			shape: "empty transient response",
			body: "",
			status: 429,
			expected: OAuthTokenEndpointError,
			classification: "transient",
		},
	])("classifies refresh response $shape", async ({ body, status, expected, classification }) => {
		// Given a token endpoint response in a supported wire shape.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status })),
		);

		// When the saved session refreshes.
		const error = await openaiChatGPTOAuth
			.refresh(connectedCredential(), neverAbortedSignal)
			.catch((error: unknown) => error);

		// Then only machine-readable codes select recovery, after the status rule.
		expect(error).toBeInstanceOf(expected);
		expect(error instanceof Error && error.constructor).toBe(expected);
		expect(error).toHaveProperty("status", status);
		expect(classifyOAuthRefreshFailure(error)).toBe(classification);
	});

	it.each([
		"invalid_grant",
		"invalid_refresh_token",
		"token_expired",
		"refresh_token_expired",
		"refresh_token_invalidated",
		"refresh_token_reused",
	])("requires reauthorization on refresh code %s", async (code) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: code, error_description: "opaque" }, 400)),
		);
		const error = await openaiChatGPTOAuth
			.refresh(connectedCredential(), neverAbortedSignal)
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(OAuthReauthorizationRequiredError);
		expect(error).toMatchObject({ name: "OAuthReauthorizationRequiredError", code, status: 400 });
		expect(classifyOAuthRefreshFailure(error)).toBe("permanent");
	});

	it("reports invalid_client as configuration rather than reauthorization", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_client" }, 400)),
		);
		const error = await openaiChatGPTOAuth
			.refresh(connectedCredential(), neverAbortedSignal)
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(OAuthClientConfigurationError);
		expect(error).toMatchObject({ name: "OAuthClientConfigurationError", code: "invalid_client", status: 400 });
		expect(classifyOAuthRefreshFailure(error)).toBe("permanent");
	});

	it.each(["network", 500, 503, 599] as const)(
		"preserves credentials on a transient %s refresh failure",
		async (failure) => {
			const stored = connectedCredential();
			const store = new InMemoryCredentialStore();
			await store.modify("siwc-fixture", async () => stored);
			vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					if (failure === "network") throw Object.assign(new TypeError("opaque"), { code: "ECONNRESET" });
					return jsonResponse({ error: "invalid_grant" }, failure);
				}),
			);
			await expect(
				resolveProviderAuth({ id: "siwc-fixture", auth: { oauth: openaiChatGPTOAuth } }, store, {
					env: async () => undefined,
					fileExists: async () => false,
				}),
			).rejects.toSatisfy(isOAuthRefreshUnavailableError);
			expect(await store.read("siwc-fixture")).toEqual(stored);
		},
	);

	it.each([JSON.stringify({ error: "unknown_error", error_description: "invalid_grant" }), "invalid_client"])(
		"does not infer recovery from diagnostic text: %s",
		async (responseBody) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(responseBody, { status: 400 })),
			);
			const error = await openaiChatGPTOAuth
				.refresh(connectedCredential(), neverAbortedSignal)
				.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(OAuthTokenEndpointError);
			expect(error).not.toBeInstanceOf(OAuthReauthorizationRequiredError);
			expect(error).not.toBeInstanceOf(OAuthClientConfigurationError);
		},
	);

	it("does not classify an authorization-code invalid_grant as an expired renewable session", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
		);
		const error = await openaiChatGPTOAuth
			.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), { getDeviceId: () => DEVICE_ID })
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(OAuthTokenEndpointError);
		expect(error).not.toBeInstanceOf(OAuthReauthorizationRequiredError);
	});
});
