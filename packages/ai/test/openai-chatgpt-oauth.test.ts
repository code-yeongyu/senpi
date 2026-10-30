import { createServer, get, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REQUIRED_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const neverAbortedSignal = new AbortController().signal;
const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";

async function listenOnAssignedPort(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
	onCallback?: (url: URL) => void;
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
			options?.onCallback?.(callback);
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
	let preferredCallbackPort: number;

	beforeEach(async () => {
		const reservation = createServer();
		preferredCallbackPort = await listenOnAssignedPort(reservation);
		await closeServer(reservation);
	});

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
			{ getDeviceId: () => DEVICE_ID, preferredCallbackPort },
		);

		expect(authorizeUrl?.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authorizeUrl?.searchParams.get("agent_name_hint")).toBe("Pi");
		expect(authorizeUrl?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE_ID}`);
		expect(authorizeUrl?.searchParams.get("scope")).toBe(REQUIRED_SCOPE);
		const redirectUri = `http://127.0.0.1:${preferredCallbackPort}/auth/callback`;
		expect(authorizeUrl?.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(exchangeBody?.get("redirect_uri")).toBe(redirectUri);
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

		await expect(
			openaiChatGPTOAuth.login(loginInteraction(), { getDeviceId: () => DEVICE_ID, preferredCallbackPort }),
		).rejects.toThrow("registration callback did not contain an issued client ID");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// senpi#5003 W4: exercise real binding, not a mocked listener choosing its own port.
	it("receives the browser callback on a free port when the preferred port is occupied", async () => {
		const occupied = createServer();
		const occupiedPort = await listenOnAssignedPort(occupied);
		let redirectUri = "";
		let exchangeBody: URLSearchParams | undefined;
		stubTokenEndpoint(tokenResponse(), (body) => {
			exchangeBody = body;
		});
		let resolveResponse!: (status: number | undefined) => void;
		const responseStatus = new Promise<number | undefined>((resolve) => {
			resolveResponse = resolve;
		});
		let authorizeUrl: URL | undefined;
		try {
			await openaiChatGPTOAuth.login(
				{
					signal: neverAbortedSignal,
					notify: (event) => {
						if (event.type !== "auth_url") return;
						authorizeUrl = new URL(event.url);
						redirectUri = authorizeUrl.searchParams.get("redirect_uri") ?? "";
						const redirect = new URL(redirectUri);
						expect(redirect.hostname).toBe("127.0.0.1");
						expect(redirect.pathname).toBe("/auth/callback");
						expect(redirect.port).not.toBe(String(occupiedPort));
						expect(Number(redirect.port)).toBeGreaterThan(0);
					},
					prompt: (prompt) =>
						new Promise<string>((_resolve, reject) => {
							prompt.signal?.addEventListener("abort", () => reject(new Error("Prompt cancelled")), {
								once: true,
							});
							const callback = new URL(redirectUri);
							callback.search = new URLSearchParams({
								code: "browser-code",
								state: authorizeUrl?.searchParams.get("state") ?? "",
								client_id: "oaiapp_browser",
							}).toString();
							get(callback, (response) => {
								response.resume();
								resolveResponse(response.statusCode);
							}).on("error", reject);
						}),
				},
				{ getDeviceId: () => DEVICE_ID, preferredCallbackPort: occupiedPort },
			);
			expect(await responseStatus).toBe(200);
			expect(exchangeBody?.get("redirect_uri")).toBe(redirectUri);
			expect(exchangeBody?.get("code")).toBe("browser-code");
			expect(exchangeBody?.get("client_id")).toBe("oaiapp_browser");
		} finally {
			await closeServer(occupied);
		}
	});

	it.each(["/auth/callback", "/callback"])(
		"validates the pasted fallback URI with path %s when the preferred port is occupied",
		async (path) => {
			const occupied = createServer();
			const occupiedPort = await listenOnAssignedPort(occupied);
			let redirectUri = "";
			let exchangeBody: URLSearchParams | undefined;
			const fetchMock = stubTokenEndpoint(tokenResponse(), (body) => {
				exchangeBody = body;
			});
			try {
				const login = openaiChatGPTOAuth.login(
					loginInteraction({
						callbackClientId: "oaiapp_issued",
						onAuthorize: (url) => {
							redirectUri = url.searchParams.get("redirect_uri") ?? "";
							expect(new URL(redirectUri).port).not.toBe(String(occupiedPort));
						},
						onCallback: (url) => {
							url.pathname = path;
						},
					}),
					{ getDeviceId: () => DEVICE_ID, preferredCallbackPort: occupiedPort },
				);
				if (path === "/auth/callback") {
					await expect(login).resolves.toMatchObject({ clientId: "oaiapp_issued" });
					expect(exchangeBody?.get("redirect_uri")).toBe(redirectUri);
				} else {
					await expect(login).rejects.toThrow("The pasted callback URL must start with");
					expect(fetchMock).not.toHaveBeenCalled();
				}
			} finally {
				await closeServer(occupied);
			}
		},
	);

	it("rejects a token response that did not grant direct token use", async () => {
		stubTokenEndpoint(tokenResponse("openid profile email offline_access resource.invoke"));

		await expect(
			openaiChatGPTOAuth.login(loginInteraction({ callbackClientId: "oaiapp_issued" }), {
				getDeviceId: () => DEVICE_ID,
				preferredCallbackPort,
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
});
