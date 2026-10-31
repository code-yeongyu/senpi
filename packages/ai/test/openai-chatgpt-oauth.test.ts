import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createOpenAIChatGPTOAuth, openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { OpenAIIdTokenValidationError } from "../src/auth/oauth/openai-id-token.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const neverAbortedSignal = new AbortController().signal;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
const ISSUER = "https://auth.openai.com";
const JWKS_URL = `${ISSUER}/test-jwks`;
const loopbackFetch = fetch;
let signingKey: CryptoKey;
let publicKey: JsonWebKey;
let pendingNonce = "";

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	signingKey = pair.privateKey;
	publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

async function signedIdToken(claims: Record<string, unknown> = {}, badSignature = false): Promise<string> {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const input = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({
		iss: ISSUER,
		aud: "oaiapp_issued",
		exp: Math.floor(Date.now() / 1000) + 3600,
		nonce: pendingNonce,
		sub: "test-subject",
		email: "user@example.test",
		...claims,
	})}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input)),
	);
	if (badSignature) signature[0] ^= 1;
	return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

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

function stubTokenEndpoint(
	response: unknown,
	inspect?: (body: URLSearchParams) => void,
	claims?: Record<string, unknown>,
	badSignature = false,
) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === `${ISSUER}/.well-known/openid-configuration`) return jsonResponse({ jwks_uri: JWKS_URL });
		if (url === JWKS_URL) return jsonResponse({ keys: [{ ...publicKey, kid: "test-key", alg: "RS256" }] });
		expect(url).toBe(TOKEN_URL);
		inspect?.(new URLSearchParams(String(init?.body)));
		if (typeof response === "object" && response !== null && "id_token" in response) {
			return jsonResponse({ ...response, id_token: await signedIdToken(claims, badSignature) });
		}
		return jsonResponse(response);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function loginInteraction(options?: {
	callbackClientId?: string;
	callbackError?: string;
	callbackState?: string;
	callbackTransport?: "manual" | "loopback";
	onAuthorize?: (url: URL) => void;
}): ProviderAuthInteraction {
	let authorizeUrl: URL | undefined;
	return {
		signal: neverAbortedSignal,
		notify: (event) => {
			if (event.type === "info" && options?.callbackTransport === "loopback") {
				throw new Error(`Loopback test listener unavailable: ${event.message}`);
			}
			if (event.type !== "auth_url") return;
			authorizeUrl = new URL(event.url);
			pendingNonce = authorizeUrl.searchParams.get("nonce") ?? "";
			options?.onAuthorize?.(authorizeUrl);
		},
		prompt: async (prompt) => {
			if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
			if (!authorizeUrl) throw new Error("Authorization URL was not emitted before the callback prompt");
			const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
			callback.searchParams.set("code", "authorization-code");
			callback.searchParams.set("state", options?.callbackState ?? authorizeUrl.searchParams.get("state") ?? "");
			if (options?.callbackError) {
				callback.searchParams.delete("code");
				callback.searchParams.set("error", options.callbackError);
			}
			if (options?.callbackClientId) callback.searchParams.set("client_id", options.callbackClientId);
			if (options?.callbackTransport === "loopback") {
				const expectedState = authorizeUrl.searchParams.get("state") ?? "";
				return new Promise<string>((_resolve, reject) => {
					prompt.signal?.addEventListener("abort", () => reject(new Error("Prompt cancelled")), { once: true });
					void (async () => {
						if (options.callbackState) {
							const invalid = await loopbackFetch(callback);
							expect(invalid.status).toBe(400);
							callback.searchParams.set("state", expectedState);
						}
						await loopbackFetch(callback);
					})().catch(reject);
				});
			}
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
		expect(authorizeUrl?.searchParams.has("prompt")).toBe(false);
		expect(authorizeUrl?.searchParams.has("force_reconsent")).toBe(false);
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
			subject: "test-subject",
			email: "user@example.test",
			issuer: ISSUER,
		});
		expect(credential.idToken).toEqual(expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/));
	});

	it.each([
		["bad signature", {}, true],
		["wrong issuer", { iss: "https://other.example.test" }, false],
		["wrong audience", { aud: "oaiapp_other" }, false],
		["wrong audience array", { aud: ["oaiapp_other"] }, false],
		["expired token", { exp: 0 }, false],
		["missing expiration", { exp: undefined }, false],
		["wrong nonce", { nonce: "another-attempt" }, false],
		["missing subject", { sub: "" }, false],
	] as const)("rejects an ID token with %s before returning credentials", async (_name, claims, badSignature) => {
		stubTokenEndpoint(tokenResponse(), undefined, claims, badSignature);
		await expect(
			openaiChatGPTOAuth.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), {
				getDeviceId: () => DEVICE_ID,
			}),
		).rejects.toMatchObject({ name: "OpenAIIdTokenValidationError" });
	});

	// #5003 W3: the selected registration, not email, binds a returning sign-in.
	it.each([
		[undefined, "manual"],
		["oaiapp_existing", "manual"],
		[undefined, "loopback"],
		["oaiapp_existing", "loopback"],
	] as const)("reauthorizes with callback client %s over %s", async (callbackClientId, callbackTransport) => {
		const existing = {
			...connectedCredential(),
			subject: "test-subject",
			email: "saved@example.test",
			idToken: "retained-id-token",
		};
		let authorizeUrl: URL | undefined;
		let exchangeBody: URLSearchParams | undefined;
		stubTokenEndpoint(
			tokenResponse(),
			(body) => {
				exchangeBody = body;
			},
			{ aud: existing.clientId },
		);
		const options = { getDeviceId: () => DEVICE_ID, reauthorize: existing };
		const credential = await openaiChatGPTOAuth.login(
			loginInteraction({
				callbackClientId,
				callbackTransport,
				onAuthorize: (url) => {
					authorizeUrl = url;
				},
			}),
			options,
		);
		expect(authorizeUrl?.searchParams.get("client_id")).toBe(existing.clientId);
		expect(authorizeUrl?.searchParams.get("id_token_hint")).toBe(existing.idToken);
		expect(authorizeUrl?.searchParams.get("login_hint")).toBe(existing.email);
		expect(authorizeUrl?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE_ID}`);
		expect(authorizeUrl?.searchParams.has("agent_name_hint")).toBe(false);
		expect(exchangeBody?.get("client_id")).toBe(existing.clientId);
		expect(credential).toMatchObject({ clientId: existing.clientId, subject: existing.subject });
	});

	it.each(["manual", "loopback"] as const)(
		"rejects another callback client over %s before exchange",
		async (callbackTransport) => {
			const fetchMock = stubTokenEndpoint(tokenResponse());
			const options = {
				getDeviceId: () => DEVICE_ID,
				reauthorize: { ...connectedCredential(), subject: "test-subject" },
			};
			await expect(
				openaiChatGPTOAuth.login(
					loginInteraction({ callbackClientId: "oaiapp_other", callbackTransport }),
					options,
				),
			).rejects.toMatchObject({ name: "OpenAIReauthorizationError", code: "client_mismatch" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("keeps the stored account untouched when the newly verified subject differs", async () => {
		const credentials = new InMemoryCredentialStore();
		const existing = { ...connectedCredential(), subject: "selected-subject", email: "user@example.test" };
		await credentials.modify("test-siwc", async () => existing);
		const before = structuredClone(await credentials.read("test-siwc"));
		const models = createModels({ credentials });
		models.setProvider(
			createProvider({
				id: "test-siwc",
				auth: { oauth: openaiChatGPTOAuth },
				models: [],
				api: {
					stream: () => {
						throw new Error("No inference in OAuth tests");
					},
					streamSimple: () => {
						throw new Error("No inference in OAuth tests");
					},
				},
			}),
		);
		stubTokenEndpoint(tokenResponse(), undefined, { aud: existing.clientId, sub: "other-subject" });
		const options = { getDeviceId: () => DEVICE_ID, reauthorize: existing };
		await expect(
			models.login("test-siwc", "oauth", loginInteraction({ callbackClientId: existing.clientId }), options),
		).rejects.toMatchObject({ name: "OpenAIReauthorizationError", code: "subject_mismatch" });
		expect(await credentials.read("test-siwc")).toEqual(before);
	});

	it("reauthorizes a signed-out registration without retained hints", async () => {
		const existing = { ...connectedCredential(), subject: "test-subject" };
		stubTokenEndpoint(tokenResponse(), undefined, { aud: existing.clientId });
		const options = { getDeviceId: () => DEVICE_ID, reauthorize: existing };
		await expect(
			openaiChatGPTOAuth.login(
				loginInteraction({
					onAuthorize: (url) => {
						expect(url.searchParams.get("client_id")).toBe(existing.clientId);
						expect(url.searchParams.has("id_token_hint")).toBe(false);
						expect(url.searchParams.has("login_hint")).toBe(false);
						expect(url.searchParams.has("agent_name_hint")).toBe(false);
					},
				}),
				options,
			),
		).resolves.toMatchObject({ subject: existing.subject });
	});

	it.each([
		{ clientId: undefined, subject: "test-subject" },
		{ clientId: "dynamic_agent_client", subject: "test-subject" },
		{ clientId: "oaiapp_existing", subject: undefined },
	])("rejects an incomplete saved identity before authorization", async (identity) => {
		const notify = vi.fn();
		const options = { getDeviceId: () => DEVICE_ID, reauthorize: { ...connectedCredential(), ...identity } };
		await expect(openaiChatGPTOAuth.login({ ...loginInteraction(), notify }, options)).rejects.toMatchObject({
			name: "OpenAIReauthorizationError",
			code: "invalid_account",
		});
		expect(notify).not.toHaveBeenCalled();
	});

	it("uses injected fetch and clock, accepts audience arrays, and expires its discovery and JWKS cache", async () => {
		let now = 1_900_000_000_000;
		let rawIdToken = "";
		const fetchMock = vi.fn(async (url: string) => {
			if (url === `${ISSUER}/.well-known/openid-configuration`) return jsonResponse({ jwks_uri: JWKS_URL });
			if (url === JWKS_URL) return jsonResponse({ keys: [{ ...publicKey, kid: "test-key", alg: "RS256" }] });
			expect(url).toBe(TOKEN_URL);
			rawIdToken = await signedIdToken({ aud: ["other-client", "oaiapp_issued"], exp: now / 1000 + 3600 });
			return jsonResponse({ ...tokenResponse(), id_token: rawIdToken });
		});
		const flow = createOpenAIChatGPTOAuth({ fetch: fetchMock, now: () => now });
		const login = () =>
			flow.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), { getDeviceId: () => DEVICE_ID });
		const credential = await login();
		expect(credential).toMatchObject({
			subject: "test-subject",
			email: "user@example.test",
			issuer: ISSUER,
			clientId: "oaiapp_issued",
			idToken: rawIdToken,
			expires: now + (3600 - 180) * 1000,
		});
		await login();
		expect(fetchMock.mock.calls.filter(([url]) => url === JWKS_URL)).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("openid-configuration"))).toHaveLength(1);
		now += 5 * 60 * 1000;
		await login();
		expect(fetchMock.mock.calls.filter(([url]) => url === JWKS_URL)).toHaveLength(2);
		expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("openid-configuration"))).toHaveLength(2);
	});

	it("rejects expiration at the injected clock boundary", async () => {
		const now = 1_900_000_000_000;
		const fetchMock = stubTokenEndpoint(tokenResponse(), undefined, { exp: now / 1000 });
		const flow = createOpenAIChatGPTOAuth({ fetch: fetchMock, now: () => now });
		await expect(
			flow.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), { getDeviceId: () => DEVICE_ID }),
		).rejects.toBeInstanceOf(OpenAIIdTokenValidationError);
	});

	it("reloads JWKS once for an unfamiliar signing key", async () => {
		let keyRequests = 0;
		const flow = createOpenAIChatGPTOAuth({
			fetch: async (url) => {
				if (url.endsWith("openid-configuration")) return jsonResponse({ jwks_uri: JWKS_URL });
				if (url === JWKS_URL) {
					keyRequests++;
					return jsonResponse({ keys: keyRequests === 1 ? [] : [{ ...publicKey, kid: "test-key" }] });
				}
				expect(url).toBe(TOKEN_URL);
				return jsonResponse({ ...tokenResponse(), id_token: await signedIdToken() });
			},
		});
		await expect(
			flow.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), { getDeviceId: () => DEVICE_ID }),
		).resolves.toMatchObject({ subject: "test-subject" });
		expect(keyRequests).toBe(2);
	});

	it.each(["discovery failure", "JWKS failure", "unknown key"])(
		"rejects %s without returning credentials",
		async (failure) => {
			const flow = createOpenAIChatGPTOAuth({
				fetch: async (url) => {
					if (url.endsWith("openid-configuration")) {
						return failure === "discovery failure" ? jsonResponse({}, 503) : jsonResponse({ jwks_uri: JWKS_URL });
					}
					if (url === JWKS_URL) return jsonResponse({ keys: [] }, failure === "JWKS failure" ? 503 : 200);
					expect(url).toBe(TOKEN_URL);
					return jsonResponse({ ...tokenResponse(), id_token: await signedIdToken() });
				},
			});
			await expect(
				flow.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), { getDeviceId: () => DEVICE_ID }),
			).rejects.toBeInstanceOf(OpenAIIdTokenValidationError);
		},
	);

	it.each(["", "not-a-jwt", "e30.e30.e30", "%%%.e30.e30"])(
		"rejects malformed ID token %j with a typed error",
		async (idToken) => {
			const flow = createOpenAIChatGPTOAuth({
				fetch: async () => jsonResponse({ ...tokenResponse(), id_token: idToken }),
			});
			await expect(
				flow.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), { getDeviceId: () => DEVICE_ID }),
			).rejects.toBeInstanceOf(OpenAIIdTokenValidationError);
		},
	);

	it("rejects registration without an issued client ID", async () => {
		const fetchMock = stubTokenEndpoint(tokenResponse());

		await expect(openaiChatGPTOAuth.login(loginInteraction(), { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
			"registration callback did not contain an issued client ID",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps a verified sign-in without direct scope but refuses request auth", async () => {
		stubTokenEndpoint(tokenResponse("openid profile email offline_access resource.invoke"));

		const credential = await openaiChatGPTOAuth.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), {
			getDeviceId: () => DEVICE_ID,
		});
		expect(credential).toMatchObject({
			subject: "test-subject",
			clientId: "oaiapp_issued",
			access: "access-token",
			refresh: "refresh-token",
			planUsageEnabled: false,
		});
		expect(credential.idToken).toBeTruthy();
		await expect(openaiChatGPTOAuth.toAuth(credential)).rejects.toMatchObject({
			name: "OpenAIPlanUsageNotEnabledError",
			code: "plan_usage_not_enabled",
			recovery: ["enable_plan_usage", "use_api_key"],
		});
	});

	it.each(["manual", "loopback"] as const)(
		"stops a state-validated consent decline on the %s callback without exchanging",
		async (transport) => {
			const fetchToken = vi.fn();
			const flow = createOpenAIChatGPTOAuth({ fetch: fetchToken });
			await expect(
				flow.login(
					loginInteraction({
						callbackError: "access_denied",
						callbackTransport: transport === "loopback" ? transport : undefined,
					}),
					{ getDeviceId: () => DEVICE_ID },
				),
			).rejects.toMatchObject({ name: "OpenAIConsentDeclinedError", code: "consent_declined" });
			expect(fetchToken).not.toHaveBeenCalled();
		},
	);

	it("validates state before classifying a pasted consent decline", async () => {
		const fetchToken = vi.fn();
		const flow = createOpenAIChatGPTOAuth({ fetch: fetchToken });
		await expect(
			flow.login(loginInteraction({ callbackError: "access_denied", callbackState: "wrong-state" }), {
				getDeviceId: () => DEVICE_ID,
			}),
		).rejects.toThrow("OAuth state mismatch");
		expect(fetchToken).not.toHaveBeenCalled();
	});

	it("ignores an unrelated loopback decline until a state-matching callback arrives", async () => {
		const fetchToken = vi.fn();
		const flow = createOpenAIChatGPTOAuth({ fetch: fetchToken });
		await expect(
			flow.login(
				loginInteraction({
					callbackError: "access_denied",
					callbackState: "wrong-state",
					callbackTransport: "loopback",
				}),
				{ getDeviceId: () => DEVICE_ID },
			),
		).rejects.toMatchObject({ code: "consent_declined" });
		expect(fetchToken).not.toHaveBeenCalled();
	});

	it("requests explicit plan consent with the saved client ID and complete scopes", async () => {
		let authorizeUrl: URL | undefined;
		stubTokenEndpoint(tokenResponse(), (body) => expect(body.get("client_id")).toBe("oaiapp_issued"));
		const credential = await openaiChatGPTOAuth.login(
			loginInteraction({ onAuthorize: (url) => (authorizeUrl = url) }),
			{ getDeviceId: () => DEVICE_ID, planUsageConsent: { clientId: "oaiapp_issued" } },
		);
		expect(authorizeUrl?.searchParams.get("client_id")).toBe("oaiapp_issued");
		expect(authorizeUrl?.searchParams.get("scope")).toBe(REQUIRED_SCOPE);
		expect(authorizeUrl?.searchParams.get("prompt")).toBe("consent");
		expect(authorizeUrl?.searchParams.has("force_reconsent")).toBe(false);
		expect(credential.planUsageEnabled).toBe(true);
		expect(await openaiChatGPTOAuth.toAuth(credential)).toEqual({ apiKey: "access-token" });
	});

	it("rejects a different issued client ID during explicit consent", async () => {
		const fetchToken = vi.fn();
		const flow = createOpenAIChatGPTOAuth({ fetch: fetchToken });
		await expect(
			flow.login(loginInteraction({ callbackClientId: "oaiapp_other" }), {
				getDeviceId: () => DEVICE_ID,
				planUsageConsent: { clientId: "oaiapp_issued" },
			}),
		).rejects.toThrow("client ID mismatch");
		expect(fetchToken).not.toHaveBeenCalled();
	});

	it.each(["", "dynamic_agent_client"])("rejects consent without an issued client ID (%s)", async (clientId) => {
		await expect(
			openaiChatGPTOAuth.login(loginInteraction(), {
				getDeviceId: () => DEVICE_ID,
				planUsageConsent: { clientId },
			}),
		).rejects.toThrow("requires the saved issued client ID");
	});

	it("accepts an older direct-scope credential without the optional plan flag", async () => {
		expect(await openaiChatGPTOAuth.toAuth(connectedCredential())).toEqual({ apiKey: "old-access" });
	});

	it("refuses a credential explicitly marked disabled despite retained scopes", async () => {
		await expect(
			openaiChatGPTOAuth.toAuth({ ...connectedCredential(), planUsageEnabled: false }),
		).rejects.toMatchObject({ code: "plan_usage_not_enabled" });
	});

	it.each([false, undefined])("refuses missing direct scope even with plan flag %s", async (planUsageEnabled) => {
		await expect(
			openaiChatGPTOAuth.toAuth({ ...connectedCredential(), scopes: ["openid"], planUsageEnabled }),
		).rejects.toMatchObject({ code: "plan_usage_not_enabled" });
	});

	it("rechecks plan permission on refresh in both directions", async () => {
		stubTokenEndpoint(tokenResponse("openid profile email"));
		const disabled = await openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal);
		expect(disabled.planUsageEnabled).toBe(false);
		await expect(openaiChatGPTOAuth.toAuth(disabled)).rejects.toMatchObject({ code: "plan_usage_not_enabled" });
		stubTokenEndpoint(tokenResponse());
		const enabled = await openaiChatGPTOAuth.refresh(disabled, neverAbortedSignal);
		expect(enabled.planUsageEnabled).toBe(true);
		expect(await openaiChatGPTOAuth.toAuth(enabled)).toEqual({ apiKey: "access-token" });
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

	it("refreshes with the credential's issued client ID and stores replacement scopes", async () => {
		let refreshBody: URLSearchParams | undefined;
		stubTokenEndpoint({ ...tokenResponse(), access_token: "new-access", refresh_token: "new-refresh" }, (body) => {
			refreshBody = body;
		});

		const before = Date.now();
		const credential = await openaiChatGPTOAuth.refresh(connectedCredential(), neverAbortedSignal);

		// expires_in is 3600 seconds; the credential expires 3 minutes early so it is refreshed in time.
		expect(credential.expires).toBeGreaterThanOrEqual(before + (3600 - 180) * 1000);
		expect(credential.expires).toBeLessThanOrEqual(Date.now() + (3600 - 180) * 1000);

		expect(refreshBody?.get("grant_type")).toBe("refresh_token");
		expect(refreshBody?.get("client_id")).toBe("oaiapp_existing");
		expect(refreshBody?.get("refresh_token")).toBe("old-refresh");
		expect(refreshBody?.get("resource")).toBe("https://api.openai.com/v1");
		expect(refreshBody?.has("scope")).toBe(false);
		expect(credential).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
			clientId: "oaiapp_existing",
			scopes: REQUIRED_SCOPE.split(" "),
		});
	});

	it("preserves the validated identity and retained ID token across refresh", async () => {
		stubTokenEndpoint(tokenResponse());
		const credential = {
			...connectedCredential(),
			subject: "existing-subject",
			email: "existing@example.test",
			issuer: ISSUER,
			idToken: "previous-validated-id-token",
		};
		expect(await openaiChatGPTOAuth.refresh(credential, neverAbortedSignal)).toMatchObject({
			subject: credential.subject,
			email: credential.email,
			issuer: credential.issuer,
			idToken: credential.idToken,
		});
	});
});
